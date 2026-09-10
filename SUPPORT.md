# Support

## Where to ask for help

Use the canonical repository for
[questions and bug reports](https://github.com/yshaaban/claude-workflow/issues).
The Soar Capital Systems repository is a synchronized mirror and does not have
a separate support queue. Report vulnerabilities through the private channel
described in [SECURITY.md](SECURITY.md), not in an issue.

## Supported environment

- Node.js 22 or newer recommended. Node 20 supports the gateway with a native
  Claude Code installation; the Claude Code npm package requires Node 22.
- Claude Code 2.1.261 or newer.
- Codex CLI 0.153.4 or newer.
- macOS, Linux, or WSL 2. Shared mode requires Bash; historical shell cleanup
  supports Bash and zsh.
- Codex account access to the configured model, with that model present in the
  installed or discovered catalog.
- For the built-in Kimi 1M preset, a Kimi Code API key and an Allegretto plan or
  higher. Moderato can select the 256K profile with `config --main k3`.
- For Qwen, an Alibaba Token Plan with access to `qwen3.8-max` and a matching
  `sk-sp-` key for the configured region and endpoint.

On WSL, install Node.js, Claude Code, Codex, and Claude Workflow in the same
distribution. Their commands, user configuration, and gateway state must use
the Linux filesystem rather than `/mnt/...` paths or Windows executables.

The configured Codex model must be available to your account. The gateway reads
bundled metadata first and discovers online metadata only for missing models. This
profile is shared by workflow agents and the direct Codex main route. If the
default `gpt-6-astra` route is absent, run
`claude-workflow config --agents <model-id>` with a full model ID available to
your Codex workspace. The interactive Codex `/model` picker shows available
choices.

Direct Codex, Kimi, and Qwen use documented per-session custom-model settings;
Claude Workflow does not modify `.claude.json`, user settings, or project
settings. Kimi uses its own provider route and does not need to appear in the
Codex catalog or gateway discovery response; the launcher adds its exact ID to
the private Claude Code `/model` picker. Select the 1M profile with
`claude-workflow config --main kimi` or the Moderato 256K profile with
`claude-workflow config --main k3`, then add
`ULTRATHINK_GATEWAY_KIMI_API_KEY` to the owner-only
`~/.claude-workflow.env` file, and verify a new session with Claude Code's
`/status` command. Kimi Code keys and Kimi Open Platform keys are not
interchangeable.

For Qwen, select `claude-workflow config --main qwen`, add
`ULTRATHINK_GATEWAY_QWEN_API_KEY` to the owner-only configuration, and start a
new session. The built-in profile uses the Singapore Token Plan
OpenAI-compatible endpoint. Standard DashScope keys require an explicit
matching base URL and are not interchangeable with Token Plan keys.

In shared mode, run `claude-workflow-gateway reconcile` or rerun setup after
changing any route, provider, endpoint, credential, model, or executable.

## Context reporting

Provider capacity is not the same as Claude Workflow's custom-model context
budget. Kimi K3 can accept 1,048,576 tokens on Allegretto and higher plans, and
the Moderato profile accepts 262,144. Qwen 3.8 Max has a 1,000,000-token context
window, a 983,616-token maximum input in thinking mode, and a 131,072-token
maximum output. Its `xhigh` profile can use up to 262,144 chain-of-thought
tokens.

Canonical Anthropic model IDs keep their native maximum, while third-party IDs
use one shared custom-model maximum. Claude's proactive compaction threshold is
shared across both kinds of ID. Claude Workflow derives the smaller safe value
across the selected non-Anthropic main route and delegated Codex route. With the
default Codex Astra `long` profile, Codex advertises 872,000 raw tokens, exposes
an 828,400-token custom-model maximum, and compacts at 784,800. Fable 5.1 and
Opus 5 retain their native 1M maximum but also compact at 784,800 when those agents
are enabled. Kimi 1M and Qwen use the 828,400 / 784,800 client pair even though
their providers accept more. The Kimi Moderato route lowers both custom-model
values to 262,144. If the installed Codex catalog or selected model changes,
the derived values change with it.

The per-session `claude-workflow` launcher overrides user, project, and local
routing settings without modifying them. Organization-managed Claude settings
remain authoritative. Shared mode relies on environment exports, so use the
launcher in repositories whose settings conflict with those exports.

## Before opening an issue

Run:

```bash
claude-workflow --version
claude-workflow doctor
claude-workflow config
```

For shared-mode problems, also run:

```bash
claude-workflow-gateway status
claude-workflow-gateway log 100
curl -s "http://127.0.0.1:${ULTRATHINK_GATEWAY_DAEMON_PORT:-4318}/healthz"
```

Include the failing command, OS/shell, sanitized health response, and the first
relevant error. Never attach credentials or an unredacted gateway env file.

## Known boundaries

- Native Ultracode requires Claude's dynamic workflows and xhigh support for
  the model and organization. Codex route effort is independent. Upgrade
  v0.3.0 installations to v0.3.1 or newer and start a new session to clear the
  old `CLAUDE_CODE_EFFORT_LEVEL=max` pin. Kimi/Qwen retain fixed client effort.
- Codex-routed image blocks are rejected rather than silently discarded.
- A pending dynamic tool call occupies one bounded pool slot until its result,
  its independent timeout, or daemon restart.
- `ULTRATHINK_GATEWAY_CODEX_PENDING_TOOL_TIMEOUT_MS=0` disables expiry and can
  hold that slot indefinitely; the hard session cap still prevents unbounded
  process growth.
- All workflow Codex routes disable Codex-native agents and integrations. Codex
  app-server 0.153.4 still advertises the unavoidable code-mode
  `functions.exec` and `functions.wait` wrappers alongside Claude's dynamic
  tools.
- Isolated Codex processes use a private catalog snapshot to suppress
  experimental native tools, including async questions and clock. All other
  model metadata stays intact. The source catalog is cached for the gateway's
  lifetime and reloaded after a gateway restart or executable change; metadata
  does not refresh mid-session. A missing or invalid catalog fails startup.
- Fable 5.1 thinking is bound to the preceding request prefix. The Anthropic
  route forwards it unchanged, including error responses. Start a new session
  when switching model families; forced tool selection is unsupported on Fable.
- Fable's native Opus fallback stays on Anthropic. Custom route maps and
  passthrough lists must preserve those targets. Ordinary agents are forced to
  the configured Codex model, but native forks and skill subagents explicitly
  inheriting main follow Claude's own model rules.
- Claude Workflow supplies one exact `/model` picker row for each distinct
  selected route in its private session settings. Claude Code accepts only one
  explicit custom metadata profile. An unrecognized-model
  diagnostic is cosmetic only when `/model` or `/status` retains the exact ID
  and requests succeed; organization-managed `availableModels` can still block
  it. Gateway discovery remains disabled because Claude Code filters truthful
  non-Anthropic IDs and discovery would add startup traffic.
- Large-output truncation is never proof of complete review. Follow
  `docs/LARGE_FILES_AND_DIFFS.md` for coverage accounting.
- Kimi's provider-side 1M context window does not raise its 2,097,152-byte total
  message-content ceiling or change the smaller custom-model limit described
  above. Large files and diffs still require bounded reads and explicit coverage
  tracking.
- Claude Workflow answers Kimi and Qwen token-count requests locally. The
  gateway uses a conservative ceiling of one estimated token per UTF-8 byte for
  Claude Code's compaction signal. It is not a tokenizer or billing count and
  makes no provider request.
- Outbound upstream requests reject redirects. Configure the final HTTPS
  endpoint directly; the gateway does not forward provider credentials to a
  redirect target.
- Qwen deep-thinking mode accepts automatic or disabled tool selection. Named
  and required choices are rejected locally because coercion would change the
  request contract.
- Shared mode is user-wide. It rejects project `.env` loading and cannot
  override organization policy or conflicting Claude settings introduced by a
  repository entered after setup. Use the per-session launcher for those cases.
