// Обзор мероприятия (спецификация v2): организатор за короткое время видит, что требует
// внимания, что реально выполняется и где ждём ответа, и переходит к нужной задаче. Каждая
// задача показывается на странице ровно один раз — приоритет размещения «Требует внимания» →
// «Ждём ответа» → «В работе» (§0). Использует те же компоненты и функцию срочности, что и
// «Мои мероприятия», чтобы число и статус совпадали.

import { h, clear, announce } from '../dom.js';
import { api } from '../api.js';
import {
  statusChip, taskRow, withFrom, safeListPath,
} from '../ui/components.js';
import { openChecklistPanel } from '../ui/checklistPanel.js';
import { openVendorPickerPanel } from '../ui/vendorPickerPanel.js';
import {
  fullDate, dateTimeIn, attentionLabel, projectStage, relativeDay, pluralize,
} from '../format.js';
import { defaultListLimit } from '../breakpoints.js';

const KIND_TONE = { overdue: 'blocked', blocked: 'blocked', due_today: 'soon' };

function shortDue(task, timeZone) {
  if (task.dueAt) return `Срок: ${dateTimeIn(Date.parse(task.dueAt), timeZone)}`;
  if (task.dueDate) return `Срок: ${fullDate(task.dueDate)}`;
  return null;
}

function dueSort(a, b) {
  const da = a.dueAt ? Date.parse(a.dueAt) : a.dueDate ? Date.parse(`${a.dueDate}T23:59:59`) : null;
  const db = b.dueAt ? Date.parse(b.dueAt) : b.dueDate ? Date.parse(`${b.dueDate}T23:59:59`) : null;
  if (da === db) return a.id < b.id ? -1 : 1; // стабильно по id при равном сроке (в т.ч. без срока)
  if (da === null) return 1;
  if (db === null) return -1;
  return da - db;
}

const rowId = (taskId) => `task-row-${taskId}`;

/**
 * Прокручивает к строке (или к разделу, если строк несколько), временно подсвечивает её и
 * переводит туда фокус клавиатуры/скринридера. Сделано обычным JS, а не ссылкой на #якорь:
 * нативная прокрутка к фрагменту здесь ненадёжна — в этом окружении `:target` ни разу не
 * сработал для содержимого внутри корневого узла приложения ни в одном браузере, которым мы
 * это проверяли, притом что тот же CSS исправно работает для элементов вне этого узла.
 */
function scrollAndHighlight(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const isRow = el.classList.contains('attention-row');
  el.scrollIntoView({ behavior: 'smooth', block: isRow ? 'center' : 'start' });
  if (isRow) {
    el.classList.add('attention-row--flash');
    setTimeout(() => el.classList.remove('attention-row--flash'), 2000);
    el.querySelector('.attention-row__link')?.focus({ preventScroll: true });
  } else {
    el.focus({ preventScroll: true }); // разделы (.zone) уже tabindex="-1" для этого
  }
}

/**
 * «Ещё N задач(и) — в „Требует внимания“»: одна задача — прокрутка и подсветка именно её
 * строки (§0 «прокручивает и выделяет нужную строку сверху»); несколько — прокрутка к самому
 * блоку, без попытки подсветить сразу несколько строк.
 */
function shownAboveNote(hiddenTasks) {
  if (!hiddenTasks.length) return null;
  const n = hiddenTasks.length;
  const targetId = n === 1 ? rowId(hiddenTasks[0].id) : 'section-requires';
  return h('p', { class: 'shown-above' },
    `Ещё ${n} ${pluralize(n, 'задача', 'задачи', 'задач')} — в `,
    h('button', { type: 'button', class: 'link-button', onclick: () => scrollAndHighlight(targetId) }, '«Требует внимания»'),
    ' выше.');
}

export function renderOverview(slot, { params, session, query }) {
  const flash = history.state?.flash ?? null;
  if (flash) history.replaceState({ ...history.state, flash: null }, '');
  const backToList = safeListPath(query.get('from')) ?? '/events';
  const overviewUrl = withFrom(`/events/${encodeURIComponent(params.eventId)}/overview`, query.get('from'));
  // Задача открывается из обзора — карточка знает об этом через `from` и вернётся сюда,
  // подписав кнопку «Вернуться к проекту» (докс/specs/03-tasks.md, §5.3).
  const taskUrl = (id) => withFrom(`/events/${encodeURIComponent(params.eventId)}/tasks/${encodeURIComponent(id)}`, overviewUrl);
  const allTasksUrl = withFrom(`/events/${encodeURIComponent(params.eventId)}/tasks`, query.get('from'));
  const budgetUrl = withFrom(`/events/${encodeURIComponent(params.eventId)}/budget`, query.get('from'));
  const canArchive = session.user.role === 'owner';
  const canRetryPlan = session.permissions.createEvent;

  const main = h('main', { id: 'main', class: 'container page', 'aria-busy': 'true' });
  slot.append(main);
  let controller = new AbortController();
  let firstRender = true;
  let requiresExpanded = false;
  let vendors = null;
  let vendorsError = false;

  const back = () => h('p', { class: 'back' }, h('a', { href: backToList, class: 'link' }, '← Мои мероприятия'));

  async function loadVendors() {
    try {
      const res = await api.listEventVendors(params.eventId);
      vendors = res.items;
      vendorsError = false;
    } catch {
      vendorsError = true;
    }
    if (lastData) render(lastData);
  }

  async function load() {
    controller.abort();
    controller = new AbortController();
    try {
      const data = await api.getEvent(params.eventId, { signal: controller.signal });
      render(data);
      loadVendors();
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

  /**
   * «Требует внимания»: та же функция срочности, что на «Мои мероприятия» — число и статус
   * совпадают. У задачи, которая одновременно in_progress/waiting, — маленький второй бейдж,
   * чтобы её не пришлось повторять строкой в блоке «В работе»/«Ждём ответа» ниже (§0, §2.3).
   */
  function requiresSection(attention, tasksById, archived, timeZone, now) {
    const limit = defaultListLimit();
    const rows = requiresExpanded ? attention : attention.slice(0, limit);
    const toggle = attention.length > limit
      ? h('button', {
        type: 'button', class: 'btn btn--secondary btn--small',
        'aria-expanded': String(requiresExpanded),
        onclick: () => { requiresExpanded = !requiresExpanded; render(lastData); },
      }, requiresExpanded ? 'Свернуть' : `Показать все ${attention.length}`)
      : null;
    return h('section', {
      class: 'zone', id: 'section-requires', 'aria-labelledby': 'zone-requires', tabindex: '-1',
    },
      h('h2', { class: 'zone__title', id: 'zone-requires' }, `Требует внимания${attention.length ? ` · ${attention.length}` : ''}`),
      attention.length
        ? [h('ol', { class: 'attention__list attention__list--light' }, rows.map((item) => {
          const { label, detail } = attentionLabel(item, timeZone, now);
          const owner = item.ownerName ?? 'Не назначен';
          const task = tasksById.get(item.id);
          let secondary = null;
          if (task?.status === 'in_progress') secondary = statusChip('progress', 'В работе');
          else if (task?.status === 'waiting') {
            secondary = statusChip('soon', task.waitingFrom ? `Ждём: ${task.waitingFrom}` : 'Ждём ответа');
          }
          const tooltip = [label, item.title, owner, detail].filter(Boolean).join('. ');
          return taskRow({
            id: rowId(item.id), href: taskUrl(item.id), tone: KIND_TONE[item.kind], chipLabel: label,
            title: item.title, meta: owner, tooltip, secondary,
          });
        })), toggle]
        : h('p', { class: 'muted' }, archived ? 'Проект в архиве' : 'Сейчас нет задач, требующих срочного действия'),
    );
  }

  /** Разбивает задачи одного статуса на «свои» строки и уже показанные выше — считается один раз в render(). */
  function splitByStatus(tasks, status, requiresIds) {
    const all = tasks.filter((t) => t.status === status);
    return { all, rows: all.filter((t) => !requiresIds.has(t.id)), hidden: all.filter((t) => requiresIds.has(t.id)) };
  }

  /**
   * «В работе»: только in_progress, не показанные выше в «Требует внимания» (§0, §2.4).
   * Следующее действие не придумывается, если его нет в данных.
   */
  function workSection({ all, rows, hidden }, timeZone) {
    let body;
    if (!all.length) body = h('p', { class: 'muted' }, 'Пока нет задач в работе');
    else if (!rows.length) body = shownAboveNote(hidden);
    else {
      body = [
        h('ol', { class: 'attention__list attention__list--light' }, rows.sort(dueSort).map((t) => {
          const due = shortDue(t, timeZone);
          const meta = [t.assigneeName ?? 'Не назначен', due].filter(Boolean).join(' · ');
          return taskRow({
            href: taskUrl(t.id), tone: 'progress', chipLabel: 'В работе', title: t.title, meta,
            tooltip: [t.title, meta].join('. '),
          });
        })),
        shownAboveNote(hidden),
      ];
    }
    return h('section', { class: 'zone', id: 'section-work', 'aria-labelledby': 'zone-work', tabindex: '-1' },
      h('h2', { class: 'zone__title', id: 'zone-work' }, `В работе${all.length ? ` · ${all.length}` : ''}`),
      body,
    );
  }

  /**
   * «Ждём ответа»: только явный статус waiting, не показанные выше (§0, §2.5). «Ждём: …» — только
   * если источник (waitingFrom) есть в данных; контроль ожидания — только если хранится followUpAt
   * и не путается со сроком выполнения самой задачи. «Нужно напомнить» не выводится самостоятельно.
   */
  function waitingSection({ all, rows, hidden }, timeZone) {
    let body;
    if (!all.length) body = h('p', { class: 'muted' }, 'Сейчас никого не ждём');
    else if (!rows.length) body = shownAboveNote(hidden);
    else {
      body = [
        h('ol', { class: 'attention__list attention__list--light' }, rows.map((t) => {
          const chipLabel = t.waitingFrom ? `Ждём: ${t.waitingFrom}` : 'Ждём ответа';
          const meta = [
            `Ответственный: ${t.assigneeName ?? 'Не назначен'}`,
            t.followUpAt ? `Контроль: ${fullDate(t.followUpAt.slice(0, 10))}` : null,
          ].filter(Boolean).join(' · ');
          return taskRow({
            href: taskUrl(t.id), tone: 'soon', chipLabel, title: t.title, meta,
            tooltip: [chipLabel, t.title, meta].join('. '),
          });
        })),
        shownAboveNote(hidden),
      ];
    }
    return h('section', { class: 'zone', id: 'section-waiting', 'aria-labelledby': 'zone-waiting', tabindex: '-1' },
      h('h2', { class: 'zone__title', id: 'zone-waiting' }, `Ждём ответа${all.length ? ` · ${all.length}` : ''}`),
      body,
    );
  }

  // ---------- подрядчики свадьбы ----------

  async function toggleVendorStatus(v, button) {
    button.disabled = true;
    try {
      await api.updateEventVendorStatus(params.eventId, v.id, v.status === 'confirmed' ? 'candidate' : 'confirmed');
      loadVendors();
    } catch {
      button.disabled = false;
      announce('Не удалось изменить статус. Повторите попытку.', 0);
    }
  }

  // Смета: у каждого выбранного подрядчика есть связанная строка расхода (docs/specs/06-budget.md),
  // поэтому убрать из свадьбы — это ещё и решить её судьбу. Два последовательных подтверждения
  // вместо отдельного диалога: это разовое редкое действие, а не то, ради чего стоит вводить
  // новый компонент.
  async function removeVendor(v, button) {
    if (!window.confirm(`Убрать «${v.name}» из этой свадьбы? Личная запись сохранится.`)) return;
    const budgetAction = window.confirm('Удалить также его строку из сметы?\n\nОтмена — оставить как отдельный расход.')
      ? 'delete' : 'keep';
    button.disabled = true;
    try {
      await api.removeEventVendor(params.eventId, v.id, budgetAction);
      announce('Подрядчик убран из свадьбы', 0);
      loadVendors();
    } catch {
      button.disabled = false;
      announce('Не удалось убрать. Повторите попытку.', 0);
    }
  }

  function vendorItemRow(v, canEdit) {
    const meta = [v.phone, v.link].filter(Boolean).join(' · ');
    return h('li', { class: 'vendor-row' },
      h('div', { class: 'vendor-row__main' },
        statusChip(v.status === 'confirmed' ? 'done' : 'planned', v.status === 'confirmed' ? 'Подтверждён' : 'Кандидат'),
        h('span', { class: 'vendor-row__name' }, v.name),
      ),
      meta ? h('p', { class: 'vendor-row__meta' }, meta) : null,
      canEdit ? h('div', { class: 'vendor-row__actions' },
        h('button', {
          type: 'button', class: 'btn btn--secondary btn--small',
          onclick: (e) => toggleVendorStatus(v, e.currentTarget),
        }, v.status === 'confirmed' ? 'Вернуть в кандидаты' : 'Подтвердить'),
        h('button', {
          type: 'button', class: 'btn btn--ghost btn--small',
          onclick: (e) => removeVendor(v, e.currentTarget),
        }, 'Убрать'),
      ) : null,
    );
  }

  function vendorsSection(event, archived) {
    const pickBtn = !archived ? h('button', {
      type: 'button', class: 'btn btn--secondary btn--small',
      onclick: (e) => openVendorPickerPanel({
        opener: e.currentTarget,
        eventId: event.id,
        onAdded: () => { announce('Подрядчики добавлены', 0); loadVendors(); },
      }),
    }, '+ Выбрать подрядчиков') : null;

    let body;
    if (vendorsError) {
      body = h('p', { class: 'muted' }, 'Не удалось загрузить подрядчиков.');
    } else if (vendors === null) {
      body = h('p', { class: 'muted' }, 'Загружаем…');
    } else if (!vendors.length) {
      body = h('p', { class: 'muted' }, 'Подрядчики ещё не выбраны');
    } else {
      const bySection = new Map();
      for (const v of vendors) {
        if (!bySection.has(v.category)) bySection.set(v.category, []);
        bySection.get(v.category).push(v);
      }
      body = h('div', { class: 'checklist-groups' },
        [...bySection].map(([category, items]) => h('div', { class: 'checklist-group' },
          h('h3', { class: 'overline checklist-group__title' }, category),
          h('ul', { class: 'vendor-list' }, items.map((v) => vendorItemRow(v, !archived))))));
    }

    return h('section', { class: 'zone', 'aria-labelledby': 'zone-vendors' },
      h('div', { class: 'zone__head' },
        h('h2', { class: 'zone__title', id: 'zone-vendors' }, `Подрядчики${vendors?.length ? ` · ${vendors.length}` : ''}`),
        h('div', { class: 'zone__head-actions' }, pickBtn,
          h('a', { class: 'btn btn--secondary btn--small', href: budgetUrl }, 'Смета →')),
      ),
      body,
    );
  }

  /**
   * Показатель-переход (§2.2): ведёт к своему блоку; если в нём не осталось собственных строк
   * (все задачи уже показаны в «Требует внимания»), прокручивает и подсвечивает первую из них.
   */
  function statLink(count, label, sectionId, split) {
    const onclick = split && !split.rows.length && split.hidden.length
      ? () => scrollAndHighlight(rowId(split.hidden[0].id))
      : () => scrollAndHighlight(sectionId);
    return h('button', { type: 'button', class: 'stat', onclick },
      h('span', { class: 'stat__num' }, count), h('span', { class: 'stat__label' }, label));
  }

  // ---------- сборка страницы ----------

  let lastData = null;

  function render(data) {
    const { event, attention, tasks, timeZone } = data;
    lastData = data;
    clear(main);
    main.removeAttribute('aria-busy');
    document.title = `${event.title} — обзор`;
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

    // Шапка: тип, название, стадия проекта (та же функция, что и на карточке списка),
    // дата/площадка, «через N дней»/«Сегодня» только для будущего активного события.
    const stage = projectStage(event, timeZone, now);
    const dateText = event.eventDate ? fullDate(event.eventDate) : 'Дата уточняется';
    const rel = event.eventDate && event.lifecycle === 'active' ? relativeDay(event.eventDate, timeZone, now) : null;
    const metaText = [dateText, event.locationName].filter(Boolean).join(' · ');

    const requiresIds = new Set(attention.map((i) => i.id));
    const tasksById = new Map(tasks.map((t) => [t.id, t]));
    const work = splitByStatus(tasks, 'in_progress', requiresIds);
    const waiting = splitByStatus(tasks, 'waiting', requiresIds);

    const statRow = h('nav', { class: 'stat-row', 'aria-label': 'Сводка по проекту' },
      statLink(attention.length, 'Требует внимания', 'section-requires', null),
      statLink(work.all.length, 'В работе', 'section-work', work),
      statLink(waiting.all.length, 'Ждём ответа', 'section-waiting', waiting),
    );

    const menu = canArchive ? projectMenu(event) : null;
    const addTasksBtn = !archived ? h('button', {
      type: 'button', class: 'btn btn--secondary',
      onclick: (e) => openChecklistPanel({
        opener: e.currentTarget,
        eventId: event.id,
        onAdded: () => { announce('Задачи добавлены', 0); load(); },
      }),
    }, 'Добавить задачи') : null;

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
          h('div', { class: 'overview-head__actions' }, addTasksBtn, menu),
        ),
        h('div', { class: 'overview-meta' },
          statusChip(stage.tone, stage.label),
          h('span', { class: 'overview-meta__text' }, metaText),
          rel ? h('span', { class: 'overview-meta__rel' }, rel) : null,
        ),
      ),
      statRow,
      requiresSection(attention, tasksById, archived, timeZone, now),
      h('div', { class: 'zones' }, workSection(work, timeZone), waitingSection(waiting, timeZone)),
      h('p', { class: 'overview-alltasks' }, h('a', { class: 'btn btn--secondary', href: allTasksUrl }, 'Открыть все задачи →')),
      vendorsSection(event, archived),
    ].filter(Boolean));

    firstRender = false;
  }

  load();
  return () => {
    controller.abort();
    document.removeEventListener('click', onDocumentClick, { capture: true });
  };
}
