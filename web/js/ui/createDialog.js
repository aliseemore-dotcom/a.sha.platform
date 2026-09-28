// Диалог «Новая свадьба» (docs/specs/09-mvp-polish.md, §1.1). Нативный <dialog>: Escape,
// модальность, возврат фокуса на кнопку-источник. На узком экране — полноэкранный sheet (CSS).
// Контакты, гости и бюджет сюда не входят: это не нужно для создания проекта и превращает
// короткий первый шаг в анкету — заполняются позже в «Данные свадьбы» (editEventDialog.js).

import { h } from '../dom.js';
import { api } from '../api.js';

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

/** «Алина + Дима» → [«Алина», «Дима»] — обратная операция к composeTitle (ТЗ 09, §1). */
function splitNames(value) {
  const parts = value.trim().split(/\s*\+\s*/).map((s) => s.trim()).filter(Boolean);
  return [parts[0] || null, parts.slice(1).join(' + ') || null];
}

/**
 * @param {{ opener: HTMLElement, onCreated: (result: {eventId: string, planStatus: string}) => void }} opts
 */
export function openCreateDialog({ opener, onCreated }) {
  let idempotencyKey = newKey();
  let saving = false;
  let titleEditing = false;
  let datePrecision = 'day'; // 'day' | 'month' | 'none'

  // ---------- основное ----------

  const namesInput = h('input', {
    type: 'text', class: 'input', autocomplete: 'off', placeholder: 'Алина + Дима', maxlength: String(NAME_MAX * 2 + 10),
  });
  const namesField = field({ id: 'new-event-names', label: 'Имена пары', input: namesInput });

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
      namesField.wrap,
      titleRow,
      titleField.wrap,
      h('div', { class: 'field' }, h('span', { class: 'field__label' }, 'Дата свадьбы'), dateModeRow),
      dateDayField.wrap,
      dateMonthField.wrap,
      locationField.wrap,
      planRow,
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
    const [p1, p2] = splitNames(namesInput.value);
    const composed = composeTitle(p1, p2);
    titlePreview.textContent = composed ? `Свадьба: ${composed}` : 'Свадьба: —';
  }
  updateTitlePreview();

  titleToggle.addEventListener('click', () => {
    titleEditing = true;
    titleRow.hidden = true;
    titleField.wrap.hidden = false;
    if (!titleInput.value.trim()) titleInput.value = composeTitle(...splitNames(namesInput.value));
    titleInput.focus();
  });

  const namesError = () => (namesInput.value.trim() || titleInput.value.trim() ? null : 'Укажите хотя бы одно имя');

  function validate({ show }) {
    const nErr = namesError();
    const [p1, p2] = splitNames(namesInput.value);
    const namesErr = (p1 && [...p1].length > NAME_MAX) || (p2 && [...p2].length > NAME_MAX)
      ? `Каждое имя — не более ${NAME_MAX} символов` : null;
    const titleErr = [...titleInput.value.trim()].length > TITLE_MAX ? `Не более ${TITLE_MAX} символов` : null;
    const locErr = [...locationInput.value.trim()].length > LOCATION_MAX ? `Не более ${LOCATION_MAX} символов` : null;
    const dateErr = datePrecision === 'day' && dateDay.value && dateDay.validity.badInput ? 'Укажите дату полностью' : null;

    namesField.setError(namesErr || (show ? nErr : null));
    titleField.setError(titleErr);
    locationField.setError(locErr);
    dateDayField.setError(dateErr);

    submit.disabled = saving || Boolean(nErr || namesErr || titleErr || locErr || dateErr);
    return !(nErr || namesErr || titleErr || locErr || dateErr);
  }

  function setSaving(on) {
    saving = on;
    submit.textContent = on ? 'Создаём…' : 'Создать свадьбу';
    submit.setAttribute('aria-busy', on ? 'true' : 'false');
    for (const el of [namesInput, titleInput, dateDay, dateMonth, locationInput, planCheckbox, cancel]) el.disabled = on;
    for (const r of dateModeRadios) r.querySelector('input').disabled = on;
    if (!on) validate({ show: false });
  }

  const isDirty = () => Boolean(
    namesInput.value.trim() || titleInput.value.trim() || dateDay.value || dateMonth.value
    || locationInput.value.trim() || !planCheckbox.checked,
  );

  function values() {
    const eventDate = datePrecision === 'day' ? (dateDay.value || null)
      : datePrecision === 'month' ? (dateMonth.value ? `${dateMonth.value}-01` : null) : null;
    const [partner1Name, partner2Name] = splitNames(namesInput.value);
    return {
      partner1Name,
      partner2Name,
      title: titleEditing ? titleInput.value.trim() : '',
      titleIsCustom: titleEditing,
      eventDate,
      eventDatePrecision: eventDate ? datePrecision : null,
      locationName: locationInput.value,
      applyPlan: planCheckbox.checked,
    };
  }

  function hideConfirm() {
    confirmBox.hidden = true;
    namesInput.focus();
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

  namesInput.addEventListener('input', () => { banner.hidden = true; updateTitlePreview(); validate({ show: false }); });
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
        namesField.setError(err.fields.partner1Name ?? err.fields.partner2Name ?? null);
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
  namesInput.focus();
}
