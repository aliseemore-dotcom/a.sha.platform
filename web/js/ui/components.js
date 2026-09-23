// Компоненты экрана: метка статуса, строка внимания, карточка свадьбы, скелетон.

import { h } from '../dom.js';
import {
  attentionLabel, dayNumber, monthYear, fullDate, relativeDay, isPast, pluralize,
} from '../format.js';

const KIND_TONE = { overdue: 'blocked', blocked: 'blocked', due_today: 'soon', follow_up_due: 'soon' };

/** Метка статуса: слово + форма; цвет вторичен (брендбук, «Статусы, метки, дата»). */
export function statusChip(tone, text, attrs = {}) {
  return h('span', { class: `chip chip--${tone}`, ...attrs },
    h('span', { class: `shape shape--${tone}`, 'aria-hidden': 'true' }),
    h('span', {}, text),
  );
}

export function attentionRow(item, timeZone, now) {
  const { label, detail } = attentionLabel(item, timeZone, now);
  const meta = [item.eventTitle, item.ownerName].filter(Boolean).join(' · ');
  return h('li', { class: 'attention-row' },
    h('a', {
      href: item.targetUrl,
      class: 'attention-row__link',
      title: detail ?? undefined,
    },
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

function lifecycleChip(card, timeZone, now) {
  if (card.lifecycle === 'archived') return statusChip('planned', 'В архиве');
  if (card.eventDate && isPast(card.eventDate, timeZone, now)) {
    return statusChip('progress', 'Дата прошла · проект активен');
  }
  return statusChip('progress', 'Активен');
}

/**
 * Карточка свадьбы. Внутри две ссылки (название и «Открыть проект»), поэтому карточка целиком
 * не кликабельна: интерактивные элементы не вкладываются друг в друга.
 */
export function eventCard(card, { timeZone, now, canArchive, onRestore }) {
  const href = `/events/${encodeURIComponent(card.id)}/overview`;
  const titleId = `card-title-${card.id}`;
  const urgent = card.lifecycle === 'active' && card.urgentCount > 0;
  const archived = card.lifecycle === 'archived';

  const cover = h('div', { class: `card__cover${card.coverUrl ? ' card__cover--photo' : ''}` },
    card.coverUrl ? h('img', { class: 'card__photo', src: card.coverUrl, alt: '' }) : null,
    lifecycleChip(card, timeZone, now),
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
        more > 0 ? h('span', { class: 'card__more' }, ` и ещё ${more} ${pluralize(more, 'вопрос', 'вопроса', 'вопросов')}`) : null,
      ),
    );
  }

  let workBlock = null;
  if (!archived) {
    workBlock = card.activePreview.length
      ? h('p', { class: 'card__work' },
        h('span', { class: 'card__work-label' }, 'В работе: '),
        card.activePreview.map((t) => t.title).join('; '))
      : (urgent ? null : h('p', { class: 'card__work card__work--empty' }, 'Пока нет задач в работе'));
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
      cover,
      h('div', { class: 'card__body' },
        h('p', { class: 'caption card__kicker' }, kicker),
        h('h3', { class: 'card__title', id: titleId }, h('a', { href }, card.title)),
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
      h('div', { class: 'card__cover skeleton' }),
      h('div', { class: 'card__body' },
        h('div', { class: 'skeleton skeleton--line skeleton--short' }),
        h('div', { class: 'skeleton skeleton--title' }),
        h('div', { class: 'skeleton skeleton--line skeleton--long' }),
      ),
    ),
  );
}
