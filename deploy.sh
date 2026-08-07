#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DOCKER_CONFIG="${DOCKER_CONFIG:-${PROJECT_ROOT}/.docker-config}"
COMPOSE_BAKE="${COMPOSE_BAKE:-false}"
export DOCKER_CONFIG COMPOSE_BAKE
CODEX_SERVICE_NAME="sales-codex-broker.service"
HERMES_SERVICE_NAME="sales-hermes-broker.service"
BROKER_ENV_FILE="/etc/freelance-sales-broker.env"
OWNER_ENV_FILE="/etc/freelance-sales-owner.env"
HERMES_KEY_FILE="/etc/codex-mesh/hermes-api-key"
HERMES_EXCHANGE_DIR="/var/lib/codex-mesh-hermes/exchange/sales"
BROKER_MODE="${SALES_AI_BROKER:-auto}"
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

  local postgres_password jwt_secret encryption_key setup_token broker_token owner_token
  postgres_password="$(random_hex 24)"
  jwt_secret="$(random_hex 32)"
  encryption_key="$(random_hex 32)"
  setup_token="$(python3 -c 'import secrets; print(secrets.token_urlsafe(36))')"
  broker_token="$(random_hex 32)"
  owner_token="$(random_hex 32)"

  sed \
    -e "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://freelance:${postgres_password}@postgres:5432/freelance|" \
    -e "s|^JWT_SECRET=.*|JWT_SECRET=${jwt_secret}|" \
    -e "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=${encryption_key}|" \
    -e "s|^SETUP_TOKEN=.*|SETUP_TOKEN=${setup_token}|" \
    -e "s|^SALES_BROKER_TOKEN=.*|SALES_BROKER_TOKEN=${broker_token}|" \
    -e "s|^SALES_OWNER_TOKEN=.*|SALES_OWNER_TOKEN=${owner_token}|" \
    -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${postgres_password}|" \
    "${PROJECT_ROOT}/.env.example" >"${PROJECT_ROOT}/.env"
  chmod 600 "${PROJECT_ROOT}/.env"
  echo "Создан новый .env с уникальными секретами."
}

ensure_broker_token() {
  local broker_token
  broker_token="$(sed -n 's/^SALES_BROKER_TOKEN=//p' "${PROJECT_ROOT}/.env" | tail -n 1)"
  if [[ ${#broker_token} -lt 32 || "${broker_token}" == generate_* ]]; then
    broker_token="$(random_hex 32)"
    if grep -q '^SALES_BROKER_TOKEN=' "${PROJECT_ROOT}/.env"; then
      sed -i "s|^SALES_BROKER_TOKEN=.*|SALES_BROKER_TOKEN=${broker_token}|" "${PROJECT_ROOT}/.env"
    else
      printf '\nSALES_BROKER_TOKEN=%s\n' "${broker_token}" >>"${PROJECT_ROOT}/.env"
    fi
  fi
  umask 077
  mkdir -p "$(dirname -- "${BROKER_ENV_FILE}")"
  local temporary
  temporary="$(mktemp "${BROKER_ENV_FILE}.tmp.XXXXXX")"
  printf 'SALES_BROKER_TOKEN=%s\n' "${broker_token}" >"${temporary}"
  chmod 600 "${temporary}"
  chown root:root "${temporary}"
  mv -f "${temporary}" "${BROKER_ENV_FILE}"
}

ensure_owner_token() {
  local owner_token temporary
  owner_token="$(sed -n 's/^SALES_OWNER_TOKEN=//p' "${PROJECT_ROOT}/.env" | tail -n 1)"
  if [[ ${#owner_token} -lt 32 || "${owner_token}" == generate_* ]]; then
    owner_token="$(random_hex 32)"
    if grep -q '^SALES_OWNER_TOKEN=' "${PROJECT_ROOT}/.env"; then
      sed -i "s|^SALES_OWNER_TOKEN=.*|SALES_OWNER_TOKEN=${owner_token}|" "${PROJECT_ROOT}/.env"
    else
      printf '\nSALES_OWNER_TOKEN=%s\n' "${owner_token}" >>"${PROJECT_ROOT}/.env"
    fi
  fi
  umask 077
  mkdir -p "$(dirname -- "${OWNER_ENV_FILE}")"
  temporary="$(mktemp "${OWNER_ENV_FILE}.tmp.XXXXXX")"
  printf 'SALES_OWNER_TOKEN=%s\n' "${owner_token}" >"${temporary}"
  chmod 600 "${temporary}"
  chown root:root "${temporary}"
  mv -f "${temporary}" "${OWNER_ENV_FILE}"
}

install_codex_broker_service() {
  local codex_bin
  codex_bin="${CODEX_BIN:-$(command -v codex || true)}"
  if [[ -z "${codex_bin}" || ! -x "${codex_bin}" ]]; then
    echo "Codex CLI не найден. Укажите путь: CODEX_BIN=/path/to/codex ./deploy.sh" >&2
    exit 1
  fi

  sed \
    -e "s|__PROJECT_ROOT__|${PROJECT_ROOT}|g" \
    -e "s|__CODEX_BIN__|${codex_bin}|g" \
    "${PROJECT_ROOT}/ops/sales-codex-broker.service" \
    >"/etc/systemd/system/${CODEX_SERVICE_NAME}"
  chmod 644 "/etc/systemd/system/${CODEX_SERVICE_NAME}"
  systemctl daemon-reload
  systemctl disable --now "${HERMES_SERVICE_NAME}" 2>/dev/null || true
  systemctl enable --now "${CODEX_SERVICE_NAME}"
}

use_compose_hermes_broker() {
  prepare_hermes_directories || return 1
  systemctl disable --now "${CODEX_SERVICE_NAME}" 2>/dev/null || true
  systemctl disable --now "${HERMES_SERVICE_NAME}" 2>/dev/null || true
  compose up -d ai-broker
  compose exec -T ai-broker \
    python3 /project/ops/sales_hermes_broker.py --health-check >/dev/null || {
      compose stop ai-broker
      return 1
    }
}

prepare_hermes_directories() {
  if [[ ! -f "${HERMES_KEY_FILE}" ]]; then
    echo "Hermes API key не настроен: ${HERMES_KEY_FILE}" >&2
    return 1
  fi
  if ! getent group codex-hermes >/dev/null; then
    echo "Системная группа codex-hermes не найдена." >&2
    return 1
  fi
  install -d -o root -g root -m 0700 "${PROJECT_ROOT}/runtime/hermes-jobs"
  install -d -o root -g codex-hermes -m 2750 "${HERMES_EXCHANGE_DIR}"
}

install_hermes_broker_service() {
  local rendered rendered_dir
  prepare_hermes_directories || return 1
  SALES_BROKER_ENV_FILE="${BROKER_ENV_FILE}" \
    SALES_HERMES_API_KEY_FILE="${HERMES_KEY_FILE}" \
    SALES_HERMES_RUNTIME_DIR="${PROJECT_ROOT}/runtime/hermes-jobs" \
    SALES_HERMES_EXCHANGE_DIR="${HERMES_EXCHANGE_DIR}" \
    python3 "${PROJECT_ROOT}/ops/sales_hermes_broker.py" --health-check || return 1

  rendered_dir="$(mktemp -d /run/sales-hermes-broker.XXXXXX)"
  rendered="${rendered_dir}/${HERMES_SERVICE_NAME}"
  sed \
    -e "s|__PROJECT_ROOT__|${PROJECT_ROOT}|g" \
    -e "s|__HERMES_EXCHANGE_DIR__|${HERMES_EXCHANGE_DIR}|g" \
    "${PROJECT_ROOT}/ops/sales-hermes-broker.service" >"${rendered}" || {
      rm -rf "${rendered_dir}"
      return 1
    }
  if command -v systemd-analyze >/dev/null 2>&1; then
    systemd-analyze verify "${rendered}" || {
      rm -rf "${rendered_dir}"
      return 1
    }
  fi
  install -o root -g root -m 0644 \
    "${rendered}" "/etc/systemd/system/${HERMES_SERVICE_NAME}" || {
      rm -rf "${rendered_dir}"
      return 1
    }
  rm -rf "${rendered_dir}"
  systemctl daemon-reload
  systemctl disable --now "${CODEX_SERVICE_NAME}" 2>/dev/null || true
  systemctl enable --now "${HERMES_SERVICE_NAME}"
}

install_broker_service() {
  case "${BROKER_MODE}" in
    hermes)
      use_compose_hermes_broker
      ;;
    codex)
      compose stop ai-broker 2>/dev/null || true
      install_codex_broker_service
      ;;
    auto)
      if [[ -f "${HERMES_KEY_FILE}" ]] \
        && systemctl is-active --quiet codex-mesh-hermes.service \
        && use_compose_hermes_broker; then
        echo "AI-брокер: Hermes в изолированном Compose-сервисе."
      else
        compose stop ai-broker 2>/dev/null || true
        echo "Hermes не готов; используется host-side Codex-брокер." >&2
        install_codex_broker_service
      fi
      ;;
    *)
      echo "SALES_AI_BROKER должен быть auto, hermes или codex." >&2
      exit 2
      ;;
  esac
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
  systemctl --no-pager --full status "${HERMES_SERVICE_NAME}" 2>/dev/null | sed -n '1,12p' || true
  systemctl --no-pager --full status "${CODEX_SERVICE_NAME}" 2>/dev/null | sed -n '1,12p' || true
}

case "${COMMAND}" in
  up|start)
    require_command docker
    require_command python3
    require_command curl
    install -d -m 0700 "${DOCKER_CONFIG}"
    docker compose version >/dev/null
    create_env_if_missing
    ensure_broker_token
    ensure_owner_token
    # Stop both possible consumers before the application rollout. This keeps
    # the shared ai_tasks queue single-consumer even across mode switches.
    systemctl disable --now "${HERMES_SERVICE_NAME}" 2>/dev/null || true
    systemctl disable --now "${CODEX_SERVICE_NAME}" 2>/dev/null || true
    compose stop ai-broker 2>/dev/null || true
    compose up -d --build postgres redis api worker router-loader telegram-sync
    wait_for_api
    install_broker_service
    echo "Freelance Sales запущен."
    echo "Первичная настройка: откройте PUBLIC_URL/setup?token=<SETUP_TOKEN>."
    echo "PUBLIC_URL и SETUP_TOKEN находятся в .env."
    ;;
  stop)
    systemctl disable --now "${HERMES_SERVICE_NAME}" 2>/dev/null || true
    systemctl disable --now "${CODEX_SERVICE_NAME}" 2>/dev/null || true
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
