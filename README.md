# Claude Workflow

Claude Workflow runs Claude Code through a per-launch loopback gateway. Fable 5.1
handles the main session by default. Delegated agents run on GPT-6 Astra with
max reasoning and the Codex long-context profile. The main session can also run
directly on Codex, Kimi K3, Alibaba Qwen 3.8 Max, or DeepSeek V4.1 Flash.

Claude Code remains the client and executes project tools and sessions. Protocol
conversion happens locally and does not call another model. Third-party and
dedicated gateway credentials stay in the gateway process and are removed from
Claude, Codex, and prerequisite-check child processes. Normal loopback
Anthropic passthrough uses Claude's own credential; shared-secret Anthropic
routes require a separate gateway-side key. See
[Known boundaries](SUPPORT.md#known-boundaries) for features that cannot be
represented safely across providers.

> [!WARNING]
> Claude Workflow deliberately starts Claude Code with
> `--dangerously-skip-permissions`. Run it only in repositories and machine
> environments you trust. Use `--no-yolo` or configure
> `--permissions prompt` to restore Claude Code's permission prompts.

## Requirements

- Node.js 22 or newer recommended, with npm (the gateway also runs on Node 20)
- Git
- [Claude Code](https://code.claude.com/docs/en/setup) 2.1.261 or newer
- [Codex CLI](https://developers.openai.com/codex/cli) 0.153.4 or newer
- macOS, Linux, or WSL 2

The default Fable/Codex route requires both `claude auth login` and `codex login`,
with access to Fable 5.1 and GPT-6 Astra on the respective accounts.
A direct Codex main route does not require Anthropic authentication. Kimi and
Qwen and DeepSeek use their own provider keys, but delegated Codex agents still require a
Codex login.

Native Windows is not supported. See [Linux and WSL](#linux-and-wsl) before
installing under WSL.

## Getting started

Install release `v0.4.0` from the canonical GitHub repository. npm 12 blocks
Git dependencies by default, so the command grants access only to the package
named on the command line:

```bash
npm install --global --allow-git=root \
  git+https://github.com/yshaaban/claude-workflow.git#v0.4.0
```

Use a user-owned npm prefix, nvm, Volta, or another Node version manager if a
global install would otherwise require `sudo`. Do not run this package as root.

For development from source instead:

```bash
git clone https://github.com/yshaaban/claude-workflow.git
cd claude-workflow
npm install
npm install --global --install-links .
```

Authenticate and verify the default route:

```bash
claude auth login
codex login
claude-workflow setup
```

Start Claude Workflow from a trusted repository:

```bash
cd /path/to/your/repository
claude-workflow
```

`setup` checks the platform, CLI versions, authentication, WSL paths, and
effective routing. It makes no model request and does not modify your Claude
settings. When Bash is available, it also removes historical shell routing and
refreshes an owned running shared daemon after an upgrade; it never starts a
stopped shared daemon unless you pass `--shared`. Run `claude-workflow doctor`
later to repeat the read-only checks.

To upgrade, run the same install command with the new release tag, then rerun
`claude-workflow setup`. The package has no install-time lifecycle hooks, so npm
does not mutate shell or daemon state from a temporary Git checkout.

For a direct Codex main session, select the route before setup; Anthropic login
is not required:

```bash
codex login
claude-workflow config --main codex --agents astra --effort max --context long
claude-workflow setup
```

Kimi, Qwen, and DeepSeek also skip Anthropic login. Configure the route and provider key
first, then run setup. Delegated Codex agents still require `codex login`.

## Default routing

| Traffic | Claude-facing ID | Upstream | Context |
| --- | --- | --- | ---: |
| Main session | `claude-fable-5-1` | Anthropic Fable 5.1 | Native 1M |
| Delegated agents | `codex-astra` | Codex `gpt-6-astra`, max reasoning | 828,400 usable |

Canonical Anthropic model IDs keep their native maximum, so the default Fable 5.1
main session remains 1M. Claude's proactive compaction threshold is shared,
however: with default Astra agents, Fable 5.1 and Opus 5 compact at 784,800.
Non-Anthropic IDs also share Claude's custom-model maximum. The launcher sets
that maximum to the smallest truthful window across the custom main route, when
present, and the delegated Codex route. With default agents, `codex-astra`,
Kimi, Qwen, and DeepSeek get an 828,400-token client maximum and compact at 784,800, even
when the main provider accepts more.

The concise `codex-astra` ID is intentional. Claude Code receives its display
name, description, context limit, and supported capabilities through documented
custom-model settings. Codex receives the exact upstream model and context
values from its installed model catalog. Custom Codex models use the same short
form—for example, `gpt-5.4` appears as `codex-gpt-5.4` rather than an encoded
provider/effort routing string.

The `/model` picker contains one row for each distinct selected main or
delegated route. Direct Codex main and agent traffic therefore share one row
when they use the same ID. The picker and its metadata live in an owner-only
temporary settings file; they do not modify Claude Code's user or project
settings and do not require gateway model discovery.

Claude's documented Fable fallback stays on Anthropic: Opus 5 for biology and
Opus 4.8 for cybersecurity. These fallback targets do not add picker rows or
become Codex aliases. Conflicting custom routes fail configuration explicitly.
The launcher forces ordinary subagents to the selected Codex model using
`CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`. Claude's native forks and skill subagents
that explicitly inherit the main model remain exceptions. See
[Claude's subagent model rules](https://code.claude.com/docs/en/sub-agents#run-every-subagent-on-one-model).

Change the Codex tier, effort, or context profile with the configuration
command:

```bash
claude-workflow config --agents astra --effort max --context long
claude-workflow config --agents terra --effort max --context long
claude-workflow config --agents sol --effort max --context long
claude-workflow config --agents luna --effort high --context standard
```

The context profile sets Claude's launch-wide proactive-compaction ceiling.
Choosing `standard` lowers it to 244,800 tokens even when the main model is
canonical 1M Fable 5.1 or Opus 5.

Astra is the default for capability-focused work. `astra` selects `gpt-6-astra`;
`sol`, `terra`, and `luna` select their GPT-5.6 models. Terra is a balanced
alternative and Luna prioritizes latency and cost. Changing tiers never invents
an unavailable model such as `gpt-6-terra`. You may also pass a full model ID
available to your Codex workspace.

### Native Ultracode mode

With Fable as the coordinator, run `/effort ultracode` inside Claude Code.
This selects native xhigh reasoning with dynamic workflow orchestration.
Enable dynamic workflows in `/config` if needed. Availability depends on
Claude Code, the selected model, and your organization's effort limits.

Codex agents keep their own configured effort. For example, an Ultracode
coordinator can delegate to Astra/max agents. `claude-workflow config --effort`
controls the Codex route, not the coordinator's native mode. To set a native
effort level at launch, use `claude-workflow -- --effort xhigh`.

Workflow clears stale `CLAUDE_CODE_EFFORT_LEVEL` overrides for Anthropic and
Codex routes without editing persistent Claude settings. Kimi and Qwen retain
their required provider-specific client effort. See
[native effort and Ultracode](docs/UPSTREAM_COMPATIBILITY.md#native-effort-and-ultracode).

### Codex context profiles

Claude Workflow reads the selected model's limits from
`codex debug models --bundled` instead of assigning every custom model a 1M
window. It refreshes the online catalog only when the selected model is absent
from the installed binary's catalog.

For GPT-6 Astra in the Codex CLI 0.153.4 bundled catalog:

| Profile | Raw Codex window | Usable window exposed to Claude | Native compaction point |
| --- | ---: | ---: | ---: |
| `standard` | 272,000 | 258,400 | 244,800 |
| `long` | 872,000 | 828,400 | 784,800 |

`long` is the Claude Workflow default. These values make Codex a long-context
option without misreporting its exact window as 1,000,000 tokens.
If a future Codex release changes the catalog, the gateway follows the installed
catalog and clamps explicit overrides to the model's advertised maximum.

Literal 1,000,000-token Codex models are supported when the installed catalog
advertises them. For example, Codex CLI 0.153.4 gives `gpt-5.4` a 1,000,000
raw / 950,000 usable long profile:

```bash
claude-workflow config --agents gpt-5.4 --effort xhigh --context long
```

To use that literal 1M model for both the main session and agents:

```bash
claude-workflow config --main codex --agents gpt-5.4 --effort xhigh --context long
```

Because both routes have the same truthful ID, Claude's picker shows one
`codex-gpt-5.4` row.

This is an explicit compatibility choice, not a recommendation to replace
Astra with an older model for its context window alone. The
[GPT-6 Astra API](https://developers.openai.com/api/docs/models/gpt-6-astra)
advertises 1,050,000 tokens, but the installed Codex app-server catalog is the
authority for this integration. A `[1m]` label does not enlarge that window.

## Choose a main route

```bash
claude-workflow config --main fable  # default Fable 5.1 coordinator
claude-workflow config --main opus   # Anthropic Opus 5
claude-workflow config --main codex  # direct Codex response
claude-workflow config --main kimi   # Kimi K3, 1,048,576-token plan
claude-workflow config --main k3     # Kimi K3, 262,144-token plan
claude-workflow config --main qwen   # Qwen 3.8 Max, 1M context / 983,616 max input
claude-workflow config --main deepseek # DeepSeek V4.1 Flash, max reasoning
```

Start a new Claude Code session after changing routes. `claude-workflow config`
prints the effective model, provider, effort, and Codex context.

Fable 5.1 uses adaptive thinking and does not accept forced tool selection
(`tool_choice: any` or a named tool). The gateway forwards its requests,
thinking blocks, tool schemas, and errors without rewriting them. Keep
Claude Code current and start a new session when changing model families:
Fable 5.1 binds thinking to the preceding conversation, and older models
cannot reuse its thinking blocks. See Anthropic's
[migration guide](https://platform.claude.com/docs/en/models/fable-5-1/migration-guide).

### DeepSeek V4.1 Flash

Add `DEEPSEEK_API_KEY=your_deepseek_api_key` to `~/.claude-workflow.env`, protect
it with `chmod 600 ~/.claude-workflow.env`, then select the route:

```bash
codex login
claude-workflow config --main deepseek
claude-workflow setup
claude-workflow
```

The model appears as `deepseek-flash`. Streaming, thinking-history replay,
file tools, and images use the existing local protocol adapter. No extra model
call rewrites the answer. The profile supports DeepSeek's documented 1M window;
Claude's shared custom-model limit remains bounded by the selected Codex agents.
See [DeepSeek setup, limits, and tests](docs/DEEPSEEK.md).

### Direct Codex

Direct mode removes the Anthropic coordinator from the main response path:

```bash
codex login
claude-workflow config --main codex --agents astra --effort max --context long
claude-workflow
```

For a plain prompt with no tool use, Claude Workflow sends one request to Codex
and returns that response directly. It disables Claude Code's auxiliary
terminal-title request, and the local Anthropic conversion adds no inference.

Tool use still requires a real continuation: Codex requests a tool, Claude Code
executes it, then Codex receives the tool result. Delegation also resumes the
parent after an agent finishes. Those turns are part of Claude Code's normal
orchestration, not response-rewriting overhead.

Return to the default coordinator with:

```bash
claude-workflow config --main fable
```

### Kimi K3

The Kimi route uses the Kimi Code Anthropic-compatible API with adaptive
thinking and max reasoning. `kimi` selects the 1,048,576-token plan;
`k3` selects the 262,144-token plan.

Create a key in the [Kimi Code Console](https://www.kimi.com/code/console) and
confirm model and plan availability in Kimi's
[model reference](https://www.kimi.com/code/docs/en/kimi-code/models.html).

```bash
claude-workflow config --main kimi
${EDITOR:-vi} ~/.claude-workflow.env
chmod 600 ~/.claude-workflow.env
claude-workflow
```

Add the provider key to the user configuration:

```dotenv
ULTRATHINK_GATEWAY_KIMI_API_KEY=replace_with_your_kimi_code_key
```

The built-in endpoint is `https://api.kimi.com/coding/`. Kimi Code and Kimi
Open Platform credentials are not interchangeable. Custom remote endpoints
must use HTTPS; plain HTTP is accepted only for a loopback development service.

The 1,048,576-token value is Kimi's provider capacity. When Codex agents are
enabled, Claude Code uses the smaller common custom-model limit described in
[Default routing](#default-routing).

### Qwen 3.8 Max

The Qwen route uses Alibaba's exact `qwen3.8-max` model through the Singapore
Token Plan OpenAI-compatible endpoint. Alibaba documents a 1,000,000-token
context window, a 983,616-token maximum input in thinking mode, a 131,072-token
maximum output, and a 262,144-token maximum chain of thought. Claude Workflow
uses 983,616 as the route's safe input ceiling and selects `xhigh` reasoning.

See Alibaba's
[qwen3.8-max model reference](https://www.alibabacloud.com/help/en/model-studio/qwen3-8-max)
for the limits and the
[Token Plan quick start](https://www.alibabacloud.com/help/en/model-studio/token-plan-team-quickstart)
for key and endpoint pairing.

```bash
claude-workflow config --main qwen
${EDITOR:-vi} ~/.claude-workflow.env
chmod 600 ~/.claude-workflow.env
claude-workflow
```

Add the Token Plan key to the user configuration:

```dotenv
ULTRATHINK_GATEWAY_QWEN_API_KEY=replace_with_your_token_plan_key
```

The built-in endpoint is:

```text
https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1
```

Token Plan and standard DashScope credentials are different products. A
`DASHSCOPE_API_KEY` is accepted only when an explicit `QWEN_BASE_URL` or
`ULTRATHINK_GATEWAY_QWEN_BASE_URL` selects the matching endpoint. Custom remote
endpoints must use HTTPS; plain HTTP is accepted only for a loopback service.

Qwen's provider context window is 1,000,000 tokens; 983,616 is Alibaba's maximum
input in thinking mode and Claude Workflow's safe route ceiling. When Codex
agents are enabled, Claude Code uses the smaller common custom-model limit
described in [Default routing](#default-routing). With literal-1M `gpt-5.4`
agents, the client maximum is 950,000 and proactive compaction begins at
900,000, leaving 83,616 tokens of input headroom below the thinking-mode input
limit.

Qwen reasoning is preserved across tool continuations. Deep-thinking mode
supports `tool_choice` values `auto` and `none`; required or named choices fail
locally instead of being silently weakened. Count-token responses use a
conservative ceiling of one estimated token per UTF-8 byte for Claude Code
compaction. They are not tokenizer or billing counts and do not call the model.

## How requests are handled

```text
Claude Code
    │ Anthropic Messages
    ▼
per-launch loopback gateway
    ├── Anthropic
    ├── Codex app-server
    ├── Kimi Anthropic-compatible API
    └── Qwen OpenAI-compatible API
```

By default, each launcher gets a gateway on an operating-system-assigned
loopback port. The launcher builds an owner-only temporary Claude settings layer
and removes it at exit. Provider keys are never written to that file. Loopback
is not an OS-user security boundary; see
[Security boundaries](#security-boundaries).

Codex sessions use the installed app-server protocol and keep one process alive
across genuine continuations. Cancellation uses `turn/interrupt`; failed or
unacknowledged interruption evicts the process before reuse. Admission pressure
returns a retryable overload response rather than growing the session pool
without bound, and in-progress turns are never replayed after partial output.

Workflow Codex sessions disable optional Codex agents, memories, MCP servers,
plugins, skills, web tools, planning tools, permission prompts, clock/sleep
tools, experimental context management, and native execution environments.
An owner-only catalog snapshot also removes experimental native tools, including
async questions and clock, that model metadata enables independently of feature
flags. Questions and project operations use Claude's supplied tools. The snapshot preserves the rest of the
installed catalog and lasts only for that app-server process; restart the
gateway after updating Codex to load fresh metadata. Codex 0.153.4 still exposes its
built-in `functions.exec` and `functions.wait` code-mode control wrappers; they
are protocol orchestration primitives, not inherited repository integrations.
Repository operations use the dynamic tools supplied by Claude Code. The same
isolation policy applies to per-session and shared gateways.

## Large files and diffs

A large context window does not make a 12,000-line review complete by itself.
Claude Code, a tool result, the HTTP transport, and the provider each have
independent limits. Claude Workflow correlates Claude Code's partial `Read`
notice with the matching pending call, then gives Codex only a verified
contiguous prefix of numbered source lines plus an exact next offset. It never
presents a head-and-tail preview as complete source.

The Codex CLI 0.153.4 bundled catalog declares a 10,000-token function-output policy.
The Read guard stays below that history threshold with a page no larger than
36,000 UTF-8 bytes. Malformed notices, mismatched paths or ranges, and dense
single-line output fail closed without a coverage claim. Generic tool results
still use the installed app-server's token-aware policy.

For reliable coverage:

1. Inventory every file and diff hunk before reading.
2. Inspect bounded source ranges around each hunk.
3. Record reviewed ranges and every unresolved omission.
4. Re-inventory after edits and review the new hunks.

See [Reviewing large files and diffs](docs/LARGE_FILES_AND_DIFFS.md) for the
complete procedure, including dense single-line files and session handoffs.

## Everyday commands

```bash
# Interactive session
claude-workflow

# One prompt and exit
claude-workflow "Review the current diff and delegate focused checks."

# Resume Claude Code state
claude-workflow --resume <session-id>
claude-workflow --continue

# Configuration and diagnostics
claude-workflow config
claude-workflow config --json
claude-workflow doctor

# Restore Claude Code permission prompts
claude-workflow config --permissions prompt
claude-workflow --no-yolo
```

Use `run` when prompt text begins with a reserved command name:

```bash
claude-workflow run "setup the repository and verify the result"
```

Pass native Claude options after `--`:

```bash
claude-workflow -- --add-dir ../shared --permission-mode plan
claude-workflow "Review the diff." -- --output-format json
```

The launcher owns `--model`; overriding it would make Claude's selected model
disagree with gateway routing. Run `claude-workflow --help` for the complete
command reference.

## Configuration

Prefer `claude-workflow config` for model, effort, context, and permission
settings. It writes `~/.claude-workflow.env` atomically with owner-only
permissions. Exported parent variables take precedence, and
`~/.ultrathink.env` remains a legacy fallback. Keep any blank compatibility
aliases written by `config`: they deliberately shadow stale values with the same
name in the legacy file.

Workflow entrypoints ignore a repository `.env` by default. A trusted
per-session launch may opt in by exporting
`CLAUDE_WORKFLOW_LOAD_PROJECT_ENV=true` in its parent shell. Shared mode rejects
that option because its daemon is user-wide.

Common advanced settings:

```dotenv
ULTRATHINK_GATEWAY_CODEX_CONTEXT=long
# ULTRATHINK_GATEWAY_CODEX_CONTEXT_WINDOW=872000
# ULTRATHINK_GATEWAY_CODEX_INPUT_MAX_TOKENS=0
# ULTRATHINK_GATEWAY_CODEX_COMMAND=/absolute/path/to/codex
```

Port `0` is a launcher setting that asks the operating system for an isolated
port. A raw long-running gateway must use a positive port (4319 by default).

`ULTRATHINK_GATEWAY_CODEX_CONTEXT_WINDOW` is an exact raw-window request and is
clamped to the installed model's catalog maximum. The input limit is only a
gateway ceiling; `0` uses the capability-derived safe budget. See
[`.env.example`](.env.example) for the full reference.

## Shared gateway

The per-session launcher is the normal mode. Shared mode is an API-integration
primitive for an explicit client that needs a stable gateway URL:

```bash
claude-workflow setup --shared
claude-workflow-gateway status
claude-workflow-gateway reconcile
claude-workflow-gateway log 100
claude-workflow-gateway restart
claude-workflow-gateway stop
```

The daemon binds to `127.0.0.1:4318` by default. Its state, generated
environment, logs, and traces are owner-only. Codex model-catalog probes and
app-server processes run from that managed state directory. `setup --shared`
verifies that the caller and state directory resolve the same Codex executable;
if a cwd-relative `PATH` entry makes them differ, set
`ULTRATHINK_GATEWAY_CODEX_COMMAND` to an absolute executable path.

The manager derives the runtime revision from installed sources, effective user
configuration, and the selected Node.js and Codex executables. An unused
`PATH` entry or a comment-only configuration edit does not make the daemon
stale; selecting a different executable or effective setting does. After
changing a provider, credential, endpoint, model, or executable, run
`claude-workflow-gateway reconcile` or rerun setup. Reconciliation replaces a
stale running daemon but leaves a stopped daemon stopped.

Plain `claude` sessions are never silently routed through the shared gateway.

The explicit-client contract is the owner-only generated file at
`${XDG_STATE_HOME:-$HOME/.cache}/claude-workflow/claude-workflow-gateway.env`.
It exports the URL, local gateway credential, model IDs, and context settings.
Apply it only inside the client process's subshell; do not print it, copy it, or
source it from a persistent shell startup file:

```bash
(
  . "${XDG_STATE_HOME:-$HOME/.cache}/claude-workflow/claude-workflow-gateway.env"
  exec claude
)
```

Shared mode requires `bash` on `PATH`. The per-session launcher does not require
Bash.

## Linux and WSL

Linux is supported directly. Under WSL, install Node.js, npm, Claude Code,
Codex, and Claude Workflow inside the same Linux distribution. Keep all of the
following on the Linux filesystem under `/home`, not `/mnt` or another DrvFS
mount:

- the repository and `node_modules`;
- your home directory and `~/.claude-workflow.env`;
- npm's cache and global prefix; and
- shared-gateway state and traces.

Verify that the toolchain resolves to Linux executables:

```bash
command -v node npm claude codex claude-workflow
npm config get cache
npm config get prefix
```

`claude-workflow setup` rejects mounted Windows paths before changing files.
Executable scripts use LF line endings and the test suite covers Bash, zsh,
Linux path handling, Unicode paths, and spaces in installation paths.

## Security boundaries

- Permission bypass is deliberate and is not a sandbox.
- The gateway binds to loopback by default. Non-loopback binds require a shared
  secret.
- A non-Anthropic main route uses a random per-launch gateway credential.
- Missing or incorrect `/v1` credentials, and incorrect credentials supplied
  to `/healthz`, are rate-limited per direct socket peer. Anonymous health
  polling and valid or no-secret loopback traffic do not consume that quota.
  Model and token-count requests instead share a
  configurable process-wide concurrency cap held through complete streaming
  responses; valid requests have no rolling quota.
- Keep provider keys only in the owner-only user configuration. Do not put them
  in repositories, shell history, command arguments, traces, or issue reports.
- Third-party and dedicated gateway credentials are removed from Claude,
  Codex, and native preflight child environments. Anthropic passthrough uses
  Claude's own Anthropic credential.
- Shared-daemon Codex threads receive no native repository workspace or optional
  integrations. The app-server and its threads use the managed state directory
  as a deterministic working directory; repository work goes through Claude
  Code's dynamic tools. The app-server's built-in code-mode control wrappers
  remain present as described above.

See [SECURITY.md](SECURITY.md) for reporting and the full security model.

## Troubleshooting

- **`max` overrides `/effort ultracode`:** upgrade to v0.3.1 or newer, run
  `claude-workflow setup`, and start a new session. Version 0.3.0 injected the
  override at launch, so unsetting it in the parent shell alone did not help.
Start with:

```bash
claude-workflow --version
claude --version
codex --version
claude-workflow doctor
claude-workflow config
```

- **Claude reports `[claude-code:unrecognized_model]`:** check `/model` or
  `/status`. If each distinct selected route still appears by its exact ID and
  requests succeed, the diagnostic is cosmetic: Claude Code accepts only one
  explicit custom-model metadata profile. If a row is absent or requests fail,
  inspect organization-managed `availableModels` and other policy settings.
  Claude Workflow does not bypass organization policy or disguise Codex as an
  Anthropic model.
- **Codex appears to pause for a safety review:** the interactive Codex TUI can
  show a “keep waiting” prompt while an upstream review is buffered. Claude
  Workflow uses `codex app-server`, so that TUI prompt is not rendered. There
  is no supported client setting that bypasses the provider-side review delay.
- **Claude shows an old model or context:** close the session, run
  `claude-workflow config`, and start a new one. Run
  `claude-workflow-gateway reconcile` if you use shared mode.
- **Codex setup fails:** update to Codex CLI 0.153.4 or newer, run `codex login`,
  then rerun `claude-workflow setup`.
- **A large review is incomplete:** follow the bounded coverage process in
  `docs/LARGE_FILES_AND_DIFFS.md`; do not infer the contents of a truncated gap.
- **WSL path validation fails:** move the checkout, home, npm cache/prefix, and
  CLI installations to the Linux filesystem.
- **A provider returns 401 or 403:** confirm that the credential belongs to the
  selected product, endpoint, account, and region. Setup deliberately does not
  spend tokens to probe plan entitlement.

Never attach an unredacted environment file, trace, prompt, or API key to an
issue.

## Development

```bash
npm install
npm run check
npm test
npm run test:package
```

The tests cover protocol lifecycle, context discovery, cancellation, overload,
streaming, one-call passthrough, large tool results, provider contracts,
installed Claude clean-home flows, WSL safety, packaging, and self-contained
GitHub-tag global installation. Live provider calls are excluded from CI.

CI installs Claude Code 2.1.261 and Codex CLI 0.153.4 for the required
installed-client contracts. A separate weekly or manually triggered workflow
tests current upstream releases and clean installs from the latest matching
canonical and mirror tags. Its failures report compatibility drift; they do
not change the minimum supported versions. A Windows 2025 job installs Ubuntu
24.04 under WSL 2 and runs the WSL safety contract on its native Linux
filesystem. The hosted Linux matrix is not used as a substitute for WSL.

See [SUPPORT.md](SUPPORT.md) for supported environments and known boundaries.
See [Upstream compatibility](docs/UPSTREAM_COMPATIBILITY.md) for the model,
context, and tool-isolation contracts and their upstream sources.

## Upgrade and uninstall

Reinstall this release, then run the setup checks and upgrade maintenance:

```bash
npm install --global --allow-git=root \
  git+https://github.com/yshaaban/claude-workflow.git#v0.4.0
claude-workflow setup
```

Use another tag only to reproduce older behavior; the latest release is the
supported version. npm registry publication is not required for GitHub
installation.

Upgrades preserve explicitly saved model IDs and shell overrides. To adopt the
current defaults, update both CLIs and select the new profile:

```bash
codex update
claude update
claude-workflow config --main fable --agents astra --effort max --context long
claude-workflow setup
claude-workflow doctor
```

Use your package manager to update Codex if it does not support `codex update`.
Start a new terminal and Claude Workflow session. Shared-mode users can run
`claude-workflow-gateway reconcile` to replace a running stale gateway.

To retain an older model pair, rerun its preset instead, for example
`claude-workflow config --main opus --agents terra --effort max --context long`.
This refreshes the managed native-fallback list without changing that pair.
Manually maintained route maps must preserve the fallback targets named in any
configuration error.

Remove Claude Workflow with:

```bash
claude-workflow-gateway stop
npm uninstall --global @onetool/claude-workflow
```

Uninstalling leaves your user configuration and existing logs in place.

## Project links

[`yshaaban/claude-workflow`](https://github.com/yshaaban/claude-workflow) is the
canonical public repository for releases, issues, pull requests, and private
security reports.
[`soar-capital-systems/claude-workflow`](https://github.com/soar-capital-systems/claude-workflow)
is a synchronized mirror.

- [Releases](https://github.com/yshaaban/claude-workflow/releases)
- [Changelog](CHANGELOG.md)
- [Support policy](SUPPORT.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [MIT License](LICENSE)
