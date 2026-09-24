// Общий словарь статусов задачи (тон компонента + слово) и закрытые статусы —
// используется обзором проекта и списком «Все задачи», чтобы не разойтись в формулировках.

export const STATUS_WORD = {
  planned: ['planned', 'Запланировано'],
  in_progress: ['progress', 'В работе'],
  waiting: ['soon', 'Ждём ответа'],
  blocked: ['blocked', 'Заблокировано'],
  done: ['done', 'Готово'],
  cancelled: ['planned', 'Отменено'],
};

export const CLOSED_STATUSES = new Set(['done', 'cancelled']);
