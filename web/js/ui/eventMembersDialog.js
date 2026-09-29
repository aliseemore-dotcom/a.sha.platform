// Диалог «Участники» (docs/specs/08-foundation.md, §2.7): без этого приглашённый участник видит
// пустой список свадеб — владелец не мог добавить его ни в одну. Владельцы не показываются в
// списке — они и так видят всё.

import { h } from '../dom.js';
import { api } from '../api.js';

/**
 * @param {{ opener: HTMLElement, eventId: string, onSaved: () => void }} opts
 */
export function openEventMembersDialog({ opener, eventId, onSaved }) {
  const banner = h('div', { class: 'banner banner--error', role: 'alert', hidden: true });
  const list = h('ul', { class: 'contacts-list' }, h('p', { class: 'muted' }, 'Загружаем…'));
  const submit = h('button', { type: 'submit', class: 'btn btn--primary', disabled: true }, 'Сохранить');
  const cancel = h('button', { type: 'button', class: 'btn btn--secondary' }, 'Отмена');

  const form = h('form', { class: 'dialog__form', novalidate: true },
    h('div', { class: 'dialog__head' },
      h('h2', { class: 'dialog__title', id: 'members-heading' }, 'Участники'),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Закрыть', onclick: () => close() }, '×'),
    ),
    h('div', { class: 'dialog__body' },
      banner,
      h('p', { class: 'muted' }, 'Участник видит только те свадьбы, куда его добавили. Владельцы видят всё.'),
      h('p', { class: 'muted' }, 'Нет нужного человека в списке? ',
        h('a', { class: 'link', href: '/settings/team', onclick: () => close() }, 'Пригласите его в команду'),
        ' — координатора, ведущего или кого угодно ещё — а потом вернитесь сюда и отметьте его здесь.'),
      list,
    ),
    h('div', { class: 'dialog__foot' }, cancel, submit),
  );
  const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': 'members-heading' }, form);

  function close() { dialog.close(); }
  cancel.addEventListener('click', close);
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dialog.addEventListener('close', () => { dialog.remove(); opener?.focus(); });

  let expectedUpdatedAt = null;

  api.getEventMembers(eventId).then(({ memberIds, updatedAt, candidates }) => {
    expectedUpdatedAt = updatedAt;
    list.replaceChildren();
    if (!candidates.length) {
      list.append(h('p', { class: 'muted' }, 'В пространстве пока нет участников с ролью «Участник».'));
    } else {
      for (const c of candidates) {
        const checkbox = h('input', {
          type: 'checkbox', checked: memberIds.includes(c.id), disabled: c.status !== 'active',
          dataset: { userId: c.id },
        });
        list.append(h('label', { class: 'checkbox contact-row' },
          checkbox,
          h('span', {}, c.name, c.status !== 'active' ? ' (отключён)' : ''),
        ));
      }
    }
    submit.disabled = false;
  }).catch((err) => {
    banner.textContent = err.message;
    banner.hidden = false;
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submit.disabled = true;
    const userIds = [...list.querySelectorAll('input[type=checkbox]:checked')]
      .map((el) => el.dataset.userId);
    try {
      await api.setEventMembers(eventId, { userIds, expectedUpdatedAt });
      close();
      onSaved();
    } catch (err) {
      submit.disabled = false;
      banner.textContent = err.status === 409 ? 'Данные изменил кто-то другой. Обновите страницу.' : err.message;
      banner.hidden = false;
    }
  });

  document.body.append(dialog);
  dialog.showModal();
}
