// Точка выбора хранилища (docs/specs/08-foundation.md, §1.2). `index.js` выбирает по окружению:
// `DEMO=1` → память с демо-данными, `DEMO=0` → SQLite. Сервисы и тесты по-прежнему импортируют
// `createStore` — имя и интерфейс не изменились, реализация вынесена в `server/store/`.

export { createMemoryStore as createStore } from './store/memory.js';
export { createSqliteStore } from './store/sqlite.js';
