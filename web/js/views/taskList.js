// Задачи мероприятия (docs/specs/03-tasks.md): рабочий список одного проекта — поиск,
// фильтры, сортировка, создание и переход к карточке задачи. Поиск/фильтры/сортировка/вкладка
// живут в URL, чтобы ссылка на список и возврат из карточки восстанавливали контекст (§4).

import { h, clear, announce } from '../dom.js';
import { api } from '../api.js';
import { statusChip, withFrom, safeListPath } from '../ui/components.js';
import { openTaskDialog } from '../ui/taskDialog.js';
import { STATUS_WORD, BLOCKED_CHIP } from '../taskStatus.js';
import { fullDate, dateTimeIn, attentionLabel } from '../format.js';

const SEARCH_DEBOUNCE = 300;
const KIND_TONE = { overdue: 'blocked', blocked: 'blocked', due_today: 'soon' };
const DEFAULT = { tab: 'open', q: '', assignee: '', status: '', attention: '', noDue: '', followup: '', sort: 'attention' };

function readQuery(query) {
  return {
    tab: query.get('tab') === 'done' ? 'done' : query.get('tab') === 'cancelled' ? 'cancelled' : 'open',
    q: query.get('q') ?? '',
    assignee: query.get('assignee') ?? '',
    status: query.get('status') ?? '',
    attention: query.get('attention') === '1' ? '1' : '',
    noDue: query.get('noDue') === '1' ? '1' : '',
    followup: query.get('followup') === '1' ? '1' : '',
    sort: ['attention', 'due', 'created'].includes(query.get('sort')) ? query.get('sort') : 'attention',
  };
}

function writeQuery(eventId, state) {
  const p = new URLSearchParams();
  if (state.tab !== 'open') p.set('tab', state.tab);
  if (state.q.trim()) p.set('q', state.q.trim());
  if (state.assignee) p.set('assignee', state.assignee);
  if (state.status) p.set('status', state.status);
  if (state.attention) p.set('attention', '1');
  if (state.noDue) p.set('noDue', '1');
  if (state.followup) p.set('followup', '1');
  if (state.sort !== 'attention') p.set('sort', state.sort);
  const s = p.toString();
  return `/events/${encodeURIComponent(eventId)}/tasks${s ? `?${s}` : ''}`;
}

function dueText(t, timeZone) {
  if (t.dueAt) return dateTimeIn(Date.parse(t.dueAt), timeZone);
  if (t.dueDate) return fullDate(t.dueDate);
  return null;
}

export function renderTaskList(slot, { params, query }) {
  const eventId = params.eventId;
  let state = readQuery(query);
  const overviewUrl = withFrom(`/events/${encodeURIComponent(eventId)}/overview`, query.get('from'));
  const backToList = safeListPath(query.get('from')) ?? '/events';
  const canEdit = () => Boolean(project) && project.lifecycle === 'active';
  const taskUrl = (id) => withFrom(`/events/${encodeURIComponent(eventId)}/tasks/${encodeURIComponent(id)}`, writeQuery(eventId, state));

  let project = null; // { title, eventDate, locationName, lifecycle, teamMembers }
  let listData = null;
  let items = [];
  let nextCursor = null;
  let loading = false;
  let loadingMore = false;
  let loadError = null;
  let controller = null;
  let searchTimer = null;

  const back = () => h('p', { class: 'back' }, h('a', { href: overviewUrl, class: 'link' }, '← Обзор проекта'));

  let addBtn = null;
  function openAdd() {
    openTaskDialog({
      opener: addBtn,
      eventId,
      teamMembers: project.teamMembers,
      onSaved: () => { state = { ...state, tab: 'open' }; applyState(); announce('Задача добавлена', 0); },
    });
  }
  addBtn = h('button', { type: 'button', class: 'btn btn--primary page-head__cta' },
    h('span', { 'aria-hidden': 'true' }, '+ '), 'Добавить задачу');
  addBtn.addEventListener('click', openAdd);

  const head = h('section', { class: 'page-head' });
  const searchInput = h('input', {
    type: 'search', class: 'input search__input', id: 'tasks-search', placeholder: 'Найти задачу',
    autocomplete: 'off', value: state.q, maxlength: '200',
  });
  const assigneeSelect = h('select', { class: 'input select', id: 'tasks-assignee' },
    h('option', { value: '' }, 'Все'),
    h('option', { value: 'unassigned' }, 'Не назначен'));
  const statusSelect = h('select', { class: 'input select', id: 'tasks-status' },
    h('option', { value: '' }, 'Любой'),
    h('option', { value: 'todo' }, 'Не начато'),
    h('option', { value: 'in_progress' }, 'В работе'),
    h('option', { value: 'waiting' }, 'Ждём ответа'));
  const attentionCheckbox = h('input', { type: 'checkbox', id: 'tasks-attention' });
  const noDueCheckbox = h('input', { type: 'checkbox', id: 'tasks-no-due' });
  const followupCheckbox = h('input', { type: 'checkbox', id: 'tasks-followup' });
  const sortSelect = h('select', { class: 'input select', id: 'tasks-sort' },
    h('option', { value: 'attention' }, 'Сначала требующие внимания'),
    h('option', { value: 'due' }, 'По сроку'),
    h('option', { value: 'created' }, 'По дате создания'));
  const resetBtn = h('button', { type: 'button', class: 'btn btn--secondary btn--small' }, 'Сбросить');

  const statusField = h('div', { class: 'field field--inline' },
    h('label', { class: 'field__label', for: 'tasks-status' }, 'Статус'), statusSelect);
  const followupField = h('label', { class: 'checkbox checkbox--filter', for: 'tasks-followup' }, followupCheckbox, h('span', {}, 'Проверить ответ'));
  const sortField = h('div', { class: 'field field--inline' },
    h('label', { class: 'field__label', for: 'tasks-sort' }, 'Сортировка'), sortSelect);

  const filters = h('div', { class: 'task-filters' },
    h('div', { class: 'search' },
      h('label', { class: 'visually-hidden', for: 'tasks-search' }, 'Найти задачу'), searchInput),
    h('div', { class: 'field field--inline' },
      h('label', { class: 'field__label', for: 'tasks-assignee' }, 'Ответственный'), assigneeSelect),
    statusField,
    h('label', { class: 'checkbox checkbox--filter', for: 'tasks-attention' }, attentionCheckbox, h('span', {}, 'Требует внимания')),
    h('label', { class: 'checkbox checkbox--filter', for: 'tasks-no-due' }, noDueCheckbox, h('span', {}, 'Без срока')),
    followupField,
    sortField,
    resetBtn,
  );

  const tabOpen = h('a', { class: 'tab' }, 'Открытые');
  const tabDone = h('a', { class: 'tab' }, 'Завершённые');
  const tabCancelled = h('a', { class: 'tab' }, 'Отменённые');
  const tabs = h('nav', { class: 'tabs', 'aria-label': 'Задачи' }, tabOpen, tabDone, tabCancelled);

  const matchedNote = h('p', { class: 'caption task-matched' });
  const listSlot = h('div', { class: 'list-slot' });
  const listSection = h('section', { class: 'list-section', id: 'tasks', 'aria-labelledby': 'tasks-heading' },
    h('h2', { class: 'visually-hidden', id: 'tasks-heading', tabindex: '-1' }, 'Список задач'),
    tabs, filters, matchedNote, listSlot);

  const main = h('main', { id: 'main', class: 'container page', 'aria-busy': 'true' });
  slot.append(main);

  function syncFormFromState() {
    searchInput.value = state.q;
    assigneeSelect.value = state.assignee;
    statusSelect.value = state.status;
    attentionCheckbox.checked = Boolean(state.attention);
    noDueCheckbox.checked = Boolean(state.noDue);
    followupCheckbox.checked = Boolean(state.followup);
    sortSelect.value = state.sort;
    statusField.hidden = state.tab !== 'open';
    followupField.hidden = state.tab !== 'open';
    sortField.hidden = state.tab !== 'open';
  }

  function syncUrl() {
    history.replaceState(history.state, '', writeQuery(eventId, state));
  }

  function requestParams(cursor) {
    return {
      tab: state.tab,
      q: state.q.trim(),
      assignee: state.assignee,
      status: state.status,
      attention: state.attention,
      noDue: state.noDue,
      followup: state.followup,
      sort: state.sort,
      cursor,
    };
  }

  async function loadProject() {
    const data = await api.getEvent(eventId);
    project = {
      title: data.event.title, eventDate: data.event.eventDate, locationName: data.event.locationName,
      lifecycle: data.event.lifecycle, teamMembers: data.teamMembers,
    };
    document.title = `Задачи — ${project.title}`;
    for (const u of project.teamMembers) assigneeSelect.append(h('option', { value: u.id }, u.name));
    assigneeSelect.value = state.assignee;
    addBtn.hidden = project.lifecycle !== 'active';
    head.append(
      h('div', { class: 'page-head__text' },
        h('p', { class: 'overline' }, project.title),
        h('h1', { class: 'page-title' }, 'Все задачи'),
        h('p', { class: 'page-subtitle' }, [project.eventDate ? fullDate(project.eventDate) : 'Дата уточняется', project.locationName].filter(Boolean).join(' · ')),
      ),
      addBtn,
    );
  }

  async function load() {
    controller?.abort();
    controller = new AbortController();
    const { signal } = controller;
    loading = true;
    renderAll();
    try {
      const res = await api.listTasks(eventId, requestParams(undefined), { signal });
      listData = res;
      items = res.items;
      nextCursor = res.nextCursor;
      loadError = null;
    } catch (err) {
      if (err.name === 'AbortError') return;
      loadError = err;
    } finally {
      if (!signal.aborted) {
        loading = false;
        renderAll();
      }
    }
  }

  async function loadMore(button) {
    if (!nextCursor || loadingMore) return;
    loadingMore = true;
    button.disabled = true;
    button.textContent = 'Загружаем…';
    try {
      const res = await api.listTasks(eventId, requestParams(nextCursor));
      items = items.concat(res.items);
      nextCursor = res.nextCursor;
    } finally {
      loadingMore = false;
      renderList();
    }
  }

  function renderTabs() {
    const counts = listData ? { open: listData.openTotal, done: listData.doneTotal, cancelled: listData.cancelledTotal } : {};
    tabOpen.textContent = counts.open === undefined ? 'Открытые' : `Открытые (${counts.open})`;
    tabDone.textContent = counts.done === undefined ? 'Завершённые' : `Завершённые (${counts.done})`;
    tabCancelled.textContent = counts.cancelled === undefined ? 'Отменённые' : `Отменённые (${counts.cancelled})`;
    for (const [tab, el] of [['open', tabOpen], ['done', tabDone], ['cancelled', tabCancelled]]) {
      el.href = writeQuery(eventId, { ...state, tab });
      if (state.tab === tab) el.setAttribute('aria-current', 'page');
      else el.removeAttribute('aria-current');
    }
  }

  function isDefault() {
    return DEFAULT.tab === state.tab && !state.q && !state.assignee && !state.status
      && !state.attention && !state.noDue && !state.followup && state.sort === DEFAULT.sort;
  }

  function emptyState() {
    if (loadError) {
      return h('div', { class: 'empty', role: 'alert' },
        h('p', { class: 'empty__title' }, 'Не удалось загрузить задачи'),
        h('button', { type: 'button', class: 'btn btn--secondary', onclick: load }, 'Повторить'));
    }
    if (!isDefault()) {
      return h('div', { class: 'empty' },
        h('p', { class: 'empty__title' }, 'По вашему запросу задач нет'),
        h('button', { type: 'button', class: 'btn btn--secondary', onclick: resetFilters }, 'Сбросить фильтры'));
    }
    if (state.tab === 'open' && listData?.doneTotal > 0) {
      return h('div', { class: 'empty' },
        h('p', { class: 'empty__title' }, 'Все текущие задачи выполнены'),
        h('div', { class: 'task-missing__actions' },
          h('a', { class: 'btn btn--secondary', href: writeQuery(eventId, { ...state, tab: 'done' }) }, 'Показать завершённые'),
          canEdit() ? h('button', { type: 'button', class: 'btn btn--secondary', onclick: openAdd }, 'Добавить задачу') : null));
    }
    if (state.tab === 'open') {
      return h('div', { class: 'empty' },
        h('p', { class: 'empty__title' }, 'Здесь пока нет задач'),
        canEdit() ? h('button', { type: 'button', class: 'btn btn--primary', onclick: openAdd }, 'Добавить первую задачу') : null);
    }
    return h('div', { class: 'empty' }, h('p', { class: 'empty__title' }, state.tab === 'done' ? 'Завершённых задач пока нет' : 'Отменённых задач пока нет'));
  }

  function taskItemRow(t, timeZone) {
    const [tone, word] = STATUS_WORD[t.status] ?? ['planned', t.status];
    let attentionChip = null;
    if (t.attentionKind === 'blocked') attentionChip = statusChip(BLOCKED_CHIP[0], BLOCKED_CHIP[1]);
    else if (t.attentionKind) {
      const { label } = attentionLabel({ kind: t.attentionKind, dueAt: t.dueAt, dueDate: t.dueDate }, timeZone, Date.now());
      attentionChip = statusChip(KIND_TONE[t.attentionKind], label);
    }
    const metaParts = [t.assigneeName ?? 'Не назначен'];
    const due = dueText(t, timeZone);
    if (due && state.tab === 'open') metaParts.push(`Срок: ${due}`);
    if (t.status === 'waiting' && t.waitingFrom) metaParts.push(`Ждём: ${t.waitingFrom}`);
    if (state.tab !== 'open' && t.completedAt) metaParts.push(`Завершено: ${dateTimeIn(Date.parse(t.completedAt), timeZone)}`);
    const meta = metaParts.filter(Boolean).join(' · ');

    return h('li', { class: 'task-row' },
      h('a', { href: taskUrl(t.id), class: 'task-row__link' },
        h('span', { class: 'task-row__chips' }, attentionChip, statusChip(tone, word)),
        h('span', { class: 'task-row__title' }, t.title),
        h('span', { class: 'task-row__meta' }, meta),
        h('span', { class: 'task-row__arrow', 'aria-hidden': 'true' }, '→'),
      ),
    );
  }

  function renderList() {
    clear(listSlot);
    listSlot.setAttribute('aria-busy', loading ? 'true' : 'false');
    if (loading && !listData) {
      listSlot.append(h('p', { class: 'muted' }, 'Загружаем…'));
      return;
    }
    if (!listData || !items.length) {
      listSlot.append(emptyState());
      return;
    }
    const timeZone = listData.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    listSlot.append(h('ul', { class: 'task-list' }, items.map((t) => taskItemRow(t, timeZone))));
    if (nextCursor) {
      listSlot.append(h('div', { class: 'list-more' },
        h('button', { type: 'button', class: 'btn btn--secondary', onclick: (e) => loadMore(e.currentTarget) },
          `Показать ещё · загружено ${items.length}`)));
    }
  }

  function renderAll() {
    renderTabs();
    matchedNote.textContent = listData ? `Найдено: ${listData.matchedTotal}` : '';
    renderList();
    main.removeAttribute('aria-busy');
  }

  function resetFilters() {
    state = { ...DEFAULT, tab: state.tab };
    applyState();
    announce('Фильтры сброшены', 0);
  }

  function applyState() {
    syncFormFromState();
    syncUrl();
    load();
  }

  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      if (state.q === searchInput.value) return;
      state.q = searchInput.value;
      applyState();
    }, SEARCH_DEBOUNCE);
  });
  searchInput.addEventListener('search', () => { if (!searchInput.value && state.q) { state.q = ''; applyState(); } });
  assigneeSelect.addEventListener('change', () => { state.assignee = assigneeSelect.value; applyState(); });
  statusSelect.addEventListener('change', () => { state.status = statusSelect.value; applyState(); });
  attentionCheckbox.addEventListener('change', () => { state.attention = attentionCheckbox.checked ? '1' : ''; applyState(); });
  noDueCheckbox.addEventListener('change', () => { state.noDue = noDueCheckbox.checked ? '1' : ''; applyState(); });
  followupCheckbox.addEventListener('change', () => { state.followup = followupCheckbox.checked ? '1' : ''; applyState(); });
  sortSelect.addEventListener('change', () => { state.sort = sortSelect.value; applyState(); });
  resetBtn.addEventListener('click', resetFilters);
  for (const [tab, el] of [['open', tabOpen], ['done', tabDone], ['cancelled', tabCancelled]]) {
    el.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      if (state.tab === tab) return;
      state.tab = tab;
      // Смена вкладки на «Завершённые»/«Отменённые» отключает фильтры, применимые только к открытым.
      if (tab !== 'open') { state.status = ''; state.followup = ''; }
      applyState();
    });
  }

  main.append(back(), head, listSection);
  syncFormFromState();

  (async () => {
    try {
      await loadProject();
    } catch (err) {
      clear(main);
      main.removeAttribute('aria-busy');
      if (err.status === 404 || err.status === 403) {
        main.append(h('div', { class: 'empty', role: 'alert' },
          h('p', { class: 'empty__title' }, 'Проект не найден или доступ к нему закрыт'),
          h('a', { class: 'btn btn--secondary', href: backToList }, 'К списку мероприятий')));
      } else {
        main.append(back(), h('div', { class: 'empty', role: 'alert' },
          h('p', { class: 'empty__title' }, 'Не удалось загрузить проект'),
          h('button', { type: 'button', class: 'btn btn--secondary', onclick: () => location.reload() }, 'Повторить')));
      }
      return;
    }
    load();
  })();

  return () => controller?.abort();
}
