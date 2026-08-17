#!/usr/bin/env python3
import json
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parent
cases = json.loads((ROOT / "cases.json").read_text(encoding="utf-8"))
visuals = json.loads((ROOT / "visual_specs.json").read_text(encoding="utf-8"))
errors = []

required = {
    "id", "slug", "title", "source", "url", "status", "is_demo",
    "publication_status", "description", "client_context", "task",
    "solution_details", "challenge", "result", "stack", "stack_mismatch_note",
}
if len(cases) != 5:
    errors.append(f"expected 5 cases, got {len(cases)}")
if len(visuals.get("cases", [])) != 5:
    errors.append(f"expected 5 visual specs, got {len(visuals.get('cases', []))}")

ids = set()
slugs = set()
for case in cases:
    missing = required - set(case)
    if missing:
        errors.append(f"{case.get('title', '<untitled>')}: missing {sorted(missing)}")
    ids.add(case.get("id"))
    slugs.add(case.get("slug"))
    if case.get("source") != "demo_concept" or case.get("is_demo") is not True:
        errors.append(f"{case.get('title')}: demo metadata is incomplete")
    if case.get("status") != "DEMO_READY" or case.get("publication_status") != "not_published":
        errors.append(f"{case.get('title')}: unsafe publication status")
    if case.get("url"):
        errors.append(f"{case.get('title')}: URL must stay empty before publication")
    text = " ".join(str(case.get(k, "")) for k in ("title", "description", "result"))
    if "ДЕМО-КЕЙС" not in case.get("title", ""):
        errors.append(f"{case.get('title')}: missing visible demo label")
    if "%" in text:
        errors.append(f"{case.get('title')}: percentage claim is not allowed")

if len(ids) != 5 or len(slugs) != 5:
    errors.append("case ids and slugs must be unique")

visual_by_id = {item.get("id"): item for item in visuals.get("cases", [])}
if set(visual_by_id) != ids:
    errors.append("visual spec ids do not match case ids")

images_dir = ROOT / "images"
pngs = sorted(images_dir.glob("*.png"))
if pngs:
    expected = {item["filename"] for item in visuals["cases"]}
    actual = {path.name for path in pngs}
    if actual != expected:
        errors.append(f"image names mismatch: expected {sorted(expected)}, got {sorted(actual)}")
    for path in pngs:
        data = path.read_bytes()[:24]
        if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n":
            errors.append(f"{path.name}: not a PNG")
            continue
        width, height = struct.unpack(">II", data[16:24])
        if (width, height) != (1672, 941):
            errors.append(f"{path.name}: expected 1672x941, got {width}x{height}")

if errors:
    print("\n".join(f"ERROR: {error}" for error in errors))
    raise SystemExit(1)

print(f"OK: {len(cases)} demo cases, {len(visual_by_id)} visual specs, {len(pngs)} generated images")
