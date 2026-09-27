// Диалог «Дата свадьбы изменилась» (docs/specs/07-wedding-setup.md, §1.3): показывает задачи
// стартового плана, чей срок был рассчитан от прежней даты, и даёт выбрать, какие обновить.
// Сервер ничего не пересчитывает сам — выбор и подтверждение здесь.

import { h } from '../dom.js';
import { api } from '../api.js';
import { fullDate } from '../format.js';

function newKey() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const dateText = (d) => (d ? fullDate(d) : 'без срока');

/**
 * @param {{ opener: HTMLElement, eventId: string, review: Array, onDone: () => void }} opts
 */
export function openDueDateReviewDialog({ opener, eventId, review, onDone }) {
  let idempotencyKey = newKey();
  let saving = false;
  const checked = new Set(review.filter((r) => !r.isManual).map((r) => r.taskId));

  const banner = h('div', { class: 'banner banner--error', role: 'alert', hidden: true });
  const submit = h('button', { type: 'submit', class: 'btn btn--primary' }, '');
  const keep = h('button', { type: 'button', class: 'btn btn--secondary' }, 'Оставить как есть');

  function updateSubmit() {
    const n = checked.size;
    submit.disabled = saving || n === 0;
    submit.textContent = saving ? 'Обновляем…' : `Обновить сроки (${n})`;
  }

  function row(r) {
    const id = `due-review-${r.taskId}`;
    const checkbox = h('input', {
      type: 'checkbox', id, checked: checked.has(r.taskId),
      onchange: (e) => {
        if (e.currentTarget.checked) checked.add(r.taskId);
        else checked.delete(r.taskId);
        updateSubmit();
      },
    });
    return h('li', { class: 'due-review-row' },
      h('label', { class: 'checkbox due-review-row__check', for: id }, checkbox,
        h('span', { class: 'due-review-row__title' }, r.title)),
      h('span', { class: 'due-review-row__dates' }, `${dateText(r.currentDueDate)} → ${dateText(r.proposedDueDate)}`),
      r.isManual ? h('span', { class: 'caption due-review-row__manual' }, 'срок меняли вручную') : null,
    );
  }

  const form = h('form', { class: 'dialog__form', novalidate: true },
    h('div', { class: 'dialog__head' },
      h('h2', { class: 'dialog__title', id: 'due-review-heading' }, 'Дата свадьбы изменилась'),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Закрыть', onclick: () => close() }, '×'),
    ),
    h('div', { class: 'dialog__body' },
      banner,
      h('p', { class: 'muted' }, 'Эти задачи стартового плана рассчитаны от прежней даты. Отметьте, каким обновить срок.'),
      h('ul', { class: 'due-review-list' }, review.map(row)),
    ),
    h('div', { class: 'dialog__foot' }, keep, submit),
  );

  const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': 'due-review-heading' }, form);

  function close() {
    if (saving) return;
    dialog.close();
  }

  keep.addEventListener('click', close);
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dialog.addEventListener('close', () => { dialog.remove(); opener?.focus(); });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (saving || !checked.size) return;
    saving = true;
    banner.hidden = true;
    updateSubmit();
    try {
      await api.rescheduleTasks(eventId, { taskIds: [...checked], idempotencyKey });
      saving = false;
      dialog.close();
      onDone();
    } catch {
      saving = false;
      updateSubmit();
      banner.textContent = 'Не удалось обновить сроки. Повторите попытку.';
      banner.hidden = false;
    }
  });

  document.body.append(dialog);
  dialog.showModal();
  updateSubmit();
  dialog.querySelector('input[type=checkbox]')?.focus();
}
