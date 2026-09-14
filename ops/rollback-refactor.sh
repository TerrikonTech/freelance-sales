#!/bin/bash
# Мгновенный откат freelance-sales-v2 к состоянию до рефакторинга 2026-09-09.
# Использование: /opt/vds-console/workspaces/default/freelance-sales-v2/ops/rollback-refactor.sh [--full]
#   (по умолчанию) — вернуть старый dist и перезапустить api/worker
#   --full         — ещё и восстановить БД из дампа (уничтожит данные после бэкапа!)
set -e
BK=/opt/vds-console/backups/freelance-refactor-20260909T233126Z
ROOT=/opt/vds-console/workspaces/default/freelance-sales-v2
cd "$ROOT"
echo ">>> restore old dist+src from $BK"
docker compose stop api worker ai-broker-openrouter router-loader >/dev/null 2>&1 || true
tar xzf $BK/code-src-dist.tar.gz
if [ "$1" = "--full" ]; then
  echo ">>> restoring DB (DESTRUCTIVE)"
  docker compose start postgres >/dev/null; sleep 5
  source .env
  gunzip -c $BK/db-freelance.sql.gz | docker exec -i freelance-sales-v2-postgres-1 psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -q
fi
docker compose up -d api worker ai-broker-openrouter
sleep 8
curl -fsS http://127.0.0.1:8790/api/health && echo && echo "ROLLBACK OK (образ-страховка: freelance-sales-app:rollback-20260909T233126Z)"
