# Карта репозитория

## Верхний уровень

| Путь | Назначение |
|---|---|
| `apps/api` | NestJS API, worker, БД, интеграции и бизнес-логика |
| `apps/web` | React/Vite PWA и Mermaid Dashboard |
| `ops` | брокеры, миграции, smoke-проверки и deployment glue |
| `portfolio-assets` | нечувствительные изображения публичных кейсов |
| `CASE_LIBRARY_50.md` | библиотека описаний реальных кейсов |
| `case_visual_specs.json` | структурированные visual specs кейсов |
| `Dockerfile` | reproducible build и запуск API tests |
| `docker-compose.yml` | production-like services и safety flags |
| `deploy.sh` | первичная установка, build, health и выбор broker |
| `.env.example` | перечень конфигурации без секретных значений |
| `docs/RESEARCH_ROADMAP.md` | реализация исследования и safety gates фаз 0–3 |

## `apps/api/src`

| Файл | Ответственность |
|---|---|
| `main.ts` | запуск NestJS, base path, cookies и security middleware |
| `worker.ts` | BullMQ worker и периодические задания |
| `app.controller.ts` | Dashboard API, leads, drafts, sandbox, settings, docs |
| `database.service.ts` | PostgreSQL и применение `schema.sql` |
| `queue.service.ts` | Redis/BullMQ queue |
| `fl.service.ts` | FL.ru scan, проекты, вложения и чаты |
| `ai.service.ts` | анализ, pricing, отклики, документы и локальная валидация |
| `pricing-policy.ts` | детерминированные категории цены и модификаторы |
| `sales-agent.service.ts` | единый агент сделки, требования, handoff и ответы |
| `chat-policy.ts` | стадии общения, лимиты вопросов и stop rules |
| `research-controls.ts` | follow-up, присутствие, spotlighting и пороги классов |
| `research.service.ts` | расписание касаний, воронка, evals и агрегаты исследования |
| `telegram.service.ts` | webhook, owner intents, identity и доставка |
| `autonomy.service.ts` | решение allow/draft/block и client state |
| `processor.service.ts` | фоновые job handlers и внешняя доставка |
| `codex-task.service.ts` | долговечная очередь AI tasks |
| `documents.service.ts` | ТЗ, contract data и DOCX template |
| `design-concept.service.ts` | reference fetch, image/HTML concepts и signed URLs |
| `sandbox.service.ts` | изолированный тестовый контур |
| `settings.service.ts` | public/encrypted settings и connector state |
| `crypto.service.ts` | AES-256-GCM для чувствительных настроек |
| `push.service.ts` | browser push владельцу |
| `project-attachments.service.ts` | безопасное чтение вложений проекта |
| `caddy-loader.ts` | восстановление route `/sales` через local Admin API |

Файлы `*.spec.ts` лежат рядом с тестируемой логикой и входят в Jest suite.

## `ops`

| Файл | Назначение |
|---|---|
| `sales_hermes_broker.py` | основной Hermes consumer `ai_tasks` |
| `sales_codex_broker.py` | Codex fallback и схемы AI-задач |
| `sales_mtproto_bridge.py` | импорт сообщений/расшифровок из общей MTProto state |
| `sales_telegram_userbot.py` | fallback доставки через owner-session outbox |
| `migrate_hermes_history.py` | идемпотентная миграция старой истории |
| `stage_telegram_connector.py` | безопасный staging/activation Telegram connector |
| `test_sales_hermes_broker.py` | Python tests broker schemas и transport rules |
| `sandbox_smoke.js` | API smoke полного sandbox |
| `chat_research_smoke.js` | изолированные сценарии чат-политики |
| `sandbox_visual_check.js` | desktop/mobile browser smoke |
| `caddy-sales.json` | route для существующего Caddy |
| `userbot/` | отдельный opt-in Compose fallback-доставки |

## Что не должно попасть в Git

| Путь/тип | Почему |
|---|---|
| `.env`, `.sales-broker-token` | секреты и URL с credentials |
| `runtime/` | AI checkpoints, очереди и рабочие данные |
| `data/*` | клиентские документы и generated assets |
| `.backups/`, `ops/backups/` | локальные копии исходников/данных |
| cookies и Telegram session | доступ к внешним аккаунтам |
| PostgreSQL/Redis volumes | персональные данные и состояние production |
| `*.dump`, `*.tgz`, `*.zip`, logs | потенциальные секреты и тяжёлые артефакты |
| `node_modules`, `dist` | воспроизводимые build artifacts |

`data/.gitkeep` сохраняет каталог, но не данные. `.env.example` должен содержать
только безопасные заглушки и имена переменных.

## Что нужно для полного восстановления

Репозиторий восстанавливает код и конфигурационную структуру. Для состояния
конкретной установки дополнительно нужны зашифрованный DB dump, документы,
секреты, Redis/queue state и внешняя Telegram/Hermes state. Эти артефакты должны
иметь отдельную политику бэкапа и никогда не публиковаться в GitHub.
