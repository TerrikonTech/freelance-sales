# Конфигурация Freelance Sales

## Где задаются настройки

- `.env` — приложение, PostgreSQL/Redis, публичный URL и безопасные feature
  flags. Файл создаётся локально и не входит в Git.
- `docker-compose.yml` — production-safe принудительные значения и адреса
  сервисов. Сейчас `STRICT_APPROVAL=true` и `TELEGRAM_ON_DEMAND_ONLY=true`
  заданы здесь повторно, поэтому случайное значение в `.env` их не ослабляет.
- настройки Dashboard — профиль продавца, стиль, FL.ru/Telegram подключения,
  шаблон договора и ключ генерации изображений. Чувствительные значения в БД
  шифруются.
- root-only файлы — токены broker/owner, ключ Hermes и Telegram state. Они не
  должны копироваться в `.env.example`, Git, аргументы процесса или логи.

## Основное приложение

| Переменная | Назначение | Безопасное поведение |
|---|---|---|
| `APP_PORT` | порт NestJS внутри контейнера | `3000` |
| `PUBLIC_BASE_PATH` | base path PWA/API | `/sales` |
| `PUBLIC_URL` | внешний HTTPS URL | обязателен для webhook и signed links |
| `DATABASE_URL` | PostgreSQL DSN | secret-bearing |
| `REDIS_URL` | Redis/BullMQ | внутренняя сеть Compose |
| `JWT_SECRET` | подпись owner session | случайный секрет |
| `ENCRYPTION_KEY` | AES-256-GCM для настроек | случайный секрет |
| `SETUP_TOKEN` | одноразовый первичный setup | случайный секрет |
| `DOCUMENTS_DIR` | документы и design assets | `/app/data/documents` |
| `MIN_LEAD_SCORE` | порог квалификации | `65` |
| `FL_SCAN_INTERVAL_SECONDS` | период сканирования проектов | минимум 60 секунд |
| `FL_CHAT_SCAN_INTERVAL_SECONDS` | период сканирования FL-чатов | минимум 60 секунд |
| `FL_LOGIN` | fallback login при импорте FL-профиля | лучше хранить в Dashboard |
| `AUTO_DRAFT_FL` | автоматически готовить черновик подходящего заказа | `false`; отправку не разрешает |
| `STRICT_APPROVAL` | обязательное ручное одобрение | production: `true` |
| `TELEGRAM_ON_DEMAND_ONLY` | не реагировать без команды/адресной миссии | production: `true` |
| `MISSIONS_ENABLED` | разрешить адресные Telegram-миссии | `true`; `false` аварийно отключает |
| `OPENAI_IMAGE_API_KEY` | fallback ключа изображений | предпочтительно encrypted Dashboard setting |
| `DESIGN_ENGINE` | движок дизайн-концепций | `codex`; `openai` включает image API |

`OPENAI_MODEL_FAST` и `OPENAI_MODEL_SMART` сохраняют имена логических моделей
для конфигурации приложения. Фактические текстовые sales-задачи выполняет ровно
один внешний broker через таблицу `ai_tasks`.

## AI-брокеры

Общие секреты: `SALES_BROKER_TOKEN` используется только внутренней очередью,
`SALES_OWNER_TOKEN` — owner actions/notifications. `deploy.sh` переносит их в
root-only env-файлы. `SALES_AI_BROKER=auto|hermes|codex` выбирает ровно одного
consumer; переменная задаётся при запуске `deploy.sh`, а не хранится как право
на внешнюю отправку.

Hermes:

| Переменная | Назначение |
|---|---|
| `SALES_HERMES_API`, `SALES_HERMES_SALES_API` | только loopback API Hermes и Sales |
| `SALES_HERMES_API_KEY_FILE` | root-only файл ключа Hermes |
| `SALES_BROKER_ENV_FILE`, `SALES_BROKER_TOKEN_FILE` | источник broker token |
| `SALES_HERMES_MODEL`, `SALES_HERMES_MODEL_FAST`, `SALES_HERMES_MODEL_SMART` | default и маршрутизация моделей |
| `SALES_HERMES_REQUEST_TIMEOUT_SECONDS` | HTTP timeout, 1–60 секунд |
| `SALES_HERMES_RUN_TIMEOUT_SECONDS` | run timeout, 60–1100 секунд |
| `SALES_HERMES_POLL_INTERVAL_SECONDS` | polling, 0.5–15 секунд |
| `SALES_HERMES_RUNTIME_DIR`, `SALES_HERMES_EXCHANGE_DIR` | checkpoints и разрешённый обмен вложениями |
| `SALES_HERMES_TELEGRAM_TOKEN_FILE`, `SALES_HERMES_CHANNEL_DIRECTORY` | опциональная доставка owner-уведомлений |

Codex fallback:

| Переменная | Назначение |
|---|---|
| `CODEX_BIN` | путь к авторизованному Codex CLI |
| `SALES_CODEX_API` | loopback internal Sales API |
| `SALES_CODEX_MODEL` | необязательное имя модели |
| `SALES_CODEX_TIMEOUT_SECONDS` | timeout одной задачи, минимум 60 секунд |

## Telegram sync и owner-session fallback

`telegram-sync` читает существующую MTProto/Hermes state. Основные параметры:
`HERMES_STATE_DB`, `SALES_TELEGRAM_SYNC_STATE`, `TELEGRAM_TOKEN_FILE`,
`SALES_TELEGRAM_INTERNAL_API`, `BUSINESS_OWNER_TELEGRAM_ID` и
`SALES_MTPROTO_TEXT_SYNC`. В production синхронизация обычного текста выключена,
чтобы webhook и MTProto не создавали дубли; голосовые расшифровки импортируются
отдельно.

Owner-session bridge является opt-in и использует
`SALES_USERBOT_ENABLED=false`, `SALES_USERBOT_DAILY_LIMIT=20`,
`SALES_USERBOT_POLL_SECONDS=20`, `SALES_USERBOT_STATE_DB`,
`SALES_USERBOT_DSN` и `SALES_USERBOT_ERROR_MATCH=BUSINESS_PEER_INVALID`.
Он не генерирует текст и передаёт существующему sender только уже одобренный
draft с повторной проверкой content hash.

## Диагностические переменные

`SANDBOX_SMOKE_API`, `SANDBOX_SMOKE_POLL_MS`, `SANDBOX_SMOKE_TIMEOUT_MS` и
`SANDBOX_SMOKE_DESIGN` управляют CLI sandbox smoke. `PUBLIC_URL`,
`SCREENSHOT_DIR` и `CHROMIUM_PATH` используются visual smoke; `LOG_LEVEL` —
Python workers. Они не меняют правила внешней отправки.

## Инварианты безопасности

1. FL.ru никогда не отправляет отклик без ручного одобрения, независимо от
   `AUTO_DRAFT_FL`, policy или миссии.
2. Telegram-миссия ограничена выбранным клиентом, новыми live-сообщениями,
   deadline/turn limit и stop-темами.
3. `send_unknown` не повторяется автоматически.
4. Отключение safety flag требует осознанного изменения Compose и нового
   релиза; правка `.env` сама по себе production-режим не ослабляет.
5. Полный перечень поведения откликов находится в [PROPOSALS.md](PROPOSALS.md),
   Telegram — в [TELEGRAM_AGENT.md](TELEGRAM_AGENT.md), проверок — в
   [TESTING.md](TESTING.md).
