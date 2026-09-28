// База обложек проектов. Пока у проекта нет собственного фото (coverUrl), ему достаётся
// картинка из этой базы. Выбор «случайный», но стабильный: считается от id проекта, поэтому
// одна и та же свадьба всегда получает одну и ту же обложку — после перезагрузки, на всех
// устройствах и у всех членов команды. Чтобы добавить фото — положить файл в
// web/images/covers/ и дописать путь в список ниже.
export const COVER_LIBRARY = [
  '/images/covers/cover-01-ranunculus.jpg',
  '/images/covers/cover-02-chrysanthemum.jpg',
  '/images/covers/cover-03-roses.jpg',
  '/images/covers/cover-04-eustoma.jpg',
];

/** Простой стабильный хеш строки (FNV-1a, 32 бита). */
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Обложка проекта: собственное фото, если загружено, иначе — картинка из базы по id. */
export function coverFor(project) {
  if (project?.coverUrl) return project.coverUrl;
  if (!COVER_LIBRARY.length || project?.id == null) return null;
  return COVER_LIBRARY[hash(String(project.id)) % COVER_LIBRARY.length];
}

/**
 * Вариант кадрирования той же картинки (зеркально / другой фрагмент), тоже стабильный по id —
 * чтобы повторы из небольшой базы на соседних карточках не выглядели одинаково.
 */
export function coverVariant(project) {
  if (project?.coverUrl || project?.id == null) return '';
  return ['', 'cover--flip', 'cover--top', 'cover--flip cover--bottom'][(hash(`v:${project.id}`)) % 4];
}
