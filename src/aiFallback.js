// The fallback handles only the failed message. Retry AI on the next one.
export function prepareAiRetry(state) {
  if (!state?.fallbackMode) return state;
  const next = { ...state };
  delete next.fallbackMode;
  delete next.fallbackReason;
  return next;
}

export function activateLegacyFallback(state, now = Date.now()) {
  return { ...state, pending: undefined, history: [...(state?.history || [])], fallbackMode: true, updatedAt: now };
}

export function hasPendingCheckout(state, now = Date.now()) {
  return state?.checkout?.status === 'pendiente_pago' && now - state.checkout.createdAt < 10 * 60_000;
}

export function applyResponseModeRevision(state, revision) {
  if (!revision || state?.responseModeRevision === revision) return state;
  const next = { ...state, responseModeRevision: revision };
  delete next.fallbackMode;
  delete next.fallbackReason;
  return next;
}
