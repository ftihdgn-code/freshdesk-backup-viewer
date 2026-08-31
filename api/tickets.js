import { getDb } from './_db.js';

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Metin (regex) ile filtrelenecek alanlar
const TEXT_FIELDS = ['subject', 'requester_name', 'requester_email', 'company_name', 'agent_name', 'group_name', 'ticket_type', 'tags'];
// Tam eşleşme (sayısal kod) ile filtrelenecek alanlar
const EXACT_NUMBER_FIELDS = ['status', 'priority', 'source'];
// Tarih aralığı filtrelenebilecek alanlar (query'de _from / _to eki ile gelir)
const DATE_FIELDS = ['created_at', 'updated_at', 'due_by'];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const db = await getDb();
    const { q, page = '1', per_page = '25', id } = req.query;

    const filter = {};

    if (id) {
      const idNum = Number(id);
      if (!Number.isNaN(idNum)) filter._id = idNum;
    }

    for (const field of TEXT_FIELDS) {
      const val = req.query[field];
      if (val) filter[field] = new RegExp(escapeRegex(val.trim()), 'i');
    }

    for (const field of EXACT_NUMBER_FIELDS) {
      const val = req.query[field];
      if (val) filter[field] = Number(val);
    }

    for (const field of DATE_FIELDS) {
      const from = req.query[field + '_from'];
      const to = req.query[field + '_to'];
      if (from || to) {
        filter[field] = {};
        if (from) filter[field].$gte = new Date(from);
        if (to) filter[field].$lte = new Date(to);
      }
    }

    if (q) {
      const trimmed = q.trim();
      const bareDigits = trimmed.replace(/\D/g, '');
      const isDigitsOnly = /^\+?\d+$/.test(trimmed) && bareDigits.length > 0;

      if (isDigitsOnly && bareDigits.length <= 8) {
        // Kısa salt sayı: ticket numarası — indexed _id üzerinden hızlı tam eşleşme.
        filter._id = Number(bareDigits);
      } else if (isDigitsOnly && bareDigits.length >= 9) {
        // Uzun salt sayı: telefon numarası — 0/+90 farkına dayanıklı olması için
        // son 10 haneyi (yerel numara çekirdeği) regex ile ara.
        const core = escapeRegex(bareDigits.slice(-10));
        const re = new RegExp(core);
        filter.$or = [
          { requester_name: re },
          { subject: re },
          { 'custom_fields.cf_mteri_telefon': re },
        ];
      } else {
        const re = new RegExp(escapeRegex(trimmed), 'i');
        filter.$or = [
          { subject: re },
          { requester_name: re },
          { requester_email: re },
          { company_name: re },
          { agent_name: re },
          { tags: re },
          { 'custom_fields.cf_mteri_telefon': re },
        ];
      }
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const perPage = Math.min(100, Math.max(1, parseInt(per_page, 10) || 25));

    const col = db.collection('tickets');
    const total = await col.countDocuments(filter);
    const results = await col
      .find(filter)
      .sort({ created_at: -1 })
      .skip((pageNum - 1) * perPage)
      .limit(perPage)
      .toArray();

    res.status(200).json({ total, page: pageNum, per_page: perPage, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
