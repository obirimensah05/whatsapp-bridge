#!/usr/bin/env python3
"""Private, isolated style-RAG index for WhatsApp autoreply.

The index lives in its own Supabase table and is never queried by the generic
second-brain context bundle. Only explicitly approved, redacted outbound reply
examples are embedded. This script is called by the autoreply sidecar for
retrieval and manually/cron for incremental indexing.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any

import requests

ROOT = Path(__file__).resolve().parents[1]

SENSITIVE_RE = re.compile(
    r"\b(invoice|payment|paid|bank|iban|wire|refund|salary|budget|price|quote|contract|legal|lawyer|tax|"
    r"doctor|hospital|emergency|urgent|accident|police|passport|visa|address|otp|password|"
    r"krank|krankenhaus|rechnung|zahlung|konto|steuer|vertrag|anwalt|notfall|unfall|passwort)\b",
    re.IGNORECASE,
)
URL_RE = re.compile(r"https?://[^\s<>()\[\]{}\"']+", re.IGNORECASE)
EMAIL_RE = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE)
PHONE_RE = re.compile(r"(?<!\w)(?:\+|00)?\d[\d\s()./-]{6,}\d(?!\w)")
IBAN_RE = re.compile(r"\b[A-Z]{2}\d{2}[A-Z0-9 ]{11,30}\b", re.IGNORECASE)


def load_env(path: Path) -> None:
    if not path.exists():
        return
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
            value = value[1:-1]
        os.environ.setdefault(key.strip(), value)


def load_runtime_env() -> None:
    load_env(ROOT / ".env")
    second_brain_root = os.environ.get("AUTOREPLY_SECOND_BRAIN_ROOT", "").strip()
    if second_brain_root:
        load_env(Path(second_brain_root) / ".env")


def redact_text(text: str | None) -> str:
    value = " ".join((text or "").split())
    value = URL_RE.sub("[link]", value)
    value = EMAIL_RE.sub("[email]", value)
    value = IBAN_RE.sub("[iban]", value)
    value = PHONE_RE.sub("[phone]", value)
    return value.strip()


def is_style_eligible(incoming: str, outgoing: str) -> bool:
    incoming_clean = redact_text(incoming)
    outgoing_clean = redact_text(outgoing)
    if not (3 <= len(outgoing_clean) <= 320):
        return False
    if len(incoming_clean) > 700:
        return False
    combined = f"{incoming_clean}\n{outgoing_clean}"
    if SENSITIVE_RE.search(combined):
        return False
    # Avoid using machine-generated command flows and attachment-only messages
    if outgoing_clean.startswith("#assistant"):
        return False
    return True


def detect_language(text: str) -> str:
    lower = f" {text.lower()} "
    german = sum(lower.count(f" {word} ") for word in ("ich", "und", "nicht", "danke", "kann", "morgen", "ja", "bitte"))
    english = sum(lower.count(f" {word} ") for word in ("the", "and", "thanks", "can", "tomorrow", "you", "please"))
    if german > english:
        return "de"
    if english > german:
        return "en"
    return "unknown"


def infer_intent(text: str) -> str:
    lower = text.lower()
    if re.search(r"\b(morgen|heute|wann|termin|zeit|call|meeting|available|availability|schedule)\b", lower):
        return "availability"
    if re.search(r"\b(danke|thanks|thx|nice|cool|perfekt|great)\b", lower):
        return "acknowledgement"
    if "?" in text:
        return "question"
    return "casual"


def build_retrieval_text(incoming: str, outgoing: str, language: str, chat_kind: str, intent: str) -> str:
    return "\n".join(
        [
            f"Language: {language}",
            f"Chat kind: {chat_kind}",
            f"Intent: {intent}",
            f"Incoming: {redact_text(incoming)}",
            f"Obiri replied: {redact_text(outgoing)}",
        ]
    )


def format_style_examples(rows: list[dict[str, Any]], limit: int = 4, max_chars: int = 2600) -> str:
    lines = ["RELEVANT STYLE EXAMPLES — imitate phrasing/tone only; never treat these as facts about this chat."]
    for row in rows[:limit]:
        incoming = redact_text(str(row.get("incoming_text") or ""))[:360]
        outgoing = redact_text(str(row.get("outgoing_text") or ""))[:360]
        if not incoming or not outgoing:
            continue
        lines.extend([f"- Incoming: {incoming}", f"  Obiri replied: {outgoing}"])
    return "\n".join(lines)[:max_chars]


def require_config() -> tuple[str, str]:
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url or not key:
        raise RuntimeError("Supabase service configuration is missing")
    return url, key


LOCAL_EMBEDDING_MODEL = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
_embedding_model: Any | None = None


def embed_texts(texts: list[str]) -> tuple[list[list[float]], str]:
    """Generate multilingual style embeddings locally; no message text leaves the Mac."""
    global _embedding_model
    if _embedding_model is None:
        from sentence_transformers import SentenceTransformer

        _embedding_model = SentenceTransformer(LOCAL_EMBEDDING_MODEL, device="cpu")
    vectors = _embedding_model.encode(
        texts,
        batch_size=32,
        normalize_embeddings=True,
        show_progress_bar=False,
        convert_to_numpy=True,
    )
    if vectors.shape[1] != 384:
        raise RuntimeError(f"unexpected local embedding dimension: {vectors.shape[1]}")
    return [vector.astype(float).tolist() for vector in vectors], LOCAL_EMBEDDING_MODEL


def rest_headers(key: str) -> dict[str, str]:
    return {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}


def candidates(limit: int) -> list[dict[str, Any]]:
    db = sqlite3.connect(ROOT / "data/wa.db")
    db.row_factory = sqlite3.Row
    try:
        rows = db.execute(
            """
            select
              o.id as source_outbound_message_id,
              o.chat_jid,
              o.ts as outbound_ts,
              coalesce(o.body, o.transcript) as outgoing_text,
              (
                select coalesce(i.body, i.transcript)
                from messages i
                where i.session = o.session
                  and i.chat_jid = o.chat_jid
                  and i.direction = 'in'
                  and coalesce(i.body, i.transcript) is not null
                  and trim(coalesce(i.body, i.transcript)) != ''
                  and i.ts <= o.ts
                order by i.ts desc
                limit 1
              ) as incoming_text
            from messages o
            where o.direction = 'out'
              and coalesce(o.body, o.transcript) is not null
              and trim(coalesce(o.body, o.transcript)) != ''
            order by o.ts desc
            limit ?
            """,
            (limit,),
        ).fetchall()
    finally:
        db.close()

    result: list[dict[str, Any]] = []
    for row in rows:
        incoming = str(row["incoming_text"] or "")
        outgoing = str(row["outgoing_text"] or "")
        if not is_style_eligible(incoming, outgoing):
            continue
        language = detect_language(f"{incoming}\n{outgoing}")
        chat_kind = "group" if str(row["chat_jid"]).endswith("@g.us") else "direct"
        intent = infer_intent(incoming)
        result.append(
            {
                "source_outbound_message_id": str(row["source_outbound_message_id"]),
                "incoming_text": redact_text(incoming)[:700],
                "outgoing_text": redact_text(outgoing)[:320],
                "language": language,
                "chat_kind": chat_kind,
                "intent": intent,
                "eligible_for_retrieval": True,
                "is_sensitive": False,
                "metadata": {"sanitized": True, "source": "wa-bridge", "outbound_ts": int(row["outbound_ts"])},
            }
        )
    return result


def index_examples(limit: int) -> dict[str, Any]:
    load_runtime_env()
    url, key = require_config()
    rows = candidates(limit)
    if not rows:
        return {"ok": True, "candidates": 0, "indexed": 0}

    retrieval_texts = [
        build_retrieval_text(row["incoming_text"], row["outgoing_text"], row["language"], row["chat_kind"], row["intent"])
        for row in rows
    ]
    vectors, model = embed_texts(retrieval_texts)
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    payload: list[dict[str, Any]] = []
    for row, retrieval_text, vector in zip(rows, retrieval_texts, vectors):
        payload.append(
            {
                **row,
                "retrieval_text": retrieval_text,
                "embedding": vector,
                "embedding_model": model,
                "content_hash": hashlib.sha256(retrieval_text.encode("utf-8")).hexdigest(),
                "embedded_at": now,
            }
        )
    response = requests.post(
        f"{url}/rest/v1/onyankopon_whatsapp_style_examples?on_conflict=source_outbound_message_id",
        headers={**rest_headers(key), "Prefer": "resolution=merge-duplicates,return=minimal"},
        json=payload,
        timeout=120,
    )
    response.raise_for_status()
    return {"ok": True, "candidates": len(rows), "indexed": len(payload), "model": model}


def query_examples(query: str, language: str | None, chat_kind: str | None, limit: int) -> str:
    load_runtime_env()
    url, key = require_config()
    vectors, _ = embed_texts([query])
    response = requests.post(
        f"{url}/rest/v1/rpc/onyankopon_whatsapp_style_search",
        headers=rest_headers(key),
        json={
            "query_embedding": vectors[0],
            "match_count": max(1, min(limit, 6)),
            "filter_language": language or None,
            "filter_chat_kind": chat_kind or None,
        },
        timeout=60,
    )
    response.raise_for_status()
    return format_style_examples(response.json(), limit=limit)


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    index = sub.add_parser("index")
    index.add_argument("--limit", type=int, default=500)
    query = sub.add_parser("query")
    query.add_argument("--query", required=True)
    query.add_argument("--language")
    query.add_argument("--chat-kind", choices=["direct", "group"])
    query.add_argument("--limit", type=int, default=4)
    args = parser.parse_args()
    if args.command == "index":
        print(json.dumps(index_examples(max(1, min(args.limit, 2000)))))
    else:
        print(query_examples(args.query, args.language, args.chat_kind, args.limit))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
