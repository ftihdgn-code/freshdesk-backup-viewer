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

    // Freshcaller çağrılarında ilk not saf sistem metadata'sı oluyor
    // ("created_by: <agent_id>\nfreshcaller: true\ntime: ..."), kendisi
    // insana gösterilmeye değmez ama içindeki agent_id, orijinal Freshdesk'te
    // ticket başlığının altında görünen "Created by <Ad Soyad>" bilgisini taşıyor.
    let createdByName = null;
    const metaConv = conversations.find((c) => {
      const raw = c.body_text || c.body || '';
      return /created_by:\s*\d+/i.test(raw) && /freshcaller:\s*true/i.test(raw);
    });
    if (metaConv) {
      const raw = metaConv.body_text || metaConv.body || '';
      const m = raw.match(/created_by:\s*(\d+)/i);
      if (m) {
        const agent = await db.collection('agents').findOne({ _id: Number(m[1]) });
        if (agent) createdByName = agent.name;
      }
    }

    res.status(200).json({ ticket, conversations, attachments, createdByName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
