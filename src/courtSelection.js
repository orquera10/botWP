const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

const EXPLICIT_COURT_PATTERN = /\b(cumple|cumpleanos|cancha\s+promo|(?:futbol|fut|f)\s*(?:5|6|7(?:\s*\/\s*8)?|8)|cancha\s+(?:de\s+)?(?:5|6|7(?:\s*\/\s*8)?|8|grande|entera|completa)|(?:5|6|7|8)\s*(?:vs?\.?|x|pa|contra)\s*(?:5|6|7|8))\b/;

export function isGeneralDiscountQuery(text) {
  const value = normalize(text);
  return /\b(promocion(?:es)?|promos?|descuentos?|barat[oa]s?|ofertas?)\b/.test(value)
    && !EXPLICIT_COURT_PATTERN.test(value);
}

export function needsCourtSelection(text, history = [], options = {}) {
  const current = normalize(text);
  const userMessages = [...history.filter(item => item.role === 'user').map(item => item.parts?.map(part => part.text || '').join(' ') || ''), text];
  const evidence = normalize(userMessages.join(' '));

  // If already in a birthday context (court 8) and user isn't asking to switch to soccer or promo, keep birthday
  const birthdayCourt = options.cancha === 8 || options.canchaNombre === 'Cumpleaños' || options.availability?.cancha === 8 || options.availability?.nombre === 'Cumpleaños';
  if (birthdayCourt && !/\b(futbol|fut|f5|f6|f7|f8|promo)\b/i.test(current)) return false;

  const lastModel = history.length > 0 ? normalize(history[history.length - 1].parts?.map(part => part.text || '').join(' ') || '') : '';
  const replyingToBirthdayOffer = /\b(?:13\s*a\s*16|17\s*a\s*20|21\s*a\s*(?:00?|24))\b/.test(lastModel) && /\b(?:cumple|cumpleanos|salon|personas)\b/.test(lastModel);
  if (replyingToBirthdayOffer && !/\b(futbol|fut|f5|f6|f7|f8|promo|opciones|todas)\b/i.test(current)) return false;

  const hasTurnoQueryInCurrent = /\b(cancha|turno|disponibilidad|disponible)\b/.test(current) && /\b(quiero|queremos|queria|queriamos|necesito|necesitamos|busco|buscamos|reservar|reservame|tenes|hay|disponibilidad|disponible)\b/.test(current);
  const hasTurnoQueryInHistory = /\b(cancha|turno|disponibilidad|disponible)\b/.test(evidence) && /\b(quiero|queremos|queria|queriamos|necesito|necesitamos|busco|buscamos|reservar|reservame|tenes|hay|disponibilidad|disponible)\b/.test(evidence);
  const isTimeOrSlotProposal = (
    /\b(?:a\s+las?|para\s+las?|de)\s+\d{1,2}(?:[:.]\d{2})?\b/i.test(current) ||
    /\b\d{1,2}[:.]\d{2}\b/.test(current) ||
    /\b\d{1,2}\s*(?:hs?|horas?)\b/i.test(current) ||
    /\b(?:manana|tarde|siesta|noche|temprano|hoy|otro horario|otro dia)\b/i.test(current) ||
    /^\s*\d{1,2}\s*[?¿!.]*\s*$/.test(current)
  );

  if (!hasTurnoQueryInCurrent && !(hasTurnoQueryInHistory && isTimeOrSlotProposal)) return false;
  if (/\b(tipos|opciones|todas|cuales|que canchas|torneos?|olimpiadas?|(?:dos|2|ambas)\s+canchas)\b/.test(current)) return false;

  const cleanEvidence = evidence.replace(/\b(?:no|sin|nada de)\s+(?:quiero\s+)?cancha\s+promo\b/g, '');
  if (EXPLICIT_COURT_PATTERN.test(cleanEvidence) || /\b(somos\s+\d+|\d+\s*(?:personas|jugadores|jugadoras)|para\s+\d+\s*(?:personas|jugadores)|torneos?|olimpiadas?|(?:dos|2|ambas)\s+canchas)\b/.test(cleanEvidence)) return false;

  // A bare count is meaningful only after the bot asked how many players.
  for (let i = 1; i < history.length; i++) {
    const previous = normalize(history[i - 1].parts?.map(part => part.text || '').join(' '));
    const answer = normalize(history[i].parts?.map(part => part.text || '').join(' '));
    if (history[i].role === 'user' && /cuantos|cuantas|jugadores|personas/.test(previous) && /^\d{1,2}[.! ]*$/.test(answer)) return false;
  }
  if (history.length > 0) {
    if (history[history.length - 1].role === 'model' && /cuantos|cuantas|jugadores|personas/.test(lastModel) && /^\d{1,2}[.! ]*$/.test(current)) return false;
  }

  return true;
}
