#!/usr/bin/env bash
# Loads hand-written portfolio cases into settings.fl_portfolio_cases.
#
# These are cases for a niche the owner has no published FL.ru work in yet, so the
# 30-minute portfolio sync cannot discover them.  They carry source="manual", which
# fl.service.ts preserves across syncs until FL.ru publishes the same title.
#
# Idempotent: a case whose title is already present is replaced, not duplicated.
#
# Usage: ops/load_portfolio_seed.sh [path-to-seed.json]
set -euo pipefail

SEED="${1:-$(dirname "$0")/portfolio_seed_funnel.json}"
CONTAINER="${PG_CONTAINER:-freelance-sales-v2-postgres-1}"
DB_USER="${PG_USER:-freelance}"
DB_NAME="${PG_DB:-freelance}"

[ -f "$SEED" ] || { echo "Файл сида не найден: $SEED" >&2; exit 1; }

# Base64 keeps the payload on one line and immune to quoting, which a raw multi-line
# JSON passed through a psql \set backtick is not.
SEED_B64="$(python3 -c '
import base64, json, sys
raw = open(sys.argv[1], "rb").read()
cases = json.loads(raw)
if not isinstance(cases, list) or not cases:
    raise SystemExit("Сид должен быть непустым JSON-массивом")
for case in cases:
    for field in ("title", "description"):
        if not str(case.get(field, "")).strip():
            raise SystemExit("У кейса пустое поле " + field)
sys.stdout.write(base64.b64encode(json.dumps(cases, ensure_ascii=False).encode()).decode())
' "$SEED")"

docker exec -i -e SEED_B64="$SEED_B64" "$CONTAINER" \
  psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL'
\set seed `printf '%s' "$SEED_B64" | base64 -d`

BEGIN;

INSERT INTO settings(key, public_value)
VALUES ('fl_portfolio_cases', '[]'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE TEMP TABLE seed_cases(payload jsonb);
INSERT INTO seed_cases(payload) VALUES (:'seed'::jsonb);

UPDATE settings s
SET public_value = (
      SELECT coalesce(jsonb_agg(item), '[]'::jsonb)
      FROM (
        SELECT existing.value AS item
        FROM jsonb_array_elements(s.public_value) AS existing(value)
        WHERE lower(trim(existing.value->>'title')) NOT IN (
          SELECT lower(trim(fresh.value->>'title'))
          FROM seed_cases, jsonb_array_elements(seed_cases.payload) AS fresh(value)
        )
        UNION ALL
        SELECT fresh.value
        FROM seed_cases, jsonb_array_elements(seed_cases.payload) AS fresh(value)
      ) merged
    ),
    updated_at = now()
WHERE s.key = 'fl_portfolio_cases';

DROP TABLE seed_cases;
COMMIT;

SELECT jsonb_array_length(public_value) AS total,
       (SELECT count(*) FROM jsonb_array_elements(public_value) c
        WHERE c->>'source' = 'manual') AS manual
FROM settings WHERE key = 'fl_portfolio_cases';
SQL
