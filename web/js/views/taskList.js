// Все задачи проекта — минимальный отдельный маршрут (обзор мероприятия v2, §2.6): обзор
// ссылается сюда одной строкой «Открыть все задачи →», а не повторяет список превью у себя.
// Включает завершённые и отменённые задачи — единственное место, где они видны в проекте.

import { h, clear } from '../dom.js';
import { api } from '../api.js';
import { statusChip, withFrom, safeListPath } from '../ui/components.js';
import { STATUS_WORD } from '../taskStatus.js';

export function renderTaskList(slot, { params, query }) {
  const overviewUrl = withFrom(`/events/${encodeURIComponent(params.eventId)}/overview`, query.get('from'));
  const backToList = safeListPath(query.get('from')) ?? '/events';
  const taskUrl = (id) => withFrom(`/events/${encodeURIComponent(params.eventId)}/tasks/${encodeURIComponent(id)}`, query.get('from'));

  const main = h('main', { id: 'main', class: 'container page', 'aria-busy': 'true' });
  slot.append(main);
  let controller = new AbortController();

  const back = () => h('p', { class: 'back' }, h('a', { href: overviewUrl, class: 'link' }, '← Обзор мероприятия'));

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
        main.append(h('div', { class: 'empty', role: 'alert' },
          h('p', { class: 'empty__title' }, 'Проект не найден или доступ к нему закрыт'),
          h('a', { class: 'btn btn--secondary', href: backToList }, 'К списку мероприятий')));
      } else {
        main.append(back(), h('div', { class: 'empty', role: 'alert' },
          h('p', { class: 'empty__title' }, 'Не удалось загрузить задачи'),
          h('button', { type: 'button', class: 'btn btn--secondary', onclick: load }, 'Повторить')));
      }
    }
  }

  function render({ event, tasks }) {
    clear(main);
    main.removeAttribute('aria-busy');
    document.title = `Все задачи — ${event.title}`;

    const bySection = new Map();
    for (const t of tasks) {
      const key = t.section ?? 'Прочее';
      if (!bySection.has(key)) bySection.set(key, []);
      bySection.get(key).push(t);
    }

    main.append(
      back(),
      h('section', { class: 'overview-head' },
        h('p', { class: 'overline' }, event.title),
        h('h1', { class: 'page-title' }, 'Все задачи'),
      ),
      h('section', { class: 'zone' },
        tasks.length
          ? [...bySection].map(([section, list]) => h('div', { class: 'plan-group' },
            h('h2', { class: 'overline' }, section),
            h('ul', { class: 'plan-list' }, list.map((t) => {
              const [tone, word] = STATUS_WORD[t.status] ?? ['planned', t.status];
              return h('li', { class: 'plan-item' },
                h('a', { href: taskUrl(t.id), class: 'plan-item__link' }, t.title),
                statusChip(tone, word));
            }))))
          : h('p', { class: 'muted' }, 'Задач пока нет'),
      ),
    );
  }

  load();
  return () => controller.abort();
}
