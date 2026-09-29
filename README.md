# Платформа организатора свадеб

Рабочее пространство профессионального организатора. Сейчас собраны:

- **«Мои мероприятия»** — [`docs/specs/01-events.md`](docs/specs/01-events.md) и уточняющие
  итерации ([2](docs/specs/01-events-iteration-2.md), [3](docs/specs/01-events-iteration-3.md));
- **Обзор мероприятия** — [`docs/specs/02-overview.md`](docs/specs/02-overview.md).

Обе страницы — по брендбуку Soft Editorial Glass v1.1.

## Запуск

Нужен Node.js 22.13 или новее (нужен встроенный `node:sqlite`), npm-зависимостей нет.

```bash
npm start      # http://localhost:3000 — тестовый стенд с демо-данными (DEMO=1 по умолчанию)
npm test       # правила внимания и критерии приёмки на уровне сервиса
```

На стенде (`DEMO=1`) вход — выбор демо-пользователя:

| Пользователь | Что проверяет |
|---|---|
| Елена, owner | все проекты пространства, создание, архив |
| Ольга, member | видит только два проекта, кнопки создания нет |
| Иван, member с `event:create` | пустое состояние «Здесь появятся ваши свадьбы» |
| Сергей, owner другого пространства | чужие проекты не видны |

### Пилот (`DEMO=0`)

Постоянное хранилище (SQLite), вход по email/паролю, команда и приглашения
(docs/specs/08-foundation.md). Переменные окружения:

| Переменная | Обязательна | По умолчанию | Назначение |
|---|---|---|---|
| `DEMO` | нет | `1` | `0` включает пилотный режим (SQLite, реальный вход) |
| `DATABASE_PATH` | при `DEMO=0` | `./data/app.db` | файл базы, должен быть на постоянном диске |
| `DATABASE_BACKUP_DIR` | нет | `./data/backups` | куда складываются резервные копии |
| `PUBLIC_URL` | при `DEMO=0` | `http://localhost:3000` | для проверки `Origin` и для ссылок приглашений |
| `NODE_ENV` | нет | `development` | только для лога при старте |
| `BACKUP_S3_BUCKET` и другие `BACKUP_S3_*` | нет | — | см. «Резервные копии» — без них выгрузки во внешнее хранилище нет |
| `RESEND_API_KEY` | нет | — | письмо со ссылкой для сброса пароля (см. «Регистрация и почта») |
| `EMAIL_FROM` | нет | `A.MORE <onboarding@resend.dev>` | адрес отправителя писем |

Первый запуск — просто поднять сервер, регистрация открытая (см. ниже):

```bash
DEMO=0 DATABASE_PATH=./data/app.db PUBLIC_URL=https://your-domain npm start
```

Пространство и владельца также можно создать вручную консольной командой (например, для
пространства, которое не должно проходить публичную форму):

```bash
DATABASE_PATH=./data/app.db PUBLIC_URL=https://your-domain \
  npm run admin -- create-workspace --name "Агентство Лес" \
    --owner-email anna@example.com --owner-name "Анна" --time-zone Europe/Moscow
# печатает одноразовую ссылку-приглашение — по ней владелец задаёт пароль
```

### Регистрация и почта

`/register` — открытая регистрация: посетитель указывает название компании, своё имя, email и
пароль и сразу становится владельцем нового пространства (название компании — то, что показано
в шапке приложения). Раньше пространства создавал только администратор консольной командой —
это осознанно изменено, теперь так можно завести и себе, и любому другому агентству.

Восстановление пароля (`/login` → «Забыли пароль?») отправляет ссылку на email через
[Resend](https://resend.com) по обычному HTTP-запросу (без npm-зависимости, только `fetch`).
Без `RESEND_API_KEY` письмо не уходит, но ответ пользователю всё равно одинаковый в обоих
случаях (чтобы не раскрывать, зарегистрирован ли email) — то есть без ключа сброс пароля себе
самостоятельно фактически недоступен, только через `npm run admin -- reset-link`.

**Важно:** без верификации собственного домена в Resend их тестовый адрес
(`onboarding@resend.dev`) доставляет письма только на email, которым зарегистрирован сам
аккаунт Resend — остальным адресатам письма не придут. Для реальной рассылки всем пользователям
нужно верифицировать домен на Resend и указать его в `EMAIL_FROM`.

Готовый деплой на бесплатном хостинге с постоянным диском — см.
[`FLY_DEPLOY.md`](FLY_DEPLOY.md) (Fly.io, `Dockerfile` и `fly.toml` уже в репозитории).

Другие команды консоли (работают с той же базой, сервер запускать не нужно):

```bash
npm run admin -- list-workspaces
npm run admin -- reset-link --email anna@example.com
npm run admin -- disable-user --email anna@example.com
npm run admin -- backup-now
```

### Резервные копии и восстановление

При `DEMO=0` сервер сам делает копию (`VACUUM INTO`) каждый день в 03:00 UTC в
`DATABASE_BACKUP_DIR`; хранятся последние 14. Восстановление — **при остановленном сервере**:

```bash
npm run admin -- restore --file ./data/backups/app-2026-09-27T030000Z.db
```

Проверено вручную: создать копию → изменить данные → восстановить → данные вернулись к моменту
копии.

### `GET /healthz`

`200 { ok: true }`, если база открыта и отвечает; `503`, если нет. Без сессии, для мониторинга
хостинга.

## Структура

```
server/
  index.js          HTTP: API + раздача web/, сессии, CSP, лог запросов без персональных данных
  store.js          выбор реализации хранилища (память или SQLite) — интерфейс общий
  store/memory.js   хранилище в памяти; демо-стенд и тесты
  store/sqlite.js   хранилище на node:sqlite; пилот (DEMO=0)
  db/migrate.js     применение файлов миграций по порядку, с журналом schema_migrations
  db/migrations/    001_init.sql — вся схема пилота
  auth/             пароли (scrypt), сессии, вход, ограничение попыток, приглашения,
                    register.js (открытая регистрация), passwordReset.js (сброс по email)
  workspace.js      настройки пространства (название, часовой пояс), экспорт данных
  team.js           «Команда»: приглашения, ссылки сброса, роли, права
  eventMembers.js   участники конкретной свадьбы
  backup.js         резервные копии по расписанию и по команде
  mailer.js         отправка писем через Resend (сброс пароля) — без ключа молча не отправляет
  events.js         список, поиск, сортировка, пагинация, создание, архив, задача
  attention.js      правила «Требует внимания» и «В работе» (чистые функции)
  checklist.js      стартовый план свадьбы, детерминированные сроки, пересчёт при смене даты
  access.js         видимость проектов и разрешения — только на сервере
  time.js           календарные операции в поясе рабочего пространства
  demo/seed.js      демо-данные стенда (DEMO=1 по умолчанию; DEMO=0 — пустой сервер)
bin/admin.js         консоль: create-workspace, list-workspaces, reset-link, disable-user, backup-now, restore
web/
  fonts/              Involve (woff2) + OFL.txt
  images/covers/      база обложек проектов по умолчанию (web/js/ui/covers.js)
  styles/tokens.css   токены брендбука и @font-face
  styles/app.css      все страницы
  js/views/           events, overview, tasks, budget, vendors, login, register, invite, team, workspaceSettings
  js/ui/               диалоги: новая свадьба, редактирование, участники, чек-лист, подрядчики
  js/breakpoints.js    общая точка «мобильный/шире» для лимитов списков
test/                 node:test, включая контрактные тесты хранилища на обеих реализациях
```

## API

```
GET  /api/events?lifecycle=active|archived&q=&sort=date|attention&cursor=&limit=20
GET  /api/events/attention?cursor=&limit=20
POST /api/events            { title, eventDate|null, locationName|null, idempotencyKey }
GET  /api/events/:id
POST /api/events/:id/archive | /restore | /plan
POST /api/events/:id/tasks/:taskId/complete

# вход и команда (docs/specs/08-foundation.md)
POST   /api/session          { email, password } при DEMO=0, { userId } при DEMO=1
POST   /api/register         { companyName, ownerName, email, password } — без сессии, недоступен при DEMO=1
POST   /api/password-reset   { email } — без сессии, ответ всегда одинаковый
GET    /api/invites/:token   проверка ссылки приглашения/сброса — без сессии
POST   /api/invites/:token/accept   { name?, password } — без сессии
GET    /api/workspace
PATCH  /api/workspace        { name?, timeZone?, expectedUpdatedAt }
GET    /api/workspace/export скачивание всех данных пространства одним JSON
GET    /api/team
POST   /api/team/invite      { email, name, role, canCreateEvents }
POST   /api/team/:userId/reset-link
PATCH  /api/team/:userId     { status?, role?, canCreateEvents? }
GET    /api/events/:id/members
PUT    /api/events/:id/members   { userIds, expectedUpdatedAt }
```

`GET /api/events` и `GET /api/events/:id` отдают карточки/задачи и агрегаты внимания из одного
снимка данных, поэтому число на «Мои мероприятия» и число на обзоре проекта никогда не расходятся.
`refreshAt` в ответе списка — момент, когда классификация сроков изменится сама (наступление
`dueAt` или полночь пространства).

Что не готово и какие решения нужны — в [`docs/HANDOFF.md`](docs/HANDOFF.md).
