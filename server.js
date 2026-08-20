import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ticketsHandler from './api/tickets.js';
import ticketHandler from './api/ticket.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

app.get('/api/tickets', ticketsHandler);
app.get('/api/ticket', ticketHandler);
app.use('/media', express.static(path.join(__dirname, 'media')));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Fresh Arşiv sunucusu ${PORT} portunda dinliyor.`);
});
