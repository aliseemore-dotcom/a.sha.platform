// Диалог «Новая задача» / «Редактировать задачу» («Задачи мероприятия», раздел 5.1). Нативный
// <dialog>: Escape, модальность, возврат фокуса на кнопку-источник. Поля контекстно появляются
// при статусе «Ждём ответа» и при включении «Заблокировано» — форма не заставляет заполнять
// всё ради быстрой задачи.

import { h } from '../dom.js';
import { api } from '../api.js';
import { TITLE_MAX, DESCRIPTION_MAX, BLOCKED_REASON_MAX, WAITING_FROM_MAX } from '../taskLimits.js';

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

/**
 * @param {{
 *   opener: HTMLElement, eventId: string, teamMembers: {id:string,name:string}[],
 *   task?: object, onSaved: (task: object) => void,
 * }} opts
 */
export function openTaskDialog({ opener, eventId, teamMembers, task = null, onSaved }) {
  const isEdit = Boolean(task);
  let idempotencyKey = newKey();
  let saving = false;
  let titleTouched = false;

  const titleInput = h('input', {
    type: 'text', class: 'input', name: 'title', autocomplete: 'off', required: true,
    maxlength: String(TITLE_MAX + 20), placeholder: 'Например, Согласовать меню',
    value: task?.title ?? '',
  });
  const descInput = h('textarea', {
    class: 'input', name: 'description', rows: '3', maxlength: String(DESCRIPTION_MAX + 100),
  });
  descInput.value = task?.description ?? '';

  const assigneeSelect = h('select', { class: 'input select', name: 'assigneeId' },
    h('option', { value: '' }, 'Не назначен'),
    teamMembers.map((u) => h('option', { value: u.id }, u.name)));
  assigneeSelect.value = task?.assigneeId ?? '';

  const statusSelect = h('select', { class: 'input select', name: 'status' },
    h('option', { value: 'todo' }, 'Не начато'),
    h('option', { value: 'in_progress' }, 'В работе'),
    h('option', { value: 'waiting' }, 'Ждём ответа'),
  );
  statusSelect.value = ['todo', 'in_progress', 'waiting'].includes(task?.status) ? task.status : 'todo';

  const hasDue = h('input', { type: 'checkbox', name: 'hasDue', id: 'task-has-due' });
  const dueDateInput = h('input', { type: 'date', class: 'input', name: 'dueDate' });
  const dueTimeInput = h('input', { type: 'time', class: 'input', name: 'dueTime' });
  if (task?.dueAt) {
    const d = new Date(task.dueAt);
    hasDue.checked = true;
    dueDateInput.value = d.toISOString().slice(0, 10);
    dueTimeInput.value = d.toISOString().slice(11, 16);
  } else if (task?.dueDate) {
    hasDue.checked = true;
    dueDateInput.value = task.dueDate;
  }

  const waitingFromInput = h('input', {
    type: 'text', class: 'input', name: 'waitingFrom', autocomplete: 'off',
    maxlength: String(WAITING_FROM_MAX + 20), placeholder: 'Например, Флорист',
    value: task?.waitingFrom ?? '',
  });
  const followUpInput = h('input', { type: 'date', class: 'input', name: 'followUpAt', value: task?.followUpAt?.slice(0, 10) ?? '' });

  const blockedCheckbox = h('input', { type: 'checkbox', name: 'isBlocked', id: 'task-is-blocked', checked: Boolean(task?.isBlocked) });
  const blockedReasonInput = h('input', {
    type: 'text', class: 'input', name: 'blockedReason', autocomplete: 'off',
    maxlength: String(BLOCKED_REASON_MAX + 20), value: task?.blockedReason ?? '',
  });

  const titleField = field({ id: 'task-title', label: 'Что нужно сделать', input: titleInput });
  const descField = field({ id: 'task-description', label: 'Описание', input: descInput, hint: 'Необязательно' });
  const assigneeField = field({ id: 'task-assignee', label: 'Ответственный', input: assigneeSelect });
  const dueDateField = field({ id: 'task-due-date', label: 'Дата', input: dueDateInput });
  const dueTimeField = field({ id: 'task-due-time', label: 'Время', input: dueTimeInput, hint: 'Необязательно' });
  const waitingFromField = field({ id: 'task-waiting-from', label: 'От кого ждём', input: waitingFromInput, hint: 'Необязательно' });
  const followUpField = field({ id: 'task-follow-up', label: 'Когда проверить ответ', input: followUpInput });
  const blockedReasonField = field({ id: 'task-blocked-reason', label: 'Причина блокировки', input: blockedReasonInput });

  const dueWrap = h('div', { class: 'field-row' }, dueDateField.wrap, dueTimeField.wrap);
  const dueSection = h('div', { class: 'field' },
    h('label', { class: 'checkbox', for: 'task-has-due' }, hasDue, h('span', {}, 'Срок выполнения')),
    dueWrap);
  const waitingSection = h('div', { hidden: true }, waitingFromField.wrap, followUpField.wrap);
  const blockedSection = h('div', { class: 'field' },
    h('label', { class: 'checkbox', for: 'task-is-blocked' }, blockedCheckbox, h('span', {}, 'Заблокировано')),
    h('div', { hidden: true }, blockedReasonField.wrap));
  const blockedReasonWrap = blockedSection.lastElementChild;

  const banner = h('div', { class: 'banner banner--error', role: 'alert', hidden: true });
  const submit = h('button', { type: 'submit', class: 'btn btn--primary' }, isEdit ? 'Сохранить' : 'Добавить задачу');
  const cancel = h('button', { type: 'button', class: 'btn btn--secondary' }, 'Отмена');

  const confirmBox = h('div', { class: 'confirm', hidden: true, role: 'alertdialog', 'aria-labelledby': 'task-confirm-text' },
    h('p', { id: 'task-confirm-text' }, 'Закрыть без сохранения? Введённые данные пропадут.'),
    h('div', { class: 'confirm__actions' },
      h('button', { type: 'button', class: 'btn btn--secondary', onclick: () => hideConfirm() }, 'Продолжить ввод'),
      h('button', { type: 'button', class: 'btn btn--primary', onclick: () => close(true) }, 'Закрыть'),
    ),
  );

  const heading = isEdit ? 'Редактировать задачу' : 'Новая задача';
  const form = h('form', { class: 'dialog__form', novalidate: true },
    h('div', { class: 'dialog__head' },
      h('h2', { class: 'dialog__title', id: 'task-dialog-heading' }, heading),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Закрыть', onclick: () => requestClose() }, '×'),
    ),
    h('div', { class: 'dialog__body' },
      banner,
      titleField.wrap,
      descField.wrap,
      assigneeField.wrap,
      h('div', { class: 'field' },
        h('label', { class: 'field__label', for: 'task-status' }, 'Статус'),
        statusSelect,
      ),
      dueSection,
      waitingSection,
      blockedSection,
    ),
    confirmBox,
    h('div', { class: 'dialog__foot' }, cancel, submit),
  );
  statusSelect.id = 'task-status';

  const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': 'task-dialog-heading' }, form);

  function syncContextFields() {
    dueWrap.hidden = !hasDue.checked;
    dueDateInput.disabled = !hasDue.checked;
    dueTimeInput.disabled = !hasDue.checked;
    waitingSection.hidden = statusSelect.value !== 'waiting';
    waitingFromInput.disabled = statusSelect.value !== 'waiting';
    followUpInput.disabled = statusSelect.value !== 'waiting';
    blockedReasonWrap.hidden = !blockedCheckbox.checked;
    blockedReasonInput.disabled = !blockedCheckbox.checked;
  }
  syncContextFields();

  const isDirty = () => Boolean(
    titleInput.value.trim() || descInput.value.trim() || assigneeSelect.value
    || hasDue.checked || waitingFromInput.value.trim() || followUpInput.value || blockedCheckbox.checked,
  );

  function validate({ show }) {
    const tErr = titleInput.value.trim() ? ([...titleInput.value.trim()].length > TITLE_MAX ? `Не более ${TITLE_MAX} символов` : null) : 'Укажите, что нужно сделать';
    const dueErr = hasDue.checked && dueDateInput.validity.badInput ? 'Укажите дату полностью' : null;
    const blockedErr = blockedCheckbox.checked && !blockedReasonInput.value.trim() ? 'Укажите причину блокировки' : null;
    if (show || titleTouched) titleField.setError(tErr);
    dueDateField.setError(dueErr);
    blockedReasonField.setError(blockedErr);
    submit.disabled = saving || Boolean(tErr || dueErr || blockedErr);
    return !(tErr || dueErr || blockedErr);
  }

  function setSaving(on) {
    saving = on;
    submit.textContent = on ? 'Сохраняем…' : (isEdit ? 'Сохранить' : 'Добавить задачу');
    submit.setAttribute('aria-busy', on ? 'true' : 'false');
    for (const el of [titleInput, descInput, assigneeSelect, statusSelect, hasDue, dueDateInput, dueTimeInput,
      waitingFromInput, followUpInput, blockedCheckbox, blockedReasonInput, cancel]) el.disabled = on;
    if (!on) syncContextFields();
    validate({ show: false });
  }

  function values() {
    const body = {
      title: titleInput.value,
      description: descInput.value,
      assigneeId: assigneeSelect.value || null,
      status: statusSelect.value,
      hasDue: hasDue.checked,
      dueDate: hasDue.checked ? dueDateInput.value : null,
      dueTime: hasDue.checked ? dueTimeInput.value : null,
      isBlocked: blockedCheckbox.checked,
      blockedReason: blockedCheckbox.checked ? blockedReasonInput.value : null,
    };
    if (statusSelect.value === 'waiting') {
      body.waitingFrom = waitingFromInput.value;
      body.followUpAt = followUpInput.value || null;
    }
    return body;
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
    if (!isEdit && isDirty()) {
      confirmBox.hidden = false;
      confirmBox.querySelector('button').focus();
    } else close();
  }

  titleInput.addEventListener('input', () => { banner.hidden = true; validate({ show: false }); });
  titleInput.addEventListener('blur', () => { titleTouched = true; validate({ show: false }); });
  hasDue.addEventListener('change', () => { syncContextFields(); validate({ show: false }); });
  dueDateInput.addEventListener('input', () => validate({ show: false }));
  statusSelect.addEventListener('change', () => { syncContextFields(); validate({ show: false }); });
  blockedCheckbox.addEventListener('change', () => { syncContextFields(); validate({ show: false }); if (blockedCheckbox.checked) blockedReasonInput.focus(); });
  blockedReasonInput.addEventListener('input', () => validate({ show: false }));

  cancel.addEventListener('click', requestClose);
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
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
      const body = values();
      const saved = isEdit
        ? await api.updateTask(eventId, task.id, { ...body, expectedUpdatedAt: task.updatedAt })
        : await api.createTask(eventId, { ...body, idempotencyKey });
      saving = false;
      dialog.close();
      onSaved(saved);
    } catch (err) {
      setSaving(false);
      if (err.status === 422 && err.fields) {
        titleField.setError(err.fields.title ?? null);
        assigneeField.setError(err.fields.assigneeId ?? null);
        dueDateField.setError(err.fields.dueDate ?? null);
        waitingFromField.setError(err.fields.waitingFrom ?? null);
        followUpField.setError(err.fields.followUpAt ?? null);
        blockedReasonField.setError(err.fields.blockedReason ?? null);
        form.querySelector('[aria-invalid="true"]')?.focus();
        if (!isEdit) idempotencyKey = newKey();
      } else if (err.status === 409) {
        banner.textContent = 'Задачу уже изменил другой участник. Обновите страницу и повторите правку.';
        banner.hidden = false;
      } else {
        banner.textContent = isEdit ? 'Не удалось сохранить изменения. Повторите попытку.' : 'Не удалось создать задачу. Повторите попытку.';
        banner.hidden = false;
      }
    }
  });

  document.body.append(dialog);
  dialog.showModal();
  titleInput.focus();
}
