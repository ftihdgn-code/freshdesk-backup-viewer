import { getDb } from './_db.js';
import { getContainerClient, mintReadSas, downloadRangeBuffer } from './_azure.js';
import { estimateMp3DurationSeconds, parseCallDurationSeconds } from './_mp3duration.js';

const BLOB_ROOT = 'apsiyonbilisim.bulutsantralim.com';
const TZ_OFFSET_MS = 3 * 60 * 60 * 1000; // Türkiye: UTC+3, DST yok
const DURATION_TOLERANCE_SEC = 5;

function normalizePhone(raw) {
  const digits = (String(raw).match(/\d+/g) || []).join('');
  let d = digits;
  if (d.startsWith('0090')) d = d.slice(4);
  else if (d.startsWith('90') && d.length > 10) d = d.slice(2);
  if (d.startsWith('0')) d = d.slice(1);
  return d.length >= 10 ? d.slice(-10) : d;
}

async function extractPhone(ticket, db) {
  const candidates = [
    ticket.custom_fields?.cf_mteri_telefon,
    ticket.custom_fields?.cf_fsm_phone_number,
    ticket.requester_name,
    ticket.subject,
  ].filter(Boolean);
  for (const c of candidates) {
    const m = String(c).match(/\+?\d[\d\s()-]{8,}\d/);
    if (m) {
      const n = normalizePhone(m[0]);
      if (n.length === 10) return n;
    }
  }

  // Ticket üzerinde yoksa, requester'ın contact kaydına (phone/mobile) bak.
  if (ticket.requester_id) {
    const contact = await db.collection('contacts').findOne({ _id: ticket.requester_id });
    for (const c of [contact?.mobile, contact?.phone].filter(Boolean)) {
      const n = normalizePhone(c);
      if (n.length === 10) return n;
    }
  }

  return null;
}

// Türkiye yerel takvim günü — Azure klasör yapısı (Y/M/D) gerçek çağrı gününü
// yansıtıyor, blob'ların lastModified'ı ise sadece toplu yükleme zamanı (güvenilmez,
// çağrı zamanına yakın olmayabilir) — bu yüzden SADECE gün bazında eşleştiriyoruz.
function dayKey(date) {
  const local = new Date(new Date(date).getTime() + TZ_OFFSET_MS);
  const y = local.getUTCFullYear();
  const m = String(local.getUTCMonth() + 1).padStart(2, '0');
  const d = String(local.getUTCDate()).padStart(2, '0');
  return `${y}/${m}/${d}`;
}

// Cevapsız/terk edilmiş/sesli mesaj bırakılan çağrılarda hiçbir zaman kayıt
// olmaz — bu tür olaylar için arama bile yapmıyoruz.
const MISSED_CALL_RE = /cevaps[ıi]z|terk edilmi[şs]|unanswered|missed\s*call|abandoned|bırakılan sesli mesaj|voicemail/i;

function isMissedCallEvent(text) {
  return MISSED_CALL_RE.test(text || '');
}

// Freshcaller'ın çağrı özetini yazdığı not — "▶ Play call" butonunun orijinal
// Freshdesk'te göründüğü yer tam olarak burası.
const CALL_SUMMARY_RE = /Çağrı Süresi|Call Duration/i;

function blobMatchesPhone(blobName, targetPhone10) {
  const fname = blobName.split('/').pop().replace(/\.mp3$/i, '');
  const parts = fname.split('_').slice(1); // ilk parça call_uuid
  return parts.some((p) => normalizePhone(p) === targetPhone10);
}

const dayListCache = new Map(); // dayKey -> Promise<blob[]>
function listDay(containerClient, key) {
  if (!dayListCache.has(key)) {
    dayListCache.set(key, (async () => {
      const items = [];
      const prefix = `${BLOB_ROOT}/${key}/`;
      for await (const blob of containerClient.listBlobsFlat({ prefix })) items.push(blob);
      return items;
    })());
  }
  return dayListCache.get(key);
}

// Aynı gün + aynı telefon numarasıyla birden fazla gerçek çağrı olabilir (müşteri
// o gün başka bir konuda da aramış olabilir). Bu durumda notun içindeki "Çağrı
// Süresi" ile her adayın gerçek (CBR bitrate'ten hesaplanan) süresini karşılaştırıp
// en yakınını seçiyoruz — sadece gün+telefon eşleşmesi tek başına güvenilir değil.
async function pickBestByDuration(matches, targetSeconds) {
  const scored = await Promise.all(matches.map(async (blob) => {
    try {
      const buf = await downloadRangeBuffer(blob.name, 4096);
      const dur = estimateMp3DurationSeconds(buf, blob.properties.contentLength);
      return { blob, dur };
    } catch {
      return { blob, dur: null };
    }
  }));
  const withDur = scored.filter((s) => s.dur != null);
  if (!withDur.length) return null;
  withDur.sort((a, b) => Math.abs(a.dur - targetSeconds) - Math.abs(b.dur - targetSeconds));
  const best = withDur[0];
  return Math.abs(best.dur - targetSeconds) <= DURATION_TOLERANCE_SEC ? best.blob : null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const id = Number(req.query.id);
    if (!id) return res.status(400).json({ error: 'id gerekli' });

    const db = await getDb();
    const ticket = await db.collection('tickets').findOne({ _id: id });
    if (!ticket) return res.status(404).json({ error: 'Ticket bulunamadı' });

    // Ticket'ın kendisi cevapsız/terk edilmiş bir çağrıysa, sonraki notlar
    // (otomatik yanıt, referans numarası vb.) çağrıyla ilgili olmadığı için
    // "cevapsız" kelimesini hiç geçirmeyebilir. Bunu önlemek için ticket
    // seviyesinde cevapsız/terk edilmişse hiçbir nota bakmadan direkt çık.
    if (isMissedCallEvent(ticket.subject)) {
      return res.status(404).json({ error: 'Cevapsız/terk edilmiş çağrıda ses kaydı olmaz' });
    }

    const phone10 = await extractPhone(ticket, db);
    if (!phone10) return res.status(404).json({ error: 'Ticket\'ta telefon numarası bulunamadı' });

    const conversations = await db.collection('conversations')
      .find({ ticket_id: id })
      .sort({ created_at: 1 })
      .toArray();

    const containerClient = getContainerClient();

    // Freshcaller, çağrının gerçek özetini ("Çağrı Süresi: ...") tek bir nota
    // yazıyor — orijinal Freshdesk'teki "▶ Play call" butonu da sadece o notta
    // çıkıyor. Bu notu bulursak en güvenilir sinyal budur, sadece ona bakarız.
    // Bulamazsak SADECE ticket'ın kendi oluşturulma gününe düşüyoruz.
    const callSummaryConvs = conversations.filter((c) =>
      CALL_SUMMARY_RE.test(c.body_text || c.body || '') && !isMissedCallEvent(c.body_text || c.body)
    );

    const timePoints = callSummaryConvs.length
      ? callSummaryConvs.map((c) => ({ conversationId: c._id, at: c.created_at }))
      : [{ conversationId: null, at: ticket.created_at }];

    const convById = new Map(conversations.map((c) => [c._id, c]));

    const byDay = new Map(); // dayKey -> conversationId[]
    for (const tp of timePoints) {
      const key = dayKey(tp.at);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(tp.conversationId);
    }

    const attachments = []; // {conversationId, blob}

    for (const [key, rawConversationIds] of byDay) {
      // Aynı gün hem belirli bir konuşma notuna hem de ticket seviyesine (null)
      // denk geliyorsa, spesifik olanı tercih et.
      const specific = rawConversationIds.filter((c) => c !== null);
      const conversationIds = specific.length ? specific : rawConversationIds;

      const dayBlobs = await listDay(containerClient, key);
      const matches = dayBlobs.filter((b) => blobMatchesPhone(b.name, phone10));
      if (!matches.length) continue;

      for (const conversationId of conversationIds) {
        if (matches.length === 1) {
          attachments.push({ conversationId, blob: matches[0] });
          continue;
        }

        const sourceConv = conversationId ? convById.get(conversationId) : null;
        const targetSeconds = sourceConv
          ? parseCallDurationSeconds(sourceConv.body_text || sourceConv.body)
          : null;

        const best = targetSeconds != null ? await pickBestByDuration(matches, targetSeconds) : null;
        if (best) {
          attachments.push({ conversationId, blob: best });
        } else {
          // Süreyle daraltamadık — belirsiz, tüm adayları şeffaf şekilde göster.
          for (const blob of matches) attachments.push({ conversationId, blob, ambiguous: true });
        }
      }
    }

    if (!attachments.length) {
      return res.status(404).json({ error: 'Kayıt bulunamadı (arşiv bu tarihi kapsamıyor olabilir veya çağrı ses kaydı yok)' });
    }

    const recordings = await Promise.all(attachments.map(async (a) => {
      const { url, expiresOn } = await mintReadSas(a.blob.name);
      return {
        conversation_id: a.conversationId,
        url,
        expires_at: expiresOn.toISOString(),
        blob: a.blob.name,
        ambiguous: !!a.ambiguous,
      };
    }));

    res.status(200).json({ recordings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
