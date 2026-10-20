const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

const EXPLICIT_COURT_PATTERN = /\b(cumple|cumpleanos|cancha\s+promo|(?:futbol|fut|f)\s*(?:5|6|7(?:\s*\/\s*8)?|8)|cancha\s+(?:de\s+)?(?:5|6|7(?:\s*\/\s*8)?|8|grande|entera|completa)|(?:5|6|7|8)\s*(?:vs?\.?|x|pa|contra)\s*(?:5|6|7|8))\b/;

export function isGeneralDiscountQuery(text) {
  const value = normalize(text);
  return /\b(promocion(?:es)?|promos?|descuentos?|barat[oa]s?|ofertas?)\b/.test(value)
    && !EXPLICIT_COURT_PATTERN.test(value);
}

export function needsCourtSelection(text, history = []) {
  const current = normalize(text);
  // A general request needs a court or player count before looking up slots.
  if (!/\b(cancha|turno|disponibilidad|disponible)\b/.test(current) || !/\b(quiero|queremos|queria|queriamos|necesito|necesitamos|busco|buscamos|reservar|reservame|tenes|hay|disponibilidad|disponible)\b/.test(current)) return false;
  if (/\b(tipos|opciones|todas|cuales|que canchas|torneos?|olimpiadas?|(?:dos|2|ambas)\s+canchas)\b/.test(current)) return false;
  const userMessages = [...history.filter(item => item.role === 'user').map(item => item.parts?.map(part => part.text || '').join(' ') || ''), text];
  const evidence = normalize(userMessages.join(' '));
  if (EXPLICIT_COURT_PATTERN.test(evidence) || /\b(somos\s+\d+|\d+\s*(?:personas|jugadores|jugadoras)|para\s+\d+\s*(?:personas|jugadores)|torneos?|olimpiadas?|(?:dos|2|ambas)\s+canchas)\b/.test(evidence)) return false;
  // A bare count is meaningful only after the bot asked how many players.
  for (let i = 1; i < history.length; i++) {
    const previous = normalize(history[i - 1].parts?.map(part => part.text || '').join(' '));
    const answer = normalize(history[i].parts?.map(part => part.text || '').join(' '));
    if (history[i].role === 'user' && /cuantos|cuantas|jugadores|personas/.test(previous) && /^\d{1,2}[.! ]*$/.test(answer)) return false;
  }
  return true;
}
