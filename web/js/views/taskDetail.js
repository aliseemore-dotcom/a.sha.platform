// Карточка задачи (docs/specs/03-tasks.md, §5.2–5.3): отдельный маршрут, работает после
// перезагрузки и в новой вкладке. Кнопка закрытия называется по месту входа — «Вернуться к
// задачам» из списка, «Вернуться к проекту» из обзора — «Закрыть задачу» запрещено спецификацией
// как двусмысленное.

import { h, clear, announce } from '../dom.js';
import { api } from '../api.js';
import { statusChip, safeListPath } from '../ui/components.js';
import { openTaskDialog } from '../ui/taskDialog.js';
import { STATUS_WORD, CLOSED_STATUSES, BLOCKED_CHIP } from '../taskStatus.js';
import { fullDate, dateTimeIn, attentionLabel } from '../format.js';

const KIND_TONE = { overdue: 'blocked', blocked: 'blocked', due_today: 'soon' };

function dueText(task, timeZone) {
  if (task.dueAt) return dateTimeIn(Date.parse(task.dueAt), timeZone);
  if (task.dueDate) return `${fullDate(task.dueDate)}, до конца дня`;
  return null;
}

/** Контекст возврата: реальный источник входа, а не всегда один и тот же путь (§5.3). */
function backContext(eventId, fromParam, overviewUrl) {
  const listPrefix = `/events/${encodeURIComponent(eventId)}/tasks`;
  const safeFrom = safeListPath(fromParam);
  if (safeFrom && safeFrom.startsWith(listPrefix)) return { href: safeFrom, label: 'Вернуться к задачам' };
  if (safeFrom) return { href: safeFrom, label: 'Вернуться к проекту' };
  return { href: overviewUrl, label: 'Вернуться к проекту' };
}

export function renderTaskDetail(slot, { params, query }) {
  const { eventId, taskId } = params;
  const overviewUrl = `/events/${encodeURIComponent(eventId)}/overview`;
  const backToList = safeListPath(query.get('from')) ?? '/events';
  const back = backContext(eventId, query.get('from'), overviewUrl);

  const main = h('main', { id: 'main', class: 'container page', 'aria-busy': 'true' });
  slot.append(main);
  let controller = new AbortController();
  let project = null;
  let task = null;

  async function load() {
    controller.abort();
    controller = new AbortController();
    const { signal } = controller;
    try {
      const [eventData, taskData] = await Promise.all([
        api.getEvent(eventId, { signal }),
        api.getTask(eventId, taskId, { signal }),
      ]);
      project = {
        title: eventData.event.title, lifecycle: eventData.event.lifecycle, teamMembers: eventData.teamMembers,
        timeZone: eventData.timeZone,
      };
      task = taskData;
      render();
    } catch (err) {
      if (err.name === 'AbortError') return;
      clear(main);
      main.removeAttribute('aria-busy');
      if (err.status === 404 || err.status === 403) {
        main.append(h('div', { class: 'empty', role: 'alert' },
          h('p', { class: 'empty__title' }, err.status === 404 && project ? 'Задача больше недоступна' : 'Проект не найден или доступ к нему закрыт'),
          h('p', { class: 'empty__text' }, 'Её удалили или закрыли к ней доступ.'),
          h('div', { class: 'task-missing__actions' },
            project ? h('a', { class: 'btn btn--secondary', href: overviewUrl }, 'Открыть проект') : null,
            h('a', { class: 'btn btn--ghost', href: backToList }, 'К списку мероприятий'))));
      } else {
        main.append(h('div', { class: 'empty', role: 'alert' },
          h('p', { class: 'empty__title' }, 'Не удалось загрузить задачу'),
          h('button', { type: 'button', class: 'btn btn--secondary', onclick: load }, 'Повторить')));
      }
    }
  }

  async function completeToggle(button) {
    const willComplete = !CLOSED_STATUSES.has(task.status);
    button.disabled = true;
    const original = button.textContent;
    button.textContent = 'Сохраняем…';
    try {
      task = willComplete ? await api.completeTask(eventId, taskId) : await api.restoreTask(eventId, taskId);
      announce(willComplete ? 'Задача отмечена выполненной' : 'Задача возвращена в работу', 0);
      render();
    } catch {
      button.disabled = false;
      button.textContent = original;
      announce('Не удалось сохранить. Повторите попытку.', 0);
    }
  }

  function openEdit(opener) {
    openTaskDialog({
      opener, eventId, task, teamMembers: project.teamMembers,
      onSaved: (saved) => { task = saved; render(); announce('Изменения сохранены', 0); },
    });
  }

  function render() {
    clear(main);
    main.removeAttribute('aria-busy');
    document.title = `${task.title} — ${project.title}`;

    const [tone, word] = STATUS_WORD[task.status] ?? ['planned', task.status];
    const due = dueText(task, project.timeZone);
    const attentionKind = task.attentionKind;
    let attentionChip = null;
    if (attentionKind === 'blocked') attentionChip = statusChip(BLOCKED_CHIP[0], BLOCKED_CHIP[1], { size: 'detail' });
    else if (attentionKind) {
      const { label } = attentionLabel({ kind: attentionKind, dueAt: task.dueAt, dueDate: task.dueDate }, project.timeZone, Date.now());
      attentionChip = statusChip(KIND_TONE[attentionKind], label, { size: 'detail' });
    }

    const rows = [
      due ? ['Срок выполнения', due] : null,
      ['Ответственный', task.assigneeName ?? 'Не назначен'],
      task.description ? ['Описание', task.description] : null,
      task.isBlocked && task.blockedReason ? ['Причина блокировки', task.blockedReason] : null,
      task.status === 'waiting' && task.waitingFrom ? ['Ждём от', task.waitingFrom] : null,
      task.status === 'waiting' && task.followUpAt ? ['Контроль ответа', fullDate(task.followUpAt.slice(0, 10))] : null,
      task.completedAt ? ['Завершено', dateTimeIn(Date.parse(task.completedAt), project.timeZone)] : null,
      task.completedAt && task.completedByName ? ['Кем завершено', task.completedByName] : null,
    ].filter(Boolean);

    const canEdit = project.lifecycle === 'active';
    const editBtn = canEdit
      ? h('button', { type: 'button', class: 'btn btn--secondary', onclick: (e) => openEdit(e.currentTarget) }, 'Редактировать')
      : null;
    const toggleBtn = canEdit
      ? h('button', {
        type: 'button', class: 'btn btn--primary',
        onclick: (e) => completeToggle(e.currentTarget),
      }, CLOSED_STATUSES.has(task.status) ? 'Вернуть в работу' : 'Отметить выполненной')
      : null;

    main.append(
      h('p', { class: 'back' }, h('a', { href: back.href, class: 'link' }, `← ${back.label}`)),
      h('section', { class: 'task-panel', 'aria-labelledby': 'task-title', tabindex: '-1' },
        h('p', { class: 'overline' }, h('a', { href: overviewUrl, class: 'task-panel__project-link' }, project.title)),
        h('h1', { class: 'task-panel__title', id: 'task-title' }, task.title),
        h('div', { class: 'task-panel__chips' }, statusChip(tone, word, { size: 'detail' }), attentionChip),
        h('dl', { class: 'task-panel__facts' },
          rows.map(([k, v]) => h('div', { class: 'task-panel__fact' }, h('dt', {}, k), h('dd', {}, v)))),
        !canEdit ? h('p', { class: 'caption' }, 'Проект в архиве — задача доступна только для просмотра') : null,
        h('div', { class: 'task-panel__actions' }, toggleBtn, editBtn,
          h('a', { class: 'btn btn--secondary', href: back.href }, `← ${back.label}`)),
      ),
    );
    main.querySelector('.task-panel').focus();
  }

  load();
  return () => controller.abort();
}
