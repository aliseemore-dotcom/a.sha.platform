// Диалог «Добавить подрядчика» / «Редактировать подрядчика» (личная база, docs/specs/05-vendors.md).
// Обязательны категория и имя; телефон/ссылка/заметка — по желанию.

import { h } from '../dom.js';
import { api } from '../api.js';
import { VENDOR_CATEGORIES } from '../vendorCategories.js';
import { CURRENCIES, CURRENCY_LABEL, DEFAULT_CURRENCY } from '../currencies.js';

const NAME_MAX = 150;

function field({ id, label, input, hint }) {
  const hintEl = h('p', { class: 'field__hint', id: `${id}-hint` }, hint ?? '');
  const errorEl = h('p', { class: 'field__error', id: `${id}-error` });
  input.id = id;
  input.setAttribute('aria-describedby', `${id}-hint ${id}-error`);
  const wrap = h('div', { class: 'field' }, h('label', { class: 'field__label', for: id }, label), input, hintEl, errorEl);
  return {
    wrap,
    setError(msg) {
      errorEl.textContent = msg ?? '';
      if (msg) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
      wrap.classList.toggle('field--error', Boolean(msg));
    },
  };
}

/**
 * @param {{ opener: HTMLElement, vendor?: object, defaultCategory?: string, onSaved: (v: object) => void }} opts
 */
export function openVendorDialog({ opener, vendor = null, defaultCategory = null, onSaved }) {
  const isEdit = Boolean(vendor);
  let saving = false;
  let nameTouched = false;

  const categorySelect = h('select', { class: 'input select' },
    VENDOR_CATEGORIES.map((c) => h('option', { value: c }, c)));
  categorySelect.value = vendor?.category ?? defaultCategory ?? VENDOR_CATEGORIES[0];

  const nameInput = h('input', {
    type: 'text', class: 'input', autocomplete: 'off', maxlength: String(NAME_MAX + 20),
    placeholder: 'Например, Иван Иванов', value: vendor?.name ?? '',
  });
  const phoneInput = h('input', { type: 'tel', class: 'input', autocomplete: 'off', value: vendor?.phone ?? '' });
  const linkInput = h('input', { type: 'text', class: 'input', autocomplete: 'off', placeholder: 'Сайт или соцсеть', value: vendor?.link ?? '' });
  const noteInput = h('textarea', { class: 'input', rows: '3' });
  noteInput.value = vendor?.note ?? '';
  // Стоимость всего заказа целиком, не цена за час (docs/specs/06-budget.md) — попадёт в смету
  // при выборе подрядчика в свадьбу.
  const priceInput = h('input', { type: 'number', class: 'input', min: '0', step: 'any', value: vendor?.price ?? '' });
  const currencySelect = h('select', { class: 'input select' },
    CURRENCIES.map((c) => h('option', { value: c }, CURRENCY_LABEL[c] ?? c)));
  currencySelect.value = vendor?.currency ?? DEFAULT_CURRENCY;

  const categoryField = field({ id: 'vendor-category', label: 'Категория', input: categorySelect });
  const nameField = field({ id: 'vendor-name', label: 'Имя / название', input: nameInput });
  const phoneField = field({ id: 'vendor-phone', label: 'Телефон', input: phoneInput, hint: 'Необязательно' });
  const linkField = field({ id: 'vendor-link', label: 'Ссылка / соцсеть', input: linkInput, hint: 'Необязательно' });
  const priceField = field({ id: 'vendor-price', label: 'Стоимость услуги целиком', input: priceInput, hint: 'Необязательно' });
  const currencyField = field({ id: 'vendor-currency', label: 'Валюта', input: currencySelect });
  const noteField = field({ id: 'vendor-note', label: 'Заметка', input: noteInput, hint: 'Необязательно' });

  const banner = h('div', { class: 'banner banner--error', role: 'alert', hidden: true });
  const submit = h('button', { type: 'submit', class: 'btn btn--primary' }, isEdit ? 'Сохранить' : 'Добавить подрядчика');
  const cancel = h('button', { type: 'button', class: 'btn btn--secondary' }, 'Отмена');

  const form = h('form', { class: 'dialog__form', novalidate: true },
    h('div', { class: 'dialog__head' },
      h('h2', { class: 'dialog__title', id: 'vendor-dialog-heading' }, isEdit ? 'Редактировать подрядчика' : 'Добавить подрядчика'),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Закрыть', onclick: () => close() }, '×'),
    ),
    h('div', { class: 'dialog__body' },
      banner, categoryField.wrap, nameField.wrap, phoneField.wrap, linkField.wrap,
      h('div', { class: 'field-row' }, priceField.wrap, currencyField.wrap),
      noteField.wrap),
    h('div', { class: 'dialog__foot' }, cancel, submit),
  );

  const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': 'vendor-dialog-heading' }, form);

  function validate({ show }) {
    const nameErr = nameInput.value.trim()
      ? ([...nameInput.value.trim()].length > NAME_MAX ? `Не более ${NAME_MAX} символов` : null)
      : 'Укажите имя или название';
    const priceErr = priceInput.value !== '' && Number(priceInput.value) < 0 ? 'Укажите стоимость числом' : null;
    if (show || nameTouched) nameField.setError(nameErr);
    priceField.setError(priceErr);
    submit.disabled = saving || Boolean(nameErr || priceErr);
    return !(nameErr || priceErr);
  }

  function setSaving(on) {
    saving = on;
    submit.textContent = on ? 'Сохраняем…' : (isEdit ? 'Сохранить' : 'Добавить подрядчика');
    for (const el of [categorySelect, nameInput, phoneInput, linkInput, priceInput, currencySelect, noteInput, cancel]) el.disabled = on;
    if (!on) validate({ show: false });
  }

  function close() {
    if (saving) return;
    dialog.close();
  }

  nameInput.addEventListener('input', () => { banner.hidden = true; validate({ show: false }); });
  nameInput.addEventListener('blur', () => { nameTouched = true; validate({ show: false }); });
  cancel.addEventListener('click', close);
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dialog.addEventListener('close', () => { dialog.remove(); opener?.focus(); });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (saving) return;
    nameTouched = true;
    if (!validate({ show: true })) { nameInput.focus(); return; }
    banner.hidden = true;
    setSaving(true);
    const body = {
      category: categorySelect.value,
      name: nameInput.value,
      phone: phoneInput.value,
      link: linkInput.value,
      note: noteInput.value,
      price: priceInput.value === '' ? null : Number(priceInput.value),
      currency: currencySelect.value,
    };
    try {
      const saved = isEdit ? await api.updateVendor(vendor.id, body) : await api.createVendor(body);
      saving = false;
      dialog.close();
      onSaved(saved);
    } catch (err) {
      setSaving(false);
      if (err.status === 422 && err.fields) {
        categoryField.setError(err.fields.category ?? null);
        nameField.setError(err.fields.name ?? null);
        phoneField.setError(err.fields.phone ?? null);
        linkField.setError(err.fields.link ?? null);
        priceField.setError(err.fields.price ?? null);
        currencyField.setError(err.fields.currency ?? null);
        noteField.setError(err.fields.note ?? null);
      } else {
        banner.textContent = 'Не удалось сохранить. Повторите попытку.';
        banner.hidden = false;
      }
    }
  });

  document.body.append(dialog);
  dialog.showModal();
  nameInput.focus();
}
