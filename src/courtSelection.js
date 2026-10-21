const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

const EXPLICIT_COURT_PATTERN = /\b(cumple|cumpleanos|cancha\s+promo|(?:futbol|fut|f)\s*(?:5|6|7(?:\s*\/\s*8)?|8)|cancha\s+(?:de\s+)?(?:5|6|7(?:\s*\/\s*8)?|8|grande|entera|completa)|(?:5|6|7|8)\s*(?:vs?\.?|x|pa|contra)\s*(?:5|6|7|8))\b/;

export function isGeneralDiscountQuery(text) {
  const value = normalize(text);
  return /\b(promocion(?:es)?|promos?|descuentos?|barat[oa]s?|ofertas?)\b/.test(value)
    && !EXPLICIT_COURT_PATTERN.test(value);
}

export function needsCourtSelection(text, history = []) {
  const current = normalize(text);
  const userMessages = [...history.filter(item => item.role === 'user').map(item => item.parts?.map(part => part.text || '').join(' ') || ''), text];
  const evidence = normalize(userMessages.join(' '));

  const hasTurnoQueryInCurrent = /\b(cancha|turno|disponibilidad|disponible)\b/.test(current) && /\b(quiero|queremos|queria|queriamos|necesito|necesitamos|busco|buscamos|reservar|reservame|tenes|hay|disponibilidad|disponible)\b/.test(current);
  const hasTurnoQueryInHistory = /\b(cancha|turno|disponibilidad|disponible)\b/.test(evidence) && /\b(quiero|queremos|queria|queriamos|necesito|necesitamos|busco|buscamos|reservar|reservame|tenes|hay|disponibilidad|disponible)\b/.test(evidence);
  const isTimeOrSlotProposal = /\b(?:(?:a\s+las?|para\s+las?|de)\s+)?\d{1,2}(?:[:.]\d{2})?\b|\b\d{1,2}\s*(?:hs?|horas?)?\b|\b(?:manana|tarde|siesta|noche|temprano|hoy|otro horario|otro dia)\b/i.test(current) || /^\s*\d{1,2}\s*[?¿!.]*\s*$/.test(current);

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
    const lastModel = normalize(history[history.length - 1].parts?.map(part => part.text || '').join(' '));
    if (history[history.length - 1].role === 'model' && /cuantos|cuantas|jugadores|personas/.test(lastModel) && /^\d{1,2}[.! ]*$/.test(current)) return false;
  }

  return true;
}
