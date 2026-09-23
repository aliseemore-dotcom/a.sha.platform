// Обзор мероприятия (спецификация v1): организатор за секунды видит, что требует решения,
// что реально выполняется и где ждём ответа, и переходит к нужной задаче. Использует те же
// компоненты и функцию срочности, что и «Мои мероприятия», чтобы число и статус совпадали.

import { h, clear, announce } from '../dom.js';
import { api } from '../api.js';
import { attentionRow, statusChip, taskRow, withFrom } from '../ui/components.js';
import {
  fullDate, dateTimeIn, attentionLabel, projectStage, relativeDay,
} from '../format.js';
import { defaultListLimit } from '../breakpoints.js';

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

function shortDue(task, timeZone) {
  if (task.dueAt) return `Срок: ${dateTimeIn(Date.parse(task.dueAt), timeZone)}`;
  if (task.dueDate) return `Срок: ${fullDate(task.dueDate)}`;
  return null;
}

/** Только внутренние пути списка: `/events...`, не открытый редирект и не JS-адрес. */
function safeListPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/events') || value.startsWith('//') || value.includes('\\')) {
    return null;
  }
  return value;
}

function dueSort(a, b) {
  const da = a.dueAt ? Date.parse(a.dueAt) : a.dueDate ? Date.parse(`${a.dueDate}T23:59:59`) : null;
  const db = b.dueAt ? Date.parse(b.dueAt) : b.dueDate ? Date.parse(`${b.dueDate}T23:59:59`) : null;
  if (da === db) return 0;
  if (da === null) return 1;
  if (db === null) return -1;
  return da - db;
}

export function renderOverview(slot, { params, session, query }) {
  const flash = history.state?.flash ?? null;
  if (flash) history.replaceState({ ...history.state, flash: null }, '');
  const taskId = params.taskId ?? null;
  const backToList = safeListPath(query.get('from')) ?? '/events';
  const overviewUrl = withFrom(`/events/${encodeURIComponent(params.eventId)}/overview`, query.get('from'));
  const taskUrl = (id) => withFrom(`/events/${encodeURIComponent(params.eventId)}/tasks/${encodeURIComponent(id)}`, query.get('from'));
  const canArchive = session.user.role === 'owner';
  const canRetryPlan = session.permissions.createEvent;

  const main = h('main', { id: 'main', class: 'container page', 'aria-busy': 'true' });
  slot.append(main);
  let controller = new AbortController();
  let firstRender = true;
  let requiresExpanded = false;

  const back = () => h('p', { class: 'back' }, h('a', { href: backToList, class: 'link' }, '← Мои мероприятия'));

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
          h('a', { class: 'btn btn--secondary', href: backToList }, 'К списку мероприятий')));
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

  // ---------- панель одной задачи ----------

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
      task.status === 'waiting' && task.waitingFrom ? ['Ждём от', task.waitingFrom] : null,
      task.status === 'waiting' && task.followUpAt ? ['Контрольная дата', fullDate(task.followUpAt.slice(0, 10))] : null,
    ].filter(Boolean);

    const canComplete = !CLOSED.has(task.status) && event.lifecycle === 'active';
    const completeBtn = canComplete
      ? h('button', {
        type: 'button', class: 'btn btn--primary',
        onclick: async (e) => {
          const b = e.currentTarget;
          b.disabled = true;
          const original = b.textContent;
          b.textContent = 'Сохраняем…';
          try {
            await api.completeTask(event.id, task.id);
            announce('Задача отмечена выполненной', 0);
            load();
          } catch {
            b.disabled = false;
            b.textContent = original;
            status.textContent = 'Не удалось сохранить. Повторите попытку.';
          }
        },
      }, 'Отметить выполненной')
      : null;

    return h('section', { class: 'task-panel', 'aria-labelledby': 'task-title', tabindex: '-1' },
      h('p', { class: 'overline' }, h('a', { href: overviewUrl, class: 'task-panel__project-link' }, event.title)),
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

  // ---------- меню действий проекта ----------
  // Один обработчик клика вне меню на весь экран, а не по одному на каждый render/меню.
  let closeProjectMenu = () => {};
  const onDocumentClick = (e) => closeProjectMenu(e.target);
  document.addEventListener('click', onDocumentClick, { capture: true });

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
      title: 'Действия с проектом',
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

  // ---------- разделы обзора ----------

  /** «Требует решения»: та же функция срочности, что на «Мои мероприятия» — число и статус совпадают. */
  function requiresSection(attention, archived, timeZone, now) {
    const limit = defaultListLimit();
    const rows = requiresExpanded ? attention : attention.slice(0, limit);
    const toggle = attention.length > limit
      ? h('button', {
        type: 'button', class: 'btn btn--secondary btn--small',
        'aria-expanded': String(requiresExpanded),
        onclick: () => { requiresExpanded = !requiresExpanded; renderFrom(lastData); },
      }, requiresExpanded ? 'Свернуть' : `Показать все ${attention.length}`)
      : null;
    return h('section', {
      class: 'zone', id: 'section-requires', 'aria-labelledby': 'zone-requires', tabindex: '-1',
    },
      h('h2', { class: 'zone__title', id: 'zone-requires' }, `Требует решения${attention.length ? ` · ${attention.length}` : ''}`),
      attention.length
        ? [h('ol', { class: 'attention__list attention__list--light' }, rows.map((i) => attentionRow(i, timeZone, now))), toggle]
        : h('p', { class: 'muted' }, archived ? 'Проект в архиве' : 'Сейчас нет задач, требующих срочного решения'),
    );
  }

  /** «Сейчас в работе»: только in_progress; следующее действие не придумывается, если его нет в данных. */
  function workSection(tasks, timeZone) {
    const rows = tasks
      .filter((t) => t.status === 'in_progress')
      .sort((a, b) => dueSort(a, b) || (a.updatedAt < b.updatedAt ? 1 : -1));
    return h('section', { class: 'zone', id: 'section-work', 'aria-labelledby': 'zone-work', tabindex: '-1' },
      h('h2', { class: 'zone__title', id: 'zone-work' }, `В работе${rows.length ? ` · ${rows.length}` : ''}`),
      rows.length
        ? h('ol', { class: 'attention__list attention__list--light' }, rows.map((t) => {
          const due = shortDue(t, timeZone);
          const meta = [t.assigneeName ?? 'Не назначен', due].filter(Boolean).join(' · ');
          return taskRow({
            href: taskUrl(t.id), tone: 'progress', chipLabel: 'В работе', title: t.title, meta,
            tooltip: [t.title, meta].join('. '),
          });
        }))
        : h('p', { class: 'muted' }, 'Пока нет задач в работе'),
    );
  }

  /**
   * «Ждём ответа»: только явный статус waiting. «Ждём ответа от …» — только если источник
   * (waitingFrom) есть в данных; контрольная дата — только если хранится followUpAt.
   * Не путать со статусом «Заблокировано» и не выводить «Нужно напомнить» самостоятельно.
   */
  function waitingSection(tasks, timeZone) {
    const rows = tasks.filter((t) => t.status === 'waiting');
    return h('section', { class: 'zone', id: 'section-waiting', 'aria-labelledby': 'zone-waiting', tabindex: '-1' },
      h('h2', { class: 'zone__title', id: 'zone-waiting' }, `Ждём ответа${rows.length ? ` · ${rows.length}` : ''}`),
      rows.length
        ? h('ol', { class: 'attention__list attention__list--light' }, rows.map((t) => {
          const chipLabel = t.waitingFrom ? `Ждём: ${t.waitingFrom}` : 'Ждём ответа';
          const meta = [
            `Ответственный: ${t.assigneeName ?? 'Не назначен'}`,
            t.followUpAt ? `Контроль: ${fullDate(t.followUpAt.slice(0, 10))}` : null,
          ].filter(Boolean).join(' · ');
          return taskRow({
            href: taskUrl(t.id), tone: 'soon', chipLabel, title: t.title, meta,
            tooltip: [chipLabel, t.title, meta].join('. '),
          });
        }))
        : h('p', { class: 'muted' }, 'Сейчас никого не ждём'),
    );
  }

  /** Компактное превью ≤5 самых релевантных незавершённых задач — не повтор всей таблицы. */
  function previewSection(tasks, requiresIds) {
    const rank = (t) => (requiresIds.has(t.id) ? 0 : t.status === 'in_progress' ? 1 : t.status === 'waiting' ? 2 : 3);
    const rows = tasks
      .filter((t) => !CLOSED.has(t.status))
      .sort((a, b) => rank(a) - rank(b) || dueSort(a, b))
      .slice(0, 5);
    return h('section', { class: 'zone', 'aria-labelledby': 'zone-preview' },
      h('div', { class: 'zone__head' },
        h('h2', { class: 'zone__title', id: 'zone-preview' }, 'Ближайшие задачи'),
        tasks.length ? h('a', { class: 'link', href: '#all-tasks' }, 'Все задачи →') : null,
      ),
      rows.length
        ? h('ul', { class: 'plan-list' }, rows.map((t) => {
          const [tone, word] = STATUS_WORD[t.status] ?? ['planned', t.status];
          return h('li', { class: 'plan-item' },
            h('a', { href: taskUrl(t.id), class: 'plan-item__link' }, t.title),
            statusChip(tone, word));
        }))
        : h('p', { class: 'muted' }, tasks.length ? 'Все задачи выполнены или отменены' : 'Задач пока нет'),
    );
  }

  function allTasksSection(tasks, focusTaskId) {
    const bySection = new Map();
    for (const t of tasks) {
      const key = t.section ?? 'Прочее';
      if (!bySection.has(key)) bySection.set(key, []);
      bySection.get(key).push(t);
    }
    return h('section', { class: 'zone', id: 'all-tasks', 'aria-labelledby': 'zone-all', tabindex: '-1' },
      h('h2', { class: 'zone__title', id: 'zone-all' }, 'Все задачи'),
      tasks.length
        ? [...bySection].map(([section, list]) => h('div', { class: 'plan-group' },
          h('h3', { class: 'overline' }, section),
          h('ul', { class: 'plan-list' }, list.map((t) => {
            const [tone, word] = STATUS_WORD[t.status] ?? ['planned', t.status];
            return h('li', { class: `plan-item${t.id === focusTaskId ? ' plan-item--focus' : ''}` },
              h('a', { href: taskUrl(t.id), class: 'plan-item__link', 'aria-current': t.id === focusTaskId ? 'true' : null }, t.title),
              statusChip(tone, word));
          }))))
        : h('p', { class: 'muted' }, 'Задач пока нет'),
    );
  }

  // ---------- сборка страницы ----------

  let lastData = null;

  function renderFrom(data) {
    render(data);
  }

  function render({ event, attention, tasks, timeZone }) {
    lastData = { event, attention, tasks, timeZone };
    clear(main);
    main.removeAttribute('aria-busy');
    const task = taskId ? tasks.find((t) => t.id === taskId) : null;
    document.title = task ? `${task.title} — ${event.title}` : `${event.title} — обзор`;
    const now = Date.now();
    const archived = event.lifecycle === 'archived';

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
          h('a', { class: 'btn btn--ghost', href: backToList }, 'К списку мероприятий')));
    } else if (task) {
      taskSection = taskPanel(event, task, attention.find((i) => i.id === task.id), timeZone, now);
    }

    // Шапка: тип, название, стадия проекта (та же функция, что и на карточке списка),
    // дата/площадка, «через N дней»/«Сегодня» только для будущего активного события.
    const stage = projectStage(event, timeZone, now);
    const dateText = event.eventDate ? fullDate(event.eventDate) : 'Дата уточняется';
    const rel = event.eventDate && event.lifecycle === 'active' ? relativeDay(event.eventDate, timeZone, now) : null;
    const metaText = [dateText, event.locationName].filter(Boolean).join(' · ');

    const inProgressCount = tasks.filter((t) => t.status === 'in_progress').length;
    const waitingCount = tasks.filter((t) => t.status === 'waiting').length;
    const statRow = h('nav', { class: 'stat-row', 'aria-label': 'Сводка по проекту' },
      h('a', { class: 'stat', href: '#section-requires' },
        h('span', { class: 'stat__num' }, attention.length), h('span', { class: 'stat__label' }, 'Срочно решить')),
      h('a', { class: 'stat', href: '#section-work' },
        h('span', { class: 'stat__num' }, inProgressCount), h('span', { class: 'stat__label' }, 'В работе')),
      h('a', { class: 'stat', href: '#section-waiting' },
        h('span', { class: 'stat__num' }, waitingCount), h('span', { class: 'stat__label' }, 'Ждём ответа')),
    );

    const menu = canArchive ? projectMenu(event) : null;
    const requiresIds = new Set(attention.map((i) => i.id));

    // main.append — нативный Element.append, а не наш h()-хелпер: null стал бы текстом "null"
    // вместо того, чтобы просто отсутствовать, поэтому пустые слоты отфильтровываются явно.
    main.append(...[
      back(),
      ...banners,
      h('section', { class: 'overview-head' },
        event.coverUrl ? h('img', { class: 'overview-cover', src: event.coverUrl, alt: '' }) : null,
        h('div', { class: 'overview-head__row' },
          h('div', {},
            h('p', { class: 'overline' }, 'Свадьба'),
            h('h1', { class: 'page-title' }, event.title),
          ),
          menu,
        ),
        h('div', { class: 'overview-meta' },
          statusChip(stage.tone, stage.label),
          h('span', { class: 'overview-meta__text' }, metaText),
          rel ? h('span', { class: 'overview-meta__rel' }, rel) : null,
        ),
      ),
      statRow,
      taskSection,
      requiresSection(attention, archived, timeZone, now),
      h('div', { class: 'zones' }, workSection(tasks, timeZone), waitingSection(tasks, timeZone)),
      previewSection(tasks, requiresIds),
      allTasksSection(tasks, taskId),
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
