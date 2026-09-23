// Компоненты экрана: метка статуса, строка внимания, карточка свадьбы, скелетоны.

import { h } from '../dom.js';
import {
  attentionLabel, dayNumber, monthYear, fullDate, relativeDay, pluralize, projectStage,
} from '../format.js';

const KIND_TONE = { overdue: 'blocked', blocked: 'blocked', due_today: 'soon' };

/**
 * Метка статуса: слово + форма; цвет вторичен (брендбук, «Статусы, метки, дата»).
 * `size: 'detail'` — чуть крупнее вариант для одиночного статуса в детальной панели задачи
 * (часть II §1); в плотных списках используется размер по умолчанию.
 */
export function statusChip(tone, text, { size, ...attrs } = {}) {
  const cls = `chip chip--${tone}${size === 'detail' ? ' chip--detail' : ''}`;
  return h('span', { class: cls, ...attrs },
    h('span', { class: `shape shape--${tone}`, 'aria-hidden': 'true' }),
    h('span', {}, text),
  );
}

/**
 * Строка внимания — одна ссылка на конкретную задачу, без вложенных интерактивных элементов.
 * Порядок: статус → задача → проект · ответственный.
 */
export function attentionRow(item, timeZone, now) {
  const { label, detail } = attentionLabel(item, timeZone, now);
  const owner = item.ownerName ?? 'Не назначен';
  const meta = `${item.eventTitle} · ${owner}`;
  const full = [label, item.title, meta, detail].filter(Boolean).join('. ');
  return h('li', { class: 'attention-row' },
    h('a', { href: item.targetUrl, class: 'attention-row__link', title: full, 'aria-label': full },
      statusChip(KIND_TONE[item.kind], label),
      h('span', { class: 'attention-row__title' }, item.title),
      h('span', { class: 'attention-row__meta' }, meta),
      h('span', { class: 'attention-row__arrow', 'aria-hidden': 'true' }, '→'),
    ),
  );
}

function dateBlock(card, timeZone, now) {
  if (!card.eventDate) {
    return h('div', { class: 'dateblock dateblock--unknown' },
      h('span', { class: 'dateblock__unknown' }, 'Дата уточняется'));
  }
  const rel = card.lifecycle === 'active' ? relativeDay(card.eventDate, timeZone, now) : null;
  return h('div', { class: 'dateblock', title: fullDate(card.eventDate) },
    h('span', { class: 'visually-hidden' }, `Дата свадьбы: ${fullDate(card.eventDate)}`),
    h('span', { class: 'dateblock__day', 'aria-hidden': 'true' }, dayNumber(card.eventDate)),
    h('span', { class: 'dateblock__month', 'aria-hidden': 'true' }, monthYear(card.eventDate)),
    rel ? h('span', { class: 'dateblock__rel', 'aria-hidden': 'true' }, rel) : null,
  );
}

/**
 * Карточка свадьбы. Внутри две ссылки (название и «Открыть проект») и, в архиве, кнопка —
 * поэтому карточка целиком не кликабельна: интерактивные элементы не вкладываются друг в друга.
 */
export function eventCard(card, { timeZone, now, canArchive, onRestore }) {
  const href = `/events/${encodeURIComponent(card.id)}/overview`;
  const titleId = `card-title-${card.id}`;
  const urgent = card.lifecycle === 'active' && card.urgentCount > 0;
  const archived = card.lifecycle === 'archived';
  const stage = projectStage(card, timeZone, now);

  const top = h('div', { class: `card__top${card.coverUrl ? ' card__top--photo' : ''}` },
    card.coverUrl ? h('img', { class: 'card__photo', src: card.coverUrl, alt: '' }) : null,
    statusChip(stage.tone, stage.label),
    dateBlock(card, timeZone, now),
  );

  const kicker = ['Свадьба', card.locationName].filter(Boolean).join(' · ');

  let urgentBlock = null;
  if (urgent && card.urgentPreview) {
    const { label, detail } = attentionLabel(card.urgentPreview, timeZone, now);
    const more = card.urgentCount - 1;
    urgentBlock = h('div', { class: 'card__urgent' },
      h('p', { class: 'overline card__urgent-label' },
        h('span', { class: 'shape shape--blocked', 'aria-hidden': 'true' }),
        `Срочно · ${card.urgentCount}`),
      h('p', { class: 'card__urgent-text', title: detail ?? undefined },
        h('strong', {}, `${label}: `), card.urgentPreview.title,
        more > 0 ? h('span', { class: 'card__more' }, ` и ещё ${more}`) : null,
      ),
    );
  }

  // «В работе» — отдельная подпись, поэтому соседство со «Срочно» не читается как противоречие.
  let workBlock = null;
  if (!archived) {
    workBlock = h('p', { class: 'card__work' },
      h('span', { class: 'card__work-label' }, 'В работе: '),
      card.activePreview.length
        ? card.activePreview.map((t) => t.title).join('; ')
        : h('span', { class: 'card__work-empty' }, 'пока нет задач в работе'));
  }

  const actions = h('div', { class: 'card__actions' },
    h('a', { href, class: 'card__open', 'aria-describedby': titleId }, 'Открыть проект', h('span', { 'aria-hidden': 'true' }, ' →')),
    archived && canArchive
      ? h('button', { type: 'button', class: 'btn btn--secondary btn--small', onclick: (e) => onRestore(card, e.currentTarget) },
        'Вернуть в активные')
      : null,
  );

  return h('li', { class: `card${urgent ? ' card--urgent' : ''}${archived ? ' card--archived' : ''}` },
    h('article', { class: 'card__inner', 'aria-labelledby': titleId },
      top,
      h('div', { class: 'card__body' },
        h('p', { class: 'caption card__kicker', title: kicker }, kicker),
        h('h3', { class: 'card__title', id: titleId, title: card.title }, h('a', { href }, card.title)),
        urgentBlock,
        workBlock,
      ),
      actions,
    ),
  );
}

export function cardSkeleton() {
  return h('li', { class: 'card card--skeleton', 'aria-hidden': 'true' },
    h('div', { class: 'card__inner' },
      h('div', { class: 'card__top' },
        h('div', { class: 'skeleton skeleton--chip' }),
        h('div', { class: 'skeleton skeleton--date' })),
      h('div', { class: 'card__body' },
        h('div', { class: 'skeleton skeleton--line skeleton--short' }),
        h('div', { class: 'skeleton skeleton--title' }),
        h('div', { class: 'skeleton skeleton--line skeleton--long' }),
      ),
    ),
  );
}

export function attentionSkeleton(rows) {
  return h('section', { class: 'attention attention--skeleton', 'aria-hidden': 'true' },
    h('div', { class: 'skeleton skeleton--heading' }),
    Array.from({ length: rows }, () => h('div', { class: 'skeleton skeleton--row' })),
  );
}
