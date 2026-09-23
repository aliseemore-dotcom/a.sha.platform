# Платформа организатора свадеб

Рабочее пространство профессионального организатора. Сейчас собраны:

- **«Мои мероприятия»** — [`docs/specs/01-events.md`](docs/specs/01-events.md) и уточняющие
  итерации ([2](docs/specs/01-events-iteration-2.md), [3](docs/specs/01-events-iteration-3.md));
- **Обзор мероприятия** — [`docs/specs/02-overview.md`](docs/specs/02-overview.md).

Обе страницы — по брендбуку Soft Editorial Glass v1.1.

## Запуск

Нужен Node.js 20 или новее, зависимостей нет.

```bash
npm start      # http://localhost:3000 — тестовый стенд с демо-данными
npm test       # правила внимания и критерии приёмки на уровне сервиса
```

На стенде вход — выбор демо-пользователя:

| Пользователь | Что проверяет |
|---|---|
| Елена, owner | все проекты пространства, создание, архив |
| Ольга, member | видит только два проекта, кнопки создания нет |
| Иван, member с `event:create` | пустое состояние «Здесь появятся ваши свадьбы» |
| Сергей, owner другого пространства | чужие проекты не видны |

## Структура

```
server/
  index.js        HTTP: API + раздача web/, сессии, CSP
  events.js       список, поиск, сортировка, пагинация, создание, архив, задача (getEvent/completeTask)
  attention.js    правила «Требует внимания» и «В работе» (чистые функции)
  plan.js         стартовый план wedding_v1, идемпотентный
  access.js       видимость проектов и разрешения — только на сервере
  store.js        хранилище в памяти; заменяется на БД без изменения сервисов
  time.js         календарные операции в поясе рабочего пространства
  demo/seed.js    демо-данные стенда (DEMO=1 по умолчанию; DEMO=0 — пустой сервер)
web/
  fonts/              Involve (woff2) + OFL.txt
  styles/tokens.css   токены брендбука и @font-face
  styles/app.css      обе страницы
  js/views/           events («Мои мероприятия»), overview (обзор мероприятия + панель задачи), login (стенд)
  js/ui/               карточка, строка задачи (attentionRow/taskRow), диалог «Новая свадьба»
  js/breakpoints.js    общая точка «мобильный/шире» для лимитов списков
test/                 node:test
```

## API

```
GET  /api/events?lifecycle=active|archived&q=&sort=date|attention&cursor=&limit=20
GET  /api/events/attention?cursor=&limit=20
POST /api/events            { title, eventDate|null, locationName|null, idempotencyKey }
GET  /api/events/:id
POST /api/events/:id/archive | /restore | /plan
POST /api/events/:id/tasks/:taskId/complete
```

`GET /api/events` и `GET /api/events/:id` отдают карточки/задачи и агрегаты внимания из одного
снимка данных, поэтому число на «Мои мероприятия» и число на обзоре проекта никогда не расходятся.
`refreshAt` в ответе списка — момент, когда классификация сроков изменится сама (наступление
`dueAt` или полночь пространства).

Что не готово и какие решения нужны — в [`docs/HANDOFF.md`](docs/HANDOFF.md).
