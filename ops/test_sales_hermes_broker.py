from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import unittest
from dataclasses import replace
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sales_hermes_broker as broker


class FakeSales:
    def __init__(self) -> None:
        self.heartbeats = 0
        self.completed: list[tuple[str, dict[str, Any]]] = []
        self.failed: list[tuple[str, str]] = []

    def heartbeat(self) -> None:
        self.heartbeats += 1

    def complete(self, task_id: str, result: dict[str, Any]) -> None:
        self.completed.append((task_id, result))

    def fail(self, task_id: str, error: str) -> None:
        self.failed.append((task_id, error))


class FakeHermes:
    def __init__(self, output: str) -> None:
        self.output = output
        self.submissions = 0
        self.stopped: list[str] = []
        self.status_error: Exception | None = None

    def submit(self, **_: Any) -> str:
        self.submissions += 1
        return "run_" + "a" * 32

    def status(self, _: str) -> dict[str, Any]:
        if self.status_error is not None:
            raise self.status_error
        return {"status": "completed", "output": self.output}

    def stop(self, run_id: str) -> None:
        self.stopped.append(run_id)


class AmbiguousHermes(FakeHermes):
    def submit(self, **_: Any) -> str:
        self.submissions += 1
        raise broker.AmbiguousSubmission("ambiguous")


class FakeHttp:
    def __init__(self, responses: list[dict[str, Any]]) -> None:
        self.responses = list(responses)
        self.requests: list[dict[str, Any]] = []

    def request(self, method: str, url: str, **kwargs: Any) -> dict[str, Any]:
        self.requests.append({"method": method, "url": url, **kwargs})
        if not self.responses:
            raise AssertionError("unexpected HTTP request")
        return self.responses.pop(0)


class FakeOwnerSales:
    def __init__(self) -> None:
        self.notification: dict[str, Any] | None = {
            "id": "notification-1",
            "decisionId": "decision-1",
            "title": "Test",
            "reason": "Needs owner",
            "recommendation": "Reply",
        }
        self.sent: list[tuple[str, str]] = []
        self.failed: list[tuple[str, str]] = []

    def claim_owner_notification(self) -> dict[str, Any] | None:
        value, self.notification = self.notification, None
        return value

    def owner_notification_sent(self, notification_id: str, external_id: str = "") -> None:
        self.sent.append((notification_id, external_id))

    def owner_notification_failed(self, notification_id: str, error: str) -> None:
        self.failed.append((notification_id, error))


class FakeTelegram:
    def send(self, notification: dict[str, Any]) -> str:
        if notification["id"] != "notification-1":
            raise AssertionError("wrong notification")
        return "42"


class HermesBrokerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        runtime = root / "runtime"
        exchange = root / "exchange"
        documents = root / "documents"
        runtime.mkdir()
        exchange.mkdir()
        documents.mkdir()
        self.config = broker.Config(
            sales_api="http://127.0.0.1:8790/api/internal/codex",
            hermes_api="http://127.0.0.1:8642/v1",
            mesh_api="http://127.0.0.1:9443/api/internal/sales",
            sales_token="s" * 64,
            hermes_key="h" * 64,
            mesh_token=None,
            mesh_mode="off",
            mesh_timeout=60,
            runtime_dir=runtime,
            exchange_dir=exchange,
            documents_dir=documents,
            request_timeout=2,
            run_timeout=60,
            poll_interval=0.001,
            model="",
            worker_id="test-worker",
            telegram_token=None,
            telegram_chat_id=None,
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_mesh_route_requires_a_complex_proposal(self) -> None:
        simple = {
            "context": {
                "lead": {
                    "description": "Fix one CSS margin.",
                    "recommended_price": 30_000,
                }
            }
        }
        self.assertEqual(broker.mesh_route_reasons("draft_compose", simple), [])

        explicit_range = {
            "context": {
                "lead": {
                    "description": "Нужна грубая вилка цены и предлагаемый стек.",
                    "recommended_price": 100_000,
                }
            }
        }
        self.assertEqual(
            broker.mesh_route_reasons("draft_compose", explicit_range),
            ["buyer_requested_nonstandard_commercial_answer"],
        )

        complex_payload = {
            "context": {
                "lead": {
                    "description": "FB-01 " + "x" * 1_600,
                    "recommended_price": 750_000,
                    "analysis": {
                        "understanding": {
                            "confirmed_scope": ["minimum"],
                            "wishlist_or_future_scope": ["full"],
                        }
                    },
                }
            }
        }
        self.assertEqual(
            broker.mesh_route_reasons("draft_compose", complex_payload),
            [
                "buyer_requested_nonstandard_commercial_answer",
                "long_specification",
                "high_value",
                "multiple_scope_contours",
            ],
        )
        self.assertEqual(broker.mesh_route_reasons("lead_analysis", complex_payload), [])

    def test_mesh_timeout_cancels_the_team_run_before_fallback(self) -> None:
        config = replace(
            self.config,
            mesh_token="m" * 64,
            mesh_mode="prefer",
            mesh_timeout=0,
        )
        http = FakeHttp(
            [
                {"run_id": "run_" + "b" * 32, "state": "queued"},
                {"run_id": "run_" + "b" * 32, "state": "cancelled"},
            ]
        )
        client = broker.MeshClient(config, http)  # type: ignore[arg-type]
        with self.assertRaisesRegex(broker.BrokerError, "timeout"):
            client.run(
                "task-mesh-timeout",
                "draft_compose",
                {"context": {"lead": {"description": "FB-01"}}},
                ["buyer_requested_nonstandard_commercial_answer"],
            )
        self.assertEqual([request["method"] for request in http.requests], ["POST", "DELETE"])

    def test_loopback_validation_rejects_external_and_credentials(self) -> None:
        with self.assertRaises(broker.BrokerError):
            broker._validated_loopback_url(
                "https://example.com/v1", field="test"
            )
        with self.assertRaises(broker.BrokerError):
            broker._validated_loopback_url(
                "http://secret@127.0.0.1:8642/v1", field="test"
            )
        self.assertEqual(
            broker._validated_loopback_url(
                "http://127.0.0.1:8642/v1/", field="test"
            ),
            "http://127.0.0.1:8642/v1",
        )

    def test_private_file_requires_root_only_mode(self) -> None:
        path = Path(self.temporary.name) / "secret"
        path.write_text("x" * 64, encoding="ascii")
        path.chmod(0o600)
        self.assertEqual(
            broker._read_private_file(path, label="test").strip(),
            "x" * 64,
        )
        path.chmod(0o640)
        with self.assertRaises(broker.BrokerError):
            broker._read_private_file(path, label="test")

    def test_extract_and_validate_json_result(self) -> None:
        result = broker._extract_json_object(
            'Before\n```json\n{"content":"' + ("x" * 24) + '"}\n```\nAfter'
        )
        broker._validate_schema(result, broker.SCHEMAS["draft_reply"])
        with self.assertRaises(broker.BrokerError):
            broker._validate_schema(
                {"content": "x" * 24, "unexpected": True},
                broker.SCHEMAS["draft_reply"],
            )

    def test_conversation_turn_schema_carries_research_controls(self) -> None:
        result = {
            "intent": "clarify_catalog",
            "stage": "discovery",
            "conversation_stage": "s2_discovery",
            "confidence": 93,
            "reply": "Каталог уже есть, поэтому источник остатков важнее экранов. Он приходит из МойСклад?",
            "summary": "Каталог существует, источник остатков уточняется.",
            "next_action": "Уточнить источник остатков",
            "discovery_readiness": 45,
            "build_readiness": 20,
            "should_move_to_telegram": False,
            "discovery_complete": False,
            "requires_owner": False,
            "value_before_question": True,
            "owner_brief": None,
            "reply_deadline": None,
            "risk_flags": [],
            "requirements": [],
        }
        broker._validate_schema(result, broker.SCHEMAS["conversation_turn"])
        result["conversation_stage"] = "invented_stage"
        with self.assertRaises(broker.BrokerError):
            broker._validate_schema(result, broker.SCHEMAS["conversation_turn"])

    def test_large_context_stays_valid_and_bounded(self) -> None:
        text = broker._bounded_context(
            {
                "lead": {
                    "title": "Test",
                    "description": "д" * 100_000,
                }
            }
        )
        self.assertLessEqual(len(text), broker._MAX_HERMES_INPUT_CHARS)
        serialized = text.split("<task_context_json>\n", 1)[1].split(
            "\n</task_context_json>", 1
        )[0]
        self.assertIsInstance(json.loads(serialized), dict)

    def test_success_completes_existing_sales_task(self) -> None:
        sales = FakeSales()
        hermes = FakeHermes('{"content":"' + ("готово " * 4).strip() + '"}')
        worker = broker.Broker(self.config, sales, hermes)
        worker.process(
            {
                "id": "task-001",
                "kind": "draft_reply",
                "payload": {"context": {"lead": {"title": "Test"}}},
            }
        )
        self.assertEqual(hermes.submissions, 1)
        self.assertEqual(sales.failed, [])
        self.assertEqual(sales.completed[0][0], "task-001")
        self.assertFalse(worker.states.path_for("task-001").exists())

    def test_ambiguous_submission_is_never_retried(self) -> None:
        sales = FakeSales()
        hermes = AmbiguousHermes("")
        worker = broker.Broker(self.config, sales, hermes)
        worker.process(
            {
                "id": "task-002",
                "kind": "draft_reply",
                "payload": {"context": {}},
            }
        )
        self.assertEqual(hermes.submissions, 1)
        self.assertEqual(sales.completed, [])
        self.assertEqual(len(sales.failed), 1)
        self.assertIn("ambiguous", sales.failed[0][1].lower())

    def test_retryable_status_failure_preserves_run_for_recovery(self) -> None:
        sales = FakeSales()
        hermes = FakeHermes("")
        hermes.status_error = broker.ServiceError(
            "Loopback service is unavailable", retryable=True
        )
        worker = broker.Broker(self.config, sales, hermes)
        worker.process(
            {
                "id": "task-003",
                "kind": "draft_reply",
                "payload": {"context": {}},
            }
        )
        self.assertEqual(sales.completed, [])
        self.assertEqual(sales.failed, [])
        state = json.loads(
            (worker.states.path_for("task-003") / "state.json").read_text()
        )
        self.assertEqual(state["stage"], "running")
        self.assertEqual(state["run_id"], "run_" + "a" * 32)

    def test_recovery_polls_existing_run_without_resubmitting(self) -> None:
        sales = FakeSales()
        hermes = FakeHermes('{"content":"' + ("result " * 4).strip() + '"}')
        worker = broker.Broker(self.config, sales, hermes)
        worker.states.write(
            "task-004",
            {
                "version": 1,
                "task_id": "task-004",
                "kind": "draft_reply",
                "stage": "running",
                "run_id": "run_" + "a" * 32,
                "exchange_path": "",
                "started_at": time.time(),
            },
        )
        worker.recover()
        self.assertEqual(hermes.submissions, 0)
        self.assertEqual(sales.completed[0][0], "task-004")
        self.assertFalse(worker.states.path_for("task-004").exists())

    def test_attachment_copy_is_bounded_and_cleaned(self) -> None:
        source = self.config.documents_dir / "brief.txt"
        source.write_text("safe attachment", encoding="utf-8")
        payload = {"attachment": {"local_path": "brief.txt"}}
        exchange = broker.AttachmentExchange(self.config, "task-005")
        exchange.materialize(payload)
        target = Path(payload["attachment"]["local_path"])
        self.assertTrue(target.is_file())
        self.assertEqual(target.read_text(), "safe attachment")
        self.assertEqual(target.stat().st_mode & 0o777, 0o640)
        exchange.cleanup()
        self.assertFalse(target.exists())

    def test_owner_notification_sales_endpoints_use_existing_broker_auth(self) -> None:
        http = FakeHttp(
            [
                {
                    "notification": {
                        "id": "notification-1",
                        "decisionId": "decision-1",
                        "text": "Нужен ответ владельца",
                    }
                },
                {"ok": True},
                {"ok": True},
            ]
        )
        sales = broker.SalesClient(self.config, http)  # type: ignore[arg-type]
        notification = sales.claim_owner_notification()
        self.assertEqual(notification["id"], "notification-1")
        sales.owner_notification_sent("notification-1")
        sales.owner_notification_failed("notification-2", "delivery failed")
        self.assertEqual(
            http.requests[0]["url"],
            "http://127.0.0.1:8790/api/internal/owner/notifications/claim",
        )
        self.assertEqual(http.requests[0]["method"], "GET")
        self.assertTrue(http.requests[0]["optional"])
        self.assertEqual(
            http.requests[0]["headers"]["X-Sales-Broker-Token"],
            self.config.sales_token,
        )
        self.assertTrue(http.requests[1]["url"].endswith("/notification-1/sent"))
        self.assertTrue(http.requests[2]["url"].endswith("/notification-2/fail"))

    def test_telegram_send_uses_inline_decision_buttons_only(self) -> None:
        config = replace(
            self.config,
            telegram_token="123456:" + "t" * 40,
            telegram_chat_id="123456789",
        )
        http = FakeHttp([{"ok": True, "result": {"message_id": 10}}])
        telegram = broker.TelegramClient(config, http)  # type: ignore[arg-type]
        external_id = telegram.send(
            {
                "id": "notification-1",
                "decisionId": "decision-1",
                "title": "Проект клиента",
                "channel": "fl",
                "reason": "Клиент просит скидку",
                "confidence": 0.91,
                "recommendation": "Предлагаю сохранить согласованную цену.",
            }
        )
        self.assertEqual(external_id, "10")
        request = http.requests[0]
        self.assertEqual(request["method"], "POST")
        self.assertTrue(request["url"].startswith("https://api.telegram.org/bot"))
        body = request["body"]
        self.assertIn("Можно отправить?", body["text"])
        self.assertIn("Предлагаемый ответ", body["text"])
        callbacks = [
            button["callback_data"]
            for row in body["reply_markup"]["inline_keyboard"]
            for button in row
        ]
        self.assertEqual(
            callbacks,
            [
                "sales:approve:decision-1",
                "sales:skip:decision-1",
                "sales:pause:decision-1",
            ],
        )
        self.assertNotIn("getUpdates", request["url"])
        self.assertNotIn("setWebhook", request["url"])

    def test_channel_directory_selects_single_private_dm(self) -> None:
        directory = Path(self.temporary.name) / "channel_directory.json"
        directory.write_text(
            json.dumps(
                {
                    "platforms": {
                        "telegram": [
                            {
                                "id": "123456789",
                                "name": "Owner",
                                "type": "dm",
                                "thread_id": None,
                            }
                        ]
                    }
                }
            ),
            encoding="utf-8",
        )
        directory.chmod(0o600)
        self.assertEqual(
            broker._read_channel_directory(directory),
            "123456789",
        )

    def test_owner_notification_loop_claims_sends_and_acks(self) -> None:
        sales = FakeOwnerSales()
        loop = broker.OwnerNotificationLoop(
            sales,  # type: ignore[arg-type]
            FakeTelegram(),  # type: ignore[arg-type]
        )
        loop.tick()
        self.assertEqual(sales.sent, [("notification-1", "42")])
        self.assertEqual(sales.failed, [])


if __name__ == "__main__":
    unittest.main()
