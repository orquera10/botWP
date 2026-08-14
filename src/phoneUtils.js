function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

export function normalizeArgentinePhone(value) {
  let digits = onlyDigits(value);
  if (!digits) return '';

  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  }

  if (digits.startsWith('54')) {
    digits = digits.slice(2);
    if (digits.startsWith('9')) {
      digits = digits.slice(1);
    }
  }

  if (digits.startsWith('0')) {
    digits = digits.slice(1);
  }

  // Formato nacional antiguo: 0 + codigo de area + 15 + numero.
  // Al quitar 15 deben quedar los 10 digitos del numero argentino.
  if (digits.length === 12) {
    for (let areaCodeLength = 2; areaCodeLength <= 4; areaCodeLength += 1) {
      if (digits.slice(areaCodeLength, areaCodeLength + 2) === '15') {
        digits = `${digits.slice(0, areaCodeLength)}${digits.slice(areaCodeLength + 2)}`;
        break;
      }
    }
  }

  if (digits.length !== 10) return '';
  return `549${digits}`;
}

export function looksLikeArgentinePhone(value) {
  return Boolean(normalizeArgentinePhone(value));
}
