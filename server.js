import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ticketsHandler from './api/tickets.js';
import ticketHandler from './api/ticket.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Ek dosyaları (media/attachments) barındıran makine bu container'dan farklı
// bir host olabilirse MEDIA_ORIGIN set edilir ve istekler oraya proxy'lenir.
const MEDIA_ORIGIN = process.env.MEDIA_ORIGIN || null;

const app = express();

app.get('/api/tickets', ticketsHandler);
app.get('/api/ticket', ticketHandler);

if (MEDIA_ORIGIN) {
  app.use('/media', (req, res) => {
    const target = new URL(req.originalUrl, MEDIA_ORIGIN);
    const proxyReq = http.get(target, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', (err) => {
      res.status(502).json({ error: 'media proxy error: ' + err.message });
    });
  });
} else {
  app.use('/media', express.static(path.join(__dirname, 'media')));
}

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Fresh Arşiv sunucusu ${PORT} portunda dinliyor.`);
});
