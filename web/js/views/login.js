// Вход. На тестовом стенде (DEMO=1) — выбор демо-пользователя, как раньше. В пилоте (DEMO=0) —
// обычная форма email/пароль (docs/specs/08-foundation.md, §2.4).

import { h } from '../dom.js';
import { api } from '../api.js';

function safeReturnTo(value) {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/events';
  return value;
}

function renderDemoPicker(root, returnTo, users) {
  const status = h('p', { class: 'form-error', role: 'alert' });
  const list = h('ul', { class: 'login-list' });

  for (const u of users) {
    list.append(h('li', {},
      h('button', {
        type: 'button', class: 'login-user',
        onclick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          try {
            await api.loginDemo(u.id);
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
}

function field({ id, label, input }) {
  const errorEl = h('p', { class: 'field__error', id: `${id}-error` });
  input.id = id;
  input.setAttribute('aria-describedby', `${id}-error`);
  const wrap = h('div', { class: 'field' }, h('label', { class: 'field__label', for: id }, label), input, errorEl);
  return { wrap, setError(msg) { errorEl.textContent = msg ?? ''; wrap.classList.toggle('field--error', Boolean(msg)); } };
}

function renderCredentialsForm(root, returnTo) {
  const emailInput = h('input', { type: 'email', class: 'input', autocomplete: 'username', required: true });
  const passwordInput = h('input', { type: 'password', class: 'input', autocomplete: 'current-password', required: true });
  const emailField = field({ id: 'login-email', label: 'Email', input: emailInput });
  const passwordField = field({ id: 'login-password', label: 'Пароль', input: passwordInput });

  const showPassword = h('label', { class: 'checkbox login-show-password' },
    h('input', {
      type: 'checkbox',
      onchange: (e) => { passwordInput.type = e.currentTarget.checked ? 'text' : 'password'; },
    }),
    h('span', {}, 'Показать пароль'));

  const banner = h('p', { class: 'form-error', role: 'alert' });
  const submit = h('button', { type: 'submit', class: 'btn btn--primary login-submit' }, 'Войти');

  const resetEmailInput = h('input', { type: 'email', class: 'input', autocomplete: 'username', placeholder: 'Email' });
  const resetStatus = h('p', { class: 'muted' });
  const resetSubmit = h('button', { type: 'button', class: 'btn btn--secondary btn--small' }, 'Прислать ссылку');
  resetSubmit.addEventListener('click', async () => {
    if (!resetEmailInput.value.trim()) { resetStatus.textContent = 'Укажите email'; return; }
    resetSubmit.disabled = true;
    resetStatus.textContent = 'Отправляем…';
    try {
      await api.requestPasswordReset(resetEmailInput.value.trim());
      resetStatus.textContent = 'Если такой email зарегистрирован, ссылка для сброса пароля отправлена на него.';
    } catch {
      resetStatus.textContent = 'Если такой email зарегистрирован, ссылка для сброса пароля отправлена на него.';
    } finally {
      resetSubmit.disabled = false;
    }
  });
  const forgot = h('div', { class: 'login-forgot', hidden: true },
    h('div', { class: 'field-row' }, resetEmailInput, resetSubmit),
    resetStatus);
  const forgotLink = h('button', {
    type: 'button', class: 'link-button',
    onclick: () => { forgot.hidden = !forgot.hidden; },
  }, 'Забыли пароль?');

  const form = h('form', { class: 'login-form', novalidate: true },
    banner,
    emailField.wrap,
    passwordField.wrap,
    showPassword,
    submit,
    forgotLink,
    forgot,
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    banner.textContent = '';
    emailField.setError(null);
    passwordField.setError(null);
    submit.disabled = true;
    submit.textContent = 'Входим…';
    try {
      await api.login(emailInput.value.trim(), passwordInput.value);
      location.assign(returnTo);
    } catch (err) {
      banner.textContent = err.message;
      submit.disabled = false;
      submit.textContent = 'Войти';
    }
  });

  root.append(
    h('main', { id: 'main', class: 'login container' },
      h('div', { class: 'login__panel' },
        h('h1', { class: 'page-title' }, 'Вход'),
        form,
        h('p', {}, h('a', { class: 'link', href: `/register${returnTo !== '/events' ? `?returnTo=${encodeURIComponent(returnTo)}` : ''}` }, 'Нет аккаунта? Зарегистрироваться')),
      ),
    ),
  );
}

export function renderLogin(root) {
  const returnTo = safeReturnTo(new URLSearchParams(location.search).get('returnTo'));

  // demoUsers() отвечает 200 только при DEMO=1 — иначе сервер отдаёт 404 (см. catch ниже),
  // и вместо выбора пользователя показывается обычная форма входа.
  api.demoUsers().then(({ users }) => {
    renderDemoPicker(root, returnTo, users);
  }).catch(() => {
    renderCredentialsForm(root, returnTo);
  });

  return () => {};
}
