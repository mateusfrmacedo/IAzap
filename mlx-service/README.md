# IAZAP MLX service (local inference)

Small **localhost-only** HTTP helper that loads **Qwen2.5 Instruct 4-bit** via [`mlx-lm`](https://github.com/ml-explore/mlx-lm) and answers the Node bridge’s `MLXReplyEngine`.

## Why Python `mlx-lm` (not mlx-swift in-app)

Phase 3 already owns the auto-reply pipeline inside the Node bridge. Keeping inference behind the same `ReplyEngine` interface avoids splitting the debounce/filter/send path. On Mac, **mlx-lm** is the practical path for Hugging Face MLX community weights (download + generate). The Swift app talks model status over the existing Unix JSON-RPC (`model.*`).

Full Metal inference **requires Apple Silicon**. Linux CI / this cloud VM use `IAZAP_MLX_MOCK=1` or leave the service down → bridge falls back to `StubReplyEngine`.

## Models (M1 Pro 16GB)

| Id | HF repo | Note |
|---|---|---|
| `qwen2.5-7b-instruct-4bit` (**default**) | `mlx-community/Qwen2.5-7B-Instruct-4bit` | Better PT-BR; watch unified memory |
| `qwen2.5-3b-instruct-4bit` | `mlx-community/Qwen2.5-3B-Instruct-4bit` | Safer fallback on 16GB |

First load downloads weights into the Hugging Face cache (`~/Library/Caches/huggingface` or `IAZAP_MLX_CACHE`).

## Setup (Mac Apple Silicon)

```bash
cd mlx-service
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Optional: pre-download default 7B 4-bit (needs disk + network)
python -c "from huggingface_hub import snapshot_download; snapshot_download('mlx-community/Qwen2.5-7B-Instruct-4bit')"

# Serve (autoload weights — first run may take a while)
IAZAP_MLX_AUTOLOAD=1 python server.py
```

## Mock mode (Linux / CI)

```bash
IAZAP_MLX_MOCK=1 python server.py
```

Returns deterministic Portuguese replies without Metal.

## HTTP API (`127.0.0.1:8742`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness |
| GET | `/v1/status` | Model id, load state, memory note, catalog |
| POST | `/v1/configure` | `{ "modelId": "qwen2.5-3b-instruct-4bit" }` |
| POST | `/v1/reload` | Load / reload weights from disk/HF |
| POST | `/v1/generate` | `{ "systemPrompt", "turns":[{"role","text"}], "maxTokens"? }` |

## Env

| Env | Default |
|---|---|
| `IAZAP_MLX_HOST` | `127.0.0.1` |
| `IAZAP_MLX_PORT` | `8742` |
| `IAZAP_MLX_MODEL` | `qwen2.5-7b-instruct-4bit` |
| `IAZAP_MLX_CACHE` | unset (HF default cache) |
| `IAZAP_MLX_MOCK` | unset |
| `IAZAP_MLX_AUTOLOAD` | unset |

Bridge env: `IAZAP_MLX_URL` (default `http://127.0.0.1:8742`), `IAZAP_ENGINE=stub|mlx|auto` (default `auto`).
