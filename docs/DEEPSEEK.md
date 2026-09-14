# DeepSeek V4.1 Flash

Claude Workflow exposes DeepSeek V4.1 Flash as `deepseek-flash`, with max
reasoning. Claude Code runs the tools, while delegated agents keep the
configured Codex model. Selecting DeepSeek does not change the agent route.

## Setup

Add your key to `~/.claude-workflow.env` using a text editor:

```dotenv
DEEPSEEK_API_KEY=your_deepseek_api_key
```

Protect the file, select the model, and check the configuration:

```bash
chmod 600 ~/.claude-workflow.env
codex login
claude-workflow config --main deepseek
claude-workflow setup
claude-workflow
```

The preset saves `deepseek-flash` with max reasoning. If an older configuration
sets `ULTRATHINK_THINKING_LEVEL=OFF`, remove that override to enable thinking.
Shell exports take precedence over the saved file.

Anthropic authentication is not required for this route. The DeepSeek account
must have API credit and access to `deepseek-flash`. The same commands work on
macOS, Linux, and WSL 2. Under WSL, use Linux-installed tools and a repository
on the Linux filesystem.

To restore the default coordinator, run `claude-workflow config --main fable`.
Start a new session when changing provider families. In shared-daemon mode,
run `claude-workflow-gateway reconcile` after changing configuration.

## Model and limits

The canonical API ID is `deepseek-flash`, not `deepseek-v4.1`.
`deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are compatibility aliases
for the new Flash model. Explicit `deepseek-v4-pro` configurations remain
unchanged: the current API reference still lists V4 Pro as a separate model.
See DeepSeek's [model reference](https://api-docs.deepseek.com/quick_start/pricing/).

The profile uses a conservative 1,000,000-token interpretation of the documented
1M context window and caps output at 393,216 tokens, including reasoning.
Input and output share the context window. These are protocol limits, not a
claim that every installation has been tested with a full 1M-token prompt.

Claude Code shares one custom-model context setting across the main model and
agents. With the default Astra long-context route, Claude therefore exposes
828,400 tokens and compacts at 784,800. A `[1m]` suffix does not enlarge the
actual window. You can lower the DeepSeek limits for a smaller deployment:

```dotenv
ULTRATHINK_GATEWAY_DEEPSEEK_CONTEXT_TOKENS=262144
ULTRATHINK_GATEWAY_DEEPSEEK_MAX_OUTPUT_TOKENS=32768
```

Values above the profile ceilings are clamped. The dedicated
`ULTRATHINK_GATEWAY_DEEPSEEK_API_KEY` takes precedence over `DEEPSEEK_API_KEY`.
The default endpoint is `https://api.deepseek.com` using `/chat/completions`.
Do not put DeepSeek's `/anthropic` endpoint into this OpenAI-compatible profile.

## Thinking, tools, and images

The gateway converts the protocol locally. It makes no model call to rewrite
a response, and disables Claude's extra terminal-title request. Both streaming
and non-streaming responses retain thinking blocks. Resumed sessions replay
thinking from the transcript, including completed turns without tool calls.
This follows DeepSeek's [thinking-history contract](https://api-docs.deepseek.com/guides/thinking_mode/).

### Max thinking and overrides

Workflow explicitly sends this configuration by default, even though
DeepSeek's API defaults to `high`:

```json
{"thinking": {"type": "enabled"}, "reasoning_effort": "max"}
```

Use `low`, `high`, or `max` for effort. Compatibility aliases follow
[DeepSeek's mapping](https://api-docs.deepseek.com/guides/thinking_mode/):
`minimal` means `low`; `medium` and `xhigh` mean `high`; `ultra` means `max`.
Unknown values fail locally. Missing or blank values fall back to the next
configured value, then to `max`.

Effort settings take precedence in this order:

1. An explicit route-map entry's `reasoningEffort` or `reasoning_effort`.
2. `ULTRATHINK_GATEWAY_MAIN_REASONING_EFFORT`, for the main route only.
3. `ULTRATHINK_GATEWAY_DEEPSEEK_REASONING_EFFORT`.
4. `ULTRATHINK_DEEPSEEK_REASONING_EFFORT`, the legacy provider setting.
5. The `max` default.

`claude-workflow config --main deepseek` saves the main-route effort as `max`.
To lower it, edit `ULTRATHINK_GATEWAY_MAIN_REASONING_EFFORT` in
`~/.claude-workflow.env`. `claude-workflow config --effort` configures Codex,
not DeepSeek. The `Reasoning` line in `claude-workflow config` describes the
agents, not the main model.

`ULTRATHINK_THINKING_LEVEL=OFF` disables thinking for the provider profile;
an explicit route-map `thinking` setting takes precedence over that profile.
Disabled thinking or an effective effort of `none` omits `reasoning_effort`.
Other global thinking levels do not lower DeepSeek's effort.
Max effort does not force the maximum output size: Claude's requested output
budget still applies, capped by the profile limit, and includes reasoning.

Workflow clears inherited `CLAUDE_CODE_EFFORT_LEVEL` for DeepSeek so a stale
Claude session setting cannot override the provider configuration. Claude's
native mode and availability checks remain Claude-owned; DeepSeek does not
grant access to Fable's native Ultracode features.

### Tools and images

In thinking mode, `tool_choice: auto` and `none` are preserved. Required and
named choices fail locally because the live API rejects them. Older Pro routes
retain their existing compatibility behavior. Redacted or merged thinking
blocks are rejected when they cannot be replayed faithfully.

Inline and URL images are supported in user messages and image tool results,
including Claude's `Read` tool. Uploaded-file references, documents, and
unsupported content blocks are rejected instead of silently discarded.
DeepSeek's [vision limits](https://api-docs.deepseek.com/guides/vision/) and the
gateway's request-body limit still apply.

### Interrupted responses

Flash responses must include a valid completion reason; streams must also
reach the upstream `[DONE]` marker. Malformed JSON, provider error frames,
aborted generation, and resource interruptions produce an error instead of
a successful completion. See DeepSeek's
[completion contract](https://api-docs.deepseek.com/api/create-chat-completion/).
The gateway validates the entire tool-call batch
before forwarding any tool call to Claude. Truncated tools are not executed.

A normal text response that reaches its output limit is reported as
`max_tokens`, not a complete answer. The gateway does not automatically retry
these failures or spend tokens rewriting the response. Claude may apply its
own retry policy; inspect the error before retrying manually.

## Verification

The account-free suite covers effort precedence and opt-outs, thinking replay,
tool validation, interrupted streams, malformed frames, fragmented UTF-8,
CRLF boundaries, multiline SSE data, usage, and output-limit handling. The
installed-Claude test uses the actual Workflow launcher and a controlled
upstream to check one-request plain answers, tool execution, and resume across
a fresh gateway process:

```bash
node --test test/deepseek-provider.test.js test/installed-claude-deepseek.test.js
```

The opt-in live test sends only synthetic prompts and temporary fixture files
to DeepSeek. It incurs API usage, limits the number of requests, and verifies
streaming, resume, a real file read/edit, and image recognition:

```bash
CLAUDE_WORKFLOW_LIVE_DEEPSEEK=1 node --test test/installed-claude-deepseek.test.js
```

The test stubs Codex's prerequisite check and makes no Codex inference request.
It does not test delegation or full-window saturation. A live failure is a test
failure, not a successful skip for missing credit or provider availability.

## Troubleshooting

If the wrong model or effort is used, check shell exports, the main-route
settings, and explicit route-map entries before changing the provider default.
The workflow loads `~/.claude-workflow.env` before the legacy `~/.ultrathink.env`.
Project `.env` files are ignored unless explicitly enabled. Restart the session
after a configuration change; reconcile a shared daemon if one is in use.

For authentication or quota failures, check the configured endpoint and the
DeepSeek account's key, credit, and model access. Never include the key in a
bug report. Include the Workflow and Claude Code versions, the selected model,
whether the failure occurred during streaming or a tool call, and the error
message with sensitive content removed.
