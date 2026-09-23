// Диалог «Новая свадьба» (спецификация экрана 01, раздел 5). Нативный <dialog>: Escape, модальность,
// возврат фокуса на кнопку-источник. На узком экране — полноэкранный sheet (CSS).

import { h } from '../dom.js';
import { api } from '../api.js';

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

function titleError(value) {
  const t = value.trim();
  if (!t) return 'Укажите название проекта';
  if ([...t].length > TITLE_MAX) return `Не более ${TITLE_MAX} символов`;
  return null;
}

/**
 * @param {{ opener: HTMLElement, onCreated: (result: {eventId: string, planStatus: string}) => void }} opts
 */
export function openCreateDialog({ opener, onCreated }) {
  let idempotencyKey = newKey();
  let saving = false;
  let titleTouched = false;

  const titleInput = h('input', {
    type: 'text', class: 'input', name: 'title', autocomplete: 'off', required: true,
    maxlength: String(TITLE_MAX + 20), placeholder: 'Например, Анна + Максим',
  });
  const dateInput = h('input', { type: 'date', class: 'input', name: 'eventDate' });
  const unknownDate = h('input', { type: 'checkbox', name: 'dateUnknown', id: 'new-event-date-unknown' });
  const locationInput = h('input', {
    type: 'text', class: 'input', name: 'locationName', autocomplete: 'off',
    maxlength: String(LOCATION_MAX + 20), placeholder: 'Например, загородная площадка «Лес»',
  });

  const titleField = field({ id: 'new-event-title', label: 'Название проекта', input: titleInput });
  const dateField = field({ id: 'new-event-date', label: 'Дата свадьбы', input: dateInput, hint: 'Необязательно' });
  const locationField = field({ id: 'new-event-location', label: 'Место', input: locationInput, hint: 'Необязательно' });

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
      titleField.wrap,
      dateField.wrap,
      h('label', { class: 'checkbox', for: 'new-event-date-unknown' }, unknownDate, h('span', {}, 'Дата пока неизвестна')),
      locationField.wrap,
    ),
    confirmBox,
    h('div', { class: 'dialog__foot' }, cancel, submit),
  );

  const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': 'new-event-heading' }, form);

  const values = () => ({
    title: titleInput.value,
    eventDate: unknownDate.checked ? null : (dateInput.value || null),
    locationName: locationInput.value,
  });
  const isDirty = () => Boolean(titleInput.value.trim() || dateInput.value || unknownDate.checked || locationInput.value.trim());

  function validate({ show }) {
    const tErr = titleError(titleInput.value);
    const lErr = [...locationInput.value.trim()].length > LOCATION_MAX ? `Не более ${LOCATION_MAX} символов` : null;
    const dErr = !unknownDate.checked && dateInput.validity.badInput ? 'Укажите дату полностью' : null;
    if (show || titleTouched) titleField.setError(tErr);
    locationField.setError(lErr);
    dateField.setError(dErr);
    submit.disabled = saving || Boolean(tErr || lErr || dErr);
    return !(tErr || lErr || dErr);
  }

  function setSaving(on) {
    saving = on;
    submit.textContent = on ? 'Создаём…' : 'Создать свадьбу';
    submit.setAttribute('aria-busy', on ? 'true' : 'false');
    for (const el of [titleInput, dateInput, unknownDate, locationInput, cancel]) el.disabled = on;
    if (!on) dateInput.disabled = unknownDate.checked;
    validate({ show: false });
  }

  function hideConfirm() {
    confirmBox.hidden = true;
    titleInput.focus();
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

  titleInput.addEventListener('input', () => { banner.hidden = true; validate({ show: false }); });
  titleInput.addEventListener('blur', () => { titleTouched = true; validate({ show: false }); });
  locationInput.addEventListener('input', () => validate({ show: false }));
  dateInput.addEventListener('input', () => validate({ show: false }));
  unknownDate.addEventListener('change', () => {
    dateInput.disabled = unknownDate.checked;
    if (unknownDate.checked) dateInput.value = '';
    validate({ show: false });
  });

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
    titleTouched = true;
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
        titleField.setError(err.fields.title ?? null);
        dateField.setError(err.fields.eventDate ?? null);
        locationField.setError(err.fields.locationName ?? null);
        form.querySelector('[aria-invalid="true"]')?.focus();
        // Ничего не создано — следующий запрос может идти с новым ключом.
        idempotencyKey = newKey();
      } else {
        // Сетевой сбой: результат неизвестен, повтор идёт с тем же ключом — дубля не будет.
        banner.textContent = err.status === 403
          ? 'Нет права создавать проекты.'
          : 'Не удалось создать свадьбу. Повторите попытку.';
        banner.hidden = false;
      }
    }
  });

  document.body.append(dialog);
  dialog.showModal();
  titleInput.focus();
}
