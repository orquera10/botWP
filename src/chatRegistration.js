export const fullNameValid = value => typeof value === 'string' && value.trim().length <= 150 && !/\b(cancha|reservar|reserva|horario|precio|cuanto|cuánto|quiero|mañana|cancelar|foto|fotos|catalogo|catálogo|ninguno)\b/i.test(value) && /^[\p{L}][\p{L}\p{M}'’.-]*(?:\s+[\p{L}][\p{L}\p{M}'’.-]*)+$/u.test(value.trim());

// Codes are passed only to the business API, never to Gemini or its history.
export async function advanceChatRegistration({ api, state = { phase: 'name' }, text }) {
  if (/^(cancelar|cancelá|cancela|salir)$/i.test(text.trim())) return { state: null, cancelled: true, replies: ['Cancelé el registro. Podemos seguir consultando canchas y horarios.'] };
  const next = { ...state };
  if (next.phase === 'name') {
    if (!fullNameValid(text)) return { state: next, replies: ['¿Me pasás tu nombre y apellido completos?'] };
    next.nombre = text.trim().replace(/\s+/g, ' ');
  }
  if (next.phase === 'code' && !/^\d{6}$/.test(text.trim())) return { state: next, replies: ['Escribí el código de 6 números que recibiste, o cancelar para salir.'] };
  if (next.phase === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text.trim())) return { state: next, replies: ['Para distinguir los registros, escribí el correo que ya tenés registrado, o cancelar.'] };
  try {
    const data = await api.registrarChat({ nombre: next.nombre, ...(next.phase === 'code' ? { codigo: text.trim() } : {}), ...(next.phase === 'email' ? { email: text.trim() } : {}) });
    if (data.status === 'registered' && data.cliente?.id) return { state: null, customer: { exists: true, ...data.cliente }, replies: ['¡Listo! Tu chat quedó vinculado. Seguimos con tu reserva.'] };
    if (data.status === 'verification_required') return { state: { ...next, phase: 'code' }, replies: [data.message] };
    if (data.status === 'ambiguous') return { state: { ...next, phase: 'email' }, replies: [data.message] };
    if (data.status === 'needs_staff') return { state: null, replies: [data.message] };
    return { state: next, replies: ['No pude comprobar el registro. Consultá al negocio antes de volver a intentarlo.'] };
  } catch (error) {
    const safe = [400, 409, 429].includes(error.status);
    return { state: safe ? next : null, replies: [safe ? String(error.message).slice(0, 250) : 'No pude comprobar el registro ahora. Consultá al negocio antes de volver a intentarlo.'] };
  }
}
