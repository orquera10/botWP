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

export function slotMatchesHour(slot, targetHour) {
  if (!slot || !targetHour) return false;
  if (slot.inicio === targetHour) return true;
  const [sH, sM] = String(slot.inicio || '00:00').split(':').map(Number);
  const [tH, tM] = String(targetHour || '00:00').split(':').map(Number);
  const startMins = sH * 60 + sM;
  const targetMins = tH * 60 + tM;
  let endMins;
  if (slot.fin) {
    let [fH, fM] = String(slot.fin).split(':').map(Number);
    if (fH === 0 && fM === 0 && sH > 0) fH = 24;
    endMins = fH * 60 + fM;
  } else {
    endMins = startMins + 60;
  }
  return targetMins >= startMins && targetMins < endMins;
}
