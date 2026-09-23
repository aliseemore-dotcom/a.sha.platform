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

export function dateTimeIn(ms, timeZone) {
  return fmt(`dt|${timeZone}`, {
    day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone, timeZoneName: 'short',
  }).format(new Date(ms));
}

/** «через 34 дня», «сегодня», «завтра»; для прошедших дат — null (отрицательный отсчёт не показываем). */
export function relativeDay(date, timeZone, now = Date.now()) {
  const diff = daysBetween(localDate(now, timeZone), date);
  if (diff < 0) return null;
  if (diff === 0) return 'сегодня';
  if (diff === 1) return 'завтра';
  return `через ${diff} ${pluralize(diff, 'день', 'дня', 'дней')}`;
}

export function isPast(date, timeZone, now = Date.now()) {
  return date < localDate(now, timeZone);
}

/**
 * Текст метки срочности и полная подпись для title/aria.
 * @returns {{ label: string, detail: string | null }}
 */
export function attentionLabel(item, timeZone, now = Date.now()) {
  switch (item.kind) {
    case 'overdue': {
      if (item.dueAt) {
        const due = Date.parse(item.dueAt);
        const mins = Math.max(1, Math.floor((now - due) / 60000));
        let label;
        if (mins < 60) label = `Просрочено на ${mins} мин`;
        else if (mins < 60 * 24) {
          const hrs = Math.floor(mins / 60);
          label = `Просрочено на ${hrs} ч`;
        } else {
          const days = Math.floor(mins / (60 * 24));
          label = `Просрочено ${days} ${pluralize(days, 'день', 'дня', 'дней')}`;
        }
        return { label, detail: `Срок: ${dateTimeIn(due, timeZone)}` };
      }
      const days = Math.max(1, daysBetween(item.dueDate, localDate(now, timeZone)));
      return {
        label: `Просрочено ${days} ${pluralize(days, 'день', 'дня', 'дней')}`,
        detail: `Срок: ${fullDate(item.dueDate)}`,
      };
    }
    case 'blocked':
      return { label: 'Заблокировано', detail: null };
    case 'due_today':
      if (item.dueAt) {
        const due = Date.parse(item.dueAt);
        return { label: `Сегодня · ${timeIn(due, timeZone)}`, detail: `Срок: ${dateTimeIn(due, timeZone)}` };
      }
      return { label: 'Сегодня', detail: `Срок: ${fullDate(item.dueDate)}, в течение дня` };
    case 'follow_up_due':
      return {
        label: 'Нужно напомнить',
        detail: item.followUpAt ? `Повторный контакт: ${fullDate(item.followUpAt.slice(0, 10))}` : null,
      };
    default:
      return { label: '', detail: null };
  }
}

export function countWeddings(n) {
  return `${n} ${pluralize(n, 'свадьба', 'свадьбы', 'свадеб')}`;
}
