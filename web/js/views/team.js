// «Команда» (docs/specs/08-foundation.md, §2.6): список пользователей пространства, приглашения,
// ссылки сброса пароля, роль и право создавать свадьбы. Только владельцу — сервер и так это
// проверяет, но открывать пустую/ошибочную страницу участнику незачем.

import { h, clear, announce } from '../dom.js';
import { api } from '../api.js';

const ROLE_LABEL = { owner: 'Владелец', member: 'Участник' };

function copyButton(text) {
  return h('button', {
    type: 'button', class: 'btn btn--secondary btn--small',
    onclick: async (e) => {
      try {
        await navigator.clipboard.writeText(text);
        announce('Ссылка скопирована', 0);
      } catch {
        e.currentTarget.textContent = text;
      }
    },
  }, 'Скопировать');
}

function linkBanner(link, note) {
  return h('div', { class: 'banner banner--info', role: 'status' },
    h('p', {}, note),
    h('div', { class: 'field-row' }, h('input', { class: 'input', readonly: true, value: link, onclick: (e) => e.currentTarget.select() }), copyButton(link)));
}

function inviteDialog({ opener, onInvited }) {
  const emailInput = h('input', { type: 'email', class: 'input', autocomplete: 'off' });
  const nameInput = h('input', { type: 'text', class: 'input', autocomplete: 'off' });
  const roleSelect = h('select', { class: 'input select' },
    h('option', { value: 'member' }, 'Участник'), h('option', { value: 'owner' }, 'Владелец'));
  const canCreate = h('input', { type: 'checkbox' });
  const canCreateRow = h('label', { class: 'checkbox' }, canCreate, h('span', {}, 'Может создавать свадьбы'));

  function syncCanCreateVisibility() { canCreateRow.hidden = roleSelect.value === 'owner'; }
  roleSelect.addEventListener('change', syncCanCreateVisibility);
  syncCanCreateVisibility();

  const banner = h('div', { class: 'banner banner--error', role: 'alert', hidden: true });
  const submit = h('button', { type: 'submit', class: 'btn btn--primary' }, 'Пригласить');
  const cancel = h('button', { type: 'button', class: 'btn btn--secondary' }, 'Отмена');

  const form = h('form', { class: 'dialog__form', novalidate: true },
    h('div', { class: 'dialog__head' },
      h('h2', { class: 'dialog__title', id: 'invite-heading' }, 'Пригласить'),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Закрыть', onclick: () => close() }, '×'),
    ),
    h('div', { class: 'dialog__body' },
      banner,
      h('div', { class: 'field' }, h('label', { class: 'field__label' }, 'Email'), emailInput),
      h('div', { class: 'field' }, h('label', { class: 'field__label' }, 'Имя'), nameInput),
      h('div', { class: 'field' }, h('label', { class: 'field__label' }, 'Роль'), roleSelect),
      canCreateRow,
    ),
    h('div', { class: 'dialog__foot' }, cancel, submit),
  );
  const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': 'invite-heading' }, form);

  function close() { dialog.close(); }
  cancel.addEventListener('click', close);
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dialog.addEventListener('close', () => { dialog.remove(); opener?.focus(); });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submit.disabled = true;
    try {
      const { token, expiresInDays } = await api.inviteTeamMember({
        email: emailInput.value.trim(), name: nameInput.value.trim(),
        role: roleSelect.value, canCreateEvents: canCreate.checked,
      });
      close();
      onInvited(`${location.origin}/invite/${token}`, expiresInDays);
    } catch (err) {
      submit.disabled = false;
      banner.textContent = err.message;
      banner.hidden = false;
    }
  });

  document.body.append(dialog);
  dialog.showModal();
  emailInput.focus();
}

export function renderTeam(slot) {
  const main = h('main', { id: 'main', class: 'container page' });
  slot.append(main);
  let notice = null;

  async function load() {
    clear(main);
    try {
      const { items } = await api.getTeam();
      render(items);
    } catch (err) {
      main.append(h('div', { class: 'empty', role: 'alert' }, h('p', { class: 'empty__title' }, err.message)));
    }
  }

  function avatarBlock(u) {
    const img = u.avatarDataUrl
      ? h('img', { class: 'team-card__photo', src: u.avatarDataUrl, alt: '' })
      : h('span', { class: 'team-card__photo team-card__photo--placeholder', 'aria-hidden': 'true' }, (u.name || '?').trim().slice(0, 1).toUpperCase());
    const fileInput = h('input', {
      type: 'file', accept: 'image/*', class: 'team-card__photo-input', 'aria-label': `Фото — ${u.name}`,
      onchange: async () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        try {
          await api.updateTeamMember(u.id, { avatarDataUrl: dataUrl });
          load();
        } catch (err) {
          announce(err.message, 0);
        } finally {
          fileInput.value = '';
        }
      },
    });
    const label = h('label', { class: 'team-card__photo-wrap' }, img, fileInput);
    return label;
  }

  function memberRow(u) {
    const roleSelect = h('select', { class: 'input select' },
      h('option', { value: 'member' }, 'Участник'), h('option', { value: 'owner' }, 'Владелец'));
    roleSelect.value = u.role;
    roleSelect.addEventListener('change', async () => {
      try {
        await api.updateTeamMember(u.id, { role: roleSelect.value });
        load();
      } catch (err) {
        announce(err.message, 0);
        roleSelect.value = u.role;
      }
    });

    const canCreate = h('input', { type: 'checkbox', checked: u.role === 'owner' || u.canCreateEvents, disabled: u.role === 'owner' });
    canCreate.addEventListener('change', async () => {
      try {
        await api.updateTeamMember(u.id, { canCreateEvents: canCreate.checked });
        load();
      } catch (err) {
        announce(err.message, 0);
      }
    });

    const resetBtn = h('button', {
      type: 'button', class: 'btn btn--secondary btn--small',
      onclick: async (e) => {
        e.currentTarget.disabled = true;
        try {
          const { token, expiresInHours } = await api.resetLinkFor(u.id);
          notice = linkBanner(`${location.origin}/invite/${token}`, `Ссылка для сброса пароля ${u.email} — действует ${expiresInHours} часов, одноразовая.`);
          load();
        } catch (err) {
          announce(err.message, 0);
          e.currentTarget.disabled = false;
        }
      },
    }, 'Ссылка для сброса пароля');

    const toggleBtn = h('button', {
      type: 'button', class: 'btn btn--ghost btn--small',
      onclick: async (e) => {
        e.currentTarget.disabled = true;
        try {
          await api.updateTeamMember(u.id, { status: u.status === 'disabled' ? 'active' : 'disabled' });
          load();
        } catch (err) {
          announce(err.message, 0);
          e.currentTarget.disabled = false;
        }
      },
    }, u.status === 'disabled' ? 'Включить' : 'Отключить');

    return h('li', { class: 'team-card' },
      avatarBlock(u),
      h('div', { class: 'team-card__main' },
        h('span', { class: 'team-card__name' }, u.name),
        h('span', { class: 'team-card__email caption' }, u.email),
        u.status === 'disabled' ? h('span', { class: 'chip chip--blocked' }, 'Отключён') : null,
      ),
      h('div', { class: 'field-row' }, roleSelect, canCreateRowLabel(canCreate)),
      h('p', { class: 'caption team-card__seen' }, u.lastLoginAt ? `Последний вход: ${new Date(u.lastLoginAt).toLocaleString('ru-RU')}` : 'Ещё не входил'),
      h('div', { class: 'team-card__actions' }, resetBtn, toggleBtn),
    );
  }

  function canCreateRowLabel(input) {
    return h('label', { class: 'checkbox' }, input, h('span', {}, 'Может создавать свадьбы'));
  }

  function render(items) {
    clear(main);
    // main.append — нативный Element.append, а не наш h()-хелпер: null стал бы текстом "null".
    main.append(...[
      h('div', { class: 'page-head' },
        h('h1', { class: 'page-title' }, 'Команда'),
        h('button', {
          type: 'button', class: 'btn btn--primary',
          onclick: (e) => inviteDialog({
            opener: e.currentTarget,
            onInvited: (link, days) => {
              notice = linkBanner(link, `Отправьте эту ссылку коллеге. Она действует ${days} дней и сработает один раз.`);
              load();
            },
          }),
        }, 'Пригласить'),
      ),
      notice,
      h('ul', { class: 'team-grid' }, items.map(memberRow)),
    ].filter(Boolean));
    notice = null;
  }

  load();
  return () => {};
}
