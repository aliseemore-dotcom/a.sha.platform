// Критерии приёмки панели «Добавить задачи» (докс/spec «Выбор задач свадьбы» — см. историю чата).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getChecklist, addChecklistItems, TASK_CHECKLIST } from '../server/checklist.js';
import { getEvent } from '../server/events.js';
import { ServiceError } from '../server/errors.js';
import { setup } from './helpers.js';

test('до выбора ничего не сохраняется: GET не создаёт задач', () => {
  const { event, ctx, owner } = setup();
  const e = event();
  getChecklist(ctx(owner), e.id);
  getChecklist(ctx(owner), e.id);
  const res = addChecklistItems(ctx(owner), e.id, { items: [], idempotencyKey: 'noop-key-0001' });
  assert.equal(res.added, 0);
});

test('добавление трёх задач: появляются с правильными разделами и статусом todo без ответственного', () => {
  const { event, ctx, owner } = setup();
  const e = event({ eventDate: null });
  const picked = TASK_CHECKLIST.slice(0, 3).map((i) => ({ key: i.key }));
  const res = addChecklistItems(ctx(owner), e.id, { items: picked, idempotencyKey: 'pick-key-0001' });
  assert.equal(res.added, 3);
  assert.ok(res.tasks.every((t) => t.status === 'todo' && t.assigneeId === null));
  assert.deepEqual(res.tasks.map((t) => t.section), TASK_CHECKLIST.slice(0, 3).map((i) => i.section));
});

test('повторное открытие панели и повторный клик не создают копии', () => {
  const { event, ctx, owner } = setup();
  const e = event();
  const items = [{ key: 'start-brief' }, { key: 'venue-shortlist' }];
  const first = addChecklistItems(ctx(owner), e.id, { items, idempotencyKey: 'dup-key-0001' });
  assert.equal(first.added, 2);
  // Повторный вызов с другим idempotencyKey, но теми же пунктами — уже добавленные молча пропускаются.
  const second = addChecklistItems(ctx(owner), e.id, { items, idempotencyKey: 'dup-key-0002' });
  assert.equal(second.added, 0);
  const status = getChecklist(ctx(owner), e.id);
  assert.equal(status.items.filter((i) => i.added).length, 2);
});

test('двойное нажатие «Добавить N задач»: тот же idempotencyKey возвращает тот же результат без дубля', () => {
  const { event, ctx, owner } = setup();
  const e = event();
  const items = [{ key: 'start-brief' }];
  const key = 'same-key-0001';
  const first = addChecklistItems(ctx(owner), e.id, { items, idempotencyKey: key });
  const second = addChecklistItems(ctx(owner), e.id, { items, idempotencyKey: key });
  assert.deepEqual(first.tasks.map((t) => t.id), second.tasks.map((t) => t.id));
  const status = getChecklist(ctx(owner), e.id);
  assert.equal(status.items.filter((i) => i.added).length, 1);
});

test('без даты свадьбы задачи добавляются без срока', () => {
  const { event, ctx, owner } = setup();
  const e = event({ eventDate: null });
  const status = getChecklist(ctx(owner), e.id);
  assert.ok(status.items.every((i) => i.suggestedDueDate === null));
  const res = addChecklistItems(ctx(owner), e.id, { items: [{ key: 'day-menu' }], idempotencyKey: 'no-date-key' });
  assert.equal(res.tasks[0].dueDate, null);
});

test('с датой свадьбы в будущем — предложенный срок не позже даты свадьбы', () => {
  const { event, ctx, owner } = setup();
  const e = event({ eventDate: '2026-10-03' }); // NOON = 23 сентября 2026, ~10 дней вперёд
  const status = getChecklist(ctx(owner), e.id);
  for (const item of status.items) {
    if (item.suggestedDueDate) assert.ok(item.suggestedDueDate <= '2026-10-03');
  }
});

test('дата свадьбы уже прошла — автоматических сроков нет', () => {
  const { event, ctx, owner } = setup();
  const e = event({ eventDate: '2026-01-01' });
  const status = getChecklist(ctx(owner), e.id);
  assert.ok(status.items.every((i) => i.suggestedDueDate === null));
});

test('организатор может поменять или убрать предложенный срок перед сохранением', () => {
  const { event, ctx, owner } = setup();
  const e = event({ eventDate: '2026-12-25' });
  const res = addChecklistItems(ctx(owner), e.id, {
    items: [{ key: 'start-brief', dueDate: '2026-11-01' }, { key: 'start-format', dueDate: null }],
    idempotencyKey: 'edit-key-0001',
  });
  assert.equal(res.tasks[0].dueDate, '2026-11-01');
  assert.equal(res.tasks[1].dueDate, null);
});

test('доступ к чужому проекту закрыт', () => {
  const { event, ctx, owner, stranger } = setup();
  const e = event();
  assert.throws(() => getChecklist(ctx(stranger), e.id), (err) => err instanceof ServiceError && err.status === 404);
  assert.throws(() => addChecklistItems(ctx(stranger), e.id, { items: [{ key: 'start-brief' }], idempotencyKey: 'foreign-key-01' }),
    (err) => err instanceof ServiceError && err.status === 404);
});

test('архивный проект — только чтение, добавление запрещено', () => {
  const { event, ctx, owner } = setup();
  const e = event({ lifecycle: 'archived' });
  const status = getChecklist(ctx(owner), e.id);
  assert.equal(status.canEdit, false);
  assert.throws(() => addChecklistItems(ctx(owner), e.id, { items: [{ key: 'start-brief' }], idempotencyKey: 'archived-key-01' }),
    (err) => err instanceof ServiceError && err.status === 409);
});

test('существующие задачи проекта не удаляются и не перезаписываются', () => {
  const { event, task, ctx, owner } = setup();
  const e = event();
  const manual = task(e.id, { title: 'Своя задача', status: 'in_progress' });
  addChecklistItems(ctx(owner), e.id, { items: [{ key: 'start-brief' }], idempotencyKey: 'keep-key-0001' });
  const tasks = getEvent(ctx(owner), e.id).tasks;
  assert.equal(tasks.length, 2);
  const kept = tasks.find((t) => t.id === manual.id);
  assert.equal(kept.title, 'Своя задача');
  assert.equal(kept.status, 'in_progress');
});

// ---------- подписи срока согласуются с фактической датой (ТЗ 09, §3.2) ----------

test('подпись правила пересчитывается из назначенной даты, а не хранится статично', () => {
  const { event, ctx, owner } = setup();
  // NOON = 23 сентября 2026 — свадьба через 120 дней запускает сжатие для «Подобрать площадки»
  // (300 дней «идеального» срока), назначенная дата окажется намного ближе, чем 300 дней.
  const e = event({ eventDate: '2027-01-21' });
  const { items } = getChecklist(ctx(owner), e.id);
  const venue = items.find((i) => i.key === 'venue-shortlist');
  assert.ok(venue.suggestedDueDate);
  const daysBeforeWedding = Math.round((Date.parse(e.eventDate) - Date.parse(venue.suggestedDueDate)) / 86400000);
  assert.ok(daysBeforeWedding < 300, 'срок должен быть сжат, иначе тест не проверяет нужный случай');
  // Подпись не должна утверждать «10 мес.», если реальный срок — около 3-4 месяцев.
  assert.ok(!venue.ruleLabel.includes('10 мес'), `подпись должна согласовываться с датой: ${venue.ruleLabel}`);
});

test('без даты свадьбы подписи правил отсутствуют (как и сами сроки)', () => {
  const { event, ctx, owner } = setup();
  const e = event({ eventDate: null });
  const { items } = getChecklist(ctx(owner), e.id);
  assert.ok(items.every((i) => i.ruleLabel === null));
});
