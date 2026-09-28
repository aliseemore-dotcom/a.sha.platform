// Критерии приёмки «Упакованная свадьба и быстрая ориентация», часть I (docs/specs/07-wedding-setup.md).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createEvent, getEvent, updateEvent, listEvents, computeSetupSteps, ServiceError,
} from '../server/events.js';
import {
  computeChecklistDueDates, applyChecklistPlan, rescheduleTasks, TASK_CHECKLIST,
} from '../server/checklist.js';
import { addEventVendors } from '../server/eventVendors.js';
import { createVendor } from '../server/vendors.js';
import { addManualLine } from '../server/budget.js';
import { setup, NOON, TZ } from './helpers.js';

// ---------- сроки стартового плана (раздел 3) ----------

test('без даты свадьбы — срока нет ни у одной задачи', () => {
  const dates = computeChecklistDueDates(null, '2026-09-23');
  assert.ok([...dates.values()].every((v) => v === null));
});

test('дата свадьбы в прошлом — срока нет', () => {
  const dates = computeChecklistDueDates('2026-09-01', '2026-09-23');
  assert.ok([...dates.values()].every((v) => v === null));
});

test('обычный срок подготовки: «Заполнить бриф пары» через 7 дней, порядок и подписи по таблице', () => {
  const today = '2026-09-23';
  const dates = computeChecklistDueDates('2027-09-23', today);
  assert.equal(dates.get('start-brief'), '2026-09-30');
  assert.equal(dates.get('start-format'), '2026-10-07');
  assert.equal(dates.get('start-budget'), '2026-10-07');
  // Порядок сохраняется: каждый следующий пункт из таблицы не раньше предыдущего.
  const order = TASK_CHECKLIST.map((i) => dates.get(i.key));
  for (let i = 1; i < order.length; i++) assert.ok(order[i] >= order[i - 1], `${TASK_CHECKLIST[i].key} раньше предыдущего`);
  assert.equal(order[order.length - 1] <= '2027-09-23', true);
});

test('короткий срок подготовки (60 дней): все сроки между сегодня и датой свадьбы, порядок сохранён', () => {
  const today = '2026-09-23';
  const eventDate = '2026-11-22'; // 60 дней
  const dates = computeChecklistDueDates(eventDate, today);
  for (const item of TASK_CHECKLIST) {
    const due = dates.get(item.key);
    assert.ok(due >= today, `${item.key}: ${due} раньше сегодня`);
    assert.ok(due <= eventDate, `${item.key}: ${due} позже свадьбы`);
  }
  const order = TASK_CHECKLIST.map((i) => dates.get(i.key));
  for (let i = 1; i < order.length; i++) assert.ok(order[i] >= order[i - 1]);
});

test('месяц известен — опорная дата первое число месяца', () => {
  const today = '2026-09-23';
  const dates = computeChecklistDueDates('2027-06-01', today);
  assert.ok(dates.get('day-final') <= '2027-06-01');
  assert.ok(dates.get('day-final') > today);
});

test('функция чистая: одинаковые входные данные дают одинаковые даты', () => {
  const a = computeChecklistDueDates('2027-01-15', '2026-09-23');
  const b = computeChecklistDueDates('2027-01-15', '2026-09-23');
  assert.deepEqual([...a.entries()], [...b.entries()]);
});

// ---------- стартовый план при создании (раздел 2.2) ----------

test('applyChecklistPlan создаёт 13 задач с dueDateSource=template и сроками по таблице', () => {
  const { event, ctx, owner, store } = setup();
  const e = event({ eventDate: '2027-09-23' });
  applyChecklistPlan(store, e, new Date(NOON).toISOString(), TZ);
  const tasks = getEvent(ctx(owner), e.id).tasks;
  assert.equal(tasks.length, 13);
  assert.ok(tasks.every((t) => t.status === 'todo' && t.dueDateSource === 'template'));
  const brief = tasks.find((t) => t.templateKey === 'checklist:start-brief');
  assert.equal(brief.dueDate, '2026-09-30');
});

test('createEvent с applyPlan: true применяет чек-лист; false — задач нет', () => {
  const { ctx, owner } = setup();
  const withPlan = createEvent(ctx(owner), {
    partner1Name: 'Анна', partner2Name: 'Максим', eventDate: '2027-09-23', eventDatePrecision: 'day',
    applyPlan: true, idempotencyKey: 'key-with-plan-01',
  });
  assert.equal(withPlan.planStatus, 'ready');
  assert.equal(getEvent(ctx(owner), withPlan.eventId).tasks.length, 13);

  const noPlan = createEvent(ctx(owner), {
    partner1Name: 'Анна', partner2Name: 'Максим', applyPlan: false, idempotencyKey: 'key-no-plan-01',
  });
  assert.equal(getEvent(ctx(owner), noPlan.eventId).tasks.length, 0);
});

test('повтор создания с тем же idempotencyKey не создаёт вторую свадьбу/план', () => {
  const { ctx, owner } = setup();
  const first = createEvent(ctx(owner), {
    partner1Name: 'Анна', partner2Name: 'Максим', eventDate: '2027-09-23', applyPlan: true, idempotencyKey: 'key-dup-01',
  });
  const second = createEvent(ctx(owner), {
    partner1Name: 'Анна', partner2Name: 'Максим', eventDate: '2027-09-23', applyPlan: true, idempotencyKey: 'key-dup-01',
  });
  assert.equal(first.eventId, second.eventId);
  assert.equal(listEvents(ctx(owner)).activeTotal, 1);
  assert.equal(getEvent(ctx(owner), first.eventId).tasks.length, 13);
});

// ---------- название и имена (разделы 1.1, 1.2) ----------

test('название собирается из имён, если не задано вручную', () => {
  const { ctx, owner } = setup();
  const res = createEvent(ctx(owner), { partner1Name: 'Анна', partner2Name: 'Максим', idempotencyKey: 'key-title-01' });
  const event = getEvent(ctx(owner), res.eventId).event;
  assert.equal(event.title, 'Анна + Максим');
  assert.equal(event.titleIsCustom, false);
});

test('одно имя — название из одного имени; ни имени, ни названия — ошибка', () => {
  const { ctx, owner } = setup();
  const res = createEvent(ctx(owner), { partner1Name: 'Анна', idempotencyKey: 'key-title-02' });
  assert.equal(getEvent(ctx(owner), res.eventId).event.title, 'Анна');
  assert.throws(() => createEvent(ctx(owner), { idempotencyKey: 'key-title-03' }),
    (e) => e instanceof ServiceError && e.status === 422 && Boolean(e.fields.title));
});

test('старый контракт: title без имён по-прежнему работает', () => {
  const { ctx, owner } = setup();
  const res = createEvent(ctx(owner), { title: 'Своя формулировка', idempotencyKey: 'key-legacy-01' });
  const event = getEvent(ctx(owner), res.eventId).event;
  assert.equal(event.title, 'Своя формулировка');
  assert.equal(event.titleIsCustom, true);
  assert.equal(event.partner1Name, null);
});

test('PATCH: смена имён пересобирает автоматическое название, кастомное — нет', () => {
  const { event, ctx, owner, store } = setup();
  const e = event({ partner1Name: 'Анна', partner2Name: 'Максим', title: 'Анна + Максим', titleIsCustom: false });
  const updated = updateEvent(ctx(owner), e.id, {
    partner2Name: 'Иван', expectedUpdatedAt: e.updatedAt,
  });
  assert.equal(updated.title, 'Анна + Иван');
  assert.equal(updated.titleIsCustom, false);

  const custom = updateEvent(ctx(owner), e.id, { title: 'Особенная свадьба', expectedUpdatedAt: updated.updatedAt });
  assert.equal(custom.title, 'Особенная свадьба');
  assert.equal(custom.titleIsCustom, true);

  const renamedAgain = updateEvent(ctx(owner), e.id, { partner1Name: 'Мария', expectedUpdatedAt: custom.updatedAt });
  assert.equal(renamedAgain.title, 'Особенная свадьба'); // кастомное название имена не трогают

  const backToAuto = updateEvent(ctx(owner), e.id, { titleIsCustom: false, expectedUpdatedAt: renamedAgain.updatedAt });
  assert.equal(backToAuto.title, 'Мария + Иван');
  assert.equal(backToAuto.titleIsCustom, false);
});

// ---------- PATCH: права, конфликт, архив ----------

test('PATCH требует expectedUpdatedAt и проверяет конфликт', () => {
  const { event, ctx, owner } = setup();
  const e = event();
  assert.throws(() => updateEvent(ctx(owner), e.id, { locationName: 'Новое место' }),
    (err) => err instanceof ServiceError && err.status === 400);
  assert.throws(() => updateEvent(ctx(owner), e.id, { locationName: 'Новое место', expectedUpdatedAt: '2000-01-01T00:00:00.000Z' }),
    (err) => err instanceof ServiceError && err.status === 409 && err.code === 'conflict');
  const ok = updateEvent(ctx(owner), e.id, { locationName: 'Новое место', expectedUpdatedAt: e.updatedAt });
  assert.equal(ok.locationName, 'Новое место');
});

test('PATCH доступен любому участнику с доступом к активной свадьбе; архив — только чтение', () => {
  const { event, ctx, owner, member, stranger } = setup();
  const e = event({ memberIds: [member.id] });
  const byMember = updateEvent(ctx(member), e.id, { locationName: 'От участника', expectedUpdatedAt: e.updatedAt });
  assert.equal(byMember.locationName, 'От участника');

  assert.throws(() => updateEvent(ctx(stranger), e.id, { locationName: 'x', expectedUpdatedAt: byMember.updatedAt }),
    (err) => err instanceof ServiceError && err.status === 404);

  const archived = event({ lifecycle: 'archived' });
  assert.throws(() => updateEvent(ctx(owner), archived.id, { locationName: 'x', expectedUpdatedAt: archived.updatedAt }),
    (err) => err instanceof ServiceError && err.status === 409 && err.code === 'archived');
});

test('PATCH: валидация гостей, бюджета и контактов', () => {
  const { event, ctx, owner } = setup();
  const e = event();
  assert.throws(() => updateEvent(ctx(owner), e.id, { guestsCount: 0, expectedUpdatedAt: e.updatedAt }),
    (err) => err.status === 422 && Boolean(err.fields.guestsCount));
  assert.throws(() => updateEvent(ctx(owner), e.id, { budgetTarget: { amount: -5, currency: 'RUB' }, expectedUpdatedAt: e.updatedAt }),
    (err) => err.status === 422 && Boolean(err.fields.budgetTarget));
  assert.throws(() => updateEvent(ctx(owner), e.id, {
    contacts: [{ name: 'Мама', relation: 'parent' }], expectedUpdatedAt: e.updatedAt,
  }), (err) => err.status === 422 && Boolean(err.fields.contacts));

  const ok = updateEvent(ctx(owner), e.id, {
    guestsCount: 80, budgetTarget: { amount: 1500000, currency: 'RUB' },
    contacts: [{ name: 'Мама невесты', relation: 'parent', phone: '+7 900 000-00-00' }],
    expectedUpdatedAt: e.updatedAt,
  });
  assert.equal(ok.guestsCount, 80);
  assert.deepEqual(ok.budgetTarget, { amount: 1500000, currency: 'RUB' });
  assert.equal(ok.contacts.length, 1);
});

// ---------- dueDateReview и reschedule (раздел 1.3) ----------

test('смена даты свадьбы возвращает dueDateReview с текущими и предложенными сроками', () => {
  const { event, ctx, owner, store } = setup();
  const e = event({ eventDate: null });
  applyChecklistPlan(store, e, new Date(NOON).toISOString(), TZ);
  const withDate = updateEvent(ctx(owner), e.id, { eventDate: '2027-09-23', eventDatePrecision: 'day', expectedUpdatedAt: e.updatedAt });
  assert.ok(withDate.dueDateReview);
  assert.equal(withDate.dueDateReview.length, 13);
  assert.ok(withDate.dueDateReview.every((r) => r.currentDueDate === null));
  assert.ok(withDate.dueDateReview.every((r) => r.isManual === false));
  const brief = withDate.dueDateReview.find((r) => r.title === 'Заполнить бриф пары');
  assert.equal(brief.proposedDueDate, '2026-09-30');
});

test('reschedule обновляет только отмеченные задачи; вручную изменённая — не отмечена по умолчанию, но обновляется, если её выбрали', () => {
  const { event, ctx, owner, store } = setup();
  const e = event({ eventDate: '2027-09-23' });
  applyChecklistPlan(store, e, new Date(NOON).toISOString(), TZ);
  const tasks = getEvent(ctx(owner), e.id).tasks;
  const brief = tasks.find((t) => t.templateKey === 'checklist:start-brief');
  store.updateTask(brief.id, { dueDate: '2026-10-15', dueDateSource: 'manual' });

  const moved = updateEvent(ctx(owner), e.id, {
    eventDate: '2027-10-23', eventDatePrecision: 'day', expectedUpdatedAt: e.updatedAt,
  });
  const briefReview = moved.dueDateReview.find((r) => r.taskId === brief.id);
  assert.equal(briefReview.isManual, true);

  const toUpdate = moved.dueDateReview.filter((r) => !r.isManual).map((r) => r.taskId);
  const res = rescheduleTasks(ctx(owner), e.id, { taskIds: toUpdate, idempotencyKey: 'reschedule-key-01' });
  assert.equal(res.updated, toUpdate.length);

  const after = getEvent(ctx(owner), e.id).tasks;
  const briefAfter = after.find((t) => t.id === brief.id);
  assert.equal(briefAfter.dueDate, '2026-10-15'); // не тронута — не была выбрана
  const otherAfter = after.find((t) => t.templateKey === 'checklist:venue-shortlist');
  assert.equal(otherAfter.dueDate, moved.dueDateReview.find((r) => r.taskId === otherAfter.id).proposedDueDate);
  assert.equal(otherAfter.dueDateSource, 'template');
});

test('reschedule идемпотентен: повтор с тем же ключом не меняет ничего заново', () => {
  const { event, ctx, owner, store } = setup();
  const e = event({ eventDate: '2027-09-23' });
  applyChecklistPlan(store, e, new Date(NOON).toISOString(), TZ);
  const tasks = getEvent(ctx(owner), e.id).tasks;
  const ids = tasks.map((t) => t.id);
  const first = rescheduleTasks(ctx(owner), e.id, { taskIds: ids, idempotencyKey: 'idem-key-01' });
  const second = rescheduleTasks(ctx(owner), e.id, { taskIds: ids, idempotencyKey: 'idem-key-01' });
  assert.deepEqual(first.tasks.map((t) => t.id), second.tasks.map((t) => t.id));
});

test('завершённые и отменённые задачи не попадают в dueDateReview', () => {
  const { event, task, ctx, owner } = setup();
  const e = event({ eventDate: null });
  const t = task(e.id, { templateKey: 'checklist:start-brief', dueDateSource: 'template', status: 'done' });
  const withDate = updateEvent(ctx(owner), e.id, { eventDate: '2027-09-23', eventDatePrecision: 'day', expectedUpdatedAt: e.updatedAt });
  assert.ok(!withDate.dueDateReview.some((r) => r.taskId === t.id));
});

test('дату убрали совсем — dueDateReview не строится, диалог не нужен (§1.3)', () => {
  const { event, ctx, owner, store } = setup();
  const e = event({ eventDate: '2027-09-23' });
  applyChecklistPlan(store, e, new Date(NOON).toISOString(), TZ);
  const cleared = updateEvent(ctx(owner), e.id, { eventDate: null, expectedUpdatedAt: e.updatedAt });
  assert.equal(cleared.dueDateReview, undefined);
});

// ---------- setup (раздел 4.1) ----------

test('setup: 5 шагов, done растёт по мере заполнения', () => {
  const { event, task, ctx, owner, store } = setup();
  const e = event();
  let s = computeSetupSteps(store, { ...e, contacts: [] }, []);
  assert.equal(s.total, 5);
  assert.equal(s.done, 0);

  task(e.id, { title: 'Любая задача' });
  s = computeSetupSteps(store, { ...e, contacts: [] }, [{ id: 't' }]);
  assert.equal(s.steps.find((x) => x.key === 'plan').done, true);

  const withCouple = {
    ...e, partner1Name: 'Анна', partner2Name: 'Максим',
    contacts: [{ id: 'c', name: 'Мама', relation: 'parent', phone: '+7', email: null }],
  };
  s = computeSetupSteps(store, withCouple, []);
  assert.equal(s.steps.find((x) => x.key === 'couple').done, true);

  const withDate = { ...e, eventDatePrecision: 'day' };
  s = computeSetupSteps(store, withDate, []);
  assert.equal(s.steps.find((x) => x.key === 'date').done, true);
  const monthOnly = { ...e, eventDatePrecision: 'month' };
  s = computeSetupSteps(store, monthOnly, []);
  assert.equal(s.steps.find((x) => x.key === 'date').done, false);
});

test('setup: подрядчики засчитываются из своих данных; бюджет — только по явному ориентиру', () => {
  const { event, ctx, owner, store } = setup();
  const e = event();
  let s = computeSetupSteps(store, e, []);
  assert.equal(s.steps.find((x) => x.key === 'vendors').done, false);
  assert.equal(s.steps.find((x) => x.key === 'budget').done, false);

  const vendor = createVendor({ store, user: owner, now: NOON }, { category: 'Ведущий', name: 'Ведущий' });
  addEventVendors({ store, user: owner, now: NOON }, e.id, { vendorIds: [vendor.id], idempotencyKey: 'vendor-key-01' });
  s = computeSetupSteps(store, e, []);
  assert.equal(s.steps.find((x) => x.key === 'vendors').done, true);

  // Добавление подрядчика-кандидата создаёт строку сметы автоматически (docs/specs/06-budget.md),
  // но это не значит, что организатор осознанно задал ориентир бюджета — шаг остаётся незавершён
  // (ТЗ 09, §2: «появление строки расходов при итоге 0 не должно выглядеть как завершённый бюджет»).
  addManualLine({ store, user: owner, now: NOON }, e.id, { category: 'Площадка', title: 'Аренда', amount: 1000 });
  s = computeSetupSteps(store, e, []);
  assert.equal(s.steps.find((x) => x.key === 'budget').done, false);

  const withTarget = { ...e, budgetTarget: { amount: 500000, currency: 'RUB' } };
  s = computeSetupSteps(store, withTarget, []);
  assert.equal(s.steps.find((x) => x.key === 'budget').done, true);
});

test('setup: «Данные пары» готовы по именам, без обязательного дополнительного контакта', () => {
  const { event, store } = setup();
  const e = event({ partner1Name: 'Анна', partner2Name: 'Максим', contacts: [] });
  const s = computeSetupSteps(store, e, []);
  assert.equal(s.steps.find((x) => x.key === 'couple').done, true);
});

test('setup виден в getEvent и в карточках списка из одного снимка', () => {
  const { event, ctx, owner } = setup();
  const e = event({ partner1Name: 'Анна', partner2Name: 'Максим' });
  const fromGetEvent = getEvent(ctx(owner), e.id).event.setup;
  const fromList = listEvents(ctx(owner)).items.find((i) => i.id === e.id).setup;
  assert.deepEqual(fromGetEvent, fromList);
});

// ---------- «Дальше» (раздел 5) ----------

test('«Дальше»: todo со сроком в ближайшие 14 дней, не показанные в «Требует внимания»', () => {
  const { event, task, ctx, owner } = setup();
  const e = event();
  task(e.id, { status: 'todo', dueDate: '2026-09-30' }); // через неделю от NOON (23 сентября)
  task(e.id, { status: 'todo', dueDate: '2026-09-24', isBlocked: true }); // уже в «Требует внимания»
  task(e.id, { status: 'in_progress', dueDate: '2026-09-25' }); // никогда не в «Дальше»
  task(e.id, { status: 'todo', dueDate: '2026-12-01' }); // за горизонтом

  const data = getEvent(ctx(owner), e.id);
  assert.equal(data.upcoming.items.length, 1);
  assert.equal(data.upcoming.items[0].dueDate, '2026-09-30');
});

test('«Дальше»: задача переведённая в in_progress уходит из списка', () => {
  const { event, task, ctx, owner, store } = setup();
  const e = event();
  const t = task(e.id, { status: 'todo', dueDate: '2026-09-30' });
  let data = getEvent(ctx(owner), e.id);
  assert.equal(data.upcoming.items.length, 1);
  store.updateTask(t.id, { status: 'in_progress' });
  data = getEvent(ctx(owner), e.id);
  assert.equal(data.upcoming.items.length, 0);
});

test('«Дальше»: если в окне пусто, но есть более поздняя задача — nearestBeyond', () => {
  const { event, task, ctx, owner } = setup();
  const e = event();
  task(e.id, { status: 'todo', dueDate: '2026-12-01' });
  const data = getEvent(ctx(owner), e.id);
  assert.equal(data.upcoming.items.length, 0);
  assert.ok(data.upcoming.nearestBeyond);
  assert.equal(data.upcoming.nearestBeyond.dueDate, '2026-12-01');
});

test('карточка списка получает upcomingCount и upcomingPreview из того же снимка', () => {
  const { event, task, ctx, owner } = setup();
  const e = event();
  task(e.id, { status: 'todo', dueDate: '2026-09-30' });
  const card = listEvents(ctx(owner)).items.find((i) => i.id === e.id);
  assert.equal(card.upcomingCount, 1);
  assert.equal(card.upcomingPreview.dueDate, '2026-09-30');
});

// ---------- существующие свадьбы: значения по умолчанию, без миграций ----------

test('существующая свадьба без новых полей открывается с безопасными значениями по умолчанию', () => {
  const { event, ctx, owner, store } = setup();
  const e = event({ eventDate: '2027-01-01' });
  delete e.partner1Name; delete e.titleIsCustom; delete e.eventDatePrecision; delete e.contacts;
  const data = getEvent(ctx(owner), e.id);
  assert.equal(data.event.partner1Name, null);
  assert.equal(data.event.titleIsCustom, true);
  assert.equal(data.event.eventDatePrecision, 'day');
  assert.deepEqual(data.event.contacts, []);
  // Хранилище не переписано молча.
  assert.equal(store.getEvent(e.id).partner1Name, undefined);
});
