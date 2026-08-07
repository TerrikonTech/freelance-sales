#!/usr/bin/env python3
"""Deliver owner-approved replies that the Bot API refused, from the owner's account.

The Bot API rejects chats outside the Business connection with
BUSINESS_PEER_INVALID.  Those chats are mirrored from the owner's personal
Telegram session, and that session already has a working sender: the running
`codex-mesh-hermes-mtproto-sync` service drains an `mtproto_outbox` table and
sends each row with `client.send_message`.

So this worker does not open Telegram at all.  Opening a second Telethon client
on the same StringSession would risk AUTH_KEY_DUPLICATED and kill the owner's
live mirror.  Instead it is a bridge:

    postgres (refused delivery) -> mtproto_outbox row -> existing sender
    existing sender result      -> postgres ledger, messages, activity

Safety model:

* it never composes anything -- only text the owner already approved;
* it only touches deliveries the Bot API refused with BUSINESS_PEER_INVALID;
* the content hash is re-verified against the draft before hand-off;
* the delivery id is the outbox primary key, so a row can never be queued twice;
* an outbox failure is recorded and never re-queued automatically;
* hand-off stays off until SALES_USERBOT_ENABLED=true, and is capped per day.
"""

from __future__ import annotations

import argparse
import logging
import os
import sqlite3
import sys
import time

LOG = logging.getLogger("sales_telegram_userbot")

ENABLED = os.environ.get("SALES_USERBOT_ENABLED", "false").lower() == "true"
DAILY_LIMIT = int(os.environ.get("SALES_USERBOT_DAILY_LIMIT", "20"))
POLL_SECONDS = max(5, int(os.environ.get("SALES_USERBOT_POLL_SECONDS", "20")))
STATE_DB = os.environ.get("SALES_USERBOT_STATE_DB", "/hermes-state/state.sqlite3")
DSN = os.environ.get("SALES_USERBOT_DSN") or os.environ.get("DATABASE_URL", "")
RETRYABLE_ERROR = os.environ.get("SALES_USERBOT_ERROR_MATCH", "BUSINESS_PEER_INVALID")

MARKER = "[userbot]"
QUEUED = f"{MARKER} queued:"

SELECT_REFUSED = """
SELECT d.id::text       AS delivery_id,
       d.draft_id::text AS draft_id,
       d.lead_id::text  AS lead_id,
       d.target_external_id AS peer,
       d.content_hash   AS delivery_hash,
       dr.content       AS content,
       dr.content_hash  AS draft_hash,
       dr.status        AS draft_status,
       l.title          AS lead_title
FROM outbound_deliveries d
JOIN drafts dr ON dr.id = d.draft_id
JOIN leads  l  ON l.id  = d.lead_id
WHERE d.channel = 'telegram'
  AND d.status = 'failed_before_send'
  AND d.error ILIKE %s
  AND coalesce(d.error, '') NOT LIKE %s
  AND d.target_external_id IS NOT NULL
ORDER BY d.updated_at
LIMIT 10
"""

SELECT_QUEUED = """
SELECT d.id::text       AS delivery_id,
       d.draft_id::text AS draft_id,
       d.lead_id::text  AS lead_id,
       d.target_external_id AS peer,
       dr.content       AS content,
       l.title          AS lead_title
FROM outbound_deliveries d
JOIN drafts dr ON dr.id = d.draft_id
JOIN leads  l  ON l.id  = d.lead_id
WHERE d.status = 'failed_before_send'
  AND coalesce(d.error, '') LIKE %s
ORDER BY d.updated_at
LIMIT 20
"""

SENT_TODAY = """
SELECT count(*) FROM outbound_deliveries
WHERE channel='telegram' AND status='sent'
  AND coalesce(error,'') LIKE %s
  AND completed_at >= date_trunc('day', now())
"""


def connect_db():
    try:
        import psycopg  # type: ignore

        return psycopg.connect(DSN, autocommit=True), "psycopg"
    except ModuleNotFoundError:
        pass
    import psycopg2  # type: ignore

    conn = psycopg2.connect(DSN)
    conn.autocommit = True
    return conn, "psycopg2"


def state_db(readonly: bool = False):
    """The sender owns this file; hold it briefly and commit immediately."""
    if readonly:
        db = sqlite3.connect(f"file:{STATE_DB}?mode=ro", uri=True, timeout=15)
    else:
        db = sqlite3.connect(STATE_DB, timeout=15)
    db.row_factory = sqlite3.Row
    return db


def rows_as_dicts(cur):
    names = [c[0] for c in cur.description]
    return [dict(zip(names, values)) for values in cur.fetchall()]


def client_id_for(db, peer: str):
    row = db.execute(
        "SELECT client_id FROM clients WHERE chat_id=? ORDER BY last_seen_at DESC LIMIT 1",
        (int(peer),),
    ).fetchone()
    return int(row["client_id"]) if row else None


def enqueue(db, reply_id: str, client_id: int, peer: str, text: str) -> bool:
    """Insert the row the running sender drains.  The delivery id is the key."""
    with db:
        cur = db.execute(
            "INSERT OR IGNORE INTO mtproto_outbox"
            "(reply_id,client_id,chat_id,text,status,created_at)"
            " VALUES(?,?,?,?,'queued',strftime('%s','now'))",
            (reply_id, client_id, int(peer), text),
        )
        return cur.rowcount == 1


def outbox_status(db, reply_id: str):
    row = db.execute(
        "SELECT status,error_type FROM mtproto_outbox WHERE reply_id=?", (reply_id,)
    ).fetchone()
    return (row["status"], row["error_type"]) if row else (None, None)


def mark(cur, delivery_id: str, note: str) -> None:
    cur.execute(
        "UPDATE outbound_deliveries SET error = coalesce(error,'') || %s,"
        " updated_at = now() WHERE id = %s",
        (f" {MARKER} {note}", delivery_id),
    )


def record_sent(cur, row) -> None:
    external_id = f"{row['peer']}:userbot:{row['delivery_id']}"
    cur.execute(
        "UPDATE outbound_deliveries SET status='sent', external_id=%s,"
        " error = coalesce(error,'') || %s, completed_at=now(), updated_at=now()"
        " WHERE id=%s",
        (external_id, f" {MARKER} delivered", row["delivery_id"]),
    )
    cur.execute(
        "UPDATE drafts SET status='sent', sent_at=now(), error=NULL, updated_at=now()"
        " WHERE id=%s",
        (row["draft_id"],),
    )
    cur.execute(
        "INSERT INTO messages(lead_id,channel,external_id,direction,author,content,metadata)"
        " VALUES(%s,'telegram',%s,'outbound','owner',%s,"
        " jsonb_build_object('draft_id',%s::text,'transport','userbot'))"
        " ON CONFLICT(channel,external_id) DO NOTHING",
        (row["lead_id"], external_id, row["content"], row["draft_id"]),
    )
    cur.execute(
        "INSERT INTO activities(lead_id,actor,action,details)"
        " VALUES(%s,'userbot','draft_sent',"
        " jsonb_build_object('draftId',%s::text,'transport','userbot'))",
        (row["lead_id"], row["draft_id"]),
    )


def hand_off(conn, dry_run: bool) -> int:
    """Move refused deliveries into the queue the owner's session already drains."""
    queued = 0
    with conn.cursor() as cur:
        cur.execute(SENT_TODAY, (f"%{MARKER}%",))
        already = int(cur.fetchone()[0])
        if already >= DAILY_LIMIT:
            LOG.warning("daily limit reached: %s/%s", already, DAILY_LIMIT)
            return 0
        cur.execute(SELECT_REFUSED, (f"%{RETRYABLE_ERROR}%", f"%{MARKER}%"))
        pending = rows_as_dicts(cur)
    if not pending:
        return 0
    LOG.info("refused deliveries to hand off: %s", len(pending))

    db = state_db(readonly=dry_run)
    try:
        for row in pending:
            if already + queued >= DAILY_LIMIT:
                LOG.warning("daily limit reached mid-batch")
                break
            with conn.cursor() as cur:
                if row["draft_hash"] != row["delivery_hash"]:
                    mark(cur, row["delivery_id"], "content changed after approval")
                    LOG.error("draft %s: content hash mismatch", row["draft_id"])
                    continue
                if row["draft_status"] not in ("failed", "pending", "sending"):
                    mark(cur, row["delivery_id"], f"draft status {row['draft_status']}")
                    continue
                client_id = client_id_for(db, row["peer"])
                if client_id is None:
                    mark(cur, row["delivery_id"], "peer is unknown to the mirror")
                    LOG.error("peer %s is not in the mirror", row["peer"])
                    continue
                if dry_run:
                    LOG.info(
                        "DRY RUN would queue %s chars for %s (peer %s, client %s)",
                        len(row["content"]), row["lead_title"], row["peer"], client_id,
                    )
                    continue
                if not enqueue(db, row["delivery_id"], client_id, row["peer"], row["content"]):
                    mark(cur, row["delivery_id"], "already present in the outbox")
                    continue
                mark(cur, row["delivery_id"], f"queued:{row['delivery_id']}")
                queued += 1
                LOG.info("queued for %s via the owner session", row["lead_title"])
    finally:
        db.close()
    return queued


def collect(conn) -> int:
    """Finalise deliveries the owner's session has already processed."""
    settled = 0
    with conn.cursor() as cur:
        cur.execute(SELECT_QUEUED, (f"%{QUEUED}%",))
        waiting = rows_as_dicts(cur)
    if not waiting:
        return 0
    db = state_db(readonly=True)
    try:
        for row in waiting:
            status, error_type = outbox_status(db, row["delivery_id"])
            if status in (None, "queued", "sending"):
                continue
            with conn.cursor() as cur:
                if status == "sent":
                    record_sent(cur, row)
                    LOG.info("delivered to %s from the owner account", row["lead_title"])
                else:
                    mark(cur, row["delivery_id"], f"outbox {status}: {error_type}")
                    LOG.error("outbox %s for %s: %s", status, row["lead_title"], error_type)
                settled += 1
    finally:
        db.close()
    return settled


def report(conn) -> None:
    db = state_db(readonly=True)
    try:
        with conn.cursor() as cur:
            cur.execute(SELECT_REFUSED, (f"%{RETRYABLE_ERROR}%", f"%{MARKER}%"))
            refused = rows_as_dicts(cur)
            cur.execute(SELECT_QUEUED, (f"%{QUEUED}%",))
            waiting = rows_as_dicts(cur)
        LOG.info("state db: %s", STATE_DB)
        LOG.info("refused and not handed off: %s", len(refused))
        for row in refused:
            LOG.info(
                "  %s -> peer %s, client %s, %s chars",
                row["lead_title"], row["peer"],
                client_id_for(db, row["peer"]), len(row["content"]),
            )
        LOG.info("handed off and awaiting the sender: %s", len(waiting))
        for row in waiting:
            LOG.info(
                "  %s -> outbox %s",
                row["lead_title"], outbox_status(db, row["delivery_id"])[0],
            )
    finally:
        db.close()


def main() -> int:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="report state, change nothing")
    parser.add_argument("--once", action="store_true", help="single cycle, then exit")
    args = parser.parse_args()

    if not DSN:
        raise SystemExit("SALES_USERBOT_DSN (or DATABASE_URL) is required")
    if not os.path.exists(STATE_DB):
        raise SystemExit(f"mirror state database not found at {STATE_DB}")

    conn, driver = connect_db()
    LOG.info("db driver=%s enabled=%s daily_limit=%s", driver, ENABLED, DAILY_LIMIT)
    if args.check:
        report(conn)
        return 0

    while True:
        try:
            collect(conn)
            hand_off(conn, dry_run=not ENABLED)
        except Exception as error:  # noqa: BLE001 - keep the loop alive
            LOG.exception("cycle failed: %s", error)
        if args.once:
            break
        time.sleep(POLL_SECONDS)
    return 0


if __name__ == "__main__":
    sys.exit(main())
