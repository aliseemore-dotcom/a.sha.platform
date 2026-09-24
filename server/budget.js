// Смета свадьбы (docs/specs/06-budget.md): плановый свод расходов — без платежей, долгов и
// счетов. Строки живут в данных проекта (не в личной базе подрядчиков), одна валюта на проект,
// итог считает только включённые строки с известной суммой.

import { canSeeEvent } from './access.js';
import { requireMutable } from './tasks.js';
import { CURRENCIES, DEFAULT_CURRENCY } from './currencies.js';
import { ServiceError } from './errors.js';

export { CURRENCIES };

export const TITLE_MAX = 150;
export const CATEGORY_MAX = 60;
export const AMOUNT_MAX = 100_000_000;

const notFound = () => new ServiceError(404, 'not_found', 'Проект не найден или недоступен');
const lineNotFound = () => new ServiceError(404, 'not_found', 'Строка сметы не найдена');

function getOrCreateBudget(store, eventId, nowIso) {
  let b = store.getBudget(eventId);
  if (!b) {
    b = { eventId, currency: DEFAULT_CURRENCY, createdAt: nowIso, updatedAt: nowIso };
    store.insertBudget(b);
  }
  return b;
}

function publicLine(l) {
  return {
    id: l.id,
    source: l.source,
    vendorLinkId: l.sourceEventVendorId ?? null,
    category: l.category,
    title: l.title,
    amount: l.amount ?? null,
    included: l.included,
    originalPrice: l.originalPrice ?? null,
    originalCurrency: l.originalCurrency ?? null,
    // Валюта отличается от сметы — не «цена ещё не указана»: тут цена ЕСТЬ, но не в валюте
    // сметы, поэтому она не пересчитана автоматически (docs/specs/06-budget.md, «Валюта и итог»).
    needsCurrencyMatch: l.originalPrice != null && l.amount == null,
    manuallyEdited: Boolean(l.manuallyEdited),
    createdAt: l.createdAt,
    updatedAt: l.updatedAt,
  };
}

export function getBudget(ctx, eventId) {
  const event = ctx.store.getEvent(eventId);
  if (!canSeeEvent(ctx.user, event)) throw notFound();
  const nowIso = new Date(ctx.now).toISOString();
  const budget = getOrCreateBudget(ctx.store, eventId, nowIso);
  const lines = ctx.store.budgetLinesForEvent(eventId).map(publicLine);
  const included = lines.filter((l) => l.included);
  const total = included.reduce((s, l) => s + (l.amount ?? 0), 0);
  const missingCount = included.filter((l) => l.amount == null).length;
  return {
    currency: budget.currency, lines, total, missingCount, canEdit: event.lifecycle === 'active',
  };
}

export function setCurrency(ctx, eventId, currency) {
  const event = ctx.store.getEvent(eventId);
  requireMutable(ctx.user, event);
  if (!CURRENCIES.includes(currency)) {
    throw new ServiceError(422, 'validation', 'Неверная валюта', { currency: 'Выберите валюту' });
  }
  const nowIso = new Date(ctx.now).toISOString();
  const budget = getOrCreateBudget(ctx.store, eventId, nowIso);
  ctx.store.updateBudget(eventId, { currency, updatedAt: nowIso });
  return getBudget(ctx, eventId);
}

function validateLineFields(body, { partial }) {
  const fields = {};
  const patch = {};

  if (!partial || 'title' in body) {
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) fields.title = 'Укажите название расхода';
    else if ([...title].length > TITLE_MAX) fields.title = `Не более ${TITLE_MAX} символов`;
    else patch.title = title;
  }
  if (!partial || 'category' in body) {
    const category = typeof body.category === 'string' ? body.category.trim() : '';
    if (!category) fields.category = 'Укажите категорию';
    else if ([...category].length > CATEGORY_MAX) fields.category = `Не более ${CATEGORY_MAX} символов`;
    else patch.category = category;
  }
  if ('amount' in body) {
    if (body.amount === null || body.amount === '') patch.amount = null;
    else {
      const n = Number(body.amount);
      if (!Number.isFinite(n) || n < 0 || n > AMOUNT_MAX) fields.amount = 'Укажите сумму числом';
      else patch.amount = n;
    }
  }
  if ('included' in body) patch.included = Boolean(body.included);

  if (Object.keys(fields).length) throw new ServiceError(422, 'validation', 'Проверьте поля формы', fields);
  return patch;
}

/** Ручной расход — площадка, декор, транспорт и т. п.: без привязки к подрядчику. */
export function addManualLine(ctx, eventId, body) {
  const event = ctx.store.getEvent(eventId);
  requireMutable(ctx.user, event);
  const patch = validateLineFields(body, { partial: false });
  const nowIso = new Date(ctx.now).toISOString();
  getOrCreateBudget(ctx.store, eventId, nowIso);
  const line = {
    id: ctx.store.newId('bl'),
    eventId,
    source: 'manual',
    sourceEventVendorId: null,
    originalPrice: null,
    originalCurrency: null,
    included: true,
    manuallyEdited: false,
    ...patch,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  ctx.store.insertBudgetLine(line);
  return publicLine(line);
}

function getOwnedLine(store, user, eventId, lineId) {
  const event = store.getEvent(eventId);
  if (!canSeeEvent(user, event)) throw notFound();
  const line = store.getBudgetLine(lineId);
  if (!line || line.eventId !== eventId) throw lineNotFound();
  return { event, line };
}

/** Переименование, ручная цена (для этой свадьбы — личную базу не трогает) и включение в итог. */
export function updateBudgetLine(ctx, eventId, lineId, body) {
  const { event, line } = getOwnedLine(ctx.store, ctx.user, eventId, lineId);
  requireMutable(ctx.user, event);
  const patch = validateLineFields(body, { partial: true });
  if ('title' in patch || 'amount' in patch) patch.manuallyEdited = true;
  patch.updatedAt = new Date(ctx.now).toISOString();
  ctx.store.updateBudgetLine(line.id, patch);
  return publicLine(ctx.store.getBudgetLine(line.id));
}

export function removeBudgetLine(ctx, eventId, lineId) {
  const { event, line } = getOwnedLine(ctx.store, ctx.user, eventId, lineId);
  requireMutable(ctx.user, event);
  ctx.store.deleteBudgetLine(line.id);
  return { id: line.id };
}

// ---------- интеграция с подрядчиками свадьбы (server/eventVendors.js) ----------

/**
 * Одна связанная строка на подрядчика при добавлении в свадьбу (раздел «Как работает экран»,
 * пункт 1). Если валюта подрядчика не совпадает с валютой сметы, сумма остаётся неизвестной —
 * без молчаливой конвертации; если цены нет вовсе, строка помечена «Укажите стоимость» (amount:
 * null), не нулём. Кандидат по умолчанию не входит в итог — только подтверждённый.
 */
export function createLineForVendor(store, eventId, eventVendor, nowIso) {
  const budget = getOrCreateBudget(store, eventId, nowIso);
  const sameCurrency = eventVendor.currency === budget.currency;
  const line = {
    id: store.newId('bl'),
    eventId,
    source: 'vendor',
    sourceEventVendorId: eventVendor.id,
    category: eventVendor.category,
    title: eventVendor.name,
    originalPrice: eventVendor.price ?? null,
    originalCurrency: eventVendor.currency,
    amount: sameCurrency ? (eventVendor.price ?? null) : null,
    included: eventVendor.status === 'confirmed',
    manuallyEdited: false,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  store.insertBudgetLine(line);
  return line;
}

/** Подтверждение подрядчика включает его строку в итог автоматически. */
export function syncLineIncludedOnConfirm(store, eventId, eventVendorId, nowIso) {
  const line = store.findBudgetLineByEventVendor(eventId, eventVendorId);
  if (line && !line.included) store.updateBudgetLine(line.id, { included: true, updatedAt: nowIso });
}

/**
 * При удалении подрядчика из свадьбы — что делать с его строкой (раздел «Как работает экран»,
 * пункт 4): `delete` убирает строку целиком, `keep` отвязывает её от подрядчика и оставляет
 * обычным ручным расходом с уже введённой суммой. Отсутствие строки — не ошибка (её могли уже
 * убрать раньше).
 */
export function resolveVendorLine(store, eventId, eventVendorId, action, nowIso) {
  const line = store.findBudgetLineByEventVendor(eventId, eventVendorId);
  if (!line) return;
  if (action === 'keep') {
    store.updateBudgetLine(line.id, { source: 'manual', sourceEventVendorId: null, updatedAt: nowIso });
  } else {
    store.deleteBudgetLine(line.id);
  }
}

export function findVendorLine(ctx, eventId, eventVendorId) {
  const line = ctx.store.findBudgetLineByEventVendor(eventId, eventVendorId);
  return line ? publicLine(line) : null;
}
