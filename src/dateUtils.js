export const BUSINESS_TIME_ZONE = process.env.BUSINESS_TIME_ZONE || 'America/Argentina/Buenos_Aires';

const businessDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

function formatUtcDate(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function todayIsoInBusinessTimeZone(now = new Date()) {
  const parts = Object.fromEntries(
    businessDateFormatter
      .formatToParts(now)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );

  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function addDaysToIso(isoDate, days) {
  const [year, month, day] = String(isoDate).split('-').map(Number);
  return formatUtcDate(new Date(Date.UTC(year, month - 1, day + days)));
}

export function validIsoDate(year, month, day) {
  const numericYear = Number(year);
  const numericMonth = Number(month);
  const numericDay = Number(day);
  const date = new Date(Date.UTC(numericYear, numericMonth - 1, numericDay));

  if (
    date.getUTCFullYear() !== numericYear ||
    date.getUTCMonth() !== numericMonth - 1 ||
    date.getUTCDate() !== numericDay
  ) {
    return null;
  }

  return formatUtcDate(date);
}
