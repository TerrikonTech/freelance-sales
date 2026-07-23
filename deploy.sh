#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="sales-codex-broker.service"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}"
COMMAND="${1:-up}"

if [[ ${EUID} -ne 0 ]]; then
  exec sudo -E "$0" "$@"
fi

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Не найдена команда: $1" >&2
    exit 1
  fi
}

compose() {
  docker compose --project-directory "${PROJECT_ROOT}" -f "${PROJECT_ROOT}/docker-compose.yml" "$@"
}

random_hex() {
  python3 -c "import secrets; print(secrets.token_hex($1))"
}

create_env_if_missing() {
  if [[ -f "${PROJECT_ROOT}/.env" ]]; then
    return
  fi

  local postgres_password jwt_secret encryption_key setup_token broker_token
  postgres_password="$(random_hex 24)"
  jwt_secret="$(random_hex 32)"
  encryption_key="$(random_hex 32)"
  setup_token="$(python3 -c 'import secrets; print(secrets.token_urlsafe(36))')"
  broker_token="$(random_hex 32)"

  sed \
    -e "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://freelance:${postgres_password}@postgres:5432/freelance|" \
    -e "s|^JWT_SECRET=.*|JWT_SECRET=${jwt_secret}|" \
    -e "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=${encryption_key}|" \
    -e "s|^SETUP_TOKEN=.*|SETUP_TOKEN=${setup_token}|" \
    -e "s|^SALES_BROKER_TOKEN=.*|SALES_BROKER_TOKEN=${broker_token}|" \
    -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${postgres_password}|" \
    "${PROJECT_ROOT}/.env.example" >"${PROJECT_ROOT}/.env"
  chmod 600 "${PROJECT_ROOT}/.env"
  echo "Создан новый .env с уникальными секретами."
}

ensure_broker_token() {
  local broker_token
  broker_token="$(sed -n 's/^SALES_BROKER_TOKEN=//p' "${PROJECT_ROOT}/.env" | tail -n 1)"
  if [[ -z "${broker_token}" || "${broker_token}" == generate_* ]]; then
    broker_token="$(random_hex 32)"
    if grep -q '^SALES_BROKER_TOKEN=' "${PROJECT_ROOT}/.env"; then
      sed -i "s|^SALES_BROKER_TOKEN=.*|SALES_BROKER_TOKEN=${broker_token}|" "${PROJECT_ROOT}/.env"
    else
      printf '\nSALES_BROKER_TOKEN=%s\n' "${broker_token}" >>"${PROJECT_ROOT}/.env"
    fi
  fi
  umask 077
  printf '%s\n' "${broker_token}" >"${PROJECT_ROOT}/.sales-broker-token"
}

install_broker_service() {
  local codex_bin
  codex_bin="${CODEX_BIN:-$(command -v codex || true)}"
  if [[ -z "${codex_bin}" || ! -x "${codex_bin}" ]]; then
    echo "Codex CLI не найден. Укажите путь: CODEX_BIN=/path/to/codex ./deploy.sh" >&2
    exit 1
  fi

  sed \
    -e "s|__PROJECT_ROOT__|${PROJECT_ROOT}|g" \
    -e "s|__CODEX_BIN__|${codex_bin}|g" \
    "${PROJECT_ROOT}/ops/sales-codex-broker.service" >"${SERVICE_FILE}"
  chmod 644 "${SERVICE_FILE}"
  systemctl daemon-reload
  systemctl enable --now "${SERVICE_NAME}"
}

wait_for_api() {
  local attempt
  for attempt in {1..90}; do
    if curl -fsS --max-time 2 http://127.0.0.1:8790/api/health >/dev/null; then
      return
    fi
    sleep 2
  done
  echo "API не стал доступен за 180 секунд." >&2
  compose ps
  exit 1
}

show_status() {
  compose ps -a
  systemctl --no-pager --full status "${SERVICE_NAME}" 2>/dev/null | sed -n '1,12p' || true
}

case "${COMMAND}" in
  up|start)
    require_command docker
    require_command python3
    require_command curl
    docker compose version >/dev/null
    create_env_if_missing
    ensure_broker_token
    compose up -d --build
    wait_for_api
    install_broker_service
    echo "Freelance Sales запущен."
    echo "Первичная настройка: откройте PUBLIC_URL/setup?token=<SETUP_TOKEN>."
    echo "PUBLIC_URL и SETUP_TOKEN находятся в .env."
    ;;
  stop)
    systemctl disable --now "${SERVICE_NAME}" 2>/dev/null || true
    compose stop
    echo "Freelance Sales и анализатор остановлены. Данные сохранены."
    ;;
  status)
    show_status
    ;;
  *)
    echo "Использование: ./deploy.sh [up|stop|status]" >&2
    exit 2
    ;;
esac
