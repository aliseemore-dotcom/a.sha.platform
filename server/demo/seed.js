// ДЕМОНСТРАЦИОННЫЕ ДАННЫЕ ТЕСТОВОГО СТЕНДА.
// Загружаются только при DEMO=1. Имена и проекты вымышлены; в продукт не переносить.
// Сроки считаются от момента запуска, чтобы на стенде всегда были видны все состояния.

import { localDate, startOfLocalDay, addDays } from '../time.js';

export const DEMO_TIME_ZONE = 'Europe/Moscow';

export function seedDemo(store, now = Date.now()) {
  const tz = DEMO_TIME_ZONE;
  const today = localDate(now, tz);
  const day = (n) => addDays(today, n);
  const iso = (ms) => new Date(ms).toISOString();
  const dayStart = startOfLocalDay(today, tz);
  const laterToday = Math.min(now + 2 * 3600_000, dayStart + (23 * 60 + 45) * 60_000);
  const nowIso = iso(now);

  store.insertWorkspace({ id: 'ws_demo', name: 'Тестовое агентство', timeZone: null });
  store.insertWorkspace({ id: 'ws_other', name: 'Другое агентство', timeZone: null });

  const users = [
    { id: 'usr_elena', name: 'Елена', role: 'owner', workspaceId: 'ws_demo', permissions: [],
      note: 'Владелец пространства: видит все проекты, может создавать' },
    { id: 'usr_olga', name: 'Ольга', role: 'member', workspaceId: 'ws_demo', permissions: [],
      note: 'Участник: видит два проекта, создавать не может' },
    { id: 'usr_ivan', name: 'Иван', role: 'member', workspaceId: 'ws_demo', permissions: ['event:create'],
      note: 'Участник с правом event:create, без проектов' },
    { id: 'usr_other', name: 'Сергей', role: 'owner', workspaceId: 'ws_other', permissions: [],
      note: 'Владелец другого пространства: чужие проекты не видит' },
  ];
  users.forEach((u) => store.insertUser(u));

  const ev = (id, title, eventDate, locationName, extra = {}) => store.insertEvent({
    id, workspaceId: 'ws_demo', title, kind: 'wedding', eventDate, locationName,
    lifecycle: 'active', coverUrl: null, memberIds: [], planStatus: 'ready',
    createdAt: nowIso, updatedAt: nowIso, createdBy: 'usr_elena', ...extra,
  });

  let n = 0;
  const task = (eventId, title, status, extra = {}) => store.insertTask({
    id: `task_demo_${String(++n).padStart(2, '0')}`, eventId, title, status,
    dueAt: null, dueDate: null, followUpAt: null, assigneeId: null,
    createdAt: nowIso, updatedAt: iso(now - n * 60_000), ...extra,
  });

  ev('evt_demo_anna_maxim', 'Анна + Максим', day(264), 'Загородная площадка «Лес»',
    { memberIds: ['usr_olga'], createdAt: iso(now - 9 * 86400_000) });
  task('evt_demo_anna_maxim', 'Подписать договор с площадкой', 'in_progress',
    { dueAt: iso(laterToday), assigneeId: 'usr_elena' });
  task('evt_demo_anna_maxim', 'Согласовать меню', 'in_progress', { dueDate: day(21) });
  task('evt_demo_anna_maxim', 'Подбор ведущего', 'in_progress');
  task('evt_demo_anna_maxim', 'Собрать предварительный список гостей', 'planned');

  ev('evt_demo_maria_ilya', 'Мария + Илья', day(40), 'Усадьба «Белые ночи»',
    { memberIds: ['usr_olga'], createdAt: iso(now - 30 * 86400_000) });
  task('evt_demo_maria_ilya', 'Отправить подрядчикам финальный тайминг', 'in_progress',
    { dueDate: day(-2), assigneeId: 'usr_olga' });
  task('evt_demo_maria_ilya', 'Согласовать смету с флористом', 'waiting',
    { dueAt: iso(now - 3 * 3600_000), followUpAt: day(-1), assigneeId: 'usr_elena' });
  task('evt_demo_maria_ilya', 'Утвердить декор зала', 'blocked', {
    dueDate: day(-1), assigneeId: 'usr_olga', blockedReason: 'Пара ещё не утвердила бюджет на декор',
  });
  task('evt_demo_maria_ilya', 'Рассадка гостей', 'in_progress', { dueDate: day(10) });
  task('evt_demo_maria_ilya', 'Подтвердить трансфер гостей', 'done', { dueDate: day(-5) });

  ev('evt_demo_anna_maxim_2', 'Анна + Максим', null, 'Ресторан «Сад»',
    { createdAt: iso(now - 2 * 86400_000) });
  task('evt_demo_anna_maxim_2', 'Получить ответ от фотографа', 'waiting', { followUpAt: day(0) });
  task('evt_demo_anna_maxim_2', 'Получить ответ от кейтеринга', 'waiting', { followUpAt: day(3) });
  task('evt_demo_anna_maxim_2', 'Уточнить дату свадьбы', 'planned', { templateKey: 'wedding_v1:01' });

  ev('evt_demo_alina_roman', 'Алина + Роман', day(75), 'Отель «Причал»',
    { createdAt: iso(now - 14 * 86400_000) });
  task('evt_demo_alina_roman', 'Выбрать ведущего', 'blocked', {
    blockedReason: 'Пара не определилась с форматом вечера',
  });
  task('evt_demo_alina_roman', 'Отправить паре варианты приглашений', 'in_progress', { dueDate: day(0) });
  task('evt_demo_alina_roman', 'Согласовать фотографа', 'in_progress', { dueDate: day(6) });
  task('evt_demo_alina_roman', 'Отправить райдер ведущему', 'in_progress', { dueDate: day(1) });

  ev('evt_demo_ksenia_dmitry', 'Ксения + Дмитрий', day(-10), null,
    { createdAt: iso(now - 120 * 86400_000) });
  task('evt_demo_ksenia_dmitry', 'Собрать отзывы подрядчиков', 'in_progress');

  ev('evt_demo_ekaterina_pavel', 'Екатерина + Павел', day(120), 'Пространство «Винзавод»',
    { createdAt: iso(now - 1 * 86400_000) });
  task('evt_demo_ekaterina_pavel', 'Заполнить бриф пары', 'planned');

  ev('evt_demo_sofia_artem', 'Софья + Артём', day(-200), 'Шато «Ле Грант»',
    { lifecycle: 'archived', createdAt: iso(now - 400 * 86400_000) });
  task('evt_demo_sofia_artem', 'Закрыть расчёты с подрядчиками', 'in_progress', { dueDate: day(-190) });

  store.insertEvent({
    id: 'evt_demo_other', workspaceId: 'ws_other', title: 'Виктория + Олег', kind: 'wedding',
    eventDate: day(90), locationName: 'Чужая площадка', lifecycle: 'active', coverUrl: null,
    memberIds: [], planStatus: 'ready', createdAt: nowIso, updatedAt: nowIso, createdBy: 'usr_other',
  });
  store.insertTask({
    id: 'task_demo_other', eventId: 'evt_demo_other', title: 'Чужая срочная задача', status: 'blocked',
    dueAt: null, dueDate: null, followUpAt: null, assigneeId: 'usr_other', createdAt: nowIso, updatedAt: nowIso,
  });

  return { users };
}
