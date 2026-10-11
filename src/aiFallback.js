// Stay in the legacy flow until the conversation has been idle for 30 minutes.
// This matches the existing AI conversation lifetime and avoids switching menus mid-flow.
export function useLegacyFallback(state, now = Date.now()) {
  return state?.fallbackMode === true && now - state.updatedAt < 30 * 60_000;
}

export function activateLegacyFallback(state, now = Date.now()) {
  return { ...state, pending: undefined, history: [], fallbackMode: true, updatedAt: now };
}

export function hasPendingCheckout(state, now = Date.now()) {
  return state?.checkout?.status === 'pendiente_pago' && now - state.checkout.createdAt < 10 * 60_000;
}
