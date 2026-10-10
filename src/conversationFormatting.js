export function friendlyDate(value) {
  const raw = String(value || '');
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : raw.replace(/^(\d{2})-(\d{2})-(\d{4})$/, '$3-$2-$1');
  const date = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return raw;
  return new Intl.DateTimeFormat('es-AR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(date).replace(',', '');
}

export function friendlyTime(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})/);
  if (!match) return String(value || '');
  const hour = Number(match[1]);
  const minutes = match[2] === '00' ? '' : `:${match[2]}`;
  const period = hour < 6 ? 'de la madrugada' : hour < 12 ? 'de la mañana' : hour < 20 ? 'de la tarde' : 'de la noche';
  return `${hour % 12 || 12}${minutes} ${period}`;
}

export function friendlyRange(start, duration, end) {
  const parts = String(start || '').match(/^(\d{1,2}):(\d{2})/);
  if (!parts) return friendlyTime(start);
  const total = (Number(parts[1]) * 60 + Number(parts[2]) + Number(duration) * 60) % 1440;
  const finish = end || `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  return `${friendlyTime(start)} a ${friendlyTime(finish)}`;
}

// The API dates late-night slots on the following calendar day.
export function chronologicalSlots(slots) {
  return [...slots].sort((a, b) => `${a.fecha}T${a.inicio}`.localeCompare(`${b.fecha}T${b.inicio}`));
}

export function availabilityRanges(slots, duration, merge = true) {
  const intervals = chronologicalSlots(slots).map(slot => {
    const start = Date.parse(`${slot.fecha}T${slot.inicio}:00Z`);
    let end = start + duration * 3_600_000;
    if (slot.fin) {
      end = Date.parse(`${slot.fecha}T${slot.fin}:00Z`);
      if (end <= start) end += 86_400_000;
    }
    return { start, end };
  }).filter(item => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start);
  const ranges = [];
  for (const interval of intervals) {
    const last = ranges.at(-1);
    if (merge && last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else ranges.push({ ...interval });
  }
  return ranges.map(({ start, end }) => {
    const startTime = new Date(start).toISOString().slice(11, 16);
    const endTime = new Date(end).toISOString().slice(11, 16);
    const from = friendlyTime(startTime);
    const to = endTime === '12:00' ? '12 del mediodía' : friendlyTime(endTime);
    const suffix = from.match(/ de la .+$/)?.[0];
    const compact = suffix && to.endsWith(suffix) ? from.slice(0, -suffix.length) : from;
    return `de ${compact} a ${to}`;
  });
}
