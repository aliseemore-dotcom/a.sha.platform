// Вход. Системы авторизации в проекте пока нет: на тестовом стенде вход — выбор демо-пользователя.

import { h } from '../dom.js';
import { api } from '../api.js';

function safeReturnTo(value) {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/events';
  return value;
}

export function renderLogin(root) {
  const returnTo = safeReturnTo(new URLSearchParams(location.search).get('returnTo'));
  const status = h('p', { class: 'form-error', role: 'alert' });
  const list = h('ul', { class: 'login-list', 'aria-busy': 'true' });

  root.append(
    h('main', { id: 'main', class: 'login container' },
      h('div', { class: 'login__panel' },
        h('p', { class: 'overline' }, 'Тестовый стенд'),
        h('h1', { class: 'page-title' }, 'Вход'),
        h('p', { class: 'muted' }, 'Выберите пользователя. Данные на стенде вымышленные.'),
        list,
        status,
      ),
    ),
  );

  api.demoUsers().then(({ users }) => {
    list.removeAttribute('aria-busy');
    for (const u of users) {
      list.append(h('li', {},
        h('button', {
          type: 'button', class: 'login-user',
          onclick: async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            try {
              await api.login(u.id);
              location.assign(returnTo);
            } catch (err) {
              status.textContent = `Не удалось войти: ${err.message}`;
              btn.disabled = false;
            }
          },
        },
          h('span', { class: 'login-user__name' }, u.name),
          h('span', { class: 'login-user__note' }, u.note),
        ),
      ));
    }
  }).catch(() => {
    list.removeAttribute('aria-busy');
    status.textContent = 'Вход не настроен на этом сервере.';
  });

  return () => {};
}
