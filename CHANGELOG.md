# Changelog

## 0.4.1 - 2026-09-14

### Fixed

- DeepSeek Flash defaults missing thinking and effort settings to enabled/max,
  validates effort names, and applies the provider's aliases consistently.
  Explicit thinking opt-outs remain supported; `xhigh` maps to `high`, not max.
- Interrupted Flash streams, malformed frames, and unsuccessful completion
  reasons report errors instead of successful completions. Entire tool-call
  batches are validated before any tool is forwarded, with no gateway retry.
- Flash streaming accepts fragmented UTF-8, CRLF, and multiline SSE data while
  preserving usage and output-limit stop reasons.

### Documentation and tests

- Setup and troubleshooting explain max thinking, override precedence, output
  budgets, Claude session effort, and interrupted responses.
- HTTP fault-injection tests cover incomplete streams and invalid tools;
  installed-Claude tests include a stale session-effort override.

## 0.4.0 - 2026-09-14

### Added

- DeepSeek V4.1 Flash main preset: `claude-workflow config --main deepseek`.
  The canonical `deepseek-flash` route uses max reasoning, a conservative
  1,000,000-token context ceiling, and a 393,216-token output ceiling. Claude's
  custom-model context remains bounded by the selected Codex agents.
- User images and image tool results on Flash routes, including Claude's Read
  tool. Explicit V4 Pro routes remain unchanged.
- Installed-Claude regression coverage and an opt-in live test for streaming,
  tool execution, file edits, image recognition, and session resume.

### Fixed

- Flash thinking history survives completed no-tool turns and gateway restarts.
- Flash preserves automatic/disabled tool selection and rejects required/named
  choices unsupported by the live thinking API instead of discarding them.
- DeepSeek setup uses its own key without requiring Anthropic authentication
  and leaves Claude's session effort unpinned.

## 0.3.1 - 2026-09-10

### Fixed

- Native `/effort ultracode` is no longer overridden by the Codex agent effort.
  Anthropic and Codex launches clear stale `CLAUDE_CODE_EFFORT_LEVEL` values
  from the child environment and private settings. Persistent Claude settings
  remain untouched, and Codex agents keep their configured upstream effort.
- Native `--effort` launch options are accepted after `--`. Kimi and Qwen keep
  their required provider-specific client effort and reject conflicting flags.

### Added

- Account-free installed-Claude tests for Ultracode activation, independent
  coordinator/agent effort, and stale shell/settings cleanup. Verified with
  Claude Code 2.1.261 and 2.1.267.
- Setup and troubleshooting guidance distinguishing native Ultracode mode from
  Codex reasoning levels.

## 0.3.0 - 2026-09-05

### Changed

- New installations use Anthropic Fable 5.1 for the main session and GPT-6
  Astra with max reasoning for Codex agents. Existing explicit model pins stay
  intact. Select `--main fable --agents astra --effort max --context long` to
  migrate. Opus 5 and the GPT-5.6 Sol, Terra, and Luna aliases remain available.
- Required upstream versions are Claude Code 2.1.261 and Codex CLI 0.153.4.
  Node 22+ is recommended for npm-based Claude installations; the gateway still
  supports Node 20 with a native Claude installation.
- Astra appears as `codex-astra` / “Codex Astra.” Its context follows the
  installed Codex catalog: 872,000 raw and 828,400 usable tokens in the default
  long profile, with compaction at 784,800. The API's larger advertised context
  is not substituted for the app-server's limit.

### Fixed

- Isolated Codex sessions suppress experimental native tools enabled through
  model metadata, including Astra's async questions and clock. A private
  per-process catalog snapshot preserves all other model fields. This keeps
  user questions on Claude's tool channel instead of silently hiding them.
- Inherited experimental Codex context management cannot re-enable native
  conversation-management tools inside a workflow thread.
- Closing an app-server connection settles active text, stream, and pending
  tool-continuation requests instead of leaving response consumers waiting.
- Anthropic token-count responses preserve request IDs and retry/rate-limit
  headers, matching the Messages passthrough.
- Native Fable fallback targets stay on Anthropic instead of being disabled
  by a Codex Opus alias or rerouted to Codex. Ordinary agents use Claude's
  documented subagent-model force setting; conflicting fallback routes fail
  configuration with an explicit diagnostic.
- Updated the transitive `qs` dependency to 6.16.0 to address its published
  parsing and denial-of-service advisories.

### Added

- Real installed-client tests for Astra's tool isolation and Fable 5.1's native
  adaptive-thinking/tool replay, plus HTTP contracts for untouched thinking
  prefixes, progress events, forced-tool errors, and one-call passthrough.
- Catalog snapshot lifecycle, permission, failure, cancellation, and restart
  coverage. Supported-version CI and latest-upstream canaries run the new tests.

## 0.2.4 - 2026-08-29

### Added

- Required installed-client CI against Claude Code 2.1.251 and Codex CLI
  0.150.1. Separate weekly or manually triggered jobs test current upstream
  releases, clean installs from matching canonical and mirror tags, and Ubuntu
  24.04 running under WSL 2 on a Windows runner.

### Changed

- Detached shared gateways expose their managed state directory through both
  the kernel working directory and `PWD`.
- Runtime revisions include Node.js process-start, certificate, TLS, and proxy
  settings that can change gateway behavior. Referenced certificate and OpenSSL
  files, symlink targets, and bounded certificate-directory state are tracked,
  so same-path rotations recycle the daemon.

### Fixed

- Codex CLI 0.151.0's typed transient rate-limit and non-retryable usage-limit
  turn errors are returned as Anthropic-shaped 429 responses without replaying
  a started turn.
- Concurrent managed-state claims revalidate an ownership marker published
  between the initial lookup and claim, avoiding a stale missing-marker failure.
- A transient Codex model-catalog failure is retried after a bounded
  negative-cache interval. Successful catalogs remain cached by resolved
  executable identity and effective Codex home.
- Installed-client compatibility jobs fail when a required CLI is absent or
  unusable instead of reporting a skipped test as a passing gate.
- Support guidance now respects a custom daemon port and explains when shared
  gateways must be reconciled. Release guidance distinguishes the supported
  release from historical tags.
- WSL CI reconstructs the committed tree on the native Linux filesystem from
  Git metadata, preserving real executable bits instead of DrvFS modes.
- WSL CI inspects the registered distribution before requesting conversion,
  avoiding the nonzero response from setting an existing WSL 2 distro to WSL 2.
- Windows checkout paths are passed to `wslpath` without native-command
  backslash loss, inline Bash is normalized to LF and streamed over stdin, and
  network-dependent package downloads use bounded retries.
- Permission-sensitive tests set their intended fixture modes explicitly, so a
  restrictive caller umask cannot weaken WSL security coverage.
- Latest-upstream CI resolves one exact Codex release and uses bounded,
  verified fresh-cache retries while npm finishes processing its native
  platform packages. Persistent packaging and compatibility failures still
  fail the canary without falling back to an older release.

## 0.2.3 - 2026-08-28

### Changed

- Shared gateways use their managed state directory as the process working
  directory. Codex model-catalog discovery and app-server launches therefore
  resolve relative commands from the same location.

### Fixed

- Shared-daemon revision checks load user configuration with the gateway's
  precedence rules and fingerprint the selected Node.js and Codex executables
  and effective Codex home instead of the literal `PATH`. `setup --shared`,
  `status`, and `reconcile` agree across equivalent shell environments. Unused
  `PATH` entries and comment-only configuration edits do not mark a healthy
  daemon stale, while selecting a different executable still does.
- Shared setup rejects cwd-relative resolution when the caller and managed
  state directory would select different Codex binaries. An absolute
  `ULTRATHINK_GATEWAY_CODEX_COMMAND` provides a stable override.

## 0.2.2 - 2026-08-28

### Changed

- GitHub installs are lifecycle-free. Validation remains in CI and
  `prepublishOnly`; the required `claude-workflow setup` step now removes
  historical shell routing and refreshes an owned running shared daemon from
  the final installation. It does not start a stopped daemon unless
  `--shared` is supplied.
- Installation examples grant npm 12 Git access only to the requested root
  package with `--allow-git=root`.

### Fixed

- Global installs from a GitHub tag no longer trigger npm's temporary
  Git-package preparation path. That checkout could run upgrade maintenance
  and leave global command links pointing to it after npm deleted it.

## 0.2.1 - 2026-08-28

### Changed

- Shared-secret comparisons now use constant-time byte equality checks for
  equal-length credentials.
- Missing or incorrect `/v1` credentials and incorrect credentials supplied to
  `/healthz` are rate-limited per direct socket peer, including alternate route
  casing and trailing slashes. Valid credentials,
  anonymous health polling, and no-secret loopback traffic have no rolling
  quota.
- Model and token-count requests share a configurable process-wide concurrency
  cap. Admission runs before the 32 MiB JSON parser and remains held until a
  complete JSON or streaming response closes.
- Stable GitHub installation examples pin the `v0.2.1` release.

### Fixed

- Bracket-qualified model IDs are parsed in one pass, preventing quadratic
  backtracking on long, unmatched input.
- Codex request, session, tool-schema, and system-prompt routing keys use full
  SHA-256 digests instead of truncated SHA-1 values.
- Daemon test executables and child working directories are anchored to the
  test module location instead of the caller's current directory.

## 0.2.0 - 2026-08-28

### Added

- Direct Codex main routing through `claude-workflow config --main codex`, using
  the configured model and reasoning effort without an Anthropic parent or
  login.
- Kimi K3 routing through the Kimi Code Anthropic-compatible API. The `kimi`
  preset selects the 1,048,576-token Allegretto profile; `k3` selects the
  262,144-token Moderato profile. Both preserve adaptive thinking and use the
  configured reasoning effort.
- Alibaba Qwen 3.8 Max routing through the Singapore Token Plan
  OpenAI-compatible endpoint, with a 1,000,000-token context window, a safe
  983,616-token thinking-mode input ceiling, a 131,072-token output limit,
  `xhigh` reasoning, strict reasoning replay, and parallel tool continuations.
- Installed-Codex contract tests for initialization and request attestation,
  thread and turn lifecycle, interruption, asynchronous events, dynamic tool
  calls, typed errors, compaction, cache-write usage, and model rerouting.
- Capability discovery through `codex debug models`, with `standard`, `long`,
  and exact-window configuration for Codex routes.
- Public contribution guidance and issue templates with an explicit private
  vulnerability-reporting path.

### Changed

- The supported baseline is Node.js 20, Claude Code 2.1.250, and Codex CLI
  0.150.1. App-server version detection accepts the current
  `<originator>/<codex-version>` initialize user agent and the older
  `codex_cli_rs` form.
- Opus 5 is the default main route. Delegated agents use `gpt-5.6-terra` with
  `max` reasoning and the concise `codex-terra` label; Fable 5 remains
  available.
- Canonical provider model IDs replace client-only `[1m]` aliases. Claude
  receives documented custom-model names, descriptions, capabilities, and
  context metadata through a private per-session settings layer. Its `/model`
  picker contains one exact row per distinct selected main or delegated route
  without enabling gateway discovery.
- Codex context is read from the installed catalog. Codex CLI 0.150.1's bundled 5.6 models
  advertise 272,000 raw and 258,400 usable tokens in `standard` mode, or 872,000
  raw and 828,400 usable tokens in `long` mode. Native compaction starts at
  244,800 and 784,800 respectively, and explicit requests are clamped to the
  catalog maximum.
- Claude's custom-model maximum is the minimum across the selected
  non-Anthropic main and delegated routes. Canonical Opus 5 and Fable 5 keep
  their native 1M maximum, but Claude's shared proactive-compaction setting
  makes them compact at 784,800 with the default Terra agents. Kimi and Qwen
  retain their larger provider capacities while using an 828,400-token client
  maximum and the same 784,800 compaction point.
- Codex app-server owns live context compaction and token-aware tool-output
  truncation for generic results. The gateway no longer recycles healthy
  sessions from estimated context pressure or adds a generic byte policy by
  default. Claude `Read` results use a bounded contiguous paging guard so no
  omitted middle can be mistaken for reviewed source.
- Direct third-party responses are selected and converted locally. A plain
  direct Codex prompt makes one provider request; only a real tool continuation
  or delegation resume creates another turn. Terminal-title traffic and unsafe
  non-streaming fallback retries are disabled for these routes.
- Local Kimi and Qwen token-count responses use a conservative ceiling of one
  estimated token per UTF-8 byte for Claude Code compaction without making
  another provider request.
- Every workflow Codex route starts without native execution environments,
  capability roots, agents, memories, MCP servers, plugins, skills, web,
  planning, permission, request-input, or clock/sleep tools. Codex 0.150.1 still
  advertises its unavoidable code-mode `functions.exec` and `functions.wait`
  wrappers alongside Claude's dynamic tools.
- Claude Workflow no longer changes `.claude.json`, user settings, or project
  settings. `setup --prepare-claude` is a compatibility no-op; custom routes use
  documented per-session settings.
- Third-party and dedicated gateway credentials stay in the gateway process and
  are removed from Claude, Codex, prerequisite checks, and app-server children.
  Anthropic passthrough continues to use Claude's own credential. Repository
  `.env` files remain disabled for workflow entrypoints unless a trusted
  per-session parent explicitly opts in.
- Shared-daemon upgrades use managed-state ownership, runtime-revision
  reconciliation, bounded shell cleanup, and self-contained global-install
  checks. The standalone gateway accepts request bodies up to 32 MiB.
- Stable GitHub installation examples pin the `v0.2.0` release.
  `yshaaban/claude-workflow` is the canonical public project home;
  `soar-capital-systems/claude-workflow` is a synchronized mirror.
- GitHub Actions dependencies are pinned to reviewed commit SHAs.

### Fixed

- Coalesced app-server messages no longer race listener registration, including
  streamed responses and large tool-result continuations.
- Failed or unacknowledged interruption evicts the affected Codex process before
  reuse. Partial and in-progress turns are never replayed after transport or
  context failure.
- Typed pre-output context failures can recover on a fresh thread without
  weakening cancellation, tool-call ownership, or transcript continuity.
- Schema agents retain the exact `StructuredOutput` tool name and can retry a
  rejected result on the live Codex turn without an enforcement inference.
- Launcher options remain ahead of native Claude commands, temporary settings
  are removed on signals, and provider credentials do not leak through child
  environments, traces, or generated settings.
- Shell migration preserves later user edits and Bash/zsh option state, hides
  credential-bearing updates from xtrace, and cannot leave stale workflow
  routing when the manager or environment file is unavailable.
- Claude 2.1.250 partial `Read` notices are correlated with the matching pending
  call. Codex receives a verified contiguous source prefix and exact next
  offset; malformed notices and dense single-line output fail closed without a
  coverage claim.
- Claude's transient transcript `system` reminders no longer change persistent
  Codex instructions or thread identity. Read results are canonicalized with
  the same gap-safe policy during live continuation and authoritative replay.
- Automatic Claude-facing Codex IDs are derived after route-map overrides, and
  conflicting generated aliases fail before launch. Concise requested IDs are
  the default response metadata; longer resolved route strings are opt-in.
- Kimi custom endpoints require HTTPS except for loopback development services.
- Outbound upstream requests reject HTTP redirects. Shared-secret Anthropic
  passthrough requires its dedicated gateway credential, and managed blank
  compatibility aliases prevent stale legacy fallback values from resurfacing.

## 0.1.0 - 2026-07-10

### Added

- Zero-config `setup` and read-only `doctor` checks for native tools,
  authentication, routing, and WSL path safety.
- A friendly `config` command for Fable/Codex models, reasoning effort, and
  permission behavior, backed by atomic owner-only user configuration.
- Shared `claude-workflow-gateway` daemon manager with revision-aware health,
  safe shell-hook install/uninstall, exact PID ownership, and upgrade-compatible
  state discovery.
- Large-file and diff review protocol, including a 12,000-line pending-result
  regression and explicit 1-based Claude Read guidance.
- Hard session admission limits, independent pending-tool expiry, context-window
  learning, proactive recycling, and transcript-first overflow recovery.
- Transcript continuity detection for Claude rewinds, branches, and compaction.
- Release checks for packed npm-bin execution, hostile shell values, trace
  concurrency, daemon lifecycle, Codex pipe failures, and native Claude argv.
- Linux checks for a self-contained global install, sourced Bash hooks, and
  shell-rc mode preservation.

### Changed

- Workflow subagents now default to `gpt-5.6-terra` with `max` reasoning and
  the short Claude-facing label `codex-terra`; Fable 5 remains the main route.
- Shared-daemon Codex threads are dynamic-tools-only (`environments: []`) so a
  daemon started in one directory cannot expose that native cwd to every repo.
- Current Codex owns token-aware tool-output truncation for workflow sessions;
  gateway byte caps remain explicit compatibility options.
- Workflow entrypoints ignore repository `.env` files unless the parent shell
  explicitly opts in with `CLAUDE_WORKFLOW_LOAD_PROJECT_ENV=true`.
- Standalone raw gateway moved to port 4319; the managed daemon remains 4318.
- Native Claude options and commands use an explicit `--` boundary.

### Fixed

- Large matching tool results no longer destroy the pending app-server call or
  get replayed as lossy transcript text.
- Read offsets are no longer rewritten or documented as zero-based, and a
  truncated middle never produces a fabricated continuation cursor.
- Historical/colliding tool-result IDs cannot hijack a pending call.
- Changed system instructions cannot silently reuse a thread pinned to stale
  developer instructions.
- Fresh fork sessions retain their bounded authoritative transcript.
- Child stdin `EPIPE`, duplicate replay cancellation, hard pool pressure, and
  blank/false-like configuration values are handled without daemon crashes or
  unbounded growth.
- Session expiry and forced shutdown await bounded app-server cleanup, avoiding
  orphaned Codex processes during timeouts and test interruption.
- Daemon env publication is shell-injection-safe, atomic, and private; health
  checks verify service/PID/revision rather than accepting an arbitrary 2xx.
- Trace files are private, bounded, rotated under a cross-process lock, recover
  abandoned locks, and reject unsafe existing directories without chmod side
  effects.
- GNU/Linux shell-rc mode detection no longer depends on BSD `stat` behavior.
  WSL state and trace paths fail closed when their filesystem cannot enforce
  Unix permissions, and manager-owned paths must be absolute.
- Executable scripts retain LF line endings in Windows/WSL checkouts, and test
  subprocess paths handle spaces and non-ASCII characters correctly.
