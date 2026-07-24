#!/usr/bin/env python3
"""Mirror Telegram MTProto text and voice transcripts into the sales agent."""

from __future__ import annotations

import json
import logging
import os
import pathlib
import sqlite3
import time
import urllib.request


LOG = logging.getLogger("sales_mtproto_bridge")
STATE_DB = pathlib.Path(
    os.environ.get(
        "HERMES_STATE_DB",
        "/var/lib/codex-mesh-hermes/exchange/business-bridge-runtime/state/state.sqlite3",
    )
)
STATE_FILE = pathlib.Path(
    os.environ.get(
        "SALES_TELEGRAM_SYNC_STATE",
        "/opt/vds-console/workspaces/default/freelance-sales-v2/runtime/telegram-sync.json",
    )
)
BROKER_ENV = pathlib.Path(
    os.environ.get("SALES_BROKER_ENV_FILE", "/etc/freelance-sales-broker.env")
)
TOKEN_FILE = pathlib.Path(
    os.environ.get(
        "TELEGRAM_TOKEN_FILE",
        "/var/lib/codex-mesh/hermes-business/telegram-token",
    )
)
API_ROOT = os.environ.get(
    "SALES_TELEGRAM_INTERNAL_API",
    "http://127.0.0.1:8790/api/internal/telegram",
).rstrip("/")
OWNER_ID = int(os.environ.get("BUSINESS_OWNER_TELEGRAM_ID", "0"))
SYNC_TEXT = os.environ.get("SALES_MTPROTO_TEXT_SYNC", "false").lower() == "true"


def secret_from_env(path: pathlib.Path, name: str) -> str:
    values: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped.startswith("export "):
            stripped = stripped[7:].lstrip()
        if stripped.startswith(f"{name}="):
            values.append(stripped.split("=", 1)[1].strip().strip("'\""))
    if len(values) != 1 or len(values[0]) < 32:
        raise RuntimeError(f"{name} is missing")
    return values[0]


def request_json(
    url: str,
    *,
    payload: dict[str, object] | None = None,
    token: str | None = None,
) -> dict:
    headers = {"Content-Type": "application/json"}
    if token:
        headers["X-Sales-Broker-Token"] = token
    request = urllib.request.Request(
        url,
        data=(
            json.dumps(payload, ensure_ascii=False).encode()
            if payload is not None
            else None
        ),
        method="POST" if payload is not None else "GET",
        headers=headers,
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        result = json.loads(response.read().decode())
        if not isinstance(result, dict):
            raise RuntimeError("unexpected API response")
        return result


def bot_id() -> int:
    token = TOKEN_FILE.read_text(encoding="utf-8").strip()
    if not token:
        raise RuntimeError("Telegram token is missing")
    result = request_json(f"https://api.telegram.org/bot{token}/getMe")
    value = int((result.get("result") or {}).get("id") or 0)
    if not value:
        raise RuntimeError("could not resolve Telegram bot id")
    return value


def load_state(db: sqlite3.Connection) -> dict[str, object]:
    if STATE_FILE.is_file():
        value = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        if isinstance(value, dict):
            return value
    last_id = int(
        db.execute("SELECT COALESCE(max(id),0) FROM client_messages").fetchone()[0]
    )
    voices = {
        f"{row['chat_id']}:{row['message_id']}:{row['updated_at']}": int(time.time())
        for row in db.execute(
            """
            SELECT chat_id,message_id,updated_at FROM voice_transcripts
            WHERE status='ready'
            """
        ).fetchall()
    }
    state = {"last_message_id": last_id, "voices": voices}
    save_state(state)
    return state


def save_state(state: dict[str, object]) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = STATE_FILE.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, separators=(",", ":")), encoding="utf-8")
    temporary.chmod(0o600)
    temporary.replace(STATE_FILE)


def post_messages(token: str, rows: list[dict[str, object]]) -> None:
    if rows:
        request_json(
            f"{API_ROOT}/messages",
            payload={"messages": rows},
            token=token,
        )


def post_owner_command(
    token: str,
    *,
    message_id: int,
    text: str,
) -> None:
    request_json(
        f"{API_ROOT}/owner-command",
        payload={
            "ownerId": OWNER_ID,
            "chatId": OWNER_ID,
            "messageId": message_id,
            "text": text,
        },
        token=token,
    )


def main() -> None:
    if not OWNER_ID:
        raise SystemExit("BUSINESS_OWNER_TELEGRAM_ID is missing")
    broker_token = secret_from_env(BROKER_ENV, "SALES_BROKER_TOKEN")
    current_bot_id = bot_id()
    db = sqlite3.connect(f"file:{STATE_DB}?mode=ro", uri=True, timeout=30)
    db.row_factory = sqlite3.Row
    state = load_state(db)
    LOG.info("Sales Telegram mirror started")
    while True:
        try:
            last_id = int(state.get("last_message_id") or 0)
            rows = db.execute(
                """
                SELECT m.id,m.role,m.content,m.created_at,c.chat_id,c.label
                FROM client_messages m JOIN clients c ON c.client_id=m.client_id
                WHERE m.id>? AND c.chat_id IS NOT NULL AND trim(m.content)<>''
                ORDER BY m.id LIMIT 250
                """,
                (last_id,),
            ).fetchall()
            messages: list[dict[str, object]] = []
            for row in rows:
                if not SYNC_TEXT:
                    continue
                if (
                    int(row["chat_id"]) == current_bot_id
                    and str(row["role"]) == "assistant"
                ):
                    post_owner_command(
                        broker_token,
                        message_id=int(row["id"]),
                        text=str(row["content"])[:8000],
                    )
                else:
                    messages.append(
                        {
                            "chatId": str(row["chat_id"]),
                            "messageId": f"mtproto-row:{row['id']}",
                            "direction": (
                                "outbound"
                                if str(row["role"]) == "assistant"
                                else "inbound"
                            ),
                            "text": str(row["content"])[:8000],
                            "label": str(row["label"] or "")[:200],
                            "createdAt": int(row["created_at"]),
                            "live": True,
                        }
                    )
            post_messages(broker_token, messages)
            if rows:
                state["last_message_id"] = int(rows[-1]["id"])

            seen = dict(state.get("voices") or {})
            voice_rows = db.execute(
                """
                SELECT chat_id,message_id,text,updated_at FROM voice_transcripts
                WHERE status='ready' AND text IS NOT NULL
                  AND updated_at>=strftime('%s','now')-86400
                ORDER BY updated_at,chat_id,message_id
                """
            ).fetchall()
            for row in voice_rows:
                key = f"{row['chat_id']}:{row['message_id']}:{row['updated_at']}"
                if key in seen:
                    continue
                text = str(row["text"] or "").strip()
                if not text:
                    seen[key] = int(time.time())
                    continue
                if int(row["chat_id"]) == current_bot_id:
                    post_owner_command(
                        broker_token,
                        message_id=int(row["message_id"]),
                        text=text[:8000],
                    )
                else:
                    post_messages(
                        broker_token,
                        [
                            {
                                "chatId": str(row["chat_id"]),
                                "messageId": f"voice:{row['message_id']}",
                                "direction": "inbound",
                                "text": f"[Расшифровка голосового] {text[:7900]}",
                                "createdAt": int(row["updated_at"]),
                                "live": True,
                                "voice": True,
                            }
                        ],
                    )
                seen[key] = int(time.time())
            if len(seen) > 1000:
                seen = dict(sorted(seen.items(), key=lambda item: item[1])[-1000:])
            state["voices"] = seen
            save_state(state)
        except Exception as exc:
            LOG.warning("Telegram mirror iteration failed: %s", type(exc).__name__)
        time.sleep(2)


if __name__ == "__main__":
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(message)s",
    )
    main()
