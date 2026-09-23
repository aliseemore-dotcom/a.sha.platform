// Экран 01 «Мои мероприятия».
// Состояние вкладки, поиска и сортировки живёт в URL; поиск, сортировка и пагинация — на сервере.

import { h, clear, announce } from '../dom.js';
import { api } from '../api.js';
import { attentionRow, eventCard, cardSkeleton } from '../ui/components.js';
import { openCreateDialog } from '../ui/createDialog.js';
import { countWeddings } from '../format.js';

const SEARCH_DEBOUNCE = 300;
const MAX_TIMER = 2 ** 31 - 1;

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
  let attention = [];       // показанные строки внимания
  let attentionCursor = null;
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
    ),
  );

  const listSlot = h('div', { class: 'list-slot' });
  const listSection = h('section', { class: 'list-section', 'aria-labelledby': 'list-heading' },
    h('h2', { class: 'visually-hidden', id: 'list-heading' }, 'Список свадеб'),
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
      attention = res.attentionPreview;
      attentionCursor = res.attentionNextCursor;
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

  async function loadMoreAttention(button) {
    if (!attentionCursor) return;
    button.disabled = true;
    button.textContent = 'Загружаем…';
    try {
      const res = await api.listAttention({ cursor: attentionCursor, limit: 20 });
      const firstNew = attention.length;
      attention = attention.concat(res.items);
      attentionCursor = res.nextCursor;
      renderAttention();
      attentionSlot.querySelectorAll('.attention-row__link')[firstNew]?.focus();
    } catch {
      button.disabled = false;
      button.textContent = 'Не удалось загрузить. Повторить';
    }
  }

  function scheduleRefresh(refreshAt) {
    clearTimeout(timer);
    const delay = Date.parse(refreshAt) - Date.now() + 1000;
    if (Number.isFinite(delay)) timer = setTimeout(() => load({ keepItems: true }), Math.min(Math.max(delay, 1000), MAX_TIMER));
  }

  // ---------- отрисовка ----------

  function renderAttention() {
    clear(attentionSlot);
    if (!data || data.attentionTotal === 0) return;
    const tz = data.timeZone;
    const now = Date.now();
    attentionSlot.append(
      h('section', { class: 'attention', 'aria-labelledby': 'attention-heading', id: 'attention' },
        h('h2', { class: 'attention__title', id: 'attention-heading' }, `Требует внимания · ${data.attentionTotal}`),
        h('ol', { class: 'attention__list' }, attention.map((item) => attentionRow(item, tz, now))),
        attentionCursor
          ? h('button', {
            type: 'button', class: 'btn btn--on-dark attention__more',
            onclick: (e) => loadMoreAttention(e.currentTarget),
          }, 'Показать ещё')
          : null,
      ),
    );
  }

  function renderTabs() {
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
          h('button', { type: 'button', class: 'btn btn--secondary', onclick: resetSearch }, 'Сбросить поиск')));
      } else if (state.tab === 'archive') {
        listSlot.append(emptyState('В архиве пока ничего нет', null,
          h('a', { class: 'btn btn--secondary', href: writeQuery({ ...state, tab: 'active' }) }, 'Вернуться к активным')));
      } else {
        listSlot.append(emptyState('Нет активных свадеб', null, secondaryCreate()));
      }
      return;
    }

    if (state.tab === 'active' && data.attentionTotal === 0 && !q) {
      listSlot.append(h('p', { class: 'list-note' }, 'Срочных вопросов сейчас нет'));
    }

    const now = Date.now();
    listSlot.append(h('ul', { class: 'cards' },
      items.map((card) => eventCard(card, { timeZone: data.timeZone, now, canArchive, onRestore: restore }))));

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

  renderTabs();
  load();

  return () => {
    controller?.abort();
    clearTimeout(timer);
    clearTimeout(searchTimer);
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onFocus);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
  };
}
