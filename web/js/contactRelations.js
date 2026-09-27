// Кем контакт приходится паре (docs/specs/07-wedding-setup.md, §1.1) — зеркало server/events.js.

export const CONTACT_RELATIONS = ['partner', 'parent', 'planner_side', 'other'];
export const RELATION_LABEL = {
  partner: 'Партнёр', parent: 'Родитель', planner_side: 'Организатор', other: 'Другое',
};
