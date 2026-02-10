# Convos Agent Railway Template

A Railway-deployable container that runs an [OpenClaw](https://github.com/openclaw/openclaw) AI agent with [XMTP](https://xmtp.org) messaging via the Convos channel. Designed to be managed by a pool manager that provisions instances on demand, or run standalone with an interactive setup wizard.

> **Origin:** This repo was originally forked from [vignesh07/clawdbot-railway-template](https://github.com/vignesh07/clawdbot-railway-template), which provides a general-purpose OpenClaw Railway template with 1-click deploy. This fork has diverged significantly to add XMTP/Convos integration, pool mode for automated provisioning, and multi-provider model support.

## How it works

The container runs a lightweight Node.js wrapper server that:

1. Builds OpenClaw from source (using the [xmtplabs/openclaw](https://github.com/xmtplabs/openclaw) fork with the Convos XMTP channel)
2. Writes gateway config and starts the OpenClaw gateway as a child process
3. Reverse-proxies all traffic (including WebSockets) to the internal gateway
4. Exposes `/pool/*` endpoints for machine-to-machine provisioning
5. Optionally serves a `/setup` web wizard for interactive configuration

## Modes of operation

### Pool mode (`POOL_MODE=true`)

Used when instances are managed by the [convos-agent-pool-manager](https://github.com/xmtplabs/convos-agent-pool-manager). On boot, the container:

- Auto-writes OpenClaw config from environment variables
- Starts the gateway and pre-warms an XMTP identity
- Reports ready at `GET /pool/status`
- Waits for `POST /pool/provision` with instructions, agent name, and optionally a group invite URL to join

This is the primary mode for production use.

### Interactive mode (default)

When `POOL_MODE` is not set, the container serves a setup wizard at `/setup` (protected by `SETUP_PASSWORD`). The wizard lets you:

- Choose an AI model provider and enter API credentials
- Create an XMTP conversation with a QR code to scan
- Configure Telegram, Discord, or Slack channels (if supported by the OpenClaw build)
- Edit config, export/import backups, and run debug commands

## Environment variables

### Required (pool mode)

| Variable | Description |
|---|---|
| `POOL_MODE` | Set to `true` to enable pool mode |
| `POOL_API_KEY` | Bearer token for authenticating `/pool/*` requests |
| `POOL_AUTH_CHOICE` | AI provider auth method (e.g. `openai-api-key`, `apiKey`) |
| Provider API key | The relevant key for your chosen provider (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) |

### Required (interactive mode)

| Variable | Description |
|---|---|
| `SETUP_PASSWORD` | Password to access the `/setup` wizard |

### Optional

| Variable | Default | Description |
|---|---|---|
| `XMTP_ENV` | `production` | XMTP network environment (`production` or `dev`) |
| `OPENCLAW_STATE_DIR` | `~/.openclaw` | Where OpenClaw stores config and state |
| `OPENCLAW_WORKSPACE_DIR` | `<state_dir>/workspace` | Agent workspace directory |
| `OPENCLAW_GATEWAY_TOKEN` | auto-generated | Token for authenticating with the internal gateway |

### Docker build args

| Arg | Default | Description |
|---|---|---|
| `OPENCLAW_CACHE_BUST` | `35` | Bump to force a fresh `git clone` of OpenClaw (invalidates Docker cache) |
| `OPENCLAW_GIT_REPO` | `https://github.com/xmtplabs/openclaw.git` | OpenClaw source repo |
| `OPENCLAW_GIT_REF` | `staging` | Branch or tag to build from |

## API endpoints

### Pool endpoints (require `Authorization: Bearer <POOL_API_KEY>`)

- `GET /pool/status` -- Returns `{ ready, provisioned, conversationId, inviteUrl }`
- `POST /pool/provision` -- Provision the instance with `{ instructions, name, joinUrl? }`

### Setup endpoints (require Basic auth with `SETUP_PASSWORD`)

- `GET /setup` -- Interactive setup wizard
- `GET /setup/healthz` -- Health check for Railway
- `POST /setup/api/convos/setup` -- Start Convos XMTP setup
- `POST /setup/api/convos/complete-setup` -- Finalize setup after user joins
- `GET /setup/export` -- Download a `.tar.gz` backup
- `POST /setup/import` -- Restore from a backup

### Other

- `GET /version` -- Build version info (wrapper commit, OpenClaw commit, build timestamp)
- Everything else is reverse-proxied to the OpenClaw gateway

## Supported AI providers

The template supports a wide range of model providers out of the box:

- **Anthropic** (API key, Claude Code CLI, setup token)
- **OpenAI** (API key, Codex CLI, ChatGPT OAuth)
- **Google** (Gemini API key, Antigravity OAuth, Gemini CLI)
- **OpenRouter**, **Vercel AI Gateway**, **Moonshot AI**, **Z.AI**, **MiniMax**, **Qwen**, **GitHub Copilot**, **Synthetic**, **OpenCode Zen**

## Local development

```bash
docker build -t convos-agent-template .

docker run --rm -p 8080:8080 \
  -e PORT=8080 \
  -e SETUP_PASSWORD=test \
  -e OPENCLAW_STATE_DIR=/data/.openclaw \
  -e OPENCLAW_WORKSPACE_DIR=/data/workspace \
  -v $(pwd)/.tmpdata:/data \
  convos-agent-template

# open http://localhost:8080/setup (password: test)
```

## License

MIT -- see [LICENSE](LICENSE).
