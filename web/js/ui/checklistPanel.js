// Панель «Добавить задачи»: готовый черновой набор задач свадьбы с чекбоксами и примерными
// сроками. До нажатия «Добавить N задач» ничего не сохраняется — выбор и правки дат живут
// только в этой панели. Уже добавленные пункты помечены «Добавлено» и не выбираются повторно.

import { h } from '../dom.js';
import { api } from '../api.js';

function newKey() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * @param {{ opener: HTMLElement, eventId: string, onAdded: () => void }} opts
 */
export function openChecklistPanel({ opener, eventId, onAdded }) {
  let idempotencyKey = newKey();
  let saving = false;
  let loaded = null; // ответ GET /checklist
  const checked = new Set();     // ключи выбранных (ещё не добавленных) пунктов
  const dueDates = new Map();    // key → значение поля даты (может быть пустым, если убрали)

  const banner = h('div', { class: 'banner banner--error', role: 'alert', hidden: true });
  const body = h('div', { class: 'dialog__body' }, banner, h('p', { class: 'muted' }, 'Загружаем…'));
  const note = h('p', { class: 'field__hint checklist-note' }, 'Сроки примерные — их можно изменить.');
  const submit = h('button', { type: 'submit', class: 'btn btn--primary', disabled: true }, 'Добавить задачи');
  const cancel = h('button', { type: 'button', class: 'btn btn--secondary' }, 'Отмена');

  const form = h('form', { class: 'dialog__form', novalidate: true },
    h('div', { class: 'dialog__head' },
      h('h2', { class: 'dialog__title', id: 'checklist-heading' }, 'Добавить задачи'),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Закрыть', onclick: () => close() }, '×'),
    ),
    body,
    h('div', { class: 'dialog__foot' }, cancel, submit),
  );

  const dialog = h('dialog', { class: 'dialog checklist-dialog', 'aria-labelledby': 'checklist-heading' }, form);

  function updateSubmit() {
    const n = checked.size;
    submit.disabled = saving || n === 0;
    submit.textContent = saving ? 'Добавляем…' : (n ? `Добавить ${n} ${pluralizeTasks(n)}` : 'Добавить задачи');
  }

  function pluralizeTasks(n) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return 'задачу';
    if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return 'задачи';
    return 'задач';
  }

  function itemRow(item) {
    if (item.added) {
      return h('li', { class: 'checklist-item checklist-item--added' },
        h('span', { class: 'checklist-item__label' }, item.title),
        h('span', { class: 'checklist-item__status' }, 'Добавлено'));
    }
    const id = `checklist-${item.key}`;
    const checkbox = h('input', {
      type: 'checkbox', id, checked: checked.has(item.key),
      onchange: (e) => {
        if (e.currentTarget.checked) checked.add(item.key);
        else checked.delete(item.key);
        updateSubmit();
      },
    });
    let dateInput = null;
    if (loaded.eventDate) {
      dateInput = h('input', {
        type: 'date', class: 'input checklist-item__date', 'aria-label': `Срок: ${item.title}`,
        value: dueDates.get(item.key) ?? '',
        max: loaded.eventDate,
        onchange: (e) => dueDates.set(item.key, e.currentTarget.value),
      });
    }
    return h('li', { class: 'checklist-item' },
      h('label', { class: 'checkbox checklist-item__check', for: id }, checkbox, h('span', {}, item.title)),
      dateInput,
    );
  }

  function renderItems() {
    const bySection = new Map();
    for (const item of loaded.items) {
      if (!bySection.has(item.section)) bySection.set(item.section, []);
      bySection.get(item.section).push(item);
    }
    const hasAnySuggested = loaded.eventDate && loaded.items.some((i) => !i.added);
    body.replaceChildren(
      banner,
      hasAnySuggested ? note : null,
      h('div', { class: 'checklist-groups' },
        [...bySection].map(([section, items]) => h('div', { class: 'checklist-group' },
          h('h3', { class: 'overline checklist-group__title' }, section),
          h('ul', { class: 'checklist-list' }, items.map(itemRow)),
        ))),
    );
  }

  async function load() {
    try {
      loaded = await api.getChecklist(eventId);
      for (const item of loaded.items) if (item.suggestedDueDate) dueDates.set(item.key, item.suggestedDueDate);
      renderItems();
      updateSubmit();
    } catch {
      body.replaceChildren(banner);
      banner.textContent = 'Не удалось загрузить список задач.';
      banner.hidden = false;
    }
  }

  function close() {
    if (saving) return;
    dialog.close();
  }

  dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dialog.addEventListener('close', () => { dialog.remove(); opener?.focus(); });
  cancel.addEventListener('click', close);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (saving || !checked.size) return;
    saving = true;
    banner.hidden = true;
    updateSubmit();
    const items = [...checked].map((key) => ({ key, dueDate: dueDates.get(key) || null }));
    try {
      await api.addChecklistItems(eventId, { items, idempotencyKey });
      saving = false;
      dialog.close();
      onAdded();
    } catch {
      saving = false;
      updateSubmit();
      banner.textContent = 'Не удалось добавить задачи. Повторите попытку.';
      banner.hidden = false;
    }
  });

  document.body.append(dialog);
  dialog.showModal();
  load();
}
