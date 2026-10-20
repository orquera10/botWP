// Detect clear truncations without requiring every valid answer to end in punctuation.
export function incompleteModelText(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if ((text.match(/¿/g) || []).length > (text.match(/\?/g) || []).length) return true;
  if ((text.match(/¡/g) || []).length > (text.match(/!/g) || []).length) return true;
  return /(?:[,;:]|\b(?:quer[eé]s|necesit[aá]s|te gustar[ií]a|para|con|y|de|el|la))$/i.test(text);
}
