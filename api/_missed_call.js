// Cevapsız/terk edilmiş/sesli mesaj bırakılan çağrı tespiti — ticket subject'i üzerinde
// çalışır. Tek yerden yönetiliyor çünkü hem canlı sorgularda (ticket-recording.js,
// hiçbir zaman kaydı olmayan bu tür ticketlarda arama bile yapmamak için) hem de
// tickets.is_missed_call alanının hesaplanmasında (migrate_missed_call.mjs, stats.js)
// aynı tanım kullanılıyor.
export const MISSED_CALL_RE = /cevaps[ıi]z|terk edilmi[şs]|unanswered|missed\s*call|abandoned|bırakılan sesli mesaj|voicemail/i;

export function isMissedCallEvent(text) {
  return MISSED_CALL_RE.test(text || '');
}
