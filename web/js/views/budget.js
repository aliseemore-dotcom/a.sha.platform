// Смета свадьбы (docs/specs/06-budget.md): плановый свод расходов по проекту — без платежей,
// долгов и счетов. Строки по категориям, общий итог, ручные расходы, включение/исключение из
// итога. Изменение суммы здесь не трогает цену в личной базе подрядчика.

import { h, clear, announce } from '../dom.js';
import { api } from '../api.js';
import { withFrom, safeListPath } from '../ui/components.js';
import { CURRENCIES, CURRENCY_LABEL } from '../currencies.js';
import { formatMoney } from '../format.js';

export function renderBudget(slot, { params, query }) {
  const eventId = params.eventId;
  const overviewUrl = withFrom(`/events/${encodeURIComponent(eventId)}/overview`, query.get('from'));
  const backToList = safeListPath(query.get('from')) ?? '/events';

  let project = null;
  let budget = null;
  let controller = null;

  const back = () => h('p', { class: 'back' }, h('a', { href: overviewUrl, class: 'link' }, '← Обзор проекта'));

  const head = h('section', { class: 'page-head' });
  const currencySelect = h('select', { class: 'input select', id: 'budget-currency' },
    CURRENCIES.map((c) => h('option', { value: c }, CURRENCY_LABEL[c] ?? c)));
  currencySelect.addEventListener('change', async () => {
    currencySelect.disabled = true;
    try {
      budget = await api.setBudgetCurrency(eventId, currencySelect.value);
      render();
    } catch {
      announce('Не удалось изменить валюту. Повторите попытку.', 0);
    } finally {
      currencySelect.disabled = false;
    }
  });

  const totalSlot = h('section', { class: 'budget-total' });
  const addBtn = h('button', { type: 'button', class: 'btn btn--secondary' }, '+ Добавить расход');
  const listSlot = h('div', { class: 'list-slot' });
  const main = h('main', { id: 'main', class: 'container page', 'aria-busy': 'true' });
  slot.append(main);

  function openManualForm(opener) {
    const categoryInput = h('input', { type: 'text', class: 'input', autocomplete: 'off', placeholder: 'Например, Площадка' });
    const titleInput = h('input', { type: 'text', class: 'input', autocomplete: 'off', placeholder: 'Например, Аренда зала' });
    const amountInput = h('input', { type: 'number', class: 'input', min: '0', step: 'any' });
    const errorEl = h('p', { class: 'form-error', role: 'alert' });
    const submit = h('button', { type: 'submit', class: 'btn btn--primary' }, 'Добавить');
    const cancel = h('button', { type: 'button', class: 'btn btn--secondary' }, 'Отмена');
    const form = h('form', { class: 'dialog__form', novalidate: true },
      h('div', { class: 'dialog__head' },
        h('h2', { class: 'dialog__title', id: 'manual-line-heading' }, 'Добавить расход'),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Закрыть', onclick: () => dialog.close() }, '×')),
      h('div', { class: 'dialog__body' },
        errorEl,
        h('div', { class: 'field' }, h('label', { class: 'field__label' }, 'Категория'), categoryInput),
        h('div', { class: 'field' }, h('label', { class: 'field__label' }, 'Название'), titleInput),
        h('div', { class: 'field' }, h('label', { class: 'field__label' }, `Сумма, ${CURRENCY_LABEL[budget.currency] ?? budget.currency}`), amountInput)),
      h('div', { class: 'dialog__foot' }, cancel, submit));
    const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': 'manual-line-heading' }, form);
    cancel.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { dialog.remove(); opener?.focus(); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      submit.disabled = true;
      try {
        await api.addBudgetLine(eventId, {
          category: categoryInput.value, title: titleInput.value,
          amount: amountInput.value === '' ? null : Number(amountInput.value),
        });
        dialog.close();
        announce('Расход добавлен', 0);
        load();
      } catch (err) {
        submit.disabled = false;
        errorEl.textContent = err.fields
          ? Object.values(err.fields)[0]
          : 'Не удалось добавить расход. Повторите попытку.';
      }
    });
    document.body.append(dialog);
    dialog.showModal();
    categoryInput.focus();
  }
  addBtn.addEventListener('click', (e) => openManualForm(e.currentTarget));

  async function load() {
    controller?.abort();
    controller = new AbortController();
    const { signal } = controller;
    try {
      const [eventData, budgetData] = await Promise.all([
        api.getEvent(eventId, { signal }),
        api.getBudget(eventId, { signal }),
      ]);
      project = eventData.event;
      budget = budgetData;
      render();
    } catch (err) {
      if (err.name === 'AbortError') return;
      clear(main);
      main.removeAttribute('aria-busy');
      if (err.status === 404 || err.status === 403) {
        main.append(h('div', { class: 'empty', role: 'alert' },
          h('p', { class: 'empty__title' }, 'Проект не найден или доступ к нему закрыт'),
          h('a', { class: 'btn btn--secondary', href: backToList }, 'К списку мероприятий')));
      } else {
        main.append(h('div', { class: 'empty', role: 'alert' },
          h('p', { class: 'empty__title' }, 'Не удалось загрузить смету'),
          h('button', { type: 'button', class: 'btn btn--secondary', onclick: load }, 'Повторить')));
      }
    }
  }

  async function patchLine(line, patch, input) {
    const original = input.value;
    try {
      await api.updateBudgetLine(eventId, line.id, patch);
      // Итог и «не хватает цены» зависят от всех строк разом — надёжнее перечитать смету
      // целиком, чем пересчитывать их на клиенте по одной изменённой строке.
      budget = await api.getBudget(eventId);
      renderTotal();
      renderList();
    } catch {
      input.value = original;
      announce('Не удалось сохранить изменение. Повторите попытку.', 0);
    }
  }

  function lineRow(line) {
    const titleInput = h('input', {
      type: 'text', class: 'input budget-line__title', value: line.title, disabled: !budget.canEdit,
    });
    titleInput.addEventListener('change', () => {
      if (titleInput.value.trim() && titleInput.value !== line.title) patchLine(line, { title: titleInput.value }, titleInput);
      else titleInput.value = line.title;
    });

    const amountInput = h('input', {
      type: 'number', class: 'input budget-line__amount', min: '0', step: 'any',
      placeholder: 'Укажите стоимость', value: line.amount ?? '', disabled: !budget.canEdit,
    });
    amountInput.addEventListener('change', () => {
      const v = amountInput.value === '' ? null : Number(amountInput.value);
      if (v !== line.amount) patchLine(line, { amount: v }, amountInput);
    });

    const includedCheckbox = h('input', {
      type: 'checkbox', checked: line.included, disabled: !budget.canEdit,
      onchange: (e) => patchLine(line, { included: e.currentTarget.checked }, e.currentTarget),
    });

    const mismatchNote = line.needsCurrencyMatch
      ? h('p', { class: 'budget-line__note' },
        `Исходная цена: ${formatMoney(line.originalPrice, CURRENCY_LABEL[line.originalCurrency])} — валюта отличается от сметы, сумма не пересчитана автоматически`)
      : null;

    return h('li', { class: 'budget-line' },
      h('label', { class: 'checkbox budget-line__include', title: 'Учитывать в итоге' }, includedCheckbox, h('span', { class: 'visually-hidden' }, 'Учитывать в итоге')),
      h('div', { class: 'budget-line__main' },
        titleInput,
        line.source === 'vendor' ? h('span', { class: 'caption budget-line__source' }, 'Подрядчик') : null,
        mismatchNote,
      ),
      h('div', { class: 'budget-line__amount-wrap' }, amountInput, h('span', { class: 'caption' }, CURRENCY_LABEL[budget.currency] ?? budget.currency)),
    );
  }

  function renderList() {
    clear(listSlot);
    if (!budget.lines.length) {
      listSlot.append(h('div', { class: 'empty' },
        h('p', { class: 'empty__title' }, 'Смета пока пуста'),
        h('p', { class: 'empty__text' }, 'Выберите подрядчиков в свадьбу или добавьте расход вручную.')));
      return;
    }
    const bySection = new Map();
    for (const l of budget.lines) {
      if (!bySection.has(l.category)) bySection.set(l.category, []);
      bySection.get(l.category).push(l);
    }
    listSlot.append(...[...bySection].map(([category, lines]) => h('div', { class: 'budget-group' },
      h('h2', { class: 'overline budget-group__title' }, category),
      h('ul', { class: 'budget-list' }, lines.map(lineRow)))));
  }

  function renderTotal() {
    clear(totalSlot);
    // totalSlot.append — нативный Element.append: null стал бы текстом "null", поэтому
    // отсутствующий элемент отфильтровывается явно (см. main.append в overview.js).
    totalSlot.append(...[
      h('div', { class: 'budget-total__row' },
        h('span', { class: 'budget-total__label' }, 'Итого'),
        h('span', { class: 'budget-total__value' }, formatMoney(budget.total, CURRENCY_LABEL[budget.currency] ?? budget.currency)),
      ),
      budget.missingCount
        ? h('p', { class: 'caption budget-total__missing' },
          `Не хватает цены у ${budget.missingCount} ${budget.missingCount === 1 ? 'включённой строки' : 'включённых строк'} — итог неполный`)
        : null,
    ].filter(Boolean));
  }

  function render() {
    clear(main);
    main.removeAttribute('aria-busy');
    document.title = `Смета — ${project.title}`;
    currencySelect.value = budget.currency;
    addBtn.hidden = !budget.canEdit;

    clear(head);
    head.append(
      h('div', { class: 'page-head__text' },
        h('p', { class: 'overline' }, project.title),
        h('h1', { class: 'page-title' }, 'Смета'),
      ),
      h('div', { class: 'field field--inline' },
        h('label', { class: 'field__label', for: 'budget-currency' }, 'Валюта'), currencySelect),
    );

    renderTotal();
    renderList();

    main.append(back(), head, totalSlot, h('p', {}, addBtn), listSlot);
  }

  load();
  return () => controller?.abort();
}
