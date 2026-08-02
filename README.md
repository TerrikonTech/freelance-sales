# Freelance Sales

AI-система продаж для FL.ru и Telegram: собирает новые проекты и вложения,
оценивает релевантность и цену, готовит отклики и сообщения, но ничего не
отправляет без ручного подтверждения.

Telegram работает в режиме `on-demand`: входящие сообщения сохраняются и
пополняют контекст сделки, но сами по себе не запускают AI-генерацию, ответ или
уведомление владельцу. Бот отвечает и готовит материалы только после явной
команды владельца; отправка клиенту требует отдельной команды «отправь».

## Единый агент сделки

Один `lead` остаётся источником истины при переходе клиента между FL.ru и
Telegram. Агент хранит каналы, полную хронологию, краткое резюме, стадию
продажи и структурированные требования. Он:

- оценивает новый заказ и готовит персональный отклик на FL.ru;
- продолжает диалог и безопасно переводит клиента в Telegram по одноразовому
  коду `FS-XXXXXX`;
- ведёт предпроектное интервью небольшими блоками, не повторяя уже закрытые
  вопросы;
- отделяет подтверждённые требования от допущений и открытых вопросов;
- отвечает владельцу на вопросы по конкретному клиенту и учитывает указанный
  период переписки;
- готовит ответ клиенту, но отправляет его только после отдельной команды
  владельца «отправь» и повторной проверки актуальности;
- формирует ТЗ, данные для DOCX-шаблона договора и проверяемый пакет для Codex
  с acceptance criteria, тест-планом и Definition of Done.

Рискованные темы — цена, срок, скидка, договор, доступы, гарантии и конфликт —
всегда требуют решения владельца. Даже в режиме `smart` автоматически могут
уйти только безопасные информационные ответы без новых обязательств.

## Быстрый запуск

Требования к Linux-серверу:

- Docker с `docker compose`;
- Python 3;
- готовый loopback-only Hermes Agent sidecar или авторизованный Codex CLI;
- systemd.

```bash
git clone https://github.com/TerrikonTech/freelance-sales.git
cd freelance-sales
sudo ./deploy.sh
```

Скрипт сам:

1. создаёт `.env` с уникальными секретами, если его ещё нет;
2. собирает и запускает API, PWA, PostgreSQL, Redis и FL-воркер;
3. выбирает и запускает ровно один host-side AI-брокер;
4. проверяет готовность API.

По умолчанию `SALES_AI_BROKER=auto`: если локальный Hermes полностью готов
(health, API-аутентификация и модель), используется Hermes; иначе скрипт
оставляет безопасный fallback на Codex. Выбор можно зафиксировать явно:

```bash
sudo SALES_AI_BROKER=hermes ./deploy.sh
sudo SALES_AI_BROKER=codex ./deploy.sh
```

Оба брокера используют одну очередь `ai_tasks`, поэтому одновременно они не
запускаются. systemd units дополнительно объявлены конфликтующими.

Данные, cookies FL.ru и настройки подключений не хранятся в Git. После первого
запуска откройте `PUBLIC_URL/setup?token=<SETUP_TOKEN>`; оба значения находятся
в локальном `.env`.

Если Codex CLI установлен нестандартно:

```bash
sudo CODEX_BIN=/path/to/codex ./deploy.sh
```

## Hermes-брокер

`ops/sales_hermes_broker.py` — отдельный host-side worker без сетевого
listener. Он:

- читает ключ Hermes только из `/etc/codex-mesh/hermes-api-key`;
- читает `SALES_BROKER_TOKEN` только из root-only
  `/etc/freelance-sales-broker.env`;
- AI-run и внутреннюю очередь обслуживает только через
  `127.0.0.1:8642` и `127.0.0.1:8790`;
- делает heartbeat, claim, complete/fail через существующий внутренний API;
- отправляет Hermes строго ограниченный JSON-контекст и проверяет результат по
  той же схеме, что использует Codex-брокер;
- копирует только явно указанные вложения задачи в
  `/var/lib/codex-mesh-hermes/exchange/sales`;
- сохраняет только техническую контрольную точку `task_id/kind/run_id`, чтобы
  после рестарта продолжить уже запущенный run и не создать дубль;
- не повторяет `POST /runs`, если ответ на отправку потерялся: такой запуск
  помечается неоднозначным и безопасно завершается ошибкой;
- останавливает run при таймауте или неподдерживаемом запросе подтверждения.

Если API проекта предоставляет опциональную очередь
`/api/internal/owner/notifications`, брокер также доставляет владельцу вопросы
через уже настроенного Hermes Telegram bot. Токен читается только из
`/etc/codex-mesh/hermes-telegram-token`, а единственный DM/home target — из
`/var/lib/codex-mesh-hermes/channel_directory.json`. Сообщение получает
inline-кнопки **Ответить**, **Пропустить** и **Пауза** с callback_data
`sales:approve:*`, `sales:skip:*`, `sales:pause:*`. Брокер не вызывает
`getUpdates` и не меняет webhook: входящие callback updates остаются у
существующего Hermes gateway. Если токен, однозначный home DM или API endpoints
отсутствуют, уведомления отключаются, но AI-очередь продолжает работать.

Для входящих нажатий Telegram используется отдельный `SALES_OWNER_TOKEN`.
`deploy.sh` хранит его в project `.env` для API и синхронизирует root-only
`/etc/freelance-sales-owner.env` (mode `0600`) для последующей безопасной
передачи Hermes unit через systemd `LoadCredential`. Этот токен не даёт
Telegram gateway доступа к claim/complete AI-задачам. AI-брокер продолжает
использовать только `SALES_BROKER_TOKEN`.

Hermes в этом контуре только анализирует лиды и готовит структурированные
результаты. Он не получает cookies FL.ru, Docker socket, SSH-ключи или
возможность самостоятельно отправлять сообщения.

Локальная проверка конфигурации без сети и без получения задач:

```bash
sudo python3 ops/sales_hermes_broker.py --dry-run
```

Проверка Sales API, ключа Hermes и готовности модели (задача не забирается):

```bash
sudo python3 ops/sales_hermes_broker.py --health-check
```

Один цикл для диагностики очереди:

```bash
sudo python3 ops/sales_hermes_broker.py --once
```

Допустимые настройки находятся только в окружении systemd:
`SALES_HERMES_REQUEST_TIMEOUT_SECONDS` (1–60),
`SALES_HERMES_RUN_TIMEOUT_SECONDS` (60–1100),
`SALES_HERMES_POLL_INTERVAL_SECONDS` (0.5–15) и необязательный
`SALES_HERMES_MODEL`. Пути к Telegram token и channel directory можно
переопределить через `SALES_HERMES_TELEGRAM_TOKEN_FILE` и
`SALES_HERMES_CHANNEL_DIRECTORY`. Секреты через `Environment=` не передаются.

## Управление

```bash
sudo ./deploy.sh status
sudo ./deploy.sh stop
sudo ./deploy.sh up
```

`stop` останавливает приложение, сканирование и анализатор, но сохраняет базу,
Redis и загруженные документы в Docker volumes.

## Telegram Business и история Hermes

Текстовые сообщения принимает webhook приложения. Авторизованная MTProto-сессия
используется только для расшифровки голосовых; `telegram-sync` переносит готовую
расшифровку во внутреннюю очередь и не дублирует текст webhook.

Для существующей установки сначала сделайте бэкап PostgreSQL, Redis и Hermes
SQLite, затем перенесите историю без генерации ответов:

```bash
python3 ops/migrate_hermes_history.py
python3 ops/migrate_hermes_history.py --apply
```

Команда идемпотентна. После контрольной сверки перенесите существующее Business
подключение. Без `--activate` данные только шифруются и сохраняются в Sales:

```bash
python3 ops/stage_telegram_connector.py --owner-id <TELEGRAM_USER_ID>
python3 ops/stage_telegram_connector.py --owner-id <TELEGRAM_USER_ID> --activate
docker compose up -d telegram-sync
```

Один bot token нельзя одновременно использовать с webhook и `getUpdates`.
Поэтому старый long-polling bridge нужно остановить непосредственно перед
`--activate`; MTProto-сессию останавливать не следует.

Для договора загрузите в настройках DOCX-шаблон. Неизвестные юридические данные
не подставляются: они остаются в `open_questions`, а готовый договор всегда
требует ручной проверки.

## Безопасность

- исходящие отклики и сообщения требуют одобрения;
- `.env`, broker token, cookies, база, документы, runtime-логи и бэкапы
  исключены из Git;
- Hermes API key, Sales broker token и отдельный owner token не копируются в
  репозиторий, аргументы процессов или журналы;
- секреты подключений в базе шифруются AES-256-GCM;
- OpenAI API-ключ приложению не нужен: AI-задачи выполняет отдельно
  авторизованный Hermes либо локально авторизованный Codex.
- `STRICT_APPROVAL=true` принудительно оставляет ручной режим даже при старой
  настройке `smart`, а `TELEGRAM_ON_DEMAND_ONLY=true` блокирует автоматические
  Telegram-черновики и инициативные сообщения бота.

## Публикация на текущем VDS

В `ops/caddy-sales.json` лежит маршрут `/sales` для существующего Caddy на VDS.
Контейнер `router-loader` восстанавливает этот маршрут через локальный Caddy
Admin API. Для другого домена замените `PUBLIC_URL` в `.env` и настройте HTTPS
reverse proxy на `127.0.0.1:8790`.
