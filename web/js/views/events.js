// Экран 01 «Мои мероприятия» (итерация 2).
// Состояние вкладки, поиска и сортировки живёт в URL; поиск, сортировка и пагинация — на сервере.

import { h, clear, announce } from '../dom.js';
import { api } from '../api.js';
import { attentionRow, eventCard, cardSkeleton, attentionSkeleton } from '../ui/components.js';
import { openCreateDialog } from '../ui/createDialog.js';
import { countWeddings } from '../format.js';
import { mobileQuery, defaultListLimit as attentionLimit } from '../breakpoints.js';

const SEARCH_DEBOUNCE = 300;
const MAX_TIMER = 2 ** 31 - 1;
const ATTENTION_PAGE = 20;

function readQuery(query) {
  return {
    tab: query.get('tab') === 'archive' ? 'archive' : 'active',
    q: query.get('q') ?? '',
    sort: query.get('sort') === 'attention' ? 'attention' : 'date',
  };
}

function writeQuery(state) {
  const p = new URLSearchParams();
  if (state.tab === 'archive') p.set('tab', 'archive');
  if (state.q.trim()) p.set('q', state.q.trim());
  if (state.sort === 'attention') p.set('sort', 'attention');
  const s = p.toString();
  return `/events${s ? `?${s}` : ''}`;
}

export function renderEvents(slot, { session, navigate, query, restoreScroll }) {
  const canCreate = session.permissions.createEvent;
  const canArchive = session.user.role === 'owner';
  const state = readQuery(query);

  let data = null;          // последний ответ списка
  let items = [];           // загруженные карточки
  let nextCursor = null;
  let attentionExpanded = false;
  let attentionAll = [];    // раскрытый список, догружается страницами по 20
  let attentionAllCursor = null;
  let attentionLoading = false;
  let attentionError = false;
  let loading = false;
  let loadingMore = false;
  let loadError = null;
  let refreshError = null;
  let controller = null;
  let timer = null;
  let searchTimer = null;
  let lastFocusRefresh = 0;
  let announceNext = false;
  let pendingScroll = restoreScroll;

  // ---------- постоянные элементы ----------

  let createBtn = null;
  const openCreate = (opener) => openCreateDialog({
    opener,
    onCreated: (result) => navigate(`/events/${encodeURIComponent(result.eventId)}/overview`, {
      state: { flash: 'Свадьба создана', planStatus: result.planStatus },
    }),
  });
  if (canCreate) {
    createBtn = h('button', { type: 'button', class: 'btn btn--primary page-head__cta' },
      h('span', { 'aria-hidden': 'true' }, '+ '), 'Создать свадьбу');
    createBtn.addEventListener('click', () => openCreate(createBtn));
  }

  const head = h('section', { class: 'page-head' },
    h('div', { class: 'page-head__text' },
      h('h1', { class: 'page-title' }, 'Мои мероприятия'),
      h('p', { class: 'page-subtitle' }, 'Свадебные проекты вашей команды'),
    ),
    createBtn,
  );

  const attentionSlot = h('div');
  const connection = h('div', { class: 'banner banner--warning', role: 'status', hidden: navigator.onLine });
  connection.textContent = 'Нет соединения. Показаны последние загруженные данные, изменения недоступны.';

  const tabActive = h('a', { class: 'tab' });
  const tabArchive = h('a', { class: 'tab' });
  const searchInput = h('input', {
    type: 'search', class: 'input search__input', id: 'events-search', placeholder: 'Найти свадьбу',
    autocomplete: 'off', value: state.q, maxlength: '100',
  });
  const sortSelect = h('select', { class: 'input select', id: 'events-sort' },
    h('option', { value: 'date' }, 'По дате'),
    h('option', { value: 'attention' }, 'По вниманию'),
  );
  sortSelect.value = state.sort;
  // В архиве один порядок — подписываем его, а не показываем неработающий выбор.
  const sortArchiveNote = h('p', { class: 'sort-note' }, 'По дате события, сначала поздние');

  const toolbar = h('div', { class: 'toolbar' },
    h('nav', { class: 'tabs', 'aria-label': 'Проекты' }, tabActive, tabArchive),
    h('div', { class: 'toolbar__filters' },
      h('div', { class: 'search' },
        h('label', { class: 'visually-hidden', for: 'events-search' }, 'Найти свадьбу'),
        searchInput,
      ),
      h('div', { class: 'sort' },
        h('label', { class: 'sort__label', for: 'events-sort' }, 'Сортировка'),
        sortSelect,
      ),
      sortArchiveNote,
    ),
  );

  const listSlot = h('div', { class: 'list-slot' });
  const listSection = h('section', { class: 'list-section', id: 'projects', 'aria-labelledby': 'list-heading' },
    h('h2', { class: 'visually-hidden', id: 'list-heading', tabindex: '-1' }, 'Список свадеб'),
    toolbar,
    listSlot,
  );

  const main = h('main', { id: 'main', class: 'container page' }, head, connection, attentionSlot, listSection);
  slot.append(main);

  // ---------- загрузка ----------

  function requestParams(limit) {
    return {
      lifecycle: state.tab === 'archive' ? 'archived' : 'active',
      q: state.q.trim(),
      sort: state.sort,
      limit,
    };
  }

  async function load({ keepItems = false } = {}) {
    controller?.abort();
    controller = new AbortController();
    const { signal } = controller;
    // При обновлении сохраняем столько карточек, сколько уже было загружено.
    const limit = keepItems ? Math.min(50, Math.max(20, items.length)) : 20;
    loading = !keepItems || !data;
    if (loading) renderList();
    try {
      const res = await api.listEvents(requestParams(limit), { signal });
      data = res;
      items = res.items;
      nextCursor = res.nextCursor;
      loadError = null;
      refreshError = null;
      scheduleRefresh(res.refreshAt);
      if (announceNext) {
        announce(res.total ? `Найдено: ${countWeddings(res.total)}` : 'Ничего не найдено');
        announceNext = false;
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      if (data) refreshError = err;
      else loadError = err;
    } finally {
      if (!signal.aborted) {
        loading = false;
        renderAll();
        // Раскрытый список внимания обновляется из того же источника, что и счётчик.
        if (attentionExpanded && data && !loadError) loadAttention({ reset: true });
      }
    }
  }

  async function loadMore(button) {
    if (!nextCursor || loadingMore) return;
    loadingMore = true;
    button.disabled = true;
    button.textContent = 'Загружаем…';
    try {
      const res = await api.listEvents({ ...requestParams(20), cursor: nextCursor });
      const firstNew = items.length;
      items = items.concat(res.items);
      nextCursor = res.nextCursor;
      renderList();
      listSlot.querySelectorAll('.card__title a')[firstNew]?.focus();
    } catch {
      refreshError = { message: 'Не удалось загрузить продолжение списка.' };
      renderList();
    } finally {
      loadingMore = false;
    }
  }

  async function loadAttention({ reset = false } = {}) {
    if (attentionLoading) return;
    attentionLoading = true;
    attentionError = false;
    if (!reset) renderAttention();
    try {
      const limit = reset ? Math.min(50, Math.max(ATTENTION_PAGE, attentionAll.length)) : ATTENTION_PAGE;
      const res = await api.listAttention({ cursor: reset ? undefined : attentionAllCursor, limit });
      const firstNew = reset ? 0 : attentionAll.length;
      attentionAll = reset ? res.items : attentionAll.concat(res.items);
      attentionAllCursor = res.nextCursor;
      attentionLoading = false;
      renderAttention();
      if (!reset && firstNew > 0) attentionSlot.querySelectorAll('.attention-row__link')[firstNew]?.focus();
    } catch {
      attentionLoading = false;
      attentionError = true;
      renderAttention();
    }
  }

  function expandAttention() {
    attentionExpanded = true;
    attentionAll = [];
    attentionAllCursor = null;
    const firstHidden = attentionLimit();
    loadAttention({ reset: true }).then(() => {
      attentionSlot.querySelectorAll('.attention-row__link')[firstHidden]?.focus();
    });
  }

  function collapseAttention() {
    attentionExpanded = false;
    attentionAll = [];
    attentionAllCursor = null;
    renderAttention();
    attentionSlot.querySelector('.attention__toggle')?.focus();
  }

  function scheduleRefresh(refreshAt) {
    clearTimeout(timer);
    const delay = Date.parse(refreshAt) - Date.now() + 1000;
    if (Number.isFinite(delay)) timer = setTimeout(() => load({ keepItems: true }), Math.min(Math.max(delay, 1000), MAX_TIMER));
  }

  // ---------- отрисовка ----------

  function renderAttention() {
    clear(attentionSlot);
    if (!data) {
      if (loading && !loadError) attentionSlot.append(attentionSkeleton(attentionLimit()));
      return;
    }
    // Нет проектов вовсе — onboarding в списке, блок внимания не показываем.
    if (data.activeTotal === 0 && data.archivedTotal === 0) return;

    if (data.attentionTotal === 0) {
      attentionSlot.append(h('section', { class: 'attention-calm', 'aria-labelledby': 'attention-heading' },
        h('h2', { class: 'attention-calm__title', id: 'attention-heading' },
          h('span', { class: 'shape shape--done', 'aria-hidden': 'true' }),
          'Сейчас ничего не требует срочного решения'),
        data.activeTotal > 0
          ? h('a', { class: 'attention-calm__link', href: '#projects', onclick: goToProjects }, 'К проектам ↓')
          : null,
      ));
      return;
    }

    const tz = data.timeZone;
    const now = Date.now();
    const limit = attentionLimit();
    const rows = attentionExpanded && attentionAll.length ? attentionAll : data.attentionPreview.slice(0, limit);
    const total = data.attentionTotal;

    const controls = [];
    if (attentionExpanded) {
      if (attentionAllCursor) {
        controls.push(h('button', {
          type: 'button', class: 'btn btn--on-blue', disabled: attentionLoading,
          onclick: () => loadAttention(),
        }, attentionLoading ? 'Загружаем…' : `Показать ещё · ${attentionAll.length} из ${total}`));
      }
      controls.push(h('button', {
        type: 'button', class: 'btn btn--on-blue attention__toggle', 'aria-expanded': 'true',
        'aria-controls': 'attention-list', onclick: collapseAttention,
      }, 'Свернуть'));
    } else if (total > limit) {
      controls.push(h('button', {
        type: 'button', class: 'btn btn--on-blue attention__toggle', 'aria-expanded': 'false',
        'aria-controls': 'attention-list', disabled: attentionLoading, onclick: expandAttention,
      }, attentionLoading ? 'Загружаем…' : `Показать все ${total}`));
    }

    attentionSlot.append(
      h('section', { class: 'attention', 'aria-labelledby': 'attention-heading', id: 'attention' },
        h('h2', { class: 'attention__title', id: 'attention-heading' }, `Требует внимания · ${total}`),
        h('ol', { class: 'attention__list', id: 'attention-list' }, rows.map((item) => attentionRow(item, tz, now, writeQuery(state)))),
        attentionError
          ? h('p', { class: 'attention__error', role: 'alert' }, 'Не удалось загрузить список. Попробуйте ещё раз.')
          : null,
        controls.length ? h('div', { class: 'attention__controls' }, controls) : null,
      ),
    );
  }

  function goToProjects(e) {
    e.preventDefault();
    listSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.getElementById('list-heading')?.focus({ preventScroll: true });
  }

  function renderTabs() {
    sortSelect.parentElement.hidden = state.tab === 'archive';
    sortArchiveNote.hidden = state.tab !== 'archive';
    const a = data?.activeTotal;
    const r = data?.archivedTotal;
    const base = { ...state };
    tabActive.textContent = a === undefined ? 'Активные' : `Активные (${a})`;
    tabArchive.textContent = r === undefined ? 'Архив' : `Архив (${r})`;
    tabActive.href = writeQuery({ ...base, tab: 'active' });
    tabArchive.href = writeQuery({ ...base, tab: 'archive' });
    const [current, other] = state.tab === 'active' ? [tabActive, tabArchive] : [tabArchive, tabActive];
    current.setAttribute('aria-current', 'page');
    other.removeAttribute('aria-current');
  }

  function emptyState(title, text, action) {
    return h('div', { class: 'empty' },
      h('p', { class: 'empty__title' }, title),
      text ? h('p', { class: 'empty__text' }, text) : null,
      action,
    );
  }

  function secondaryCreate() {
    if (!canCreate) return null;
    const b = h('button', { type: 'button', class: 'btn btn--secondary' }, 'Создать свадьбу');
    b.addEventListener('click', () => openCreate(b));
    return b;
  }

  function renderList() {
    clear(listSlot);
    listSlot.setAttribute('aria-busy', loading ? 'true' : 'false');

    if (loading && !data) {
      listSlot.append(h('ul', { class: 'cards' }, cardSkeleton(), cardSkeleton(), cardSkeleton()));
      return;
    }
    if (loadError && !data) {
      listSlot.append(h('div', { class: 'empty', role: 'alert' },
        h('p', { class: 'empty__title' }, 'Не удалось загрузить мероприятия'),
        h('button', { type: 'button', class: 'btn btn--secondary', onclick: () => load() }, 'Повторить')));
      return;
    }
    if (!data) return;

    if (refreshError) {
      listSlot.append(h('div', { class: 'banner banner--error', role: 'alert' },
        h('span', {}, refreshError.status === 0 ? 'Нет соединения — данные могут быть устаревшими.' : 'Не удалось обновить список.'),
        h('button', { type: 'button', class: 'btn btn--secondary btn--small', onclick: () => load({ keepItems: true }) }, 'Повторить')));
    }

    const q = state.q.trim();
    if (!items.length) {
      if (q) {
        listSlot.append(emptyState(`По запросу «${q}» ничего не найдено`, null,
          h('button', { type: 'button', class: 'btn btn--secondary', onclick: resetSearch }, 'Очистить поиск')));
      } else if (state.tab === 'archive') {
        listSlot.append(emptyState('В архиве пока ничего нет', null,
          h('a', { class: 'btn btn--secondary', href: writeQuery({ ...state, tab: 'active' }) }, 'Вернуться к активным')));
      } else {
        listSlot.append(emptyState('Нет активных свадеб', null, secondaryCreate()));
      }
      return;
    }

    const now = Date.now();
    listSlot.append(h('ul', { class: 'cards' },
      items.map((card) => eventCard(card, { timeZone: data.timeZone, now, canArchive, onRestore: restore, fromHref: writeQuery(state) }))));

    if (nextCursor) {
      listSlot.append(h('div', { class: 'list-more' },
        h('button', { type: 'button', class: 'btn btn--secondary', onclick: (e) => loadMore(e.currentTarget) },
          `Показать ещё · загружено ${items.length} из ${data.total}`)));
    }
  }

  function renderAll() {
    const firstRun = data && data.activeTotal === 0 && data.archivedTotal === 0;
    toolbar.hidden = Boolean(firstRun);
    renderTabs();
    renderAttention();
    if (firstRun) {
      clear(listSlot);
      listSlot.append(emptyState('Здесь появятся ваши свадьбы',
        'Создайте первый проект, чтобы собрать подготовку в одном месте.', secondaryCreate()));
    } else {
      renderList();
    }
    if (pendingScroll !== null && data) {
      window.scrollTo(0, pendingScroll);
      pendingScroll = null;
    }
  }

  // ---------- действия ----------

  function applyState({ announceResult = false } = {}) {
    history.replaceState(history.state, '', writeQuery(state));
    announceNext = announceResult;
    nextCursor = null;
    load();
  }

  function resetSearch() {
    state.q = '';
    searchInput.value = '';
    applyState({ announceResult: true });
    searchInput.focus();
  }

  async function restore(card, button) {
    button.disabled = true;
    try {
      await api.restoreEvent(card.id);
      announce(`«${card.title}» возвращён в активные`, 0);
      load({ keepItems: true });
    } catch {
      button.disabled = false;
      refreshError = { message: 'Не удалось вернуть проект' };
      renderList();
    }
  }

  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      if (state.q === searchInput.value) return;
      state.q = searchInput.value;
      applyState({ announceResult: true });
    }, SEARCH_DEBOUNCE);
  });
  searchInput.addEventListener('search', () => {
    if (!searchInput.value && state.q) resetSearch();
  });

  sortSelect.addEventListener('change', () => {
    state.sort = sortSelect.value;
    applyState({ announceResult: true });
  });

  for (const [tab, el] of [['active', tabActive], ['archive', tabArchive]]) {
    el.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      if (state.tab === tab) return;
      state.tab = tab;
      applyState({ announceResult: true });
    });
  }

  // Обновление при возврате на вкладку/окно и при восстановлении сети.
  const onFocus = () => {
    if (document.visibilityState !== 'visible' || Date.now() - lastFocusRefresh < 3000) return;
    lastFocusRefresh = Date.now();
    load({ keepItems: true });
  };
  const onOnline = () => { connection.hidden = true; load({ keepItems: true }); };
  const onOffline = () => { connection.hidden = false; };
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onFocus);
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);

  const onMedia = () => { if (data) renderAttention(); };
  mobileQuery.addEventListener('change', onMedia);

  renderTabs();
  renderAttention();
  load();

  return () => {
    controller?.abort();
    clearTimeout(timer);
    clearTimeout(searchTimer);
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onFocus);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
    mobileQuery.removeEventListener('change', onMedia);
  };
}
