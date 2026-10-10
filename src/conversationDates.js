export function upcomingWeekday(text, now, timeZone) {
  const value = String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const match = value.match(/\b(domingo|lunes|martes|miercoles|jueves|viernes|sabado)\b/);
  if (!match || /\b(pasado|anterior)\b/.test(value)) return null;
  const weekdays = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
  const local = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  const date = new Date(`${local}T12:00:00Z`);
  const offset = (weekdays.indexOf(match[1]) - date.getUTCDay() + 7) % 7;
  date.setUTCDate(date.getUTCDate() + (offset || 7));
  return date.toISOString().slice(0, 10);
}
