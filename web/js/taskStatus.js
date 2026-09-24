// Общий словарь рабочих статусов задачи (тон компонента + слово) и закрытые статусы.
// Блокировка — отдельный признак задачи (`isBlocked`/`blockedReason`), не значение статуса:
// задача может быть одновременно «В работе» и заблокирована («Задачи мероприятия», раздел 2).

export const STATUS_WORD = {
  todo: ['planned', 'Не начато'],
  in_progress: ['progress', 'В работе'],
  waiting: ['soon', 'Ждём ответа'],
  done: ['done', 'Готово'],
  cancelled: ['planned', 'Отменено'],
};

export const CLOSED_STATUSES = new Set(['done', 'cancelled']);
export const OPEN_STATUSES = ['todo', 'in_progress', 'waiting'];

export const BLOCKED_CHIP = ['blocked', 'Заблокировано'];
