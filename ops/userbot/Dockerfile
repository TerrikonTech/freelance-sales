# Build context is the project root (see docker-compose.userbot.yml).
FROM python:3.12-alpine

# Only a Postgres driver is needed: Telegram is reached through the mirror's
# own outbox, not through a second Telethon client.
RUN pip install --no-cache-dir "psycopg[binary]==3.2.3"

WORKDIR /app
COPY ops/sales_telegram_userbot.py /app/sales_telegram_userbot.py

ENV SALES_USERBOT_STATE_DB=/hermes-state/state.sqlite3 \
    PYTHONUNBUFFERED=1

ENTRYPOINT ["python3", "/app/sales_telegram_userbot.py"]
