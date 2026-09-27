// Диалог редактирования данных свадьбы. Часть I ТЗ 07 определяет только API (`PATCH
// /api/events/:id`) и не описывает отдельный экран — полноценная страница «Данные пары» с
// разделами, режимом просмотра и маршрутом `/events/:id/profile` запланирована в части II (§7).
// Чтобы часть I не добавляла кнопок без работающего поведения (правило раздела 0 ТЗ), этот диалог
// уже сейчас даёт отредактировать все поля из раздела 1.1 и провести через `dueDateReview» —
// он будет заменён страницей в части II, а не дублироваться рядом с ней.

import { h, announce } from '../dom.js';
import { api } from '../api.js';
import { CURRENCIES, CURRENCY_LABEL, DEFAULT_CURRENCY } from '../currencies.js';
import { CONTACT_RELATIONS, RELATION_LABEL } from '../contactRelations.js';
import { openDueDateReviewDialog } from './dueDateReviewDialog.js';

const NAME_MAX = 60;
const TITLE_MAX = 100;
const LOCATION_MAX = 150;
const CONTACTS_MAX = 4;

function field({ id, label, input, hint }) {
  const hintEl = h('p', { class: 'field__hint', id: `${id}-hint` }, hint ?? '');
  const errorEl = h('p', { class: 'field__error', id: `${id}-error` });
  input.id = id;
  input.setAttribute('aria-describedby', `${id}-hint ${id}-error`);
  const wrap = h('div', { class: 'field' }, h('label', { class: 'field__label', for: id }, label), input, hintEl, errorEl);
  return { wrap, setError(msg) { errorEl.textContent = msg ?? ''; wrap.classList.toggle('field--error', Boolean(msg)); } };
}

/**
 * @param {{ opener: HTMLElement, event: object, focus?: 'date'|'budget', onSaved: () => void }} opts
 */
export function openEditEventDialog({ opener, event, focus = null, onSaved }) {
  let saving = false;
  let expectedUpdatedAt = event.updatedAt;

  const p1Input = h('input', { type: 'text', class: 'input', autocomplete: 'off', value: event.partner1Name ?? '' });
  const p2Input = h('input', { type: 'text', class: 'input', autocomplete: 'off', value: event.partner2Name ?? '' });
  const p1Field = field({ id: 'edit-event-p1', label: 'Имя', input: p1Input });
  const p2Field = field({ id: 'edit-event-p2', label: 'Имя партнёра', input: p2Input, hint: 'Необязательно' });

  const titleInput = h('input', { type: 'text', class: 'input', autocomplete: 'off', value: event.title ?? '' });
  const titleField = field({ id: 'edit-event-title', label: 'Название свадьбы', input: titleInput,
    hint: 'Меняется автоматически по именам, если оставить как есть после смены имён' });

  const hasDate = Boolean(event.eventDate);
  const dateMode = h('select', { class: 'input select' },
    h('option', { value: 'day' }, 'Точная дата'), h('option', { value: 'month' }, 'Только месяц'), h('option', { value: 'none' }, 'Пока неизвестна'));
  dateMode.value = !hasDate ? 'none' : (event.eventDatePrecision === 'month' ? 'month' : 'day');
  const dateDay = h('input', { type: 'date', class: 'input', value: event.eventDatePrecision === 'day' ? event.eventDate ?? '' : '' });
  const dateMonth = h('input', { type: 'month', class: 'input', value: event.eventDatePrecision === 'month' ? (event.eventDate ?? '').slice(0, 7) : '' });
  const dateDayField = field({ id: 'edit-event-date-day', label: 'Дата', input: dateDay });
  const dateMonthField = field({ id: 'edit-event-date-month', label: 'Месяц', input: dateMonth });

  const locationInput = h('input', { type: 'text', class: 'input', autocomplete: 'off', value: event.locationName ?? '' });
  const locationField = field({ id: 'edit-event-location', label: 'Город или площадка', input: locationInput, hint: 'Необязательно' });

  const guestsInput = h('input', { type: 'number', class: 'input', min: '1', max: '2000', value: event.guestsCount ?? '' });
  const guestsField = field({ id: 'edit-event-guests', label: 'Примерно гостей', input: guestsInput, hint: 'Необязательно' });

  const budgetAmount = h('input', { type: 'number', class: 'input', min: '0', step: 'any', value: event.budgetTarget?.amount ?? '' });
  const budgetCurrency = h('select', { class: 'input select' }, CURRENCIES.map((c) => h('option', { value: c }, CURRENCY_LABEL[c] ?? c)));
  budgetCurrency.value = event.budgetTarget?.currency ?? DEFAULT_CURRENCY;
  const budgetField = field({ id: 'edit-event-budget', label: 'Ориентир бюджета', input: budgetAmount, hint: 'Необязательно' });

  const formatInput = h('textarea', { class: 'input', rows: '2' });
  formatInput.value = event.formatNotes ?? '';
  const wishesInput = h('textarea', { class: 'input', rows: '3' });
  wishesInput.value = event.wishesNotes ?? '';

  const contactsList = h('div', { class: 'contacts-list' });
  const addContactBtn = h('button', { type: 'button', class: 'btn btn--secondary btn--small' }, '+ Добавить контакт');

  function contactRow(c) {
    const name = h('input', { type: 'text', class: 'input', autocomplete: 'off', placeholder: 'Имя', value: c?.name ?? '' });
    const relation = h('select', { class: 'input select' }, CONTACT_RELATIONS.map((r) => h('option', { value: r }, RELATION_LABEL[r])));
    relation.value = c?.relation ?? 'parent';
    const phone = h('input', { type: 'tel', class: 'input', autocomplete: 'off', placeholder: 'Телефон', value: c?.phone ?? '' });
    const email = h('input', { type: 'email', class: 'input', autocomplete: 'off', placeholder: 'Email', value: c?.email ?? '' });
    const remove = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Удалить контакт' }, '×');
    const row = h('div', { class: 'contact-row' },
      h('div', { class: 'field-row' }, name, relation),
      h('div', { class: 'field-row' }, phone, email),
      remove);
    remove.addEventListener('click', () => { row.remove(); syncAddContactVisibility(); });
    row._read = () => ({ name: name.value, relation: relation.value, phone: phone.value, email: email.value });
    return row;
  }

  function syncAddContactVisibility() {
    addContactBtn.hidden = contactsList.children.length >= CONTACTS_MAX;
  }
  for (const c of event.contacts ?? []) contactsList.append(contactRow(c));
  syncAddContactVisibility();
  addContactBtn.addEventListener('click', () => {
    const row = contactRow(null);
    contactsList.append(row);
    syncAddContactVisibility();
    row.querySelector('input').focus();
  });

  const banner = h('div', { class: 'banner banner--error', role: 'alert', hidden: true });
  const submit = h('button', { type: 'submit', class: 'btn btn--primary' }, 'Сохранить');
  const cancel = h('button', { type: 'button', class: 'btn btn--secondary' }, 'Отмена');

  function syncDateMode() {
    dateDayField.wrap.hidden = dateMode.value !== 'day';
    dateMonthField.wrap.hidden = dateMode.value !== 'month';
  }
  dateMode.addEventListener('change', syncDateMode);
  syncDateMode();

  const form = h('form', { class: 'dialog__form', novalidate: true },
    h('div', { class: 'dialog__head' },
      h('h2', { class: 'dialog__title', id: 'edit-event-heading' }, 'Данные свадьбы'),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Закрыть', onclick: () => close() }, '×'),
    ),
    h('div', { class: 'dialog__body' },
      banner,
      h('div', { class: 'field-row' }, p1Field.wrap, p2Field.wrap),
      titleField.wrap,
      h('div', { class: 'field' }, h('label', { class: 'field__label' }, 'Дата свадьбы'), dateMode),
      dateDayField.wrap, dateMonthField.wrap,
      locationField.wrap,
      guestsField.wrap,
      h('div', { class: 'field-row' }, budgetField.wrap, h('div', { class: 'field' }, h('label', { class: 'field__label' }, 'Валюта'), budgetCurrency)),
      h('h3', { class: 'overline' }, 'Контакты'),
      contactsList,
      addContactBtn,
      h('div', { class: 'field' }, h('label', { class: 'field__label' }, 'Формат и стиль'), formatInput),
      h('div', { class: 'field' }, h('label', { class: 'field__label' }, 'Пожелания и важное'), wishesInput),
    ),
    h('div', { class: 'dialog__foot' }, cancel, submit),
  );

  const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': 'edit-event-heading' }, form);

  function close() {
    if (saving) return;
    dialog.close();
  }
  cancel.addEventListener('click', close);
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dialog.addEventListener('close', () => { dialog.remove(); opener?.focus(); });

  function setSaving(on) {
    saving = on;
    submit.textContent = on ? 'Сохраняем…' : 'Сохранить';
    for (const el of form.querySelectorAll('input, select, textarea, button')) if (el !== submit) el.disabled = on;
    submit.disabled = on;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (saving) return;
    banner.hidden = true;
    setSaving(true);

    const eventDate = dateMode.value === 'day' ? (dateDay.value || null)
      : dateMode.value === 'month' ? (dateMonth.value ? `${dateMonth.value}-01` : null) : null;
    const contacts = [...contactsList.children].map((row) => row._read()).filter((c) => c.name.trim());

    const body = {
      partner1Name: p1Input.value.trim() || null,
      partner2Name: p2Input.value.trim() || null,
      title: titleInput.value,
      titleIsCustom: true,
      eventDate,
      eventDatePrecision: eventDate ? dateMode.value : null,
      locationName: locationInput.value,
      guestsCount: guestsInput.value ? Number(guestsInput.value) : null,
      budgetTarget: budgetAmount.value ? { amount: Number(budgetAmount.value), currency: budgetCurrency.value } : null,
      contacts,
      formatNotes: formatInput.value,
      wishesNotes: wishesInput.value,
      expectedUpdatedAt,
    };

    try {
      const updated = await api.updateEvent(event.id, body);
      saving = false;
      dialog.close();
      announce('Изменения сохранены', 0);
      onSaved();
      if (updated.dueDateReview?.length) {
        openDueDateReviewDialog({
          opener, eventId: event.id, review: updated.dueDateReview, onDone: () => { announce('Сроки обновлены', 0); onSaved(); },
        });
      }
    } catch (err) {
      setSaving(false);
      if (err.status === 422 && err.fields) {
        p1Field.setError(err.fields.partner1Name ?? null);
        p2Field.setError(err.fields.partner2Name ?? null);
        titleField.setError(err.fields.title ?? null);
        dateDayField.setError(err.fields.eventDate ?? null);
        locationField.setError(err.fields.locationName ?? null);
        guestsField.setError(err.fields.guestsCount ?? null);
        budgetField.setError(err.fields.budgetTarget ?? null);
      } else if (err.status === 409) {
        banner.textContent = 'Данные изменил кто-то другой. Обновите страницу.';
        banner.hidden = false;
      } else {
        banner.textContent = 'Не удалось сохранить. Повторите попытку.';
        banner.hidden = false;
      }
    }
  });

  document.body.append(dialog);
  dialog.showModal();
  if (focus === 'date') dateMode.focus();
  else if (focus === 'budget') budgetAmount.focus();
  else p1Input.focus();
}
