// Русская локализация дат, чисел и меток срочности. Часовой пояс — рабочего пространства (приходит с сервера).

const plural = new Intl.PluralRules('ru');

export function pluralize(n, one, few, many) {
  const form = plural.select(n);
  return form === 'one' ? one : form === 'few' ? few : many;
}

const cache = new Map();
function fmt(key, options) {
  if (!cache.has(key)) cache.set(key, new Intl.DateTimeFormat('ru-RU', options));
  return cache.get(key);
}

// Даты мероприятий (YYYY-MM-DD) — календарные, без пояса: форматируем как UTC-полночь.
const utcDate = (d) => new Date(`${d}T00:00:00Z`);

export function dayNumber(date) {
  return fmt('day', { day: 'numeric', timeZone: 'UTC' }).format(utcDate(date));
}

/** «июня 2027» — месяц в родительном падеже, как под крупным числом в DateBlock. */
export function monthYear(date) {
  return fmt('dmy', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(utcDate(date)).replace(/\s?г\.$/, '').split(' ').slice(1).join(' ');
}

export function fullDate(date) {
  return fmt('full', { day: 'numeric', month: 'long', year: 'numeric', weekday: 'long', timeZone: 'UTC' })
    .format(utcDate(date)).replace(/\s?г\.$/, '');
}

export function localDate(ms, timeZone) {
  const p = {};
  for (const part of fmt(`iso|${timeZone}`, { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(ms))) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day}`;
}

export function daysBetween(fromDate, toDate) {
  return Math.round((utcDate(toDate) - utcDate(fromDate)) / 86400000);
}

export function timeIn(ms, timeZone) {
  return fmt(`time|${timeZone}`, { hour: '2-digit', minute: '2-digit', timeZone }).format(new Date(ms));
}

// Без timeZoneName: рабочий пояс один на всё пространство, и повторять его в каждой обычной
// подписи — шум, а не полезная информация (ТЗ 09, §3.1: «не выводи неуместный GMT−7»).
export function dateTimeIn(ms, timeZone) {
  return fmt(`dt|${timeZone}`, {
    day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone,
  }).format(new Date(ms));
}

/** «через 34 дня», «сегодня», «завтра»; для прошедших дат — null (отрицательный отсчёт не показываем). */
export function relativeDay(date, timeZone, now = Date.now()) {
  if (!date) return null;
  const diff = daysBetween(localDate(now, timeZone), date);
  if (diff < 0) return null;
  if (diff === 0) return 'сегодня';
  if (diff === 1) return 'завтра';
  return `через ${diff} ${pluralize(diff, 'день', 'дня', 'дней')}`;
}

export function isPast(date, timeZone, now = Date.now()) {
  return date < localDate(now, timeZone);
}

function lastDayOfMonth(date) {
  const [y, m] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** Как `isPast`, но для даты с известным только месяцем — «прошло» после последнего дня месяца. */
export function isPastPrecise(date, precision, timeZone, now = Date.now()) {
  const cutoff = precision === 'month' ? lastDayOfMonth(date) : date;
  return cutoff < localDate(now, timeZone);
}

/** «Июнь 2027» — для дат с известным только месяцем (первое число месяца). */
export function monthLabel(date) {
  const label = fmt('my', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(utcDate(date));
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * Срок в блоке «Дальше» (ТЗ 07, §5.2): «Завтра», «Пт, 3 окт.» в пределах недели, иначе
 * «через N дней».
 */
export function upcomingDueLabel(date, timeZone, now = Date.now()) {
  const today = localDate(now, timeZone);
  const diff = daysBetween(today, date);
  if (diff === 1) return 'Завтра';
  if (diff <= 6) {
    const d = utcDate(date);
    const weekday = fmt('wd-short', { weekday: 'short', timeZone: 'UTC' }).format(d).replace('.', '');
    const dm = fmt('dm-short', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(d).replace(/\.$/, '');
    return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)}, ${dm}`;
  }
  return `через ${diff} ${pluralize(diff, 'день', 'дня', 'дней')}`;
}

/**
 * Текст метки срочности и полная подпись для title/aria.
 * @returns {{ label: string, detail: string | null }}
 */
export function attentionLabel(item, timeZone, now = Date.now()) {
  const today = localDate(now, timeZone);
  const overdueDays = (dueDay) => {
    const days = Math.max(1, daysBetween(dueDay, today));
    return `Просрочено ${days} ${pluralize(days, 'день', 'дня', 'дней')}`;
  };
  switch (item.kind) {
    case 'overdue': {
      if (item.dueAt) {
        const due = Date.parse(item.dueAt);
        const dueDay = localDate(due, timeZone);
        // Срок сегодня уже прошёл — «с HH:mm», а не «1 день»
        const label = dueDay === today ? `Просрочено с ${timeIn(due, timeZone)}` : overdueDays(dueDay);
        return { label, detail: `Срок: ${dateTimeIn(due, timeZone)}` };
      }
      return { label: overdueDays(item.dueDate), detail: `Срок: ${fullDate(item.dueDate)}, до конца дня` };
    }
    case 'blocked': {
      // Срок у заблокированной задачи показываем в подсказке, только если он есть
      let detail = null;
      if (item.dueAt) detail = `Срок: ${dateTimeIn(Date.parse(item.dueAt), timeZone)}`;
      else if (item.dueDate) detail = `Срок: ${fullDate(item.dueDate)}`;
      return { label: 'Заблокировано', detail };
    }
    case 'due_today':
      if (item.dueAt) {
        const due = Date.parse(item.dueAt);
        return { label: `Сегодня · ${timeIn(due, timeZone)}`, detail: `Срок: ${dateTimeIn(due, timeZone)}` };
      }
      return { label: 'Сегодня', detail: `Срок: ${fullDate(item.dueDate)}, до конца дня` };
    default:
      return { label: '', detail: null };
  }
}

/** Отображаемая стадия проекта. Сохранённый статус не меняется: это только подпись. */
export function projectStage(card, timeZone, now = Date.now()) {
  if (card.lifecycle === 'archived') return { tone: 'planned', label: 'В архиве' };
  if (card.eventDate && isPastPrecise(card.eventDate, card.eventDatePrecision, timeZone, now)) {
    return { tone: 'done', label: 'Завершение проекта' };
  }
  return { tone: 'progress', label: 'В подготовке' };
}

/** «через ~4 мес.» — для дат с известным только месяцем (ТЗ 07, §1.1). */
export function relativeMonths(date, timeZone, now = Date.now()) {
  if (!date) return null;
  const today = localDate(now, timeZone);
  const [ty, tm] = today.split('-').map(Number);
  const [ey, em] = date.split('-').map(Number);
  const diff = (ey - ty) * 12 + (em - tm);
  if (diff < 0) return null;
  if (diff === 0) return 'в этом месяце';
  return `через ~${diff} ${pluralize(diff, 'месяц', 'месяца', 'месяцев')}`;
}

export function countWeddings(n) {
  return `${n} ${pluralize(n, 'свадьба', 'свадьбы', 'свадеб')}`;
}

const moneyFmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });

/** «50 000 ₽ RUB» — без символа валюты, если он не задан отдельным словарём (currencies.js). */
export function formatMoney(amount, currencyLabel) {
  return `${moneyFmt.format(amount)}${currencyLabel ? ` ${currencyLabel}` : ''}`;
}
