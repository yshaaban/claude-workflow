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

Thinking defaults to `max`. Set `ULTRATHINK_GATEWAY_MAIN_REASONING_EFFORT` to
`low`, `high`, or `max` to select another level. Set `ULTRATHINK_THINKING_LEVEL=OFF`
to disable DeepSeek thinking. Workflow does not pin `CLAUDE_CODE_EFFORT_LEVEL`
for DeepSeek. Claude's native mode and availability checks remain Claude-owned;
enabling DeepSeek does not guarantee access to Fable's native Ultracode features.

In thinking mode, `tool_choice: auto` and `none` are preserved. Required and
named choices fail locally because the live API rejects them. Older Pro routes
retain their existing compatibility behavior. Redacted or merged thinking
blocks are rejected when they cannot be replayed faithfully.

Inline and URL images are supported in user messages and image tool results,
including Claude's `Read` tool. Uploaded-file references, documents, and
unsupported content blocks are rejected instead of silently discarded.
DeepSeek's [vision limits](https://api-docs.deepseek.com/guides/vision/) and the
gateway's request-body limit still apply.

## Verification

The account-free suite uses an installed Claude Code binary, the actual Workflow
launcher, and a controlled upstream. It checks one-request plain answers, tool
execution, reasoning replay, and resume across a fresh gateway process:

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

## Integration design

The change is limited to DeepSeek model selection and its protocol contract.
Anthropic, Codex, Kimi, Qwen, permission behavior, credential isolation, and
existing explicit Pro pins remain unchanged. Endpoint/authentication failures
retain the gateway's existing handling; no new retry or inference layer is added.

| Expected change | Policy owner | Verification |
| --- | --- | --- |
| Model ID or context/output limits | `provider-profiles.js` | Configuration and picker tests |
| Thinking/tool/image compatibility | DeepSeek route flags and shared protocol adapter | Translation and installed-Claude tests |
| Setup alias or defaults | Onboarding preset | Config/doctor tests with Claude logged out |

The existing OpenAI transport already owns authentication, streaming, errors,
and cancellation. Reusing it avoids a second transport policy solely for this
release. The implementation adds no dependency, model-rewriting request, or
mutable state owner. Before this change, DeepSeek depended on a tool-call cache
and manual main-route configuration; Flash now uses persisted thinking blocks
and a named preset. The migration order is profile/route, onboarding, contract
tests, live tests, then synchronized release. Full-window behavior and Codex
delegation are outside the DeepSeek live test's evidence.
