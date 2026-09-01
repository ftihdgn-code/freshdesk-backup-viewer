import { getDb } from './_db.js';
import { getContainerClient, mintReadSas } from './_azure.js';

const BLOB_ROOT = 'apsiyonbilisim.bulutsantralim.com';
const TZ_OFFSET_MS = 3 * 60 * 60 * 1000; // Türkiye: UTC+3, DST yok

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

function dayPrefix(date) {
  const local = new Date(date.getTime() + TZ_OFFSET_MS);
  const y = local.getUTCFullYear();
  const m = String(local.getUTCMonth() + 1).padStart(2, '0');
  const d = String(local.getUTCDate()).padStart(2, '0');
  return `${BLOB_ROOT}/${y}/${m}/${d}/`;
}

function blobMatchesPhone(blobName, targetPhone10) {
  const fname = blobName.split('/').pop().replace(/\.mp3$/i, '');
  const parts = fname.split('_').slice(1); // ilk parça call_uuid
  return parts.some((p) => normalizePhone(p) === targetPhone10);
}

const dayListCache = new Map(); // prefix -> Promise<blob[]>
function listDay(containerClient, prefix) {
  if (!dayListCache.has(prefix)) {
    dayListCache.set(prefix, (async () => {
      const items = [];
      for await (const blob of containerClient.listBlobsFlat({ prefix })) items.push(blob);
      return items;
    })());
  }
  return dayListCache.get(prefix);
}

async function findRecordingBlob(containerClient, createdAt, phone10) {
  const base = new Date(createdAt);
  const dayOffsets = [0, -1, 1]; // saat dilimi/işleme gecikmesi payı

  for (const offset of dayOffsets) {
    const d = new Date(base.getTime() + offset * 24 * 60 * 60 * 1000);
    const prefix = dayPrefix(d);
    const dayBlobs = await listDay(containerClient, prefix);
    const matches = dayBlobs.filter((b) => blobMatchesPhone(b.name, phone10));
    if (matches.length) {
      const target = base.getTime();
      matches.sort((a, b) =>
        Math.abs(a.properties.lastModified.getTime() - target) -
        Math.abs(b.properties.lastModified.getTime() - target)
      );
      return matches[0];
    }
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const id = Number(req.query.id);
    if (!id) return res.status(400).json({ error: 'id gerekli' });

    const db = await getDb();
    const ticket = await db.collection('tickets').findOne({ _id: id });
    if (!ticket) return res.status(404).json({ error: 'Ticket bulunamadı' });

    const phone10 = await extractPhone(ticket, db);
    if (!phone10) return res.status(404).json({ error: 'Ticket\'ta telefon numarası bulunamadı' });

    const conversations = await db.collection('conversations')
      .find({ ticket_id: id })
      .sort({ created_at: 1 })
      .toArray();

    const containerClient = getContainerClient();

    // Her konuşma notu kendi zaman damgasıyla aranıyor (bir ticket'ta birden
    // fazla görüşme/çağrı notu olabilir). Ayrıca hiçbir nota bağlanamayan
    // (conversation_id: null) durum için ticket'ın kendi oluşturulma anı da denenir.
    const timePoints = [
      ...conversations.map((c) => ({ conversationId: c._id, at: c.created_at })),
      { conversationId: null, at: ticket.created_at },
    ];

    const found = await Promise.all(timePoints.map(async (tp) => {
      const blob = await findRecordingBlob(containerClient, tp.at, phone10);
      return blob ? { conversationId: tp.conversationId, blob } : null;
    }));

    // Aynı blob birden fazla zaman noktasından eşleşmiş olabilir (örn. ticket
    // seviyesi ile en yakın not aynı çağrıyı bulduysa) — tekrarları ele.
    const seenBlobs = new Set();
    const unique = found.filter(Boolean).filter((f) => {
      if (seenBlobs.has(f.blob.name)) return false;
      seenBlobs.add(f.blob.name);
      return true;
    });

    if (!unique.length) {
      return res.status(404).json({ error: 'Kayıt bulunamadı (arşiv bu tarihi kapsamıyor olabilir veya çağrı ses kaydı yok)' });
    }

    const recordings = await Promise.all(unique.map(async (f) => {
      const { url, expiresOn } = await mintReadSas(f.blob.name);
      return {
        conversation_id: f.conversationId,
        url,
        expires_at: expiresOn.toISOString(),
        blob: f.blob.name,
      };
    }));

    res.status(200).json({ recordings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
