// «Пространство» (docs/specs/08-foundation.md, §3): название и часовой пояс. Только владельцу.

import { h, clear, announce } from '../dom.js';
import { api } from '../api.js';

function offsetLabel(tz, now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(now);
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}

function allTimeZones() {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
}

export function renderWorkspaceSettings(slot) {
  const main = h('main', { id: 'main', class: 'container page' });
  slot.append(main);

  async function load() {
    clear(main);
    try {
      const ws = await api.getWorkspace();
      render(ws);
    } catch (err) {
      main.append(h('div', { class: 'empty', role: 'alert' }, h('p', { class: 'empty__title' }, err.message)));
    }
  }

  function render(ws) {
    clear(main);
    let expectedUpdatedAt = ws.updatedAt;

    const nameInput = h('input', { type: 'text', class: 'input', value: ws.name });
    const tzInput = h('input', { type: 'text', class: 'input', list: 'tz-options', value: ws.timeZone, autocomplete: 'off' });
    const tzHint = h('p', { class: 'field__hint' }, `${ws.timeZone} — ${offsetLabel(ws.timeZone)}`);
    const dataList = h('datalist', { id: 'tz-options' },
      allTimeZones().map((tz) => h('option', { value: tz }, `${tz} — ${offsetLabel(tz)}`)));

    tzInput.addEventListener('input', () => {
      tzHint.textContent = allTimeZones().includes(tzInput.value) ? `${tzInput.value} — ${offsetLabel(tzInput.value)}` : 'Выберите пояс из списка';
    });

    const useDeviceTz = h('button', {
      type: 'button', class: 'btn btn--secondary btn--small',
      onclick: () => {
        tzInput.value = Intl.DateTimeFormat().resolvedOptions().timeZone;
        tzInput.dispatchEvent(new Event('input'));
      },
    }, 'Использовать пояс этого устройства');

    const banner = h('div', { class: 'banner banner--error', role: 'alert', hidden: true });
    const submit = h('button', { type: 'submit', class: 'btn btn--primary' }, 'Сохранить');

    const form = h('form', { class: 'dialog__form', novalidate: true },
      banner,
      h('div', { class: 'field' }, h('label', { class: 'field__label' }, 'Название пространства'), nameInput),
      h('div', { class: 'field' },
        h('label', { class: 'field__label' }, 'Часовой пояс'),
        h('div', { class: 'field-row' }, tzInput, useDeviceTz),
        tzHint,
        dataList,
      ),
      submit,
      h('div', { class: 'field' },
        h('label', { class: 'field__label' }, 'Данные пространства'),
        h('a', { class: 'btn btn--secondary', href: '/api/workspace/export' }, 'Скачать данные пространства'),
        h('p', { class: 'field__hint' }, 'Все свадьбы, задачи, подрядчики и смета — одним JSON-файлом. Пароли в файл не попадают.'),
      ),
    );

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      banner.hidden = true;
      if (tzInput.value !== ws.timeZone) {
        const ok = window.confirm(
          'Сроки без времени и отметки «Сегодня» и «Просрочено» будут считаться по новому поясу. Сроки со временем не сдвинутся. Сохранить?',
        );
        if (!ok) return;
      }
      submit.disabled = true;
      try {
        const updated = await api.updateWorkspace({ name: nameInput.value.trim(), timeZone: tzInput.value, expectedUpdatedAt });
        expectedUpdatedAt = updated.updatedAt;
        announce('Изменения сохранены', 0);
        load();
      } catch (err) {
        submit.disabled = false;
        if (err.status === 409) banner.textContent = 'Данные изменил кто-то другой. Обновите страницу.';
        else banner.textContent = err.message;
        banner.hidden = false;
      }
    });

    main.append(
      h('div', { class: 'page-head' }, h('h1', { class: 'page-title' }, 'Пространство')),
      form,
    );
  }

  load();
  return () => {};
}
