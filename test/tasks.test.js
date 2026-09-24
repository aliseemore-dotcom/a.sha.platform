// Критерии приёмки «Задачи мероприятия» (docs/specs/03-tasks.md, раздел 8) на уровне сервиса.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  listTasks, createTask, getTask, updateTask, completeTask, restoreTask, ServiceError,
} from '../server/tasks.js';
import { setup, NOON } from './helpers.js';

test('создание только с названием: todo без срока и ответственного', () => {
  const { event, ctx, owner } = setup();
  const e = event();
  const t = createTask(ctx(owner), e.id, { title: 'Согласовать меню', idempotencyKey: 'key-0001' });
  assert.equal(t.status, 'todo');
  assert.equal(t.dueAt, null);
  assert.equal(t.dueDate, null);
  assert.equal(t.assigneeId, null);
  assert.equal(t.isBlocked, false);
});

test('назначение ограничено участниками проекта', () => {
  const { event, ctx, owner, member, stranger } = setup();
  const e = event({ memberIds: [member.id] });
  const t = createTask(ctx(owner), e.id, { title: 'Задача', idempotencyKey: 'key-0002' });
  assert.throws(() => updateTask(ctx(owner), e.id, t.id, { assigneeId: stranger.id }),
    (err) => err instanceof ServiceError && err.status === 422 && Boolean(err.fields.assigneeId));
  const updated = updateTask(ctx(owner), e.id, t.id, { assigneeId: member.id });
  assert.equal(updated.assigneeId, member.id);
  assert.equal(updated.assigneeName, member.name);
});

test('in_progress с просроченным dueAt — одна строка внимания, счётчик учитывает один раз', () => {
  const { event, task, ctx, owner } = setup();
  const e = event();
  task(e.id, { status: 'in_progress', dueAt: '2026-09-01T00:00:00Z' });
  const res = listTasks(ctx(owner), e.id, {});
  assert.equal(res.items.filter((t) => t.attentionKind === 'overdue').length, 1);
});

test('waiting с followUpAt вчера и dueAt завтра: попадает в «Проверить ответ», не просрочена, не в глобальной срочности только из-за контроля', () => {
  const { event, task, ctx, owner } = setup();
  const e = event();
  const t = task(e.id, {
    status: 'waiting', waitingFrom: 'Флорист', followUpAt: '2026-09-22', dueDate: '2026-09-24',
  });
  const followup = listTasks(ctx(owner), e.id, { followup: '1' });
  assert.equal(followup.items.length, 1);
  assert.equal(followup.items[0].id, t.id);
  const full = listTasks(ctx(owner), e.id, {});
  assert.equal(full.items.find((x) => x.id === t.id).attentionKind, null);
});

test('та же ожидающая задача с dueAt вчера: просрочена по сроку, остаётся waiting, одна строка', () => {
  const { event, task, ctx, owner } = setup();
  const e = event();
  const t = task(e.id, { status: 'waiting', waitingFrom: 'Флорист', dueDate: '2026-09-01' });
  const res = listTasks(ctx(owner), e.id, {});
  assert.equal(res.items.filter((x) => x.id === t.id).length, 1);
  assert.equal(res.items.find((x) => x.id === t.id).attentionKind, 'overdue');
});

test('блокировка с причиной и сроком сегодня не дублирует задачу', () => {
  const { event, task, ctx, owner } = setup();
  const e = event();
  const t = task(e.id, { isBlocked: true, blockedReason: 'Нет бюджета', dueDate: '2026-09-23' });
  const res = listTasks(ctx(owner), e.id, {});
  assert.equal(res.items.filter((x) => x.id === t.id).length, 1);
  assert.equal(res.items.find((x) => x.id === t.id).attentionKind, 'blocked');
});

test('завершение убирает задачу из открытых, восстановление возвращает предыдущий статус', () => {
  const { event, task, ctx, owner } = setup();
  const e = event();
  const t = task(e.id, { status: 'in_progress', dueDate: '2026-09-01' });
  const done = completeTask(ctx(owner), e.id, t.id);
  assert.equal(done.status, 'done');
  assert.ok(done.completedAt);

  let openList = listTasks(ctx(owner), e.id, { tab: 'open' });
  assert.equal(openList.items.some((x) => x.id === t.id), false);
  let doneList = listTasks(ctx(owner), e.id, { tab: 'done' });
  assert.equal(doneList.items.some((x) => x.id === t.id), true);

  const restored = restoreTask(ctx(owner), e.id, t.id);
  assert.equal(restored.status, 'in_progress');
  openList = listTasks(ctx(owner), e.id, { tab: 'open' });
  assert.equal(openList.items.some((x) => x.id === t.id), true);
});

test('поиск/фильтры/сортировка ограничены текущим проектом', () => {
  const { event, task, ctx, owner } = setup();
  const a = event();
  const b = event();
  task(a.id, { title: 'Согласовать меню с рестораном' });
  task(b.id, { title: 'Согласовать меню с кейтерингом' });
  const res = listTasks(ctx(owner), a.id, { q: 'меню' });
  assert.equal(res.items.length, 1);
  assert.equal(res.items[0].title, 'Согласовать меню с рестораном');
});

test('date-only срок не просрочен в 00:00 начала дня', () => {
  const { event, task, ctx, owner } = setup();
  const e = event();
  const t = task(e.id, { status: 'todo', dueDate: '2026-09-23' });
  const res = listTasks(ctx(owner), e.id, {});
  assert.equal(res.items.find((x) => x.id === t.id).attentionKind, 'due_today');
});

test('двойное нажатие «Сохранить»: тот же idempotencyKey не создаёт вторую задачу', () => {
  const { event, ctx, owner } = setup();
  const e = event();
  const key = 'double-submit-key';
  const first = createTask(ctx(owner), e.id, { title: 'Забронировать площадку', idempotencyKey: key });
  const second = createTask(ctx(owner), e.id, { title: 'Забронировать площадку', idempotencyKey: key });
  assert.equal(first.id, second.id);
  const list = listTasks(ctx(owner), e.id, {});
  assert.equal(list.items.length, 1);
});

test('конкурентное изменение: expectedUpdatedAt не совпадает — конфликт, запись не затёрта', () => {
  const { event, task, ctx, owner } = setup();
  const e = event();
  const t = task(e.id, { title: 'Исходное название' });
  assert.throws(() => updateTask(ctx(owner), e.id, t.id, { title: 'Правка А', expectedUpdatedAt: '2000-01-01T00:00:00.000Z' }),
    (err) => err instanceof ServiceError && err.status === 409);
  const stillOriginal = getTask(ctx(owner), e.id, t.id);
  assert.equal(stillOriginal.title, 'Исходное название');
});

test('потеря доступа к проекту: чужая задача и чужой проект недоступны', () => {
  const { event, task, ctx, owner, stranger } = setup();
  const e = event();
  const t = task(e.id, { title: 'Секретная задача' });
  assert.throws(() => getTask(ctx(stranger), e.id, t.id), (err) => err.status === 404);
  assert.throws(() => listTasks(ctx(stranger), e.id, {}), (err) => err.status === 404);
});

test('архивный проект: список доступен, редактирование запрещено', () => {
  const { event, task, ctx, owner } = setup();
  const e = event({ lifecycle: 'archived' });
  const t = task(e.id, { title: 'Историческая задача' });
  const res = listTasks(ctx(owner), e.id, {});
  assert.equal(res.items.length, 1);
  assert.throws(() => updateTask(ctx(owner), e.id, t.id, { title: 'Новое название' }),
    (err) => err instanceof ServiceError && err.status === 409 && err.code === 'archived');
});

test('переход в waiting и обратно снимает адресата и контроль ожидания', () => {
  const { event, task, ctx, owner } = setup();
  const e = event();
  const t = task(e.id, {
    status: 'waiting', waitingFrom: 'Фотограф', followUpAt: '2026-10-01',
  });
  const updated = updateTask(ctx(owner), e.id, t.id, { status: 'in_progress' });
  assert.equal(updated.waitingFrom, null);
  assert.equal(updated.followUpAt, null);
});

test('переход в done снимает активную блокировку и ожидание, сохраняет предыдущий статус', () => {
  const { event, task, ctx, owner } = setup();
  const e = event();
  const t = task(e.id, { status: 'waiting', isBlocked: true, blockedReason: 'Ждём бюджет', waitingFrom: 'Пара' });
  const done = updateTask(ctx(owner), e.id, t.id, { status: 'done' });
  assert.equal(done.isBlocked, false);
  assert.equal(done.blockedReason, null);
  assert.equal(done.waitingFrom, null);
  const restored = restoreTask(ctx(owner), e.id, t.id);
  assert.equal(restored.status, 'waiting');
});
