#!/usr/bin/env python3
"""
ZapIA local MLX inference helper (macOS Apple Silicon).

HTTP (127.0.0.1 only):
  GET  /health
  GET  /v1/status
  POST /v1/configure   {"modelId": "..."}
  POST /v1/reload
  POST /v1/generate    {"systemPrompt", "turns":[{"role","text"}], "maxTokens"?}

Env:
  ZAPIA_MLX_HOST       default 127.0.0.1
  ZAPIA_MLX_PORT       default 8742
  ZAPIA_MLX_MODEL      model id (see catalog.py) or HF repo
  ZAPIA_MLX_CACHE      HF / mlx cache dir (optional)
  ZAPIA_MLX_MOCK       if "1", skip mlx-lm and return deterministic PT-BR replies
                       (for Linux CI / wiring tests without Metal)
  ZAPIA_MLX_AUTOLOAD   if "1", load weights on startup (Mac only; downloads if needed)

On Linux / without Metal the server starts with state=unavailable unless MOCK=1.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlparse

from catalog import catalog_dicts, default_model_id, get_model
from prompt import DEFAULT_SYSTEM_PROMPT, build_chatml, mock_portuguese_reply

# Upgrade compatibility; all documented variables now use ZAPIA_.
for _key, _value in list(os.environ.items()):
    if _key.startswith("IAZAP_"):
        os.environ.setdefault(_key.replace("IAZAP_", "ZAPIA_", 1), _value)

HOST = os.environ.get("ZAPIA_MLX_HOST", "127.0.0.1")
PORT = int(os.environ.get("ZAPIA_MLX_PORT", "8742"))
MOCK = os.environ.get("ZAPIA_MLX_MOCK", "") == "1"
AUTOLOAD = os.environ.get("ZAPIA_MLX_AUTOLOAD", "") == "1"
CACHE_DIR = os.environ.get("ZAPIA_MLX_CACHE") or None


class InferenceState:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.model_id = os.environ.get("ZAPIA_MLX_MODEL") or default_model_id()
        self.state = "unavailable"  # unavailable | not_loaded | loading | ready | error
        self.last_error: str | None = None
        self.mlx_import_ok = False
        self.model = None
        self.tokenizer = None
        self.backend = "unavailable"
        self._probe_mlx()

    def _probe_mlx(self) -> None:
        if MOCK:
            self.mlx_import_ok = False
            self.backend = "mock"
            self.state = "ready"
            self.last_error = None
            return
        try:
            import mlx.core  # noqa: F401
            import mlx_lm  # noqa: F401

            self.mlx_import_ok = True
            self.backend = "mlx"
            self.state = "not_loaded"
            self.last_error = None
        except Exception as exc:  # noqa: BLE001 — surface any import/Metal failure
            self.mlx_import_ok = False
            self.backend = "unavailable"
            self.state = "unavailable"
            self.last_error = (
                f"MLX indisponível neste host ({exc}). "
                "Use macOS Apple Silicon com `pip install -r requirements.txt`, "
                "ou ZAPIA_MLX_MOCK=1 para testar o fio HTTP."
            )

    def resolve_repo(self) -> str:
        spec = get_model(self.model_id)
        if spec:
            return spec.hf_repo
        # Allow raw HF repo ids
        return self.model_id

    def status_dict(self) -> dict[str, Any]:
        spec = get_model(self.model_id)
        return {
            "backend": self.backend if self.backend != "unavailable" else "unavailable",
            "engineId": self._engine_id(),
            "modelId": spec.id if spec else self.model_id,
            "modelLabel": spec.label if spec else self.model_id,
            "hfRepo": self.resolve_repo(),
            "state": self.state,
            "mlxAvailable": self.mlx_import_ok or MOCK,
            "memoryNote": spec.memory_hint
            if spec
            else "Escolha um modelo do catálogo ZapIA (7B ou 3B 4-bit).",
            "lastError": self.last_error,
            "availableModels": catalog_dicts(),
            "defaultSystemPrompt": DEFAULT_SYSTEM_PROMPT,
            "service": {"host": HOST, "port": PORT, "mock": MOCK},
        }

    def _engine_id(self) -> str:
        if MOCK:
            return f"mlx-mock:{self.model_id}"
        if self.state == "ready" and self.mlx_import_ok:
            return f"mlx:{self.model_id}"
        if self.mlx_import_ok:
            return f"mlx:{self.model_id}:pending"
        return "mlx:unavailable"

    def configure(self, model_id: str) -> dict[str, Any]:
        with self.lock:
            if not model_id or not isinstance(model_id, str):
                raise ValueError("modelId obrigatório")
            spec = get_model(model_id)
            self.model_id = spec.id if spec else model_id.strip()
            # Drop loaded weights when switching models
            self.model = None
            self.tokenizer = None
            if MOCK:
                self.state = "ready"
                self.last_error = None
            elif self.mlx_import_ok:
                self.state = "not_loaded"
                self.last_error = None
            else:
                self.state = "unavailable"
            return self.status_dict()

    def reload(self) -> dict[str, Any]:
        with self.lock:
            if MOCK:
                self.state = "ready"
                self.last_error = None
                return self.status_dict()
            if not self.mlx_import_ok:
                self.state = "unavailable"
                return self.status_dict()
            self._load_locked()
            return self.status_dict()

    def _load_locked(self) -> None:
        self.state = "loading"
        self.last_error = None
        repo = self.resolve_repo()
        try:
            from mlx_lm import load

            kwargs: dict[str, Any] = {}
            if CACHE_DIR:
                kwargs["tokenizer_config"] = {}  # keep signature flexible
                # mlx_lm load uses huggingface hub cache via HF_HOME / env
                os.environ.setdefault("HF_HOME", CACHE_DIR)
                os.environ.setdefault("HUGGINGFACE_HUB_CACHE", os.path.join(CACHE_DIR, "hub"))

            print(f"[zapia-mlx] loading {repo} …", file=sys.stderr, flush=True)
            model, tokenizer = load(repo)
            self.model = model
            self.tokenizer = tokenizer
            self.state = "ready"
            self.backend = "mlx"
            print(f"[zapia-mlx] ready: {repo}", file=sys.stderr, flush=True)
        except Exception as exc:  # noqa: BLE001
            self.model = None
            self.tokenizer = None
            self.state = "error"
            self.last_error = (
                f"Falha ao carregar modelo {repo}: {exc}. "
                "Baixe no Mac (HF) ou confira disco/RAM. "
                f"Detalhe: {traceback.format_exc(limit=3)}"
            )
            print(f"[zapia-mlx] load error: {self.last_error}", file=sys.stderr, flush=True)

    def generate(
        self,
        system_prompt: str,
        turns: list[dict[str, Any]],
        max_tokens: int = 192,
    ) -> dict[str, Any]:
        with self.lock:
            if MOCK:
                latest = ""
                for t in reversed(turns):
                    if t.get("role") == "user" and t.get("text"):
                        latest = str(t["text"])
                        break
                text = mock_portuguese_reply(latest, len(turns))
                return {"text": text, "engineId": self._engine_id(), "mock": True}

            if not self.mlx_import_ok:
                raise RuntimeError(
                    self.last_error
                    or "MLX indisponível (precisa macOS Apple Silicon + mlx-lm)."
                )

            if self.state != "ready" or self.model is None or self.tokenizer is None:
                self._load_locked()
            if self.state != "ready" or self.model is None or self.tokenizer is None:
                raise RuntimeError(
                    self.last_error or "Modelo não carregado. Rode POST /v1/reload no Mac."
                )

            from mlx_lm import generate as mlx_generate

            prompt = build_chatml(system_prompt or DEFAULT_SYSTEM_PROMPT, turns)
            # mlx_lm.generate API: model, tokenizer, prompt=..., max_tokens=...
            out = mlx_generate(
                self.model,
                self.tokenizer,
                prompt=prompt,
                max_tokens=max(16, min(int(max_tokens), 512)),
                verbose=False,
            )
            text = str(out).strip()
            # Some mlx-lm versions return full prompt+completion; strip ChatML tail if present.
            if "<|im_start|>assistant" in text:
                text = text.split("<|im_start|>assistant")[-1]
            text = text.replace("<|im_end|>", "").strip()
            if not text:
                raise RuntimeError("Modelo retornou texto vazio")
            return {"text": text, "engineId": self._engine_id(), "mock": False}


STATE = InferenceState()


class Handler(BaseHTTPRequestHandler):
    server_version = "ZapIA-MLX/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("[zapia-mlx] " + (fmt % args) + "\n")

    def _read_json(self) -> Any:
        length = int(self.headers.get("Content-Length") or "0")
        raw = self.rfile.read(length) if length else b"{}"
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    def _send(self, code: int, body: dict[str, Any]) -> None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path in ("/health", "/"):
            self._send(200, {"ok": True, "service": "zapia-mlx"})
            return
        if path == "/v1/status":
            self._send(200, STATE.status_dict())
            return
        self._send(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        try:
            payload = self._read_json()
        except json.JSONDecodeError:
            self._send(400, {"error": "invalid json"})
            return

        if path == "/v1/configure":
            try:
                status = STATE.configure(str(payload.get("modelId") or ""))
                self._send(200, status)
            except ValueError as exc:
                self._send(400, {"error": str(exc)})
            return

        if path == "/v1/reload":
            status = STATE.reload()
            code = 200 if status.get("state") in ("ready", "not_loaded") or MOCK else 500
            if status.get("state") == "error":
                code = 500
            self._send(code, status)
            return

        if path == "/v1/generate":
            turns = payload.get("turns") or []
            if not isinstance(turns, list):
                self._send(400, {"error": "turns must be a list"})
                return
            try:
                result = STATE.generate(
                    system_prompt=str(payload.get("systemPrompt") or DEFAULT_SYSTEM_PROMPT),
                    turns=turns,
                    max_tokens=int(payload.get("maxTokens") or 192),
                )
                self._send(200, result)
            except Exception as exc:  # noqa: BLE001
                self._send(503, {"error": str(exc), "status": STATE.status_dict()})
            return

        self._send(404, {"error": "not found"})


def main() -> None:
    if CACHE_DIR:
        os.makedirs(CACHE_DIR, exist_ok=True)
        os.environ.setdefault("HF_HOME", CACHE_DIR)

    if AUTOLOAD and not MOCK and STATE.mlx_import_ok:
        with STATE.lock:
            STATE._load_locked()

    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(
        f"[zapia-mlx] listening http://{HOST}:{PORT} "
        f"backend={STATE.backend} model={STATE.model_id} state={STATE.state}",
        file=sys.stderr,
        flush=True,
    )
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[zapia-mlx] shutdown", file=sys.stderr)


if __name__ == "__main__":
    main()
