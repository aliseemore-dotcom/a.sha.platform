// Обзор проекта — минимальная версия, достаточная для переходов с экрана 01:
// подтверждение создания, состояние плана, панель конкретной задачи (/events/:id/tasks/:taskId),
// блок «Срочно решить», архив/восстановление. Полный обзор описывается следующей спецификацией.

import { h, clear, announce } from '../dom.js';
import { api } from '../api.js';
import { attentionRow, statusChip } from '../ui/components.js';
import { fullDate, dateTimeIn, attentionLabel } from '../format.js';

const STATUS_WORD = {
  planned: ['planned', 'Запланировано'],
  in_progress: ['progress', 'В работе'],
  waiting: ['soon', 'Ждём ответа'],
  blocked: ['blocked', 'Заблокировано'],
  done: ['done', 'Готово'],
  cancelled: ['planned', 'Отменено'],
};

const CLOSED = new Set(['done', 'cancelled']);
const KIND_TONE = { overdue: 'blocked', blocked: 'blocked', due_today: 'soon' };

function dueText(task, timeZone) {
  if (task.dueAt) return dateTimeIn(Date.parse(task.dueAt), timeZone);
  if (task.dueDate) return `${fullDate(task.dueDate)}, до конца дня`;
  return null;
}

export function renderOverview(slot, { params, session }) {
  const flash = history.state?.flash ?? null;
  if (flash) history.replaceState({ ...history.state, flash: null }, '');
  const taskId = params.taskId ?? null;
  const overviewUrl = `/events/${encodeURIComponent(params.eventId)}/overview`;
  const canArchive = session.user.role === 'owner';
  const canRetryPlan = session.permissions.createEvent;

  const main = h('main', { id: 'main', class: 'container page', 'aria-busy': 'true' });
  slot.append(main);
  let controller = new AbortController();
  let firstRender = true;

  const back = () => h('p', { class: 'back' }, h('a', { href: '/events', class: 'link' }, '← Мои мероприятия'));

  async function load() {
    controller.abort();
    controller = new AbortController();
    try {
      const data = await api.getEvent(params.eventId, { signal: controller.signal });
      render(data);
    } catch (err) {
      if (err.name === 'AbortError') return;
      clear(main);
      main.removeAttribute('aria-busy');
      if (err.status === 404 || err.status === 403) {
        main.append(back(), h('div', { class: 'empty', role: 'alert' },
          h('p', { class: 'empty__title' }, 'Проект не найден или доступ к нему закрыт'),
          h('a', { class: 'btn btn--secondary', href: '/events' }, 'К списку мероприятий')));
      } else {
        main.append(back(), h('div', { class: 'empty', role: 'alert' },
          h('p', { class: 'empty__title' }, 'Не удалось загрузить проект'),
          h('button', { type: 'button', class: 'btn btn--secondary', onclick: load }, 'Повторить')));
      }
    }
  }

  async function lifecycleAction(kind, button) {
    button.disabled = true;
    try {
      if (kind === 'archive') await api.archiveEvent(params.eventId);
      else await api.restoreEvent(params.eventId);
      announce(kind === 'archive' ? 'Проект перемещён в архив' : 'Проект возвращён в активные', 0);
      load();
    } catch {
      button.disabled = false;
      announce('Не удалось выполнить действие', 0);
    }
  }

  function taskPanel(event, task, signal, timeZone, now) {
    const [tone, word] = STATUS_WORD[task.status] ?? ['planned', task.status];
    const due = dueText(task, timeZone);
    const signalLabel = signal ? attentionLabel(signal, timeZone, now).label : null;
    const status = h('p', { class: 'task-panel__status', role: 'status' });

    const rows = [
      ['Проект', event.title],
      due ? ['Срок', due] : null,
      ['Ответственный', task.assigneeName ?? 'Не назначен'],
      task.section ? ['Раздел', task.section] : null,
      task.blockedReason ? ['Причина блокировки', task.blockedReason] : null,
    ].filter(Boolean);

    const canComplete = !CLOSED.has(task.status) && event.lifecycle === 'active';
    const completeBtn = canComplete
      ? h('button', {
        type: 'button', class: 'btn btn--primary',
        onclick: async (e) => {
          const b = e.currentTarget;
          b.disabled = true;
          try {
            await api.completeTask(event.id, task.id);
            announce('Задача отмечена выполненной', 0);
            load();
          } catch {
            b.disabled = false;
            status.textContent = 'Не удалось сохранить. Повторите попытку.';
          }
        },
      }, 'Отметить выполненной')
      : null;

    return h('section', { class: 'task-panel', 'aria-labelledby': 'task-title', tabindex: '-1' },
      h('p', { class: 'overline' }, 'Задача'),
      h('h2', { class: 'task-panel__title', id: 'task-title' }, task.title),
      h('div', { class: 'task-panel__chips' },
        statusChip(tone, word, { size: 'detail' }),
        signalLabel && signal.kind !== 'blocked'
          ? statusChip(KIND_TONE[signal.kind], signalLabel, { size: 'detail' })
          : null),
      h('dl', { class: 'task-panel__facts' },
        rows.map(([k, v]) => h('div', { class: 'task-panel__fact' }, h('dt', {}, k), h('dd', {}, v)))),
      status,
      h('div', { class: 'task-panel__actions' },
        completeBtn,
        h('a', { class: 'btn btn--secondary', href: overviewUrl }, 'Вернуться к проекту')),
    );
  }

  // Один обработчик клика вне меню на весь экран, а не по одному на каждый render/меню.
  let closeProjectMenu = () => {};
  const onDocumentClick = (e) => closeProjectMenu(e.target);
  document.addEventListener('click', onDocumentClick, { capture: true });

  /** Меню действий проекта — сейчас только архивирование/восстановление. */
  function projectMenu(event) {
    const archived = event.lifecycle === 'archived';
    const menuId = 'project-menu';
    const item = h('button', {
      type: 'button', role: 'menuitem', class: 'project-menu__item',
      onclick: (e) => {
        const b = e.currentTarget;
        if (!archived && !window.confirm(`Переместить «${event.title}» в архив?`)) return;
        setOpen(false);
        lifecycleAction(archived ? 'restore' : 'archive', b);
      },
    }, archived ? 'Вернуть в активные' : 'Переместить в архив');
    const panel = h('div', { class: 'project-menu__panel', id: menuId, role: 'menu', hidden: true }, item);
    const toggle = h('button', {
      type: 'button', class: 'icon-btn project-menu__toggle', 'aria-haspopup': 'true',
      'aria-expanded': 'false', 'aria-controls': menuId, 'aria-label': 'Действия с проектом',
    }, '⋮');
    const wrap = h('div', { class: 'project-menu' }, toggle, panel);
    function setOpen(open) {
      panel.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      if (open) item.focus();
    }
    toggle.addEventListener('click', () => setOpen(panel.hidden));
    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !panel.hidden) { setOpen(false); toggle.focus(); }
    });
    wrap.addEventListener('focusout', (e) => { if (!wrap.contains(e.relatedTarget)) setOpen(false); });
    closeProjectMenu = (target) => { if (!wrap.contains(target)) setOpen(false); };
    return wrap;
  }

  function render({ event, attention, tasks, timeZone }) {
    clear(main);
    main.removeAttribute('aria-busy');
    const task = taskId ? tasks.find((t) => t.id === taskId) : null;
    document.title = task ? `${task.title} — ${event.title}` : `${event.title} — обзор`;
    const now = Date.now();

    const banners = [];
    if (flash && firstRender) banners.push(h('div', { class: 'banner banner--success', role: 'status' }, flash));
    if (event.planStatus === 'pending') {
      banners.push(h('div', { class: 'banner banner--info', role: 'status' }, 'Создаём план подготовки'));
    }
    if (event.planStatus === 'failed') {
      banners.push(h('div', { class: 'banner banner--error', role: 'alert' },
        h('span', {}, 'План подготовки не создан.'),
        canRetryPlan ? h('button', {
          type: 'button', class: 'btn btn--secondary btn--small',
          onclick: async (e) => {
            e.currentTarget.disabled = true;
            await api.retryPlan(event.id).catch(() => null);
            load();
          },
        }, 'Повторить создание плана') : null));
    }

    let taskSection = null;
    if (taskId && !task) {
      taskSection = h('section', { class: 'empty task-missing', role: 'alert', tabindex: '-1' },
        h('p', { class: 'empty__title' }, 'Задача больше недоступна'),
        h('p', { class: 'empty__text' }, 'Её удалили или закрыли к ней доступ.'),
        h('div', { class: 'task-missing__actions' },
          h('a', { class: 'btn btn--secondary', href: overviewUrl }, 'Открыть проект'),
          h('a', { class: 'btn btn--ghost', href: '/events' }, 'К списку мероприятий')));
    } else if (task) {
      taskSection = taskPanel(event, task, attention.find((i) => i.id === task.id), timeZone, now);
    }

    const meta = [
      event.eventDate ? fullDate(event.eventDate) : 'Дата уточняется',
      event.locationName,
    ].filter(Boolean).join(' · ');

    const archived = event.lifecycle === 'archived';
    const menu = canArchive ? projectMenu(event) : null;

    const attentionSection = h('section', { class: 'zone', id: 'attention', 'aria-labelledby': 'zone-attention' },
      h('h2', { class: 'zone__title', id: 'zone-attention' }, `Срочно решить${attention.length ? ` · ${attention.length}` : ''}`),
      attention.length
        ? h('ol', { class: 'attention__list attention__list--light' }, attention.map((i) => attentionRow(i, timeZone, now)))
        : h('p', { class: 'muted' }, archived ? 'Проект в архиве' : 'Сейчас ничего не требует срочного решения'),
    );

    const bySection = new Map();
    for (const t of tasks) {
      const key = t.section ?? 'Прочее';
      if (!bySection.has(key)) bySection.set(key, []);
      bySection.get(key).push(t);
    }
    const planSection = h('section', { class: 'zone', 'aria-labelledby': 'zone-plan' },
      h('h2', { class: 'zone__title', id: 'zone-plan' }, 'Задачи проекта'),
      tasks.length
        ? [...bySection].map(([section, list]) => h('div', { class: 'plan-group' },
          h('h3', { class: 'overline' }, section),
          h('ul', { class: 'plan-list' }, list.map((t) => {
            const [tone, word] = STATUS_WORD[t.status] ?? ['planned', t.status];
            const href = `/events/${encodeURIComponent(event.id)}/tasks/${encodeURIComponent(t.id)}`;
            return h('li', { class: `plan-item${t.id === taskId ? ' plan-item--focus' : ''}` },
              h('a', { href, class: 'plan-item__link', 'aria-current': t.id === taskId ? 'true' : null }, t.title),
              statusChip(tone, word));
          }))))
        : h('p', { class: 'muted' }, 'Задач пока нет'),
    );

    // main.append — нативный Element.append, а не наш h()-хелпер: null превратился бы в текст
    // "null" вместо того, чтобы просто отсутствовать, поэтому пустые слоты отфильтровываются явно.
    main.append(...[
      back(),
      ...banners,
      h('section', { class: 'overview-head' },
        h('div', {},
          h('p', { class: 'overline' }, archived ? 'Свадьба · в архиве' : 'Свадьба'),
          h('h1', { class: 'page-title' }, event.title),
          h('p', { class: 'page-subtitle' }, meta),
        ),
        menu,
      ),
      taskSection,
      h('div', { class: 'zones' }, attentionSection, planSection),
      h('p', { class: 'caption muted' }, 'Полный обзор проекта — следующий этап.'),
    ].filter(Boolean));

    if (taskSection && firstRender) taskSection.focus();
    firstRender = false;
  }

  load();
  return () => {
    controller.abort();
    document.removeEventListener('click', onDocumentClick, { capture: true });
  };
}
