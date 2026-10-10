const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

export function needsCourtSelection(text, history = []) {
  const current = normalize(text);
  // A general request needs a court or player count before looking up slots.
  if (!/\b(cancha|turno|disponibilidad|disponible)\b/.test(current) || !/\b(quiero|queremos|queria|queriamos|necesito|necesitamos|busco|buscamos|reservar|reservame|tenes|hay|disponibilidad|disponible)\b/.test(current)) return false;
  if (/\b(tipos|opciones|todas|cuales|que canchas)\b/.test(current)) return false;
  const userMessages = [...history.filter(item => item.role === 'user').map(item => item.parts?.map(part => part.text || '').join(' ') || ''), text];
  const evidence = normalize(userMessages.join(' '));
  if (/\b(cumple|cumpleanos|cancha\s+promo|futbol\s*(?:5|6|7|8)|cancha\s+(?:de\s+)?(?:5|6|7|8)|somos\s+\d+|\d+\s*(?:personas|jugadores|jugadoras)|para\s+\d+\s*(?:personas|jugadores))\b/.test(evidence)) return false;
  // A bare count is meaningful only after the bot asked how many players.
  for (let i = 1; i < history.length; i++) {
    const previous = normalize(history[i - 1].parts?.map(part => part.text || '').join(' '));
    const answer = normalize(history[i].parts?.map(part => part.text || '').join(' '));
    if (history[i].role === 'user' && /cuantos|cuantas|jugadores|personas/.test(previous) && /^\d{1,2}[.! ]*$/.test(answer)) return false;
  }
  return true;
}
