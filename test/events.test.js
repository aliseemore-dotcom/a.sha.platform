// Критерии приёмки экрана 01 (раздел 11) на уровне сервиса.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  listEvents, listAttention, createEvent, retryPlan, getEvent, archiveEvent, restoreEvent, ServiceError,
} from '../server/events.js';
import { completeTask } from '../server/tasks.js';
import { applyWeddingPlan } from '../server/plan.js';
import { setup, NOON } from './helpers.js';

test('1. три активные и одна архивная: верные счётчики, архив не смешивается', () => {
  const { event, ctx, owner } = setup();
  event({ title: 'А' }); event({ title: 'Б' }); event({ title: 'В' });
  event({ title: 'Г', lifecycle: 'archived' });
  const active = listEvents(ctx(owner));
  assert.equal(active.activeTotal, 3);
  assert.equal(active.archivedTotal, 1);
  assert.equal(active.items.length, 3);
  assert.ok(active.items.every((i) => i.lifecycle === 'active'));
  const archived = listEvents(ctx(owner), { lifecycle: 'archived' });
  assert.deepEqual(archived.items.map((i) => i.title), ['Г']);
});

test('2. просроченная и заблокированная из разных свадеб в общем блоке; urgentCount точный; done исчезает', () => {
  const { event, task, ctx, owner, store } = setup();
  const e1 = event({ title: 'Первая', eventDate: '2027-01-10' });
  const e2 = event({ title: 'Вторая', eventDate: '2027-02-10' });
  const overdue = task(e1.id, { title: 'Просрочена', status: 'in_progress', dueDate: '2026-09-20' });
  task(e1.id, { title: 'Сегодня', status: 'in_progress', dueDate: '2026-09-23' });
  task(e2.id, { title: 'Блок', isBlocked: true });
  task(e2.id, { title: 'Готово', status: 'done', dueDate: '2026-09-01' });

  let res = listEvents(ctx(owner));
  assert.equal(res.attentionTotal, 3);
  assert.deepEqual(res.attentionPreview.map((i) => [i.title, i.kind]),
    [['Просрочена', 'overdue'], ['Блок', 'blocked'], ['Сегодня', 'due_today']]);
  const byId = Object.fromEntries(res.items.map((i) => [i.id, i]));
  assert.equal(byId[e1.id].urgentCount, 2);
  assert.equal(byId[e2.id].urgentCount, 1);
  assert.equal(byId[e1.id].urgentPreview.title, 'Просрочена');

  store.updateTask(overdue.id, { status: 'done' });
  res = listEvents(ctx(owner));
  assert.equal(res.attentionTotal, 2);
  assert.equal(res.items.find((i) => i.id === e1.id).urgentCount, 1);
});

test('архивные проекты не дают сигналов внимания', () => {
  const { event, task, ctx, owner } = setup();
  const e = event({ lifecycle: 'archived' });
  task(e.id, { isBlocked: true });
  const res = listEvents(ctx(owner), { lifecycle: 'archived' });
  assert.equal(res.attentionTotal, 0);
  assert.equal(res.items[0].urgentCount, 0);
  assert.equal(res.items[0].urgentPreview, null);
});

test('«Сейчас в работе»: только in_progress вне внимания, максимум два, ближайший срок первым', () => {
  const { event, task, ctx, owner } = setup();
  const e = event();
  task(e.id, { title: 'Позже', status: 'in_progress', dueDate: '2026-10-20' });
  task(e.id, { title: 'Раньше', status: 'in_progress', dueDate: '2026-10-01' });
  task(e.id, { title: 'Без срока', status: 'in_progress' });
  task(e.id, { title: 'Срочная', status: 'in_progress', dueDate: '2026-09-23' });
  task(e.id, { title: 'План', status: 'todo' });
  const [card] = listEvents(ctx(owner)).items;
  assert.deepEqual(card.activePreview.map((t) => t.title), ['Раньше', 'Позже']);
});

test('5. две свадьбы с одинаковым названием различаются по id', () => {
  const { event, ctx, owner } = setup();
  const a = event({ title: 'Анна + Максим', eventDate: '2027-06-14' });
  const b = event({ title: 'Анна + Максим', locationName: 'Ресторан' });
  const res = listEvents(ctx(owner), { q: 'анна' });
  assert.deepEqual(res.items.map((i) => i.id), [a.id, b.id]);
  assert.equal(getEvent(ctx(owner), b.id).event.locationName, 'Ресторан');
});

test('6. поиск и сортировка по всему набору, пагинация по 20', () => {
  const { event, ctx, owner } = setup();
  for (let i = 0; i < 50; i++) {
    event({ id: `evt_${String(i).padStart(2, '0')}`, title: `Пара ${i}`, eventDate: `2027-01-${String((i % 28) + 1).padStart(2, '0')}` });
  }
  event({ id: 'evt_zz', title: 'Ёлка + Сергей', eventDate: '2028-12-31', locationName: 'Усадьба' });

  const first = listEvents(ctx(owner));
  assert.equal(first.items.length, 20);
  assert.equal(first.total, 51);
  assert.ok(first.nextCursor);
  assert.ok(!first.items.some((i) => i.id === 'evt_zz'), 'последний по дате не на первой странице');

  const found = listEvents(ctx(owner), { q: 'елка' });
  assert.deepEqual(found.items.map((i) => i.id), ['evt_zz']);
  assert.equal(found.activeTotal, 51, 'счётчик вкладки не зависит от поиска');
  assert.equal(listEvents(ctx(owner), { q: 'УСАДЬБА' }).items.length, 1);

  const all = [];
  let cursor;
  do {
    const page = listEvents(ctx(owner), { cursor });
    all.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(all.length, 51);
  assert.equal(new Set(all.map((i) => i.id)).size, 51);
});

test('6. «По дате»: будущие по возрастанию, затем прошедшие, затем без даты; «По вниманию»: urgentCount', () => {
  const { event, task, ctx, owner } = setup();
  const noDateB = event({ title: 'Б без даты' });
  const noDateA = event({ title: 'А без даты' });
  const late = event({ title: 'Поздняя', eventDate: '2027-08-01' });
  const soon = event({ title: 'Скоро', eventDate: '2026-10-01' });
  const today = event({ title: 'Сегодня', eventDate: '2026-09-23' });
  const pastOld = event({ title: 'Давняя', eventDate: '2026-06-01' });
  const pastNew = event({ title: 'Недавняя', eventDate: '2026-09-13' });
  task(late.id, { isBlocked: true });
  task(late.id, { isBlocked: true });
  task(noDateB.id, { isBlocked: true });

  const res = listEvents(ctx(owner));
  assert.equal(res.sort, 'date');
  assert.deepEqual(res.items.map((i) => i.id),
    [today.id, soon.id, late.id, pastNew.id, pastOld.id, noDateA.id, noDateB.id]);
  assert.deepEqual(listEvents(ctx(owner), { sort: 'attention' }).items.map((i) => i.id),
    [late.id, noDateB.id, today.id, soon.id, pastNew.id, pastOld.id, noDateA.id]);
});

test('архив: по дате события, сначала поздние, параметр sort игнорируется', () => {
  const { event, ctx, owner } = setup();
  const a = event({ title: 'А', eventDate: '2025-01-01', lifecycle: 'archived' });
  const b = event({ title: 'Б', eventDate: '2026-01-01', lifecycle: 'archived' });
  const c = event({ title: 'В', lifecycle: 'archived' });
  const res = listEvents(ctx(owner), { lifecycle: 'archived', sort: 'attention' });
  assert.equal(res.sort, 'date_desc');
  assert.deepEqual(res.items.map((i) => i.id), [b.id, a.id, c.id]);
});

test('4, 9. заблокированная просроченная задача считается один раз; после выполнения счётчики согласованы', () => {
  const { event, task, ctx, owner } = setup();
  const e = event({ title: 'Пара' });
  const t = task(e.id, { isBlocked: true, dueDate: '2026-09-01', blockedReason: 'Нет бюджета' });
  task(e.id, { status: 'in_progress', dueDate: '2026-09-23' });
  let res = listEvents(ctx(owner));
  assert.equal(res.attentionTotal, 2);
  assert.equal(res.attentionPreview.filter((i) => i.id === t.id).length, 1);
  assert.equal(res.attentionPreview[0].kind, 'blocked');
  assert.equal(res.items[0].urgentCount, 2);

  const done = completeTask(ctx(owner), e.id, t.id);
  assert.equal(done.status, 'done');
  res = listEvents(ctx(owner));
  assert.equal(res.attentionTotal, 1);
  assert.equal(res.items[0].urgentCount, 1);
  assert.equal(res.items[0].urgentPreview.kind, 'due_today');
});

test('5. задача открывается по прямому маршруту; чужая задача и чужой проект недоступны', () => {
  const { event, task, ctx, owner, member, store } = setup();
  const e = event();
  const other = event();
  const t = task(e.id, { isBlocked: true, assigneeId: owner.id, blockedReason: 'Ждём договор' });
  const [item] = listEvents(ctx(owner)).attentionPreview;
  assert.equal(item.targetUrl, `/events/${e.id}/tasks/${t.id}`);
  const detail = getEvent(ctx(owner), e.id).tasks.find((x) => x.id === t.id);
  assert.equal(detail.blockedReason, 'Ждём договор');
  assert.equal(detail.assigneeName, 'Елена');
  assert.throws(() => completeTask(ctx(owner), other.id, t.id), (err) => err.status === 404);
  assert.throws(() => completeTask(ctx(member), e.id, t.id), (err) => err.status === 404);
  assert.equal(store.getTask(t.id).isBlocked, true);
});

test('7. создание без даты; ошибка без названия; повтор с тем же ключом не создаёт дубль', () => {
  const { ctx, owner, store } = setup();
  const created = createEvent(ctx(owner), { title: '  Анна + Максим  ', eventDate: null, locationName: '', idempotencyKey: 'key-00000001' });
  assert.equal(created.planStatus, 'ready');
  const ev = store.getEvent(created.eventId);
  assert.equal(ev.title, 'Анна + Максим');
  assert.equal(ev.eventDate, null);
  assert.equal(ev.locationName, null);
  assert.equal(ev.lifecycle, 'active');

  const again = createEvent(ctx(owner), { title: 'Анна + Максим', idempotencyKey: 'key-00000001' });
  assert.equal(again.eventId, created.eventId);
  assert.equal(listEvents(ctx(owner)).activeTotal, 1);

  assert.throws(() => createEvent(ctx(owner), { title: '   ', idempotencyKey: 'key-00000002' }),
    (e) => e instanceof ServiceError && e.status === 422 && e.fields.title === 'Укажите название проекта');
  assert.throws(() => createEvent(ctx(owner), { title: 'x'.repeat(101), idempotencyKey: 'key-00000003' }),
    (e) => e.fields.title === 'Не более 100 символов');
  assert.throws(() => createEvent(ctx(owner), { title: 'Ок', locationName: 'м'.repeat(151), idempotencyKey: 'key-00000004' }),
    (e) => e.fields.locationName === 'Не более 150 символов');
});

test('план wedding_v1: 12 задач без даты свадьбы, 11 с датой; все planned без срока и ответственного', () => {
  const { ctx, owner } = setup();
  const noDate = createEvent(ctx(owner), { title: 'А', idempotencyKey: 'key-plan-0001' });
  const withDate = createEvent(ctx(owner), { title: 'Б', eventDate: '2027-06-14', idempotencyKey: 'key-plan-0002' });
  const t1 = getEvent(ctx(owner), noDate.eventId).tasks;
  const t2 = getEvent(ctx(owner), withDate.eventId).tasks;
  assert.equal(t1.length, 12);
  assert.equal(t2.length, 11);
  assert.ok(t1.some((t) => t.templateKey === 'wedding_v1:01'));
  assert.ok(!t2.some((t) => t.templateKey === 'wedding_v1:01'));
  assert.ok(t1.every((t) => t.status === 'todo'));
  // Стартовый план не создаёт сигналов внимания
  assert.equal(listEvents(ctx(owner)).attentionTotal, 0);
});

test('8. сбой плана не удаляет проект; повтор идемпотентен и не трогает правки', () => {
  const { ctx, owner, store } = setup();
  let calls = 0;
  const flaky = (s, event, now) => {
    calls++;
    // Первая попытка добавляет часть задач и падает
    const partial = { ...s, insertTask: s.insertTask };
    applyWeddingPlan({ ...partial, findTaskByTemplateKey: (id, key) => (key > 'wedding_v1:05' ? true : s.findTaskByTemplateKey(id, key)) }, event, now);
    throw new Error('boom');
  };
  const res = createEvent(ctx(owner), { title: 'Сбой', idempotencyKey: 'key-fail-0001' }, { applyPlan: flaky });
  assert.equal(res.planStatus, 'failed');
  assert.equal(calls, 1);
  assert.ok(store.getEvent(res.eventId), 'проект сохранён');
  const before = getEvent(ctx(owner), res.eventId).tasks;
  assert.equal(before.length, 5);

  const edited = before.find((t) => t.templateKey === 'wedding_v1:02');
  store.updateTask(edited.id, { title: 'Бриф — своя формулировка', status: 'in_progress' });

  assert.equal(retryPlan(ctx(owner), res.eventId).planStatus, 'ready');
  assert.equal(retryPlan(ctx(owner), res.eventId).planStatus, 'ready');
  const after = getEvent(ctx(owner), res.eventId).tasks;
  assert.equal(after.length, 12);
  assert.equal(new Set(after.map((t) => t.templateKey)).size, 12);
  assert.equal(store.getTask(edited.id).title, 'Бриф — своя формулировка');
});

test('9. доступ: участник видит только свои проекты; чужое пространство недоступно и через прямой запрос', () => {
  const { event, task, ctx, owner, member, stranger, store } = setup();
  const mine = event({ title: 'Моя', memberIds: [member.id] });
  const hidden = event({ title: 'Скрытая' });
  task(hidden.id, { isBlocked: true });
  store.insertEvent({ ...hidden, id: 'evt_foreign', workspaceId: 'ws2', title: 'Чужая' });

  assert.deepEqual(listEvents(ctx(member)).items.map((i) => i.id), [mine.id]);
  assert.equal(listEvents(ctx(member)).attentionTotal, 0, 'внимание — только по доступным проектам');
  assert.equal(listEvents(ctx(owner)).items.length, 2);
  assert.deepEqual(listEvents(ctx(stranger)).items.map((i) => i.id), ['evt_foreign']);

  assert.throws(() => getEvent(ctx(member), hidden.id), (e) => e.status === 404);
  assert.throws(() => getEvent(ctx(stranger), mine.id), (e) => e.status === 404);
  assert.throws(() => archiveEvent(ctx(stranger), mine.id), (e) => e.status === 404);
});

test('создавать может owner и участник с event:create; остальным — 403', () => {
  const { ctx, member, creator } = setup();
  assert.throws(() => createEvent(ctx(member), { title: 'А', idempotencyKey: 'key-perm-0001' }), (e) => e.status === 403);
  const res = createEvent(ctx(creator), { title: 'А', idempotencyKey: 'key-perm-0002' });
  assert.deepEqual(listEvents(ctx(creator)).items.map((i) => i.id), [res.eventId], 'создатель видит свой проект');
});

test('архив и восстановление меняют вкладку и счётчики', () => {
  const { event, ctx, owner } = setup();
  const e = event();
  archiveEvent(ctx(owner), e.id);
  assert.equal(listEvents(ctx(owner)).archivedTotal, 1);
  restoreEvent(ctx(owner), e.id);
  assert.equal(listEvents(ctx(owner)).activeTotal, 1);
});

test('догрузка внимания курсором: первые 5 в списке, дальше страницы по 20', () => {
  const { event, task, ctx, owner } = setup();
  const e = event();
  for (let i = 0; i < 30; i++) task(e.id, { id: `task_${String(i).padStart(2, '0')}`, isBlocked: true });
  const res = listEvents(ctx(owner));
  assert.equal(res.attentionPreview.length, 5);
  assert.equal(res.attentionTotal, 30);
  const p2 = listAttention(ctx(owner), { cursor: res.attentionNextCursor, limit: 20 });
  assert.equal(p2.items.length, 20);
  assert.equal(p2.items[0].id, 'task_05');
  const p3 = listAttention(ctx(owner), { cursor: p2.nextCursor, limit: 20 });
  assert.equal(p3.items.length, 5);
  assert.equal(p3.nextCursor, null);
});

test('refreshAt приходит в ответе', () => {
  const { ctx, owner } = setup();
  const res = listEvents(ctx(owner, NOON));
  assert.equal(res.refreshAt, '2026-09-23T21:00:00.000Z');
});
