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

function extractPhone(ticket) {
  const candidates = [ticket.requester_name, ticket.subject].filter(Boolean);
  for (const c of candidates) {
    const m = c.match(/\+?\d[\d\s()-]{8,}\d/);
    if (m) {
      const n = normalizePhone(m[0]);
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

async function findRecordingBlob(createdAt, phone10) {
  const containerClient = getContainerClient();
  const base = new Date(createdAt);
  const dayOffsets = [0, -1, 1]; // saat dilimi/işleme gecikmesi payı

  for (const offset of dayOffsets) {
    const d = new Date(base.getTime() + offset * 24 * 60 * 60 * 1000);
    const prefix = dayPrefix(d);
    const matches = [];
    for await (const blob of containerClient.listBlobsFlat({ prefix })) {
      if (blobMatchesPhone(blob.name, phone10)) matches.push(blob);
    }
    if (matches.length) return { matches, prefix };
  }
  return { matches: [], prefix: null };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const id = Number(req.query.id);
    if (!id) return res.status(400).json({ error: 'id gerekli' });

    const db = await getDb();
    const ticket = await db.collection('tickets').findOne({ _id: id });
    if (!ticket) return res.status(404).json({ error: 'Ticket bulunamadı' });

    const phone10 = extractPhone(ticket);
    if (!phone10) return res.status(404).json({ error: 'Ticket\'ta telefon numarası bulunamadı' });

    const { matches } = await findRecordingBlob(ticket.created_at, phone10);
    if (!matches.length) {
      return res.status(404).json({ error: 'Kayıt bulunamadı (arşiv bu tarihi kapsamıyor olabilir veya çağrı ses kaydı yok)' });
    }

    // Birden fazla eşleşme varsa ticket oluşturulma anına en yakın olanı seç.
    const target = ticket.created_at.getTime();
    matches.sort((a, b) =>
      Math.abs(a.properties.lastModified.getTime() - target) -
      Math.abs(b.properties.lastModified.getTime() - target)
    );
    const chosen = matches[0];

    const { url, expiresOn } = await mintReadSas(chosen.name);
    res.status(200).json({
      url,
      expires_at: expiresOn.toISOString(),
      blob: chosen.name,
      alternatives: matches.length - 1,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
