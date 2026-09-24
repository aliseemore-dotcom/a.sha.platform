// Стартовый план wedding_v1 (спецификация экрана 01, раздел 5).
// Все задачи — todo, без ответственного и без срока: сроки по дате свадьбы не выдумываем.

import { blankTaskFields } from './tasks.js';

export const WEDDING_V1 = [
  { key: '01', section: 'Основное', title: 'Уточнить дату свадьбы', onlyWithoutDate: true },
  { key: '02', section: 'Основное', title: 'Заполнить бриф пары' },
  { key: '03', section: 'Основное', title: 'Согласовать формат и приоритеты свадьбы' },
  { key: '04', section: 'Финансы', title: 'Определить ориентир бюджета' },
  { key: '05', section: 'Площадка', title: 'Составить короткий список площадок' },
  { key: '06', section: 'Площадка', title: 'Подтвердить площадку и договорённости' },
  { key: '07', section: 'Подрядчики', title: 'Определить необходимые роли подрядчиков' },
  { key: '08', section: 'Подрядчики', title: 'Согласовать выбранных подрядчиков' },
  { key: '09', section: 'Гости', title: 'Собрать предварительный список гостей' },
  { key: '10', section: 'Логистика', title: 'Зафиксировать потребности по размещению и трансферу' },
  { key: '11', section: 'День свадьбы', title: 'Подготовить черновой тайминг' },
  { key: '12', section: 'Финал', title: 'Подтвердить финальные договорённости с участниками' },
];

/**
 * Идемпотентно добавляет недостающие задачи плана. Уникальность — пара (eventId, templateKey);
 * существующие задачи и их пользовательские правки не трогаются.
 * @returns {number} сколько задач добавлено
 */
export function applyWeddingPlan(store, event, nowIso) {
  let added = 0;
  for (const item of WEDDING_V1) {
    if (item.onlyWithoutDate && event.eventDate) continue;
    const templateKey = `wedding_v1:${item.key}`;
    if (store.findTaskByTemplateKey(event.id, templateKey)) continue;
    store.insertTask({
      id: store.newId('task'),
      eventId: event.id,
      templateKey,
      section: item.section,
      title: item.title,
      status: 'todo',
      ...blankTaskFields(),
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    added++;
  }
  return added;
}
