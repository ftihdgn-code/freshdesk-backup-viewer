import { getDb } from './_db.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const db = await getDb();
    const id = Number(req.query.id);
    if (!id) return res.status(400).json({ error: 'id gerekli' });

    const ticket = await db.collection('tickets').findOne({ _id: id });
    if (!ticket) return res.status(404).json({ error: 'Ticket bulunamadı' });

    const conversations = await db
      .collection('conversations')
      .find({ ticket_id: id })
      .sort({ created_at: 1 })
      .toArray();

    const attachments = await db
      .collection('attachments')
      .find({ ticket_id: id })
      .toArray();

    res.status(200).json({ ticket, conversations, attachments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
