// Диалог «Данные свадьбы» — редактируемые факты о свадьбе (ТЗ 09, §1.2), разбитые на смысловые
// блоки: Основное, Пожелания пары, Бюджетный ориентир, Дополнительные контакты. Часть I ТЗ 07
// определяла только API (`PATCH /api/events/:id`), полноценная страница «Данные пары» с
// маршрутом `/events/:id/profile` запланирована отдельно — этот диалог её не дублирует и не
// заменяет собой обзор, анкету, задачи или смету.

import { h, announce } from '../dom.js';
import { api } from '../api.js';
import { CURRENCIES, CURRENCY_LABEL, DEFAULT_CURRENCY } from '../currencies.js';
import { CONTACT_RELATIONS, RELATION_LABEL } from '../contactRelations.js';
import { openDueDateReviewDialog } from './dueDateReviewDialog.js';

const NAME_MAX = 60;
const TITLE_MAX = 100;
const LOCATION_MAX = 150;
const CONTACTS_MAX = 4;

const composeTitle = (p1, p2) => [p1, p2].filter(Boolean).join(' + ');

/** «Алина + Дима» → [«Алина», «Дима»] — обратная операция к composeTitle (ТЗ 09, §1). */
function splitNames(value) {
  const parts = value.trim().split(/\s*\+\s*/).map((s) => s.trim()).filter(Boolean);
  return [parts[0] || null, parts.slice(1).join(' + ') || null];
}

function field({ id, label, input, hint }) {
  const hintEl = h('p', { class: 'field__hint', id: `${id}-hint` }, hint ?? '');
  const errorEl = h('p', { class: 'field__error', id: `${id}-error` });
  input.id = id;
  input.setAttribute('aria-describedby', `${id}-hint ${id}-error`);
  const wrap = h('div', { class: 'field' }, h('label', { class: 'field__label', for: id }, label), input, hintEl, errorEl);
  return { wrap, setError(msg) { errorEl.textContent = msg ?? ''; wrap.classList.toggle('field--error', Boolean(msg)); } };
}

function section(title, ...children) {
  return h('div', { class: 'edit-section' }, h('h3', { class: 'overline edit-section__title' }, title), ...children);
}

/**
 * @param {{ opener: HTMLElement, event: object, focus?: 'names'|'date'|'budget', onSaved: () => void }} opts
 */
export function openEditEventDialog({ opener, event, focus = null, onSaved }) {
  let saving = false;
  let expectedUpdatedAt = event.updatedAt;

  // ---------- основное ----------

  const namesInput = h('input', {
    type: 'text', class: 'input', autocomplete: 'off', placeholder: 'Алина + Дима', maxlength: String(NAME_MAX * 2 + 10),
    value: composeTitle(event.partner1Name, event.partner2Name),
  });
  const namesField = field({ id: 'edit-event-names', label: 'Имена пары', input: namesInput });

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

  // ---------- пожелания пары ----------

  const guestsInput = h('input', { type: 'number', class: 'input', min: '1', max: '2000', value: event.guestsCount ?? '' });
  const guestsField = field({ id: 'edit-event-guests', label: 'Примерное число гостей', input: guestsInput });

  const formatInput = h('textarea', { class: 'input', rows: '2' });
  formatInput.value = event.formatNotes ?? '';
  const wishesInput = h('textarea', { class: 'input', rows: '3' });
  wishesInput.value = event.wishesNotes ?? '';

  // ---------- бюджетный ориентир ----------

  const budgetAmount = h('input', { type: 'number', class: 'input', min: '0', step: 'any', value: event.budgetTarget?.amount ?? '' });
  const budgetCurrency = h('select', { class: 'input select' }, CURRENCIES.map((c) => h('option', { value: c }, CURRENCY_LABEL[c] ?? c)));
  budgetCurrency.value = event.budgetTarget?.currency ?? DEFAULT_CURRENCY;
  // Поле суммы и поле валюты — оба через field(), с одинаковой структурой (подпись/поле/подсказка/
  // ошибка), иначе они не совпадают по высоте в одной строке (ТЗ 09, §1: «не допускай скачков»).
  const budgetField = field({ id: 'edit-event-budget', label: 'Ориентир бюджета', input: budgetAmount });
  const budgetCurrencyField = field({ id: 'edit-event-budget-currency', label: 'Валюта', input: budgetCurrency });

  // ---------- дополнительные контакты ----------

  const contactsList = h('div', { class: 'contacts-list' });
  const addContactBtn = h('button', { type: 'button', class: 'btn btn--secondary btn--small' }, '+ Добавить контакт');

  function contactRow(c) {
    const name = h('input', { type: 'text', class: 'input', autocomplete: 'off', placeholder: 'Имя', value: c?.name ?? '' });
    const relation = h('select', { class: 'input select' },
      h('option', { value: '', disabled: true, hidden: true }, 'Кем приходится'),
      CONTACT_RELATIONS.map((r) => h('option', { value: r }, RELATION_LABEL[r])));
    // Роль — только у уже сохранённого контакта; новый контакт не получает предвыбранную роль,
    // организатор выбирает её осознанно (ТЗ 09, §1.2 — раньше здесь молча стояло «Родитель»).
    relation.value = c?.relation ?? '';
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

  // ---------- каркас ----------

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
      section('Основное',
        namesField.wrap,
        titleField.wrap,
        h('div', { class: 'field' }, h('label', { class: 'field__label' }, 'Дата свадьбы'), dateMode),
        dateDayField.wrap, dateMonthField.wrap,
        locationField.wrap,
      ),
      section('Пожелания пары',
        guestsField.wrap,
        h('div', { class: 'field' }, h('label', { class: 'field__label' }, 'Формат и стиль'), formatInput),
        h('div', { class: 'field' }, h('label', { class: 'field__label' }, 'Важные пожелания'), wishesInput),
      ),
      section('Бюджетный ориентир',
        h('div', { class: 'field-row' }, budgetField.wrap, budgetCurrencyField.wrap),
        h('p', { class: 'field__hint' }, 'Ориентир пары — не совпадает с рассчитанным итогом сметы'),
      ),
      section('Дополнительные контакты',
        contactsList,
        addContactBtn,
      ),
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

    const [partner1Name, partner2Name] = splitNames(namesInput.value);
    const body = {
      partner1Name,
      partner2Name,
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
        namesField.setError(err.fields.partner1Name ?? err.fields.partner2Name ?? null);
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
  else namesInput.focus();
}
