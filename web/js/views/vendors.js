// «Мои подрядчики» — личная база пользователя (docs/specs/05-vendors.md, раздел 1). Не общая
// база сервиса и не общая база агентства: каждый пользователь видит и меняет только свои записи.

import { h, clear, announce } from '../dom.js';
import { api } from '../api.js';
import { openVendorDialog } from '../ui/vendorDialog.js';
import { VENDOR_CATEGORIES } from '../vendorCategories.js';
import { CURRENCY_LABEL } from '../currencies.js';
import { formatMoney } from '../format.js';

const SEARCH_DEBOUNCE = 300;

export function renderVendors(slot) {
  let q = '';
  let category = '';
  let data = null;
  let loadError = null;
  let controller = null;
  let searchTimer = null;

  let addBtn = null;
  function openAdd() {
    openVendorDialog({
      opener: addBtn,
      onSaved: () => { announce('Подрядчик добавлен', 0); load(); },
    });
  }
  addBtn = h('button', { type: 'button', class: 'btn btn--primary page-head__cta' },
    h('span', { 'aria-hidden': 'true' }, '+ '), 'Добавить подрядчика');
  addBtn.addEventListener('click', openAdd);

  const head = h('section', { class: 'page-head' },
    h('div', { class: 'page-head__text' },
      h('h1', { class: 'page-title' }, 'Мои подрядчики'),
      h('p', { class: 'page-subtitle' }, 'Личная база — видна только вам, можно использовать в любой своей свадьбе'),
    ),
    addBtn,
  );

  const searchInput = h('input', {
    type: 'search', class: 'input search__input', id: 'vendors-search', placeholder: 'Найти по имени или категории',
    autocomplete: 'off', maxlength: '150',
  });
  const categorySelect = h('select', { class: 'input select', id: 'vendors-category' },
    h('option', { value: '' }, 'Все категории'),
    VENDOR_CATEGORIES.map((c) => h('option', { value: c }, c)));

  const toolbar = h('div', { class: 'task-filters' },
    h('div', { class: 'search' }, h('label', { class: 'visually-hidden', for: 'vendors-search' }, 'Поиск'), searchInput),
    h('div', { class: 'field field--inline' },
      h('label', { class: 'field__label', for: 'vendors-category' }, 'Категория'), categorySelect),
  );

  const listSlot = h('div', { class: 'list-slot' });
  const main = h('main', { id: 'main', class: 'container page' }, head, toolbar, listSlot);
  slot.append(main);

  function emptyState() {
    if (loadError) {
      return h('div', { class: 'empty', role: 'alert' },
        h('p', { class: 'empty__title' }, 'Не удалось загрузить список'),
        h('button', { type: 'button', class: 'btn btn--secondary', onclick: load }, 'Повторить'));
    }
    if (data.total === 0) {
      return h('div', { class: 'empty' },
        h('p', { class: 'empty__title' }, 'Добавьте первого подрядчика'),
        h('button', { type: 'button', class: 'btn btn--primary', onclick: openAdd }, 'Добавить подрядчика'));
    }
    return h('div', { class: 'empty' },
      h('p', { class: 'empty__title' }, 'По вашему запросу ничего нет'),
      h('button', {
        type: 'button', class: 'btn btn--secondary',
        onclick: () => { q = ''; category = ''; searchInput.value = ''; categorySelect.value = ''; load(); },
      }, 'Сбросить фильтры'));
  }

  function vendorRow(v) {
    const price = v.price != null ? formatMoney(v.price, CURRENCY_LABEL[v.currency]) : null;
    const meta = [v.phone, v.link].filter(Boolean).join(' · ');
    return h('li', { class: 'vendor-row' },
      h('div', { class: 'vendor-row__main' },
        h('span', { class: 'chip chip--planned' }, h('span', { class: 'shape shape--planned', 'aria-hidden': 'true' }), v.category),
        h('span', { class: 'vendor-row__name' }, v.name),
        price ? h('span', { class: 'vendor-row__price' }, price) : h('span', { class: 'vendor-row__price vendor-row__price--empty' }, 'Стоимость не указана'),
      ),
      meta ? h('p', { class: 'vendor-row__meta' }, meta) : null,
      v.note ? h('p', { class: 'vendor-row__note' }, v.note) : null,
      h('div', { class: 'vendor-row__actions' },
        h('button', {
          type: 'button', class: 'btn btn--secondary btn--small',
          onclick: (e) => openVendorDialog({
            opener: e.currentTarget, vendor: v,
            onSaved: () => { announce('Изменения сохранены', 0); load(); },
          }),
        }, 'Изменить'),
        h('button', {
          type: 'button', class: 'btn btn--ghost btn--small',
          onclick: async (e) => {
            if (!window.confirm(`Удалить «${v.name}» из личной базы?`)) return;
            e.currentTarget.disabled = true;
            try {
              await api.deleteVendor(v.id);
              announce('Подрядчик удалён', 0);
              load();
            } catch {
              e.currentTarget.disabled = false;
              announce('Не удалось удалить. Повторите попытку.', 0);
            }
          },
        }, 'Удалить'),
      ),
    );
  }

  function render() {
    clear(listSlot);
    if (!data && !loadError) { listSlot.append(h('p', { class: 'muted' }, 'Загружаем…')); return; }
    if (loadError || data.items.length === 0) { listSlot.append(emptyState()); return; }
    listSlot.append(h('ul', { class: 'vendor-list' }, data.items.map(vendorRow)));
  }

  async function load() {
    controller?.abort();
    controller = new AbortController();
    try {
      data = await api.listVendors({ q: q.trim(), category }, { signal: controller.signal });
      loadError = null;
    } catch (err) {
      if (err.name === 'AbortError') return;
      loadError = err;
    }
    render();
  }

  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      if (q === searchInput.value) return;
      q = searchInput.value;
      load();
    }, SEARCH_DEBOUNCE);
  });
  categorySelect.addEventListener('change', () => { category = categorySelect.value; load(); });

  load();
  return () => controller?.abort();
}
