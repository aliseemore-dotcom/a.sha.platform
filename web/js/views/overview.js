// Обзор проекта — минимальная версия, достаточная для переходов с экрана 01:
// подтверждение создания, состояние плана, блок «Срочно решить», архив/восстановление.
// Полный обзор описывается следующей спецификацией.

import { h, clear, announce } from '../dom.js';
import { api } from '../api.js';
import { attentionRow, statusChip } from '../ui/components.js';
import { fullDate } from '../format.js';

const STATUS_WORD = {
  planned: ['planned', 'Запланировано'],
  in_progress: ['progress', 'В работе'],
  waiting: ['soon', 'Ждём ответа'],
  blocked: ['blocked', 'Заблокировано'],
  done: ['done', 'Готово'],
  cancelled: ['planned', 'Отменено'],
};

export function renderOverview(slot, { params, query, session }) {
  const flash = history.state?.flash ?? null;
  if (flash) history.replaceState({ ...history.state, flash: null }, '');
  const focusAttention = query.get('focus') === 'attention';
  const focusTask = query.get('task');
  const canArchive = session.user.role === 'owner';
  const canRetryPlan = session.permissions.createEvent;

  const main = h('main', { id: 'main', class: 'container page', 'aria-busy': 'true' });
  slot.append(main);
  let controller = new AbortController();

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
        main.append(back(), h('h1', { class: 'page-title' }, 'Проект не найден или недоступен'));
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

  function render({ event, attention, tasks, timeZone }) {
    clear(main);
    main.removeAttribute('aria-busy');
    document.title = `${event.title} — обзор`;
    const now = Date.now();

    const banners = [];
    if (flash) banners.push(h('div', { class: 'banner banner--success', role: 'status' }, flash));
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
    if (focusTask && !tasks.some((t) => t.id === focusTask && t.status !== 'done' && t.status !== 'cancelled')) {
      banners.push(h('div', { class: 'banner banner--info', role: 'status' }, 'Элемент больше недоступен'));
    }

    const meta = [
      event.eventDate ? fullDate(event.eventDate) : 'Дата уточняется',
      event.locationName,
    ].filter(Boolean).join(' · ');

    const archived = event.lifecycle === 'archived';
    const lifecycleBtn = canArchive
      ? h('button', {
        type: 'button', class: 'btn btn--secondary',
        onclick: (e) => {
          const b = e.currentTarget;
          if (!archived && !window.confirm(`Переместить «${event.title}» в архив?`)) return;
          lifecycleAction(archived ? 'restore' : 'archive', b);
        },
      }, archived ? 'Вернуть в активные' : 'Переместить в архив')
      : null;

    const attentionSection = h('section', {
      class: 'zone', id: 'attention', tabindex: '-1', 'aria-labelledby': 'zone-attention',
    },
      h('h2', { class: 'zone__title', id: 'zone-attention' }, `Срочно решить${attention.length ? ` · ${attention.length}` : ''}`),
      attention.length
        ? h('ol', { class: 'attention__list attention__list--light' }, attention.map((i) => attentionRow(i, timeZone, now)))
        : h('p', { class: 'muted' }, archived ? 'Проект в архиве' : 'Срочных вопросов сейчас нет'),
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
            return h('li', { class: `plan-item${t.id === focusTask ? ' plan-item--focus' : ''}` },
              h('span', {}, t.title), statusChip(tone, word));
          }))))
        : h('p', { class: 'muted' }, 'Задач пока нет'),
    );

    main.append(
      back(),
      ...banners,
      h('section', { class: 'overview-head' },
        h('div', {},
          h('p', { class: 'overline' }, archived ? 'Свадьба · в архиве' : 'Свадьба'),
          h('h1', { class: 'page-title' }, event.title),
          h('p', { class: 'page-subtitle' }, meta),
        ),
        lifecycleBtn,
      ),
      h('div', { class: 'zones' }, attentionSection, planSection),
      h('p', { class: 'caption muted' }, 'Полный обзор проекта — следующий этап.'),
    );

    if (focusAttention) attentionSection.focus();
  }

  load();
  return () => controller.abort();
}
