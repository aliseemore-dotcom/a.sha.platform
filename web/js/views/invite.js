// Страница по ссылке приглашения или сброса пароля (docs/specs/08-foundation.md, §2.6):
// `/invite/:token`. Доступна без сессии.

import { h } from '../dom.js';
import { api } from '../api.js';

function field({ id, label, input }) {
  const errorEl = h('p', { class: 'field__error', id: `${id}-error` });
  input.id = id;
  input.setAttribute('aria-describedby', `${id}-error`);
  const wrap = h('div', { class: 'field' }, h('label', { class: 'field__label', for: id }, label), input, errorEl);
  return { wrap, setError(msg) { errorEl.textContent = msg ?? ''; wrap.classList.toggle('field--error', Boolean(msg)); } };
}

const INVALID_TEXT = 'Ссылка недействительна. Попросите владельца прислать новую.';

export function renderInvite(root, { params }) {
  const panel = h('div', { class: 'login__panel' });
  root.append(h('main', { id: 'main', class: 'login container' }, panel));

  api.getInvite(params.token).then(({ email, name, kind }) => {
    const nameInput = h('input', { type: 'text', class: 'input', autocomplete: 'name', value: name ?? '' });
    const passwordInput = h('input', { type: 'password', class: 'input', autocomplete: 'new-password' });
    const confirmInput = h('input', { type: 'password', class: 'input', autocomplete: 'new-password' });
    const nameField = field({ id: 'invite-name', label: 'Имя', input: nameInput });
    const passwordField = field({ id: 'invite-password', label: 'Пароль', input: passwordInput });
    const confirmField = field({ id: 'invite-confirm', label: 'Повторите пароль', input: confirmInput });

    const showPassword = h('label', { class: 'checkbox login-show-password' },
      h('input', {
        type: 'checkbox',
        onchange: (e) => {
          const type = e.currentTarget.checked ? 'text' : 'password';
          passwordInput.type = type;
          confirmInput.type = type;
        },
      }),
      h('span', {}, 'Показать пароль'));

    const banner = h('p', { class: 'form-error', role: 'alert' });
    const submit = h('button', { type: 'submit', class: 'btn btn--primary login-submit' },
      kind === 'reset' ? 'Сохранить пароль' : 'Присоединиться');

    const form = h('form', { class: 'login-form', novalidate: true },
      banner,
      h('p', { class: 'muted' }, email),
      kind === 'invite' ? nameField.wrap : null,
      passwordField.wrap,
      confirmField.wrap,
      showPassword,
      submit,
    );

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      banner.textContent = '';
      nameField.setError(null);
      passwordField.setError(null);
      confirmField.setError(null);
      if (passwordInput.value !== confirmInput.value) {
        confirmField.setError('Пароли не совпадают');
        return;
      }
      submit.disabled = true;
      try {
        await api.acceptInvite(params.token, { name: nameInput.value.trim(), password: passwordInput.value });
        location.assign('/events');
      } catch (err) {
        submit.disabled = false;
        if (err.status === 422 && err.fields) {
          nameField.setError(err.fields.name ?? null);
          passwordField.setError(err.fields.password ?? null);
        } else {
          banner.textContent = err.message;
        }
      }
    });

    panel.append(
      h('h1', { class: 'page-title' }, kind === 'reset' ? 'Новый пароль' : 'Присоединиться к пространству'),
      form,
    );
  }).catch(() => {
    panel.append(
      h('h1', { class: 'page-title' }, 'Ссылка недействительна'),
      h('p', { class: 'muted' }, INVALID_TEXT),
    );
  });

  return () => {};
}
