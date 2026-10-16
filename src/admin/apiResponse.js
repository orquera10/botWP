export async function readAdminResponse(response) {
  const contentType = response.headers.get('content-type') || '';
  const fallback = response.status === 401 || response.status === 403
    ? 'No se pudo autorizar la acción. Recargá el panel e iniciá sesión nuevamente.'
    : response.status === 404
      ? 'La función no está disponible en este servidor. Actualizá y reiniciá el bot.'
      : 'El servidor no pudo completar la acción. Probá nuevamente en unos momentos.';
  // Never display an HTML error page, stack trace or proxy response in the panel.
  if (!contentType.includes('application/json')) throw new Error(fallback);
  let body;
  try { body = await response.json(); } catch { throw new Error(fallback); }
  if (!response.ok) {
    const message = body?.error;
    throw new Error(typeof message === 'string' && message.length <= 300 && !/[<>]/.test(message) ? message : fallback);
  }
  return body;
}
