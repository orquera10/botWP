import { friendlyDate, pricedAvailabilityRanges } from './conversationFormatting.js';

export function wantsDiscountDays(text, history = []) {
  const clean = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const value = clean(text);
  const context = clean([text, ...history.filter(item => item.role === 'user').slice(-2).flatMap(item => (item.parts || []).map(p => p.text || ''))].join(' '));
  return /\b(descuentos?|promocion(?:es)?|promos?|barat[oa]s?|ofertas?)\b/.test(context)
    && /\b(que dias?|q dias?|cuales dias?|cuando|otro dia|otros dias|otra fecha|vos decime|busca(?:me)? dias)\b/.test(value);
}

export async function findDiscountDays({ api, courts, now, timeZone, excludeDate, maxDays = 7 }) {
  const local = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  const result = { desde: local, dias_revisados: [], opciones: [], consultas_fallidas: 0 };
  const deadline = Date.now() + 20_000;
  for (let offset = 0; offset < maxDays && Date.now() < deadline; offset++) {
    const date = new Date(`${local}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + offset);
    const fecha = date.toISOString().slice(0, 10);
    if (fecha === excludeDate) continue;
    result.dias_revisados.push(fecha);
    const options = await Promise.allSettled(courts.map(async court => {
      const duration = court.duracion_fija || 1;
      const slots = await api.consultarDisponibilidad({ fecha, cancha: court.id, duracion: duration });
      const tarifas = pricedAvailabilityRanges(slots, duration, !court.duracion_fija).filter(t => t.ahorro > 0);
      return { fecha, fecha_legible: friendlyDate(fecha), cancha: court.id, nombre: court.nombre, tarifas };
    }));
    result.consultas_fallidas += options.filter(item => item.status === 'rejected').length;
    result.opciones.push(...options.filter(item => item.status === 'fulfilled' && item.value.tarifas.length).map(item => item.value));
  }
  result.hasta = result.dias_revisados.at(-1) || local;
  return result;
}
