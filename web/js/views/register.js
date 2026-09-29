// Регистрация: посетитель сайта создаёт себе пространство и становится его владельцем —
// компания, имя, email, пароль (docs/specs/08-foundation.md, §2.5, изменено на публичную
// регистрацию). Публичная страница — как /login, доступна без сессии.

import { h } from '../dom.js';
import { api } from '../api.js';

function safeReturnTo(value) {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/events';
  return value;
}

function field({ id, label, input, hint }) {
  const hintEl = h('p', { class: 'field__hint' }, hint ?? '');
  const errorEl = h('p', { class: 'field__error', id: `${id}-error` });
  input.id = id;
  input.setAttribute('aria-describedby', `${id}-error`);
  const wrap = h('div', { class: 'field' }, h('label', { class: 'field__label', for: id }, label), input, hintEl, errorEl);
  return { wrap, setError(msg) { errorEl.textContent = msg ?? ''; wrap.classList.toggle('field--error', Boolean(msg)); } };
}

export function renderRegister(root) {
  const returnTo = safeReturnTo(new URLSearchParams(location.search).get('returnTo'));

  const companyInput = h('input', { type: 'text', class: 'input', autocomplete: 'organization', required: true, maxlength: '100' });
  const ownerInput = h('input', { type: 'text', class: 'input', autocomplete: 'name', required: true, maxlength: '70' });
  const emailInput = h('input', { type: 'email', class: 'input', autocomplete: 'email', required: true });
  const passwordInput = h('input', { type: 'password', class: 'input', autocomplete: 'new-password', required: true });

  const companyField = field({ id: 'register-company', label: 'Название компании', input: companyInput });
  const ownerField = field({ id: 'register-owner', label: 'Имя владельца', input: ownerInput });
  const emailField = field({ id: 'register-email', label: 'Email', input: emailInput });
  const passwordField = field({
    id: 'register-password', label: 'Пароль', input: passwordInput, hint: 'Не короче 10 символов',
  });

  const showPassword = h('label', { class: 'checkbox login-show-password' },
    h('input', {
      type: 'checkbox',
      onchange: (e) => { passwordInput.type = e.currentTarget.checked ? 'text' : 'password'; },
    }),
    h('span', {}, 'Показать пароль'));

  const banner = h('p', { class: 'form-error', role: 'alert' });
  const submit = h('button', { type: 'submit', class: 'btn btn--primary login-submit' }, 'Создать аккаунт');

  const form = h('form', { class: 'login-form', novalidate: true },
    banner,
    companyField.wrap,
    ownerField.wrap,
    emailField.wrap,
    passwordField.wrap,
    showPassword,
    submit,
  );

  function clearErrors() {
    banner.textContent = '';
    for (const f of [companyField, ownerField, emailField, passwordField]) f.setError(null);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors();
    submit.disabled = true;
    submit.textContent = 'Создаём…';
    try {
      await api.register({
        companyName: companyInput.value.trim(),
        ownerName: ownerInput.value.trim(),
        email: emailInput.value.trim(),
        password: passwordInput.value,
      });
      location.assign(returnTo);
    } catch (err) {
      submit.disabled = false;
      submit.textContent = 'Создать аккаунт';
      if (err.status === 422 && err.fields) {
        companyField.setError(err.fields.companyName ?? null);
        ownerField.setError(err.fields.ownerName ?? null);
        emailField.setError(err.fields.email ?? null);
        passwordField.setError(err.fields.password ?? null);
        (form.querySelector('[aria-invalid="true"]') ?? companyInput).focus?.();
      } else {
        banner.textContent = err.message;
      }
    }
  });

  root.append(
    h('main', { id: 'main', class: 'login container' },
      h('div', { class: 'login__panel' },
        h('h1', { class: 'page-title' }, 'Регистрация'),
        h('p', { class: 'muted' }, 'Создайте пространство для своего агентства.'),
        form,
        h('p', {}, h('a', { class: 'link', href: `/login${returnTo !== '/events' ? `?returnTo=${encodeURIComponent(returnTo)}` : ''}` }, 'Уже есть аккаунт? Войти')),
      ),
    ),
  );

  return () => {};
}
