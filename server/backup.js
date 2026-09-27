// Резервные копии (docs/specs/08-foundation.md, §5): ежедневно в 03:00 UTC и по команде
// `backup-now`, через `VACUUM INTO` — не блокирует обслуживание запросов. Хранятся последние 14.
//
// Внешняя выгрузка в S3-совместимое хранилище — только если заданы переменные `BACKUP_S3_*` и
// без добавления зависимости для работы с S3 (принцип «без npm-зависимостей», раздел 0 ТЗ). Без
// готовой библиотеки подписанные запросы AWS SigV4 пришлось бы реализовывать с нуля — риск тонких
// ошибок в продакшене без пользы для двух-трёх пилотных недель. Решение зафиксировано в
// `docs/HANDOFF.md`: пока — только локальные копии на том же диске и запись в лог о том, что
// внешняя выгрузка не настроена.

import { mkdirSync, readdirSync, unlinkSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

export const KEEP_BACKUPS = 14;
const NAME_RE = /^app-\d{4}-\d{2}-\d{2}T\d{6}Z\.db$/;

function stamp(now) {
  const iso = new Date(now).toISOString(); // 2026-09-27T12:34:56.789Z
  const [date, time] = iso.split('T');
  return `${date}T${time.slice(0, 8).replace(/:/g, '')}Z`;
}

export function runBackup(store, backupDir, now = Date.now(), log = console.error) {
  mkdirSync(backupDir, { recursive: true });
  const fileName = `app-${stamp(now)}.db`;
  const fullPath = join(backupDir, fileName);
  store.backupTo(fullPath);

  const files = readdirSync(backupDir).filter((f) => NAME_RE.test(f)).sort();
  for (const old of files.slice(0, Math.max(0, files.length - KEEP_BACKUPS))) unlinkSync(join(backupDir, old));

  if (process.env.BACKUP_S3_BUCKET) {
    log('backup: BACKUP_S3_* задан, но внешняя выгрузка не реализована — см. docs/HANDOFF.md');
  } else {
    log(`backup: локальная копия создана — ${fullPath}`);
  }
  return { path: fullPath };
}

/** Раз в сутки в 03:00 UTC, плюс сразу при первом запуске после полуночи в проде не нужно — только по расписанию. */
export function scheduleDailyBackup(store, backupDir, log = console.error) {
  function msUntilNext3amUtc() {
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 3, 0, 0, 0));
    if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
    return next.getTime() - now.getTime();
  }
  function run() {
    try { runBackup(store, backupDir, Date.now(), log); } catch (err) { log(`backup: сбой — ${err.message}`); }
  }
  let timer = setTimeout(function tick() {
    run();
    timer = setInterval(run, 24 * 3600_000);
  }, msUntilNext3amUtc());
  return () => clearTimeout(timer);
}

/** `npm run admin -- restore --file …`: сервер должен быть остановлен (§5). */
export function restoreFrom(backupFilePath, targetDbPath) {
  copyFileSync(backupFilePath, targetDbPath);
}
