# Freelance Sales

AI-система продаж для FL.ru и Telegram: собирает новые проекты и вложения,
оценивает релевантность и цену, готовит отклики и сообщения, но ничего не
отправляет без ручного подтверждения.

## Быстрый запуск

Требования к Linux-серверу:

- Docker с `docker compose`;
- Python 3;
- авторизованный Codex CLI;
- systemd.

```bash
git clone https://github.com/TerrikonTech/freelance-sales.git
cd freelance-sales
sudo ./deploy.sh
```

Скрипт сам:

1. создаёт `.env` с уникальными секретами, если его ещё нет;
2. собирает и запускает API, PWA, PostgreSQL, Redis и FL-воркер;
3. устанавливает и запускает host-side Codex-брокер;
4. проверяет готовность API.

Данные, cookies FL.ru и настройки подключений не хранятся в Git. После первого
запуска откройте `PUBLIC_URL/setup?token=<SETUP_TOKEN>`; оба значения находятся
в локальном `.env`.

Если Codex CLI установлен нестандартно:

```bash
sudo CODEX_BIN=/path/to/codex ./deploy.sh
```

## Управление

```bash
sudo ./deploy.sh status
sudo ./deploy.sh stop
sudo ./deploy.sh up
```

`stop` останавливает приложение, сканирование и анализатор, но сохраняет базу,
Redis и загруженные документы в Docker volumes.

## Безопасность

- исходящие отклики и сообщения требуют одобрения;
- `.env`, broker token, cookies, база, документы, runtime-логи и бэкапы
  исключены из Git;
- секреты подключений в базе шифруются AES-256-GCM;
- OpenAI API-ключ не нужен: AI-задачи выполняет локально авторизованный Codex.

## Публикация на текущем VDS

В `ops/caddy-sales.json` лежит маршрут `/sales` для существующего Caddy на VDS.
Контейнер `router-loader` восстанавливает этот маршрут через локальный Caddy
Admin API. Для другого домена замените `PUBLIC_URL` в `.env` и настройте HTTPS
reverse proxy на `127.0.0.1:8790`.
