# DeepSeek CC Proxy

> A Cloudflare Worker that makes Claude Code and DeepSeek play nice together. Deploy once, use from anywhere.

## What problem does this solve?

If you run Claude Code with DeepSeek models (like `deepseek-v4-pro`), you've probably hit this:

```
API Error: 400 — thinking options type cannot be disabled when reasoning_effort is set
```

This happens because Claude Code 2.1.166+ sends `thinking: { type: "disabled" }` together with `reasoning_effort` when spawning subagents. DeepSeek's API considers these mutually exclusive and rejects the request. Every subagent — web search, code exploration, multi-agent workflows — just dies.

This Worker sits between Claude Code and DeepSeek, intercepting requests and fixing the incompatibility before it reaches the API. No more 400 errors, no more broken subagents.

→ [Claude Code issue #65863](https://github.com/anthropics/claude-code/issues/65863)

## How it works

```
Claude Code (any device)
  │  ANTHROPIC_BASE_URL=https://api-deepseek.nntoan.com/anthropic
  │
  ▼
┌─────────────────────────────────────────────────────┐
│                 Cloudflare Worker                    │
│                                                      │
│  Detects subagents via x-claude-code-agent-id header │
│  Fixes thinking:disabled + reasoning_effort conflict │
│  Streams response back without buffering             │
│                                                      │
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
          api.deepseek.com
```

The proxy has two strategies for resolving the conflict:

| Strategy | What it does | When |
|----------|-------------|------|
| **Force enable** | Sets `thinking.type` to `"enabled"` for subagents | When `forceSubagentThinking` is ON |
| **Strip** | Sets `thinking` to `"disabled"` and removes `output_config` | Default for main agents, and subagents when toggle is OFF |

You control which strategy via HTTP endpoints — flip the toggle from any device, anytime.

## Quick start

### 1. Set up KV namespace

```bash
wrangler kv namespace create CCPROXY_KV
# Copy the ID into wrangler.jsonc → kv_namespaces[0].id
```

### 2. Set your auth token

```bash
wrangler secret put TOGGLE_AUTH_TOKEN
```

This token protects the toggle endpoints — only you can flip the switch.

### 3. Deploy

```bash
npm run deploy
```

### 4. Point Claude Code at it

In `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api-deepseek.nntoan.com/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "sk-your-deepseek-api-key"
  }
}
```

That's it. Subagents now work.

## API

| Route | Method | Auth | What it does |
|-------|--------|------|-------------|
| `/anthropic/*` | POST | None | Proxies requests to DeepSeek with thinking override |
| `/status` | GET | None | Returns current toggle state |
| `/toggle` | GET | Bearer | Flips the toggle |
| `/force-subagent-thinking` | POST | Bearer | Sets toggle to `{ "force": true/false }` |

### Toggle management

```bash
# Check current state (no auth needed)
curl https://api-deepseek.nntoan.com/status

# Flip the toggle
curl -H "Authorization: Bearer $TOGGLE_AUTH_TOKEN" \
  https://api-deepseek.nntoan.com/toggle

# Set explicitly
curl -X POST \
  -H "Authorization: Bearer $TOGGLE_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"force": true}' \
  https://api-deepseek.nntoan.com/force-subagent-thinking
```

The toggle defaults to `true` (force-enabled thinking for subagents) on cold starts, configurable via the `FORCE_SUBAGENT_THINKING` env var in `wrangler.jsonc`.

## Why a Worker?

Because running a local proxy on `localhost:4000` means you have to:

- Remember to start it
- Keep the machine awake
- Set it up again on every device

A Cloudflare Worker runs at the edge, always on, reachable from anywhere. Deploy once, forget about it. Cold starts and edge latency are negligible for a control-plane proxy — you're not streaming video through it.

## Local development

```bash
npm install
npm run dev         # Start wrangler dev server
npm run cf-typegen  # Regenerate types after config changes
```

To test KV locally, use `wrangler dev --remote` (KV doesn't work in fully local mode).

## Credits

- **seedlord** ([github.com/seedlord](https://github.com/seedlord)) — Original `proxy.js` implementation that proved the approach works

## License

MIT © [nntoan](https://nntoan.com)
