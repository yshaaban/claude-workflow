# Security policy

## Reporting a vulnerability

Please use the canonical repository's
[private GitHub security-advisory flow](https://github.com/yshaaban/claude-workflow/security/advisories/new)
rather than a public issue or the Soar mirror. Include the affected release or
revision, reproduction steps, impact, and a minimal redacted trace when useful.
Do not include API keys, OAuth tokens, generated gateway environment files, or
complete private prompts or transcripts.

## Security model

- `claude-workflow` intentionally launches Claude Code with
  `--dangerously-skip-permissions` by default. This is a trusted-repository
  automation mode, not a sandbox boundary. Use `--no-yolo` for normal prompts.
- The gateway binds to loopback by default, but loopback is not an OS-user
  boundary. Other local users or processes in the same network namespace may
  be able to connect. A managed non-Anthropic main route therefore creates a
  random gateway secret and requires it on `/v1`; the shared daemon publishes
  that secret only through its owner-only environment file.
- Non-loopback binds require `ULTRATHINK_GATEWAY_SHARED_SECRET`. When that is
  set, every Anthropic route also needs the dedicated gateway-side
  `ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY`. A generic `ANTHROPIC_API_KEY` is not
  accepted as the shared-secret upstream credential.
- Missing or incorrect `/v1` credentials, and incorrect credentials supplied
  to `/healthz`, are rate-limited per direct socket peer before JSON parsing.
  Anonymous health polling, valid credentials, and no-secret loopback traffic
  do not consume that quota. Model and token-count operations share a separate
  configurable process-wide admission cap held until their complete JSON or
  streaming response closes. This bounds body and upstream concurrency without
  imposing a rolling quota on valid sessions.
- Provider API keys, including `ULTRATHINK_GATEWAY_KIMI_API_KEY` and
  `ULTRATHINK_GATEWAY_QWEN_API_KEY`, belong in the
  owner-only `~/.claude-workflow.env` file. Do not export them from a shell
  startup file or store them in a repository `.env`, command-line argument,
  issue, trace, or diagnostic attachment. Kimi requests use the gateway-side
  key rather than Claude Code's inbound credential. Kimi and Qwen custom remote
  endpoints must use HTTPS; plain HTTP is allowed only on loopback. Qwen Token
  Plan keys must match their plan endpoint.
  All outbound upstream requests reject HTTP redirects so credentials are not
  forwarded to a redirect target. The built-in Qwen Token Plan route also
  ignores a generic `DASHSCOPE_API_KEY` unless an explicit matching Qwen base
  URL is configured.
  Dedicated gateway keys are removed from child processes; Kimi, Qwen, and
  unrelated Anthropic credentials are also removed from Codex probes and
  app-server processes.
- Per-session launches pass Claude a private owner-only `--settings` file that
  clears conflicting routing, beta, thinking, and provider-selection values.
  It contains only local gateway credentials, never upstream provider keys,
  and is removed on normal exit, SIGINT, and SIGTERM. Claude organization
  policy has higher precedence and is not bypassed.
- Package installation has no install-time lifecycle hooks and does not modify
  shell or daemon state. `setup` does not modify `.claude.json` or Claude user
  or project settings. When Bash is available, it can remove historical shell
  routing and refresh an already-running owned daemon after an upgrade. A
  stopped daemon stays stopped. `setup --json` and `doctor` are read-only. The
  `setup --prepare-claude` compatibility option remains a no-op for Claude
  state and custom-model preparation; `setup --shared` explicitly starts and
  manages private daemon state.
- Every workflow Codex route, including per-session, shared, direct-main, and
  delegated-agent routes, starts without Codex-native execution environments
  or capability roots. Native agents, memories, MCP servers, plugins, skills,
  web, planning, permission, request-input, and clock/sleep tools are disabled.
  A private per-process model catalog selects direct tool mode and disables
  native patching. Repository operations use the tools supplied and executed
  by Claude Code. This isolation does not turn permission bypass into a sandbox.
- Workflow entrypoints ignore project `.env` by default. Only a parent process
  can opt a trusted project into per-session loading. Shared mode rejects that
  opt-in because its daemon is global rather than repository-scoped.
- User configuration, state, env exports, logs, and traces are private. User
  configuration must be a current-user-owned, non-symlink regular file with no
  group or other access. Symlinks and broadly accessible custom state or trace
  locations are rejected. Blank compatibility aliases written to
  `~/.claude-workflow.env` deliberately shadow stale values in the legacy
  `~/.ultrathink.env` fallback.
- Unauthenticated non-loopback health responses omit paths, PIDs, revisions,
  and budgets.

Security fixes are provided for the latest release on the default branch.
Older releases are not supported.
