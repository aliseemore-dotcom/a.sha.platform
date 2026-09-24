// Панель «+ Выбрать подрядчиков» (docs/specs/05-vendors.md, раздел 2): категории раскрываются в
// списки имён из личной базы текущего пользователя; отмеченные чекбоксами добавляются в свадьбу
// только по нажатию «Добавить N». Уже добавленные в эту свадьбу помечены и не выбираются повторно.

import { h } from '../dom.js';
import { api } from '../api.js';
import { openVendorDialog } from '../ui/vendorDialog.js';
import { VENDOR_CATEGORIES } from '../vendorCategories.js';
import { CURRENCY_LABEL } from '../currencies.js';
import { formatMoney } from '../format.js';

function newKey() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function pluralizeVendors(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'подрядчика';
  return 'подрядчиков';
}

/**
 * @param {{ opener: HTMLElement, eventId: string, onAdded: () => void }} opts
 */
export function openVendorPickerPanel({ opener, eventId, onAdded }) {
  let idempotencyKey = newKey();
  let saving = false;
  let personal = [];      // личная база пользователя
  let addedSourceIds = new Set(); // sourceVendorId уже добавленных в эту свадьбу
  const checked = new Set();

  const banner = h('div', { class: 'banner banner--error', role: 'alert', hidden: true });
  const body = h('div', { class: 'dialog__body' }, banner, h('p', { class: 'muted' }, 'Загружаем…'));
  const submit = h('button', { type: 'submit', class: 'btn btn--primary', disabled: true }, 'Добавить подрядчиков');
  const cancel = h('button', { type: 'button', class: 'btn btn--secondary' }, 'Отмена');
  const addNewBtn = h('button', { type: 'button', class: 'btn btn--secondary dialog__foot-extra' }, '+ Добавить нового подрядчика');

  const form = h('form', { class: 'dialog__form', novalidate: true },
    h('div', { class: 'dialog__head' },
      h('h2', { class: 'dialog__title', id: 'vendor-picker-heading' }, 'Выбрать подрядчиков'),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Закрыть', onclick: () => close() }, '×'),
    ),
    body,
    h('div', { class: 'dialog__foot' }, addNewBtn, cancel, submit),
  );

  const dialog = h('dialog', { class: 'dialog checklist-dialog', 'aria-labelledby': 'vendor-picker-heading' }, form);

  function updateSubmit() {
    const n = checked.size;
    submit.disabled = saving || n === 0;
    submit.textContent = saving ? 'Добавляем…' : (n ? `Добавить ${n} ${pluralizeVendors(n)}` : 'Добавить подрядчиков');
  }

  function itemRow(v) {
    if (addedSourceIds.has(v.id)) {
      return h('li', { class: 'checklist-item checklist-item--added' },
        h('span', { class: 'checklist-item__label' }, v.name),
        h('span', { class: 'checklist-item__status' }, 'Добавлено'));
    }
    const id = `vendor-pick-${v.id}`;
    const checkbox = h('input', {
      type: 'checkbox', id, checked: checked.has(v.id),
      onchange: (e) => {
        if (e.currentTarget.checked) checked.add(v.id);
        else checked.delete(v.id);
        updateSubmit();
      },
    });
    const priceText = v.price != null ? formatMoney(v.price, CURRENCY_LABEL[v.currency]) : null;
    return h('li', { class: 'checklist-item' },
      h('label', { class: 'checkbox checklist-item__check', for: id }, checkbox, h('span', {}, v.name)),
      priceText ? h('span', { class: 'checklist-item__status' }, priceText) : null);
  }

  function renderItems() {
    if (!personal.length) {
      body.replaceChildren(banner,
        h('div', { class: 'empty' },
          h('p', { class: 'empty__title' }, 'В личной базе пока нет подрядчиков'),
          h('p', { class: 'empty__text' }, 'Добавьте первого кнопкой ниже.')));
      return;
    }
    const bySection = new Map();
    for (const c of VENDOR_CATEGORIES) bySection.set(c, personal.filter((v) => v.category === c));
    body.replaceChildren(banner,
      h('div', { class: 'checklist-groups' },
        [...bySection].filter(([, items]) => items.length).map(([category, items]) => h('details', { class: 'checklist-group', open: true },
          h('summary', { class: 'overline checklist-group__title' }, `${category} · ${items.length}`),
          h('ul', { class: 'checklist-list' }, items.map(itemRow)),
        ))));
  }

  async function load() {
    try {
      const [vendors, eventVendors] = await Promise.all([api.listVendors(), api.listEventVendors(eventId)]);
      personal = vendors.items;
      addedSourceIds = new Set(eventVendors.items.map((v) => v.vendorId));
      renderItems();
      updateSubmit();
    } catch {
      body.replaceChildren(banner);
      banner.textContent = 'Не удалось загрузить список подрядчиков.';
      banner.hidden = false;
    }
  }

  function close() {
    if (saving) return;
    dialog.close();
  }

  addNewBtn.addEventListener('click', () => {
    openVendorDialog({
      opener: addNewBtn,
      onSaved: (v) => { personal = [...personal, v]; renderItems(); },
    });
  });

  dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dialog.addEventListener('close', () => { dialog.remove(); opener?.focus(); });
  cancel.addEventListener('click', close);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (saving || !checked.size) return;
    saving = true;
    banner.hidden = true;
    updateSubmit();
    try {
      await api.addEventVendors(eventId, { vendorIds: [...checked], idempotencyKey });
      saving = false;
      dialog.close();
      onAdded();
    } catch {
      saving = false;
      updateSubmit();
      banner.textContent = 'Не удалось добавить подрядчиков. Повторите попытку.';
      banner.hidden = false;
    }
  });

  document.body.append(dialog);
  dialog.showModal();
  load();
}
