# pi-basert

BaseRT pi extension. Auto-discovers models from a running `basert serve` server
and registers them as the `basert` provider in [pi](https://pi.dev).

## Install

**From the shell:**

```bash
pi install git:github.com/basecompute/pi-basert
```

This clones to `~/.pi/agent/packages/pi-basert/` and adds an entry to your pi
settings. Every future `pi` invocation auto-loads it.

**From inside an interactive pi session:**

```
!pi install git:github.com/basecompute/pi-basert
```

Then run `/reload` (or restart pi) to load the extension.

**Dev mode:**

```bash
git clone https://github.com/basecompute/pi-basert ~/code/pi-basert
pi -e ~/code/pi-basert/index.ts
```

`-e` loads the extension only for the current session, useful while
developing.

## Environment Variables

This extension supports the following environment variables:

- `BASERT_BASE_URL` (Default: `http://localhost:8080/v1`)
- `BASERT_API_KEY` (Default: `no-key`) — sent as `Authorization: Bearer …` to
  both the OpenAI chat endpoint and the discovery endpoints (`/v1/models`,
  `/props`). Required if you started the server with `--api-key`.

## Usage

```bash
# 1. Install BaseRT
curl -LsSf https://basecompute.co/install.sh | sh

# 2. Pull a model and start the server
basert pull Qwen/Qwen3-0.6B
basert serve --model ~/.cache/baseRT/models/Qwen3-0.6B.base --port 8080

# Optional: point at a remote BaseRT server instead of local
export BASERT_BASE_URL="https://basert.example.com/v1"
# Optional: if the server was started with --api-key
export BASERT_API_KEY="sk-…"

# 3. Launch pi in another terminal
pi

# 4. Inside pi - search "basert" to browse your loaded models
/model
```

The extension reads the server's context window and default output-token cap
from `/props` the first time you select a BaseRT model, so pi sizes its context
budget to match `basert serve --max-context`.

## Commands

- `/basert-version` — prints the running BaseRT server's build version and target.

## How it works

- `GET /v1/models` lists the models currently loaded by `basert serve`; each is
  registered under the `basert` provider via pi's `openai-completions` API.
- `GET /props` supplies `default_generation_settings.max_context` (context
  window) and `max_tokens` (default output cap). These are server-global in
  BaseRT, so one fetch resolves every loaded model.
