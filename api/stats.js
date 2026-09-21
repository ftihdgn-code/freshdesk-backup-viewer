import { getDb } from './_db.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const db = await getDb();
    const [total, closed, contacts] = await Promise.all([
      db.collection('tickets').estimatedDocumentCount(),
      db.collection('tickets').countDocuments({ status: { $in: [4, 5] } }),
      db.collection('contacts').estimatedDocumentCount(),
    ]);

    res.status(200).json({
      total,
      closed,
      closedPct: total ? Math.round((closed / total) * 1000) / 10 : 0,
      contacts,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
