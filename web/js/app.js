// Оболочка приложения: сессия, шапка продукта, маршрутизация по History API.

import { h, clear } from './dom.js';
import { api } from './api.js';
import { renderLogin } from './views/login.js';
import { renderEvents } from './views/events.js';
import { renderOverview } from './views/overview.js';
import { renderTaskList } from './views/taskList.js';
import { renderTaskDetail } from './views/taskDetail.js';
import { renderVendors } from './views/vendors.js';

const root = document.getElementById('root');
let cleanup = null;
let session = null;

if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

function match(pathname) {
  if (pathname === '/login') return { view: 'login' };
  if (pathname === '/events') return { view: 'events' };
  if (pathname === '/vendors') return { view: 'vendors' };
  let m = pathname.match(/^\/events\/([A-Za-z0-9_-]+)\/overview$/);
  if (m) return { view: 'overview', params: { eventId: m[1] } };
  // Карточка задачи — отдельный маршрут («Задачи мероприятия», §5.3): работает после
  // перезагрузки и в новой вкладке, независимо от обзора.
  m = pathname.match(/^\/events\/([A-Za-z0-9_-]+)\/tasks\/([A-Za-z0-9_-]+)$/);
  if (m) return { view: 'taskDetail', params: { eventId: m[1], taskId: m[2] } };
  // Список всех задач проекта («Задачи мероприятия»): поиск, фильтры, сортировка, создание.
  m = pathname.match(/^\/events\/([A-Za-z0-9_-]+)\/tasks$/);
  if (m) return { view: 'tasks', params: { eventId: m[1] } };
  if (pathname === '/') return { redirect: '/events' };
  return { view: 'notFound' };
}

export function navigate(url, { replace = false, state = null } = {}) {
  // Запоминаем прокрутку текущей страницы, чтобы восстановить её при возврате назад.
  history.replaceState({ ...(history.state ?? {}), scrollY: window.scrollY }, '');
  if (replace) history.replaceState(state, '', url);
  else history.pushState(state, '', url);
  render();
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a || a.target || a.hasAttribute('download') || e.defaultPrevented) return;
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // Ссылка на якорь той же страницы: пусть браузер сам прокрутит и применит :target —
  // иначе мы бы preventDefault()-или переход и тут же увидели, что pathname/search не
  // изменились, и ничего не сделали бы вовсе.
  if (url.pathname === location.pathname && url.search === location.search && url.hash) return;
  e.preventDefault();
  if (url.pathname + url.search !== location.pathname + location.search) navigate(url.pathname + url.search);
});

window.addEventListener('popstate', () => render());

// Закрыть меню профиля по клику вне его (один обработчик на приложение).
document.addEventListener('click', (e) => {
  const profile = document.querySelector('.profile');
  if (!profile || profile.contains(e.target)) return;
  profile.querySelector('.profile__panel').hidden = true;
  profile.querySelector('.profile__toggle').setAttribute('aria-expanded', 'false');
});

const ROLE = { owner: 'Владелец', member: 'Участник' };

/**
 * Шапка: на широком экране — название агентства; на узком оно уходит в меню профиля,
 * чтобы не обрезаться до «Тестовое агент…». «Выйти» — в меню, без переполнения строки.
 */
function header() {
  const { user, workspace, demo } = session;
  const menuId = 'profile-menu';
  const panel = h('div', { class: 'profile__panel', id: menuId, hidden: true },
    h('p', { class: 'profile__name' }, user.name),
    h('p', { class: 'profile__meta' }, `${ROLE[user.role] ?? user.role} · ${workspace.name}`),
    demo ? h('p', { class: 'profile__meta' }, 'Тестовый стенд: данные вымышленные') : null,
    h('a', { class: 'btn btn--secondary profile__link', href: '/vendors' }, 'Мои подрядчики'),
    h('button', {
      type: 'button', class: 'btn btn--secondary profile__logout',
      onclick: async () => {
        await api.logout().catch(() => {});
        session = null;
        location.assign('/login');
      },
    }, 'Выйти'),
  );
  const toggle = h('button', {
    type: 'button', class: 'profile__toggle', 'aria-expanded': 'false', 'aria-controls': menuId,
  }, h('span', { class: 'profile__avatar', 'aria-hidden': 'true' }, user.name.slice(0, 1)),
  h('span', { class: 'profile__label' }, user.name),
  h('span', { class: 'visually-hidden' }, ' — меню профиля'),
  h('span', { class: 'profile__caret', 'aria-hidden': 'true' }, '▾'));

  const wrap = h('div', { class: 'profile' }, toggle, panel);
  const setOpen = (open) => {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  };
  toggle.addEventListener('click', () => setOpen(panel.hidden));
  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) { setOpen(false); toggle.focus(); }
  });
  wrap.addEventListener('focusout', (e) => { if (!wrap.contains(e.relatedTarget)) setOpen(false); });

  return h('header', { class: 'app-header' },
    h('div', { class: 'app-header__inner container' },
      h('div', { class: 'app-header__place' },
        h('span', { class: 'app-header__workspace' }, workspace.name),
        demo ? h('span', { class: 'stand-badge', title: 'Данные вымышленные, вход без пароля' }, 'Тестовый стенд') : null,
      ),
      wrap,
    ),
  );
}

function notFound() {
  return h('main', { id: 'main', class: 'container page' },
    h('h1', { class: 'page-title' }, 'Страница не найдена'),
    h('p', {}, h('a', { href: '/events', class: 'link' }, 'К списку мероприятий')),
  );
}

async function render() {
  cleanup?.();
  cleanup = null;
  const route = match(location.pathname);
  if (route.redirect) return navigate(route.redirect, { replace: true });

  if (route.view === 'login') {
    clear(root);
    root.removeAttribute('aria-busy');
    cleanup = renderLogin(root, { navigate });
    return;
  }

  if (!session) {
    try {
      session = await api.session();
    } catch {
      location.assign(`/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`);
      return;
    }
  }

  clear(root);
  root.removeAttribute('aria-busy');
  const slot = h('div', { class: 'app-body' });
  root.append(header(), slot);

  const ctx = {
    session,
    navigate,
    params: route.params ?? {},
    query: new URLSearchParams(location.search),
    restoreScroll: history.state?.scrollY ?? null,
  };
  if (route.view === 'events') cleanup = renderEvents(slot, ctx);
  else if (route.view === 'vendors') cleanup = renderVendors(slot, ctx);
  else if (route.view === 'overview') cleanup = renderOverview(slot, ctx);
  else if (route.view === 'tasks') cleanup = renderTaskList(slot, ctx);
  else if (route.view === 'taskDetail') cleanup = renderTaskDetail(slot, ctx);
  else slot.append(notFound());
}

render();
