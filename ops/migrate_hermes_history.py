#!/usr/bin/env python3
"""Idempotently copy legacy Hermes Telegram history into the sales database."""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import sqlite3
import urllib.request


DEFAULT_DB = pathlib.Path(
    "/var/lib/codex-mesh-hermes/exchange/business-bridge-runtime/state/state.sqlite3"
)
DEFAULT_ENV = pathlib.Path("/etc/freelance-sales-broker.env")
DEFAULT_API = "http://127.0.0.1:8790/api/internal/telegram/messages"


def broker_token(path: pathlib.Path) -> str:
    values: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped.startswith("export "):
            stripped = stripped[7:].lstrip()
        if stripped.startswith("SALES_BROKER_TOKEN="):
            values.append(stripped.split("=", 1)[1].strip().strip("'\""))
    if len(values) != 1 or len(values[0]) < 32:
        raise RuntimeError("broker token is missing")
    return values[0]


def batches(rows: list[dict[str, object]], size: int = 10):
    for offset in range(0, len(rows), size):
        yield rows[offset : offset + size]


def post(api: str, token: str, messages: list[dict[str, object]]) -> dict:
    request = urllib.request.Request(
        api,
        data=json.dumps({"messages": messages}, ensure_ascii=False).encode(),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Sales-Broker-Token": token,
        },
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read().decode())


def load_messages(db_path: pathlib.Path) -> list[dict[str, object]]:
    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    try:
        rows = db.execute(
            """
            SELECT m.id,m.role,m.content,m.created_at,c.chat_id,c.label
            FROM client_messages m
            JOIN clients c ON c.client_id=m.client_id
            WHERE c.chat_id IS NOT NULL AND trim(m.content)<>''
            ORDER BY m.id
            """
        ).fetchall()
        return [
            {
                "chatId": str(row["chat_id"]),
                "messageId": f"legacy:{row['id']}",
                "direction": (
                    "outbound" if str(row["role"]) == "assistant" else "inbound"
                ),
                "text": str(row["content"])[:8000],
                "label": str(row["label"] or "")[:200],
                "createdAt": int(row["created_at"]),
                "live": False,
            }
            for row in rows
        ]
    finally:
        db.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", type=pathlib.Path, default=DEFAULT_DB)
    parser.add_argument("--broker-env", type=pathlib.Path, default=DEFAULT_ENV)
    parser.add_argument("--api", default=os.environ.get("SALES_TELEGRAM_IMPORT_API", DEFAULT_API))
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    rows = load_messages(args.database)
    print(f"legacy_messages={len(rows)}")
    if not args.apply:
        print("dry_run=true")
        return

    token = broker_token(args.broker_env)
    inserted = 0
    queued = 0
    requests = 0
    for batch in batches(rows):
        result = post(args.api, token, batch)
        inserted += int(result.get("inserted") or 0)
        queued += int(result.get("queued") or 0)
        requests += 1
    print(f"requests={requests} inserted={inserted} queued={queued}")


if __name__ == "__main__":
    main()
