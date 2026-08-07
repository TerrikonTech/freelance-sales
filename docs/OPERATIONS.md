# Эксплуатация и восстановление

## Требования

- Linux host с Docker Engine и `docker compose`;
- Python 3 для host-side утилит;
- HTTPS reverse proxy;
- авторизованный Hermes или Codex broker;
- отдельное постоянное хранилище для PostgreSQL, Redis и документов.

Node.js на host не обязателен: сборка выполняется внутри Docker.

## Первый запуск

```bash
git clone https://github.com/TerrikonTech/freelance-sales.git
cd freelance-sales
sudo ./deploy.sh
```

Если `.env` отсутствует, `deploy.sh` создаёт уникальные секреты из
`.env.example`, собирает образ, запускает Compose, ждёт `/api/health` и выбирает
ровно один AI-брокер. Значения из реального `.env` никогда не копируются в Git.

После старта откройте `PUBLIC_URL/setup?token=<SETUP_TOKEN>`, создайте владельца
и настройте подключения через Dashboard.

## Режимы брокера

```bash
sudo SALES_AI_BROKER=hermes ./deploy.sh
sudo SALES_AI_BROKER=codex ./deploy.sh
```

`auto` сначала проверяет Hermes, затем использует Codex fallback. Оба варианта
обслуживают одну таблицу `ai_tasks`; одновременный запуск двух потребителей
недопустим.

## Безопасное обновление

1. Проверьте состояние Git и не затирайте локальные изменения.
2. Сделайте бэкап PostgreSQL, документов, Redis и внешней Telegram state.
3. Получите нужный commit/tag.
4. Сверьте изменения `.env.example`, SQL-схемы и Compose.
5. Выполните `docker compose build`; Dockerfile запускает build и API tests.
6. Выполните `docker compose up -d` или `./deploy.sh up`.
7. Проверьте health, контейнеры, broker heartbeat, scan runs и новые логи.

Не удаляйте volumes и не запускайте `docker system prune` как часть обычного
обновления.

## Команды состояния

```bash
sudo ./deploy.sh status
docker compose ps
curl -fsS http://127.0.0.1:8790/api/health
docker compose logs --since=15m api worker ai-broker telegram-sync
```

Проверяйте именно loopback endpoint; публичный proxy — отдельный слой. Не
выводите `.env` и secret-bearing settings в журнал диагностики.

## Признаки здоровья

- `api`, `postgres`, `redis`, `router-loader` healthy;
- `worker`, `ai-broker`, `telegram-sync` работают без restart loop;
- `/api/health` отвечает `ok`;
- `connector_state` показывает свежий heartbeat AI и успешные scan runs;
- в `ai_tasks` нет старых `claimed`/`pending` задач;
- в `outbound_deliveries` нет необъяснённых `send_unknown`;
- диск имеет запас для PostgreSQL, Docker layers и документов.

## Резервное копирование

Минимальный полноценный backup должен содержать:

1. PostgreSQL dump;
2. Redis/AOF или согласованный snapshot очереди;
3. `data/documents`;
4. зашифрованную копию `.env` и системных broker/owner tokens;
5. Telegram/Hermes state, если требуется восстановить привязки и MTProto;
6. точный Git commit и версию Docker image.

Секреты и клиентские данные храните отдельно от репозитория с шифрованием и
ограниченными правами. Периодически проверяйте восстановление на изолированном
стенде; наличие файла бэкапа само по себе не доказывает восстановимость.

## Восстановление

1. Разверните код на зафиксированном commit.
2. Восстановите `.env` с правами `0600`.
3. Создайте volumes и запустите только PostgreSQL/Redis.
4. Восстановите dump и документы.
5. Запустите API, затем worker и ровно один AI-broker.
6. Подключите Telegram/FL коннекторы после проверки базы.
7. Сначала оставьте `STRICT_APPROVAL=true` и
   `TELEGRAM_ON_DEMAND_ONLY=true`.
8. Проверьте sandbox, затем read-only scan, затем одну явно одобренную доставку.

## Миграция Hermes и Telegram

`ops/migrate_hermes_history.py` переносит историю сначала в dry-run, затем с
`--apply`. `ops/stage_telegram_connector.py` шифрует и подготавливает Business
подключение без активации; `--activate` используйте только после остановки
старого long polling для того же bot token.

Один token нельзя одновременно обслуживать webhook и `getUpdates`.

## Owner-session bridge

Bridge отделён от основного Compose:

```bash
docker compose -f ops/userbot/docker-compose.userbot.yml build
docker compose -f ops/userbot/docker-compose.userbot.yml run --rm userbot --check
SALES_USERBOT_ENABLED=true docker compose -f ops/userbot/docker-compose.userbot.yml up -d
```

Перед включением убедитесь, что существующий MTProto sender активен, outbox
доступна и дневной лимит подходит. Откат останавливает bridge, но не отменяет уже
доставленные сообщения.

## Диагностика типовых проблем

### AI-задача зависла

- проверьте heartbeat broker;
- убедитесь, что работает только один broker;
- найдите возраст и статус `ai_tasks` без вывода payload с клиентскими данными;
- проверьте доступность Hermes/Codex;
- не создавайте повторную задачу, пока результат старой неоднозначен.

### FL.ru видит ноль чатов

- проверьте валидность сессии и время последнего scan;
- проверьте загрузку страницы Chromium и таймауты;
- сначала выполните ручной scan из Dashboard;
- не меняйте cookies вслепую и не запускайте параллельные login-процессы.

### Telegram вернул `BUSINESS_PEER_INVALID`

- это может означать, что peer доступен личной сессии, но не Business API;
- проверьте, включён ли owner-session bridge и известен ли peer;
- дождитесь финального результата delivery;
- при `send_unknown` проверьте чат вручную, не повторяйте автоматически.

### Старый черновик не отправляется

Это ожидаемо, если после генерации пришло новое сообщение. Создайте новый draft;
не снимайте проверку `last_inbound_message_id`.

## Откат релиза

Откат кода выполняйте на предыдущий проверенный commit/image без удаления
данных. Если новая версия уже изменила схему, сначала проверьте обратную
совместимость SQL. Отдельно подтвердите, что внешняя доставка не осталась в
неизвестном состоянии: откат не является основанием повторять сообщение.
