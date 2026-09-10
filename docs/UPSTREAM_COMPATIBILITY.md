# Upstream compatibility

Claude Workflow uses Claude Code as the client and tool executor. Codex supplies
reasoning through `codex app-server`; the gateway translates protocol events
locally. It does not call a model to rewrite another model's response.

## Supported baseline

The required baseline is Claude Code 2.1.261 and Codex CLI 0.153.4. Newer
versions run through the same installed-client contracts in the upstream
canary. A passing canary is evidence about that version, not a guarantee about
future releases or live account entitlement.

The default coordinator is `claude-fable-5-1`. Default agents use `gpt-6-astra`
with max reasoning, exposed to Claude as `codex-astra`. Existing explicit model
pins are not migrated automatically. The configuration aliases `sol`, `terra`,
and `luna` select their released GPT-5.6 models, not a guessed GPT-6 family.

Sources: [Codex 0.153.4](https://github.com/openai/codex/releases/tag/rust-v0.153.4),
[Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md),
and [Claude model configuration](https://code.claude.com/docs/en/model-config).

## Context belongs to the selected runtime

The GPT-6 Astra API advertises a 1,050,000-token context. Codex 0.153.4's bundled
Astra catalog instead specifies 272,000 standard / 872,000 maximum raw tokens
and a 95% usable window. Claude Workflow follows the installed Codex metadata,
so the default long profile exposes 828,400 usable tokens and compacts at
784,800. Explicit window overrides are clamped to that model's advertised
maximum. A marketing label or `[1m]` suffix cannot enlarge it.

Codex's catalog also advertises `ultra` reasoning for Astra; its API model
reference lists levels only through `max`. Workflow validates reasoning against
the Codex catalog because it uses the app-server, not the public Responses API.
Codex route effort is independent of Claude's native session effort. Selecting
`ultra` for Codex does not select Claude's Ultracode mode.

Sources: [Astra API reference](https://developers.openai.com/api/docs/models/gpt-6-astra)
and [Codex bundled models](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/models-manager/models.json).
Run `codex debug models --bundled` to inspect your installed version.

## Native effort and Ultracode

For an Anthropic coordinator, use Claude's `/effort` command to choose the
session effort. `/effort ultracode` selects native xhigh reasoning with dynamic
workflow orchestration. It requires workflows to be enabled and the model and
organization to allow xhigh. Workflow does not enable the mode automatically or
override those requirements.

The launcher clears `CLAUDE_CODE_EFFORT_LEVEL` from the child environment and
shadows stale settings-file values with an empty value in its private settings.
It does not change persistent Claude settings. A nonempty environment value
takes precedence over the native effort selector; even `auto` is an override,
not a way to release it. This fixes the v0.3.0 warning that `max` overrides
Ultracode. Upgrade and start a new session to remove the old launch-time pin.

`claude-workflow config --effort max` continues to configure Codex's upstream
effort, including direct Codex main routes. It does not pin Claude's session.
Native launch flags such as `claude-workflow -- --effort xhigh` are also accepted.
The Kimi and Qwen presets retain their required client effort and reject
conflicting native launch flags.

Sources: [Claude effort precedence](https://code.claude.com/docs/en/model-config#adjust-effort-level)
and the installed Claude Code 2.1.261/2.1.267 effort-command contracts. The
account-free regression executes `/effort ultracode` and checks that it enables
the mode without an override warning or an inference request.

## One owner for tools and conversation state

Feature switches alone do not isolate Astra. Codex can advertise native async
questions and clock tools from `experimental_supported_tools` even when their
older feature switches are disabled. Native async questions acknowledge their
own call and continue running; they are not pending Claude tool calls with a
matching result channel. Forwarding their text alone would not preserve that
interaction.

For isolated workflow sessions, the gateway supplies Codex's supported startup
`model_catalog_json` override. The owner-only temporary snapshot clears the
experimental native-tool list and preserves all other model fields. The gateway
creates one private snapshot per app-server connection and removes it when that
connection closes. The source catalog is cached
by executable, Codex home, and working directory; restart the gateway after an
upstream update or catalog change. Missing catalog data and storage that does
not enforce private permissions fail explicitly.

The gateway also disables `features.context_management`. That experimental
mode can otherwise re-enable native token-budget tools despite a disabled
`features.token_budget`. Claude's supplied tools remain responsible for user
questions and project operations. Codex's `functions.exec` and `functions.wait`
control wrappers remain present; they are not native repository tools.

Sources: [Codex tool construction](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/tools/spec_plan.rs)
and [experimental context setup](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/session/token_budget.rs).

## Native Fable request handling

Fable 5.1 uses adaptive thinking and rejects forced `tool_choice: any` or a
named tool, including on token-count requests. The gateway preserves those
errors instead of converting the request to a different tool-selection policy.
It also forwards thinking signatures, system and tool prefixes, per-turn
fields, progress events, refusals, and upstream response headers.

Fable 5.1 thinking is bound to its preceding conversation. Do not edit the
prefix or move those thinking blocks to an older model. Start a new session
when changing model families; Claude Code owns its native migration behavior.

Fable's documented category-based fallback targets stay on Anthropic: Opus 5
for biology and Opus 4.8 for cybersecurity. The Opus alias remains native where
Claude needs it to arm fallback. Ordinary agents use the documented
`CLAUDE_CODE_SUBAGENT_MODEL_FORCE` setting to select Codex; native forks and
skill subagents explicitly inheriting main are exceptions. Explicit routing
that conflicts with a native fallback fails configuration rather than silently
changing the fallback provider.

Source: [Fable 5.1 migration guide](https://platform.claude.com/docs/en/models/fable-5-1/migration-guide).

## Verification

Run `npm run test:upstream-compatibility` with both supported CLIs installed.
It fails if a required executable is missing. Tests inspect generated app-server
schemas and actual tool advertisements, then run clean-home Claude sessions
against controlled upstream responses. They cover native Fable tool replay,
Codex identity and context, direct-response request counts, and the Kimi/Qwen
routes. No paid model requests are required.

The offline suite covers stream lifecycle, cancellation, overload, context
recovery, large-file paging, private catalog cleanup, and routing configuration.
The WSL smoke job runs on Ubuntu 24.04 under WSL 2, including private catalog
storage checks. Live provider availability, quota, model quality, and account
access are separate from these protocol contracts.
