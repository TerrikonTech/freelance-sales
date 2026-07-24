#!/usr/bin/env python3
"""Securely transfer the existing Telegram Business connector into Sales."""

from __future__ import annotations

import argparse
import json
import pathlib
import sqlite3
import urllib.request

from migrate_hermes_history import broker_token


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--activate", action="store_true")
    parser.add_argument(
        "--state-db",
        type=pathlib.Path,
        default=pathlib.Path(
            "/var/lib/codex-mesh-hermes/exchange/business-bridge-runtime/state/state.sqlite3"
        ),
    )
    parser.add_argument(
        "--token-file",
        type=pathlib.Path,
        default=pathlib.Path(
            "/var/lib/codex-mesh/hermes-business/telegram-token"
        ),
    )
    parser.add_argument(
        "--broker-env",
        type=pathlib.Path,
        default=pathlib.Path("/etc/freelance-sales-broker.env"),
    )
    parser.add_argument(
        "--api",
        default="http://127.0.0.1:8790/api/internal/telegram/configure",
    )
    parser.add_argument("--owner-id", type=int, required=True)
    args = parser.parse_args()

    db = sqlite3.connect(f"file:{args.state_db}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    try:
        connection = db.execute(
            """
            SELECT connection_id FROM connections
            WHERE enabled=1 ORDER BY updated_at DESC LIMIT 1
            """
        ).fetchone()
    finally:
        db.close()
    if connection is None:
        raise RuntimeError("active Telegram Business connection is missing")

    token = args.token_file.read_text(encoding="utf-8").strip()
    if ":" not in token:
        raise RuntimeError("Telegram token is missing")
    with urllib.request.urlopen(
        f"https://api.telegram.org/bot{token}/getMe",
        timeout=20,
    ) as response:
        bot = json.loads(response.read().decode())
    username = str((bot.get("result") or {}).get("username") or "").strip()
    if not username:
        raise RuntimeError("Telegram bot username is missing")
    payload = {
        "botToken": token,
        "connectionId": str(connection["connection_id"]),
        "ownerId": args.owner_id,
        "contactUsername": username,
        "activate": args.activate,
    }
    request = urllib.request.Request(
        args.api,
        data=json.dumps(payload).encode(),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Sales-Broker-Token": broker_token(args.broker_env),
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        result = json.loads(response.read().decode())
    print(
        "configured=true "
        f"staged={str(bool(result.get('staged'))).lower()} "
        f"active={str(args.activate).lower()}"
    )


if __name__ == "__main__":
    main()
