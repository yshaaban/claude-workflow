# Upstream compatibility

Claude Code owns the session, permissions, and tool execution. Codex supplies
GPT inference through its app-server. The gateway translates messages and
tool events locally. It never sends a model response to another model to
convert it into a tool call. A coordinator can still take a new turn after an
agent returns. That turn is Claude deciding what to do next.

## Supported baseline

Use Claude Code 2.1.325 or newer and Codex CLI 0.171.0 or newer. Required CI
tests Claude Code 2.1.325 and 2.1.330 with Codex 0.171.0. A daily canary runs the same contracts
against the latest releases. Neither test grants access to a model.

| Setting | Current selection |
| --- | --- |
| Main coordinator | Anthropic `claude-fable-5-2` |
| `--main opus` | Anthropic `claude-opus-5-5` |
| `--agents astra` (default) | `gpt-6.2-astra`, exposed as `codex-astra` |
| `--agents terra` | `gpt-6.1-terra` |
| `--agents luna` | `gpt-6-luna` |

Full model IDs are exact pins. To move an existing installation to the new
default, run `claude-workflow config --main fable --agents astra --effort max --context long`,
then `claude-workflow setup` and start a new session.

For Opus 5.5 orchestration, run `claude-workflow config --main opus --agents astra --effort medium`.
Choose `low` for less runner reasoning without changing models. The gateway
rejects a GPT-6.2 Sol runner instead of changing its model silently. A direct
Codex main route can still use `gpt-6.2-sol` with a separate Astra runner.
This check governs the model the gateway requests. It does not override
provider-side safety routing.

## Context belongs to the selected runtime

Claude Workflow reads context and supported effort from the installed Codex
catalog. It requests the raw context on thread creation and exposes the usable
window to Claude. Codex 0.171.0 reports these values:

| Model and profile | Raw context | Usable | Proactive compaction |
| --- | ---: | ---: | ---: |
| GPT-6.2 Astra, standard | 272,000 | 258,400 | 244,800 |
| GPT-6.2 Sol direct main, standard | 500,000 | 475,000 | 450,000 |
| Either model, long (default) | 872,000 | 828,400 | 784,800 |

A raw override is clamped to the selected model's maximum. A `[1m]` suffix
does not change that limit. An individual tool result has a separate size
limit. For a large review, use [bounded reads and diff hunks](LARGE_FILES_AND_DIFFS.md).

The [OpenAI API model](https://developers.openai.com/api/docs/models/gpt-6.2-astra)
has a different context ceiling. Use the [Codex catalog for your installed release](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/models-manager/models.json)
or run `codex debug models --bundled` for app-server values. The catalog also
governs whether a Codex route accepts `ultra`. Direct OpenAI Chat Completions
supports text requests through `max`. For GPT-6.2 tool calls, select the
`codex` provider, which uses Responses. See the [GPT-6.2 migration guide](https://developers.openai.com/api/docs/guides/latest-model#migration-quickstart).

## Native effort and Ultracode

Use `/effort` inside Claude Code to set the Anthropic coordinator's reasoning
level. On Claude Code 2.1.330, `/effort ultracode` toggles dynamic workflows
independently of that level. The selected model, account, and organization
determine availability. Workflow does not enable Ultracode automatically.

The launcher clears a stale `CLAUDE_CODE_EFFORT_LEVEL` for native Anthropic
sessions without editing persistent Claude settings. The workflow config
option `--effort` controls Codex. Kimi and Qwen retain their provider-specific
effort requirements. See [Claude model configuration](https://code.claude.com/docs/en/model-config).

## Tools and native Anthropic requests

Claude advertises the tools available to the current session. The gateway
passes their schemas to Codex and maps each selected name and its arguments
back to Claude. Claude runs the tool under the session's permission mode.
The result goes back to the pending call on the same Codex turn. Claude-owned
MCP servers work through the same path. The gateway does not grant tools that
Claude has excluded.

Inline images stay typed image inputs, including images returned by Read.
Codex does not accept a whole PDF as a dynamic tool result. Request a bounded
page range so Read can return page images. The gateway does not fetch URLs or
claim to have read an attachment that Codex cannot receive.

Codex 0.171 accepts dynamic tool definitions only at thread creation. On a
Codex-enabled launch, Workflow asks Claude to connect its MCP servers and send
their schemas up front. This uses more context when many servers are enabled,
but tools remain callable throughout the turn. Disable unneeded servers in
Claude. Native-only launches keep Claude's discovery settings. For an
independent client, set `ENABLE_TOOL_SEARCH=false` before starting Claude.
Codex chooses whether to call a tool. A named choice restricts the tool set,
but app-server has no equivalent of Anthropic's forced invocation.

Each isolated app-server uses a temporary, owner-only model catalog. It sets
direct tool mode, clears experimental native tools, and disables the native
patch handler. Claude remains the only tool executor in both per-session and
shared mode. Restart a shared gateway after changing the upstream installation.

Native Anthropic routes forward thinking, signatures, tool choices, refusals,
and errors. Claude decides whether to continue, use an available native
fallback, or show a refusal. The gateway does not retry or classify it. Start
a new session when changing model families. Ordinary delegated agents use the
configured Codex model. Native forks and skill agents that explicitly inherit
the main model follow Claude's own rules.

## Verification

Run `npm run test:upstream-compatibility` with both CLIs installed. It fails
if either executable is missing. It checks actual tool advertisements on the
model request, exercises Claude's coordinator and effort behavior, and runs a
complete Claude–Codex loop for both Astra and Sol. Each loop reads and edits a
marker near the end of a 12,000-line file, calls an MCP server, and checks the
result and number of upstream requests. Coordinated cases start Astra from
Fable 5.2 or Opus 5.5 and verify a single coordinator resume. The Opus cases
check the upstream model and effort on every request: Opus stays at high
while Astra runs at low or medium.

These tests use real CLIs and controlled provider responses. They test protocol
compatibility without sending project files or using provider credits. They do
not benchmark model quality or prove that an account is entitled to a model.
The [DeepSeek live verification harness](DEEPSEEK.md#verification) is optional.
To check actual account access for both GPT-6.2 models, run
`node scripts/verify-hosted-codex.mjs --run`. It uses your Codex account and
verifies that each model can retrieve a random value using Claude's Read tool.
