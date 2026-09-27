// Диалог «Новая свадьба» (docs/specs/07-wedding-setup.md, §2.1). Нативный <dialog>: Escape,
// модальность, возврат фокуса на кнопку-источник. На узком экране — полноэкранный sheet (CSS).
// Второй блок («Контакты, гости, бюджет») свёрнут по умолчанию — заполнить можно позже.

import { h } from '../dom.js';
import { api } from '../api.js';
import { CURRENCIES, CURRENCY_LABEL, DEFAULT_CURRENCY } from '../currencies.js';
import { CONTACT_RELATIONS, RELATION_LABEL } from '../contactRelations.js';

const NAME_MAX = 60;
const TITLE_MAX = 100;
const LOCATION_MAX = 150;

function newKey() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function field({ id, label, input, hint }) {
  const hintEl = h('p', { class: 'field__hint', id: `${id}-hint` }, hint ?? '');
  const errorEl = h('p', { class: 'field__error', id: `${id}-error` });
  input.id = id;
  input.setAttribute('aria-describedby', `${id}-hint ${id}-error`);
  const wrap = h('div', { class: 'field' },
    h('label', { class: 'field__label', for: id }, label),
    input, hintEl, errorEl);
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

const composeTitle = (p1, p2) => [p1, p2].filter(Boolean).join(' + ');

/**
 * @param {{ opener: HTMLElement, onCreated: (result: {eventId: string, planStatus: string}) => void }} opts
 */
export function openCreateDialog({ opener, onCreated }) {
  let idempotencyKey = newKey();
  let saving = false;
  let titleEditing = false;
  let datePrecision = 'day'; // 'day' | 'month' | 'none'
  let contactsExpanded = false;

  // ---------- основное ----------

  const p1Input = h('input', { type: 'text', class: 'input', autocomplete: 'off', placeholder: 'Анна', maxlength: String(NAME_MAX + 10) });
  const p2Input = h('input', { type: 'text', class: 'input', autocomplete: 'off', placeholder: 'Максим', maxlength: String(NAME_MAX + 10) });
  const p1Field = field({ id: 'new-event-p1', label: 'Имя', input: p1Input });
  const p2Field = field({ id: 'new-event-p2', label: 'Имя партнёра', input: p2Input, hint: 'Необязательно' });

  const titlePreview = h('p', { class: 'title-preview' });
  const titleInput = h('input', { type: 'text', class: 'input', autocomplete: 'off', maxlength: String(TITLE_MAX + 20) });
  const titleField = field({ id: 'new-event-title', label: 'Название свадьбы', input: titleInput });
  titleField.wrap.hidden = true;
  const titleToggle = h('button', { type: 'button', class: 'link-button' }, 'Изменить название');
  const titleRow = h('div', { class: 'title-row' }, titlePreview, titleToggle);

  const dateDay = h('input', { type: 'date', class: 'input' });
  const dateMonth = h('input', { type: 'month', class: 'input' });
  const dateDayField = field({ id: 'new-event-date-day', label: 'Дата', input: dateDay });
  const dateMonthField = field({ id: 'new-event-date-month', label: 'Месяц', input: dateMonth });
  dateMonthField.wrap.hidden = true;

  const dateModeRadios = ['day', 'month', 'none'].map((mode) => {
    const input = h('input', {
      type: 'radio', name: 'date-mode', value: mode, checked: mode === 'day',
      onchange: () => { datePrecision = mode; syncDateMode(); validate({ show: false }); },
    });
    const labelText = mode === 'day' ? 'Точная дата' : mode === 'month' ? 'Только месяц' : 'Пока неизвестна';
    return h('label', { class: 'radio-pill' }, input, h('span', {}, labelText));
  });
  const dateModeRow = h('div', { class: 'radio-pills', role: 'radiogroup', 'aria-label': 'Дата свадьбы' }, dateModeRadios);

  const locationInput = h('input', {
    type: 'text', class: 'input', autocomplete: 'off', maxlength: String(LOCATION_MAX + 20),
    placeholder: 'Например, загородная площадка «Лес»',
  });
  const locationField = field({ id: 'new-event-location', label: 'Город или площадка', input: locationInput, hint: 'Необязательно' });

  const planCheckbox = h('input', { type: 'checkbox', id: 'new-event-plan', checked: true });
  const planCaption = h('p', { class: 'field__hint' });
  const planRow = h('div', { class: 'field' },
    h('label', { class: 'checkbox', for: 'new-event-plan' }, planCheckbox, h('span', {}, 'Добавить стартовый план — 13 задач')),
    planCaption);

  // ---------- контакты, гости, бюджет ----------

  const contactName = h('input', { type: 'text', class: 'input', autocomplete: 'off', maxlength: '110' });
  const contactRelation = h('select', { class: 'input select' }, CONTACT_RELATIONS.map((r) => h('option', { value: r }, RELATION_LABEL[r])));
  contactRelation.value = 'parent';
  const contactPhone = h('input', { type: 'tel', class: 'input', autocomplete: 'off' });
  const contactEmail = h('input', { type: 'email', class: 'input', autocomplete: 'off' });
  const contactNameField = field({ id: 'new-event-contact-name', label: 'Имя', input: contactName, hint: 'Необязательно' });
  const contactPhoneField = field({ id: 'new-event-contact-phone', label: 'Телефон', input: contactPhone });
  const contactEmailField = field({ id: 'new-event-contact-email', label: 'Email', input: contactEmail });

  const guestsInput = h('input', { type: 'number', class: 'input', min: '1', max: '2000' });
  const guestsField = field({ id: 'new-event-guests', label: 'Примерно гостей', input: guestsInput, hint: 'Необязательно' });

  const budgetAmount = h('input', { type: 'number', class: 'input', min: '0', step: 'any' });
  const budgetCurrency = h('select', { class: 'input select' }, CURRENCIES.map((c) => h('option', { value: c }, CURRENCY_LABEL[c] ?? c)));
  budgetCurrency.value = DEFAULT_CURRENCY;
  const budgetField = field({ id: 'new-event-budget', label: 'Ориентир бюджета', input: budgetAmount, hint: 'Необязательно' });

  const extraToggle = h('button', {
    type: 'button', class: 'disclosure-toggle', 'aria-expanded': 'false',
  }, h('span', { class: 'disclosure-toggle__caret', 'aria-hidden': 'true' }, '▸'), 'Контакты, гости, бюджет — можно заполнить позже');
  const extraBody = h('div', { class: 'disclosure-body', hidden: true },
    h('div', { class: 'field-row' }, contactNameField.wrap, h('div', { class: 'field' }, h('label', { class: 'field__label' }, 'Кем приходится'), contactRelation)),
    h('div', { class: 'field-row' }, contactPhoneField.wrap, contactEmailField.wrap),
    guestsField.wrap,
    h('div', { class: 'field-row' }, budgetField.wrap, h('div', { class: 'field' }, h('label', { class: 'field__label' }, 'Валюта'), budgetCurrency)));

  extraToggle.addEventListener('click', () => {
    contactsExpanded = !contactsExpanded;
    extraBody.hidden = !contactsExpanded;
    extraToggle.setAttribute('aria-expanded', String(contactsExpanded));
    extraToggle.classList.toggle('disclosure-toggle--open', contactsExpanded);
  });

  // ---------- каркас ----------

  const banner = h('div', { class: 'banner banner--error', role: 'alert', hidden: true });
  const submit = h('button', { type: 'submit', class: 'btn btn--primary', disabled: true }, 'Создать свадьбу');
  const cancel = h('button', { type: 'button', class: 'btn btn--secondary' }, 'Отмена');

  const confirmBox = h('div', { class: 'confirm', hidden: true, role: 'alertdialog', 'aria-labelledby': 'confirm-text' },
    h('p', { id: 'confirm-text' }, 'Закрыть без сохранения? Введённые данные пропадут.'),
    h('div', { class: 'confirm__actions' },
      h('button', { type: 'button', class: 'btn btn--secondary', onclick: () => hideConfirm() }, 'Продолжить ввод'),
      h('button', { type: 'button', class: 'btn btn--primary', onclick: () => close(true) }, 'Закрыть'),
    ),
  );

  const form = h('form', { class: 'dialog__form', novalidate: true },
    h('div', { class: 'dialog__head' },
      h('h2', { class: 'dialog__title', id: 'new-event-heading' }, 'Новая свадьба'),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Закрыть', onclick: () => requestClose() }, '×'),
    ),
    h('div', { class: 'dialog__body' },
      banner,
      h('div', { class: 'field-row' }, p1Field.wrap, p2Field.wrap),
      titleRow,
      titleField.wrap,
      h('div', { class: 'field' }, h('span', { class: 'field__label' }, 'Дата свадьбы'), dateModeRow),
      dateDayField.wrap,
      dateMonthField.wrap,
      locationField.wrap,
      planRow,
      extraToggle,
      extraBody,
    ),
    confirmBox,
    h('div', { class: 'dialog__foot' }, cancel, submit),
  );

  const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': 'new-event-heading' }, form);

  // ---------- логика ----------

  function syncDateMode() {
    dateDayField.wrap.hidden = datePrecision !== 'day';
    dateMonthField.wrap.hidden = datePrecision !== 'month';
    const hasDate = datePrecision !== 'none';
    planCaption.textContent = hasDate
      ? 'Сроки рассчитаем от даты свадьбы'
      : 'Без даты задачи добавятся без сроков';
  }
  syncDateMode();

  function updateTitlePreview() {
    if (titleEditing) return;
    const composed = composeTitle(p1Input.value.trim(), p2Input.value.trim());
    titlePreview.textContent = composed ? `Свадьба: ${composed}` : 'Свадьба: —';
  }
  updateTitlePreview();

  titleToggle.addEventListener('click', () => {
    titleEditing = true;
    titleRow.hidden = true;
    titleField.wrap.hidden = false;
    if (!titleInput.value.trim()) titleInput.value = composeTitle(p1Input.value.trim(), p2Input.value.trim());
    titleInput.focus();
  });

  const namesError = () => (p1Input.value.trim() || p2Input.value.trim() || titleInput.value.trim() ? null : 'Укажите хотя бы одно имя');

  function validate({ show }) {
    const nErr = namesError();
    const p1Err = [...p1Input.value.trim()].length > NAME_MAX ? `Не более ${NAME_MAX} символов` : null;
    const p2Err = [...p2Input.value.trim()].length > NAME_MAX ? `Не более ${NAME_MAX} символов` : null;
    const titleErr = [...titleInput.value.trim()].length > TITLE_MAX ? `Не более ${TITLE_MAX} символов` : null;
    const locErr = [...locationInput.value.trim()].length > LOCATION_MAX ? `Не более ${LOCATION_MAX} символов` : null;
    const dateErr = datePrecision === 'day' && dateDay.value && dateDay.validity.badInput ? 'Укажите дату полностью' : null;

    p1Field.setError(p1Err || (show ? nErr : null));
    p2Field.setError(p2Err);
    titleField.setError(titleErr);
    locationField.setError(locErr);
    dateDayField.setError(dateErr);

    submit.disabled = saving || Boolean(nErr || p1Err || p2Err || titleErr || locErr || dateErr);
    return !(nErr || p1Err || p2Err || titleErr || locErr || dateErr);
  }

  function setSaving(on) {
    saving = on;
    submit.textContent = on ? 'Создаём…' : 'Создать свадьбу';
    submit.setAttribute('aria-busy', on ? 'true' : 'false');
    for (const el of [p1Input, p2Input, titleInput, dateDay, dateMonth, locationInput, planCheckbox,
      contactName, contactRelation, contactPhone, contactEmail, guestsInput, budgetAmount, budgetCurrency, cancel]) el.disabled = on;
    for (const r of dateModeRadios) r.querySelector('input').disabled = on;
    if (!on) validate({ show: false });
  }

  const isDirty = () => Boolean(
    p1Input.value.trim() || p2Input.value.trim() || titleInput.value.trim() || dateDay.value || dateMonth.value
    || locationInput.value.trim() || !planCheckbox.checked || contactName.value.trim() || contactPhone.value.trim()
    || contactEmail.value.trim() || guestsInput.value || budgetAmount.value,
  );

  function values() {
    const eventDate = datePrecision === 'day' ? (dateDay.value || null)
      : datePrecision === 'month' ? (dateMonth.value ? `${dateMonth.value}-01` : null) : null;
    const contacts = [];
    if (contactName.value.trim() && (contactPhone.value.trim() || contactEmail.value.trim())) {
      contacts.push({
        name: contactName.value.trim(), relation: contactRelation.value,
        phone: contactPhone.value.trim() || null, email: contactEmail.value.trim() || null,
      });
    }
    return {
      partner1Name: p1Input.value.trim() || null,
      partner2Name: p2Input.value.trim() || null,
      title: titleEditing ? titleInput.value.trim() : '',
      titleIsCustom: titleEditing,
      eventDate,
      eventDatePrecision: eventDate ? datePrecision : null,
      locationName: locationInput.value,
      applyPlan: planCheckbox.checked,
      contacts,
      guestsCount: guestsInput.value ? Number(guestsInput.value) : null,
      budgetTarget: budgetAmount.value ? { amount: Number(budgetAmount.value), currency: budgetCurrency.value } : null,
    };
  }

  function hideConfirm() {
    confirmBox.hidden = true;
    p1Input.focus();
  }

  function close(force = false) {
    if (saving && !force) return;
    dialog.close();
  }

  function requestClose() {
    if (saving) return;
    if (isDirty()) {
      confirmBox.hidden = false;
      confirmBox.querySelector('button').focus();
    } else close();
  }

  for (const el of [p1Input, p2Input]) el.addEventListener('input', () => { banner.hidden = true; updateTitlePreview(); validate({ show: false }); });
  titleInput.addEventListener('input', () => validate({ show: false }));
  locationInput.addEventListener('input', () => validate({ show: false }));
  dateDay.addEventListener('input', () => validate({ show: false }));

  cancel.addEventListener('click', requestClose);
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault(); // Escape: сначала проверяем несохранённые данные
    if (!confirmBox.hidden) hideConfirm();
    else requestClose();
  });
  dialog.addEventListener('close', () => {
    dialog.remove();
    opener?.focus();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (saving) return;
    if (!validate({ show: true })) {
      form.querySelector('[aria-invalid="true"]')?.focus();
      return;
    }
    banner.hidden = true;
    setSaving(true);
    try {
      const result = await api.createEvent({ ...values(), idempotencyKey });
      saving = false;
      dialog.close();
      onCreated(result);
    } catch (err) {
      setSaving(false);
      if (err.status === 422 && err.fields) {
        p1Field.setError(err.fields.partner1Name ?? null);
        p2Field.setError(err.fields.partner2Name ?? null);
        titleField.setError(err.fields.title ?? null);
        if (err.fields.title && !titleEditing) { titleEditing = true; titleRow.hidden = true; titleField.wrap.hidden = false; }
        dateDayField.setError(err.fields.eventDate ?? null);
        locationField.setError(err.fields.locationName ?? null);
        form.querySelector('[aria-invalid="true"]')?.focus();
        idempotencyKey = newKey();
      } else {
        banner.textContent = err.status === 403
          ? 'Нет права создавать проекты.'
          : 'Не удалось создать свадьбу. Повторите попытку.';
        banner.hidden = false;
      }
    }
  });

  document.body.append(dialog);
  dialog.showModal();
  p1Input.focus();
}
