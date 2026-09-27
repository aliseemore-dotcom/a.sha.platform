// Календарные операции в часовом поясе рабочего пространства.
// Без внешних библиотек: смещение пояса берётся из Intl.

const dateFormatters = new Map();

function formatterFor(timeZone) {
  let f = dateFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23',
    });
    dateFormatters.set(timeZone, f);
  }
  return f;
}

function partsOf(ms, timeZone) {
  const out = {};
  for (const p of formatterFor(timeZone).formatToParts(new Date(ms))) out[p.type] = p.value;
  return out;
}

/** Календарная дата момента `ms` в поясе `timeZone`, формат YYYY-MM-DD. */
export function localDate(ms, timeZone) {
  const p = partsOf(ms, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

function offsetAt(ms, timeZone) {
  const p = partsOf(ms, timeZone);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Момент (ms) начала календарного дня `date` (YYYY-MM-DD) в поясе `timeZone`. */
export function startOfLocalDay(date, timeZone) {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  let result = guess - offsetAt(guess, timeZone);
  // Повторная поправка на случай перехода на летнее/зимнее время в этот день.
  result = guess - offsetAt(result, timeZone);
  return result;
}

export function addDays(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/** Разница в календарных днях между двумя датами YYYY-MM-DD (b − a). */
export function daysBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

/** Последний день месяца даты `date` (YYYY-MM-DD), сама дата — первое число месяца. */
export function lastDayOfMonth(date) {
  const [y, m] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

export function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
