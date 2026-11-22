import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { CodexSessionManager } from '../js/gateway/codex-provider.js';
import { estimateCodexRequestTokens } from '../js/gateway/codex-content.js';

const MODEL = 'claude-sonnet-4-7';
const activeSessions = new Set();
let currentStage = 'bootstrap';

function beginStage(name) {
  currentStage = name;
  if (process.env.CODEX_HARDENING_DEBUG === '1') {
    process.stderr.write(`Codex hardening stage: ${name}\n`);
  }
}

function trackManager(manager) {
  const createSession = manager.createSession;
  manager.createSession = function createTrackedSession(...args) {
    const session = createSession(...args);
    activeSessions.add(session);
    return session;
  };
  return manager;
}

function forceKillTrackedAppServers() {
  for (const session of activeSessions) {
    const child = session.connection?.child;
    if (!Number.isInteger(child?.pid)) {
      continue;
    }
    if (process.platform !== 'win32') {
      try {
        process.kill(-child.pid, 'SIGKILL');
        continue;
      } catch {
        // Fall back to the direct child.
      }
    }
    try {
      child.kill('SIGKILL');
    } catch {
      // Best-effort watchdog cleanup.
    }
  }
}

function request(sessionId) {
  const headers = {
    'x-claude-code-session-id': sessionId,
    'x-claude-code-agent-id': 'agent-hardening',
    'x-claude-code-parent-agent-id': 'parent-hardening',
  };
  return {
    get(name) {
      return headers[String(name).toLowerCase()] || '';
    },
  };
}

function route() {
  return {
    provider: 'codex',
    requestedModel: MODEL,
    upstreamModel: 'gpt-5.6-terra',
    sandbox: 'workspace-write',
    approvalPolicy: 'never',
    reasoningEffort: 'max',
    verbosity: 'low',
  };
}

function body(text, tools = []) {
  return {
    model: MODEL,
    messages: [{ role: 'user', content: text }],
    tools,
  };
}

function toolResultBody(callId, content, tools) {
  return {
    model: MODEL,
    messages: [
      { role: 'user', content: 'Run the external tool.' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: callId, name: 'Bash', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: callId, content }],
      },
    ],
    tools,
  };
}

function managerConfig(command, cwd, overrides = {}) {
  return {
    requestTimeoutMs: 2_000,
    codex: {
      command,
      cwd,
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
      idleTimeoutMs: 0,
      forkIdleTimeoutMs: 30,
      closeKillTimeoutMs: 100,
      maxSessions: 16,
      pendingToolTimeoutMs: 1_000,
      ...overrides,
    },
  };
}

async function makeExecutable(filePath, content) {
  await fs.writeFile(filePath, content, { mode: 0o755 });
  await fs.chmod(filePath, 0o755);
}

async function waitFor(check, description, timeoutMs = 2_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise(function pause(resolve) {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function readJsonLines(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return text
      .split('\n')
      .filter(Boolean)
      .map(function parse(line) {
        return JSON.parse(line);
      });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function finalAppServer(
  logPath,
  userAgent =
    'claude_workflow_gateway/0.171.0 (Mac OS 26.4.0; arm64) ' +
    'iTerm.app/3.6.10 (claude_workflow_gateway; 0.1.0)'
) {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const logPath = ${JSON.stringify(logPath)};
if (process.argv[2] === 'debug' && process.argv[3] === 'models') {
  process.stdout.write(JSON.stringify({ models: [{ slug: 'gpt-5.6-terra', context_window: 272000 }] }));
  process.exit(0);
}
function log(value) { fs.appendFileSync(logPath, JSON.stringify(value) + '\\n'); }
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
log({
  event: 'process',
  cwd: process.cwd(),
  pid: process.pid,
  hasKimiApiKey: Object.hasOwn(process.env, 'KIMI_API_KEY'),
  hasDeepSeekApiKey: Object.hasOwn(process.env, 'DEEPSEEK_API_KEY'),
  hasGlmApiKey: Object.hasOwn(process.env, 'GLM_API_KEY'),
  hasOpenAiApiKey: Object.hasOwn(process.env, 'OPENAI_API_KEY'),
  hasZaiApiKey: Object.hasOwn(process.env, 'ZAI_API_KEY'),
  hasGatewayKimiApiKey: Object.hasOwn(process.env, 'ULTRATHINK_GATEWAY_KIMI_API_KEY'),
  qwenCredentialCount: [
    'BAILIAN_TOKEN_PLAN_API_KEY',
    'DASHSCOPE_API_KEY',
    'QWEN_API_KEY',
    'ULTRATHINK_GATEWAY_QWEN_API_KEY'
  ].filter((name) => Object.hasOwn(process.env, name)).length,
  hasGatewaySharedSecret: Object.hasOwn(process.env, 'ULTRATHINK_GATEWAY_SHARED_SECRET'),
  hasAnthropicAuthToken: Object.hasOwn(process.env, 'ANTHROPIC_AUTH_TOKEN'),
  hasAnthropicApiKey: Object.hasOwn(process.env, 'ANTHROPIC_API_KEY')
});
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', function onLine(line) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: ${JSON.stringify(userAgent)} } });
    return;
  }
  if (message.method === 'config/read') {
    log({ event: 'config_read', params: message.params });
    send({ id: message.id, result: { layers: [{
      name: { type: 'user', file: '/private/codex/config.toml', profile: null },
      config: {
        mcp_servers: { 'configured.server.with.dots': { command: '/usr/bin/false' } },
        plugins: { 'configured-plugin@test': { enabled: true } }
      }
    }] } });
    return;
  }
  if (message.method === 'thread/start') {
    log({
      event: 'thread',
      cwd: message.params.cwd,
      environments: message.params.environments,
      selectedCapabilityRoots: message.params.selectedCapabilityRoots,
      dynamicTools: message.params.dynamicTools,
      config: message.params.config
    });
    send({ id: message.id, result: { thread: { id: 'thread-' + process.pid } } });
    return;
  }
  if (message.method === 'turn/start') {
    log({ event: 'turn', effort: message.params.effort });
    const turnId = 'turn-' + process.pid;
    send({ id: message.id, result: { turn: { id: turnId } } });
    setTimeout(function complete() {
      send({ method: 'item/agentMessage/delta', params: { turnId, itemId: 'message', delta: 'DONE' } });
      send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });
    }, 10);
  }
});
setInterval(function keepAlive() {}, 1000);
`;
}

function toolAppServer(logPath) {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const logPath = ${JSON.stringify(logPath)};
function log(value) { fs.appendFileSync(logPath, JSON.stringify(value) + '\\n'); }
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
function sendBatch(values) { process.stdout.write(values.map((value) => JSON.stringify(value) + '\\n').join('')); }
log({ event: 'process', pid: process.pid });
let turnId = '';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', function onLine(line) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'codex_cli_rs/0.144.1' } });
    return;
  }
  if (message.method === 'thread/start') {
    send({ id: message.id, result: { thread: { id: 'thread-' + process.pid } } });
    return;
  }
  if (message.method === 'turn/start') {
    turnId = 'turn-' + process.pid;
    log({ event: 'turn_input', input: message.params.input });
    sendBatch([
      { id: message.id, result: { turn: { id: turnId } } },
      { id: 900, method: 'item/tool/call', params: {
        turnId,
        callId: 'call_pending',
        tool: 'ext_tool_001',
        arguments: { command: 'printf hardening' }
      } },
      { method: 'thread/tokenUsage/updated', params: {
        turnId,
        tokenUsage: { last: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }
      } },
    ]);
    return;
  }
  if (message.id === 900 && message.result) {
    log({ event: 'tool_result', pid: process.pid, text: message.result.contentItems?.[0]?.text, success: message.result.success });
    setImmediate(function complete() {
      send({ method: 'item/agentMessage/delta', params: { turnId, itemId: 'message', delta: 'CONTINUED' } });
      send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });
    });
  }
});
setInterval(function keepAlive() {}, 1000);
`;
}

function closedStdinAppServer() {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
const rl = readline.createInterface({ input: process.stdin });
rl.once('line', function onInitialize(line) {
  const message = JSON.parse(line);
  send({ id: message.id, result: { userAgent: 'codex_cli_rs/0.144.1' } });
  setImmediate(function closeInput() {
    rl.close();
    fs.closeSync(0);
  });
});
setInterval(function keepAlive() {}, 1000);
`;
}

function coalescedStreamingAppServer() {
  return `#!/usr/bin/env node
const readline = require('node:readline');
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
function sendBatch(values) { process.stdout.write(values.map((value) => JSON.stringify(value) + '\\n').join('')); }
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', function onLine(line) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'codex_cli_rs/0.144.1' } });
    return;
  }
  if (message.method === 'thread/start') {
    send({ id: message.id, result: { thread: { id: 'thread-coalesced-stream' } } });
    return;
  }
  if (message.method === 'turn/start') {
    const turnId = 'turn-coalesced-stream';
    sendBatch([
      { id: message.id, result: { turn: { id: turnId } } },
      { method: 'item/agentMessage/delta', params: { turnId, itemId: 'message', delta: 'COALESCED_STREAM' } },
      { method: 'thread/tokenUsage/updated', params: { turnId, tokenUsage: { last: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } } } },
      { method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } },
    ]);
  }
});
setInterval(function keepAlive() {}, 1000);
`;
}

function phaseAwareAppServer() {
  return `#!/usr/bin/env node
const readline = require('node:readline');
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
function sendBatch(values) { process.stdout.write(values.map((value) => JSON.stringify(value) + '\\n').join('')); }
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', function onLine(line) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'codex_cli_rs/0.144.1' } });
    return;
  }
  if (message.method === 'thread/start') {
    send({ id: message.id, result: { thread: { id: 'thread-' + process.pid } } });
    return;
  }
  if (message.method !== 'turn/start') {
    return;
  }

  const turnId = 'turn-' + process.pid;
  const input = message.params.input[0].text;
  const events = [{ id: message.id, result: { turn: { id: turnId } } }];
  if (input.includes('phase-aware-case')) {
    events.push(
      { method: 'item/started', params: { turnId, item: {
        id: 'commentary', type: 'agentMessage', phase: 'commentary', text: ''
      } } },
      { method: 'item/agentMessage/delta', params: {
        turnId, itemId: 'commentary', delta: 'INTERNAL_COMMENTARY'
      } },
      { method: 'item/completed', params: { turnId, item: {
        id: 'commentary', type: 'agentMessage', phase: 'commentary', text: 'INTERNAL_COMMENTARY'
      } } },
      { method: 'item/started', params: { turnId, item: {
        id: 'superseded-final', type: 'agentMessage', phase: 'final_answer', text: ''
      } } },
      { method: 'item/agentMessage/delta', params: {
        turnId, itemId: 'superseded-final', delta: 'SUPERSEDED_FINAL'
      } },
      { method: 'item/completed', params: { turnId, item: {
        id: 'superseded-final', type: 'agentMessage', phase: 'final_answer', text: 'SUPERSEDED_FINAL'
      } } },
      { method: 'item/completed', params: { turnId, item: {
        id: 'legacy-after-final', type: 'agentMessage', text: 'LEGACY_MUST_NOT_REPLACE_FINAL'
      } } },
      { method: 'item/started', params: { turnId, item: {
        id: 'final', type: 'agentMessage', phase: 'final_answer', text: ''
      } } },
      { method: 'item/agentMessage/delta', params: {
        turnId, itemId: 'final', delta: 'DIRECT_FINAL'
      } },
      { method: 'item/completed', params: { turnId, item: {
        id: 'final', type: 'agentMessage', text: 'DIRECT_FINAL'
      } } }
    );
  } else if (input.includes('legacy-stream-case')) {
    events.push(
      { method: 'item/agentMessage/delta', params: {
        turnId, itemId: 'legacy', delta: 'LEGACY_DIRECT'
      } },
      { method: 'item/completed', params: { turnId, item: {
        id: 'legacy', type: 'agentMessage', text: 'LEGACY_DIRECT'
      } } }
    );
  } else if (input.includes('legacy-selection-case')) {
    events.push(
      { method: 'item/completed', params: { turnId, item: {
        id: 'legacy-first', type: 'agentMessage', text: 'LEGACY_FIRST'
      } } },
      { method: 'item/completed', params: { turnId, item: {
        id: 'legacy-last', type: 'agentMessage', text: 'LEGACY_LAST'
      } } }
    );
  } else if (input.includes('commentary-only-case')) {
    events.push(
      { method: 'item/started', params: { turnId, item: {
        id: 'commentary-only', type: 'agentMessage', phase: 'commentary', text: ''
      } } },
      { method: 'item/agentMessage/delta', params: {
        turnId, itemId: 'commentary-only', delta: 'COMMENTARY_ONLY'
      } },
      { method: 'item/completed', params: { turnId, item: {
        id: 'commentary-only', type: 'agentMessage', phase: 'commentary', text: 'COMMENTARY_ONLY'
      } } }
    );
  }
  events.push({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });
  sendBatch(events);
});
setInterval(function keepAlive() {}, 1000);
`;
}

function immediateToolAppServer(logPath, terminal = null) {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const logPath = ${JSON.stringify(logPath)};
function log(value) { fs.appendFileSync(logPath, JSON.stringify(value) + '\\n'); }
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
function sendBatch(values) { process.stdout.write(values.map((value) => JSON.stringify(value) + '\\n').join('')); }
let turnId = '';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', function onLine(line) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'codex_cli_rs/0.144.1' } });
    return;
  }
  if (message.method === 'thread/start') {
    log({
      event: 'thread_start',
      experimentalRawEvents: message.params.experimentalRawEvents === true
    });
    send({ id: message.id, result: { thread: { id: 'thread-' + process.pid } } });
    return;
  }
  if (message.method === 'turn/start') {
    turnId = 'turn-' + process.pid;
    sendBatch([
      { id: message.id, result: { turn: { id: turnId } } },
      { method: 'error', params: { turnId: 'other-turn', willRetry: false, error: { message: 'not our failure' } } },
      { method: 'turn/completed', params: { turnId, turn: { id: 'other-turn', status: 'completed' } } },
      { method: 'rawResponse/completed', params: {
        threadId: 'thread-' + process.pid,
        turnId,
        responseId: 'response-built-in-tool',
        usage: { inputTokens: 11, cachedInputTokens: 1, outputTokens: 2, totalTokens: 13 }
      } },
      { method: 'rawResponse/completed', params: {
        threadId: 'thread-' + process.pid,
        turnId,
        responseId: 'response-tool',
        usage: { inputTokens: 19, cachedInputTokens: 4, outputTokens: 3, totalTokens: 22 }
      } },
      { id: 901, method: 'item/tool/call', params: {
        turnId,
        callId: 'call_immediate',
        tool: 'ext_tool_001',
        arguments: { command: 'printf immediate' }
      } }
    ]);
    setTimeout(function emitSeparateParallelCall() {
      send({ id: 902, method: 'item/tool/call', params: {
        turnId,
        callId: 'call_parallel',
        tool: 'ext_tool_001',
        arguments: { command: 'printf parallel' }
      } });
      const terminal = ${JSON.stringify(terminal)};
      if (terminal) {
        if (terminal === 'error') {
          send({ method: 'error', params: { turnId, willRetry: false, error: {
            message: 'context window exceeded', codexErrorInfo: 'contextWindowExceeded'
          } } });
        } else {
          send({ method: 'turn/completed', params: { turn: { id: turnId, status: terminal } } });
        }
        send({ id: 903, method: 'item/tool/call', params: {
          turnId, callId: 'after_end', tool: 'ext_tool_001', arguments: {}
        } });
      } else {
        sendBatch([
          { method: 'error', params: { turnId: 'other-turn', willRetry: false, error: { message: 'not our failure' } } },
          { method: 'turn/completed', params: { turnId, turn: { id: 'other-turn', status: 'completed' } } },
          { method: 'error', params: { turnId, willRetry: true, error: { message: 'reconnecting' } } },
          // The rejection of this unknown RPC acknowledges all three preceding
          // notifications before the test sends a real tool result.
          { id: 904, method: 'fixture/barrier', params: {} }
        ]);
      }
    }, 25);
    return;
  }
  if (message.error) {
    log({ event: 'rpc_rejected', id: message.id });
    return;
  }
  if ((message.id === 901 || message.id === 902) && message.result) {
    log({ event: 'tool_result', text: message.result.contentItems?.[0]?.text });
    if (message.id === 901) return;
    setImmediate(function complete() {
      sendBatch([
        { method: 'rawResponse/completed', params: {
          threadId: 'thread-' + process.pid,
          turnId,
          responseId: 'response-built-in-after-tool',
          usage: { inputTokens: 7, outputTokens: 1, totalTokens: 8 }
        } },
        { method: 'rawResponse/completed', params: {
          threadId: 'thread-' + process.pid,
          turnId,
          responseId: 'response-final',
          usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }
        } },
        { method: 'thread/tokenUsage/updated', params: {
          turnId,
          tokenUsage: {
            total: { inputTokens: 47, cachedInputTokens: 5, outputTokens: 8, totalTokens: 55 },
            last: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }
          }
        } },
        { method: 'item/started', params: { turnId, item: {
          id: 'final', type: 'agentMessage', phase: 'final_answer', text: ''
        } } },
        { method: 'item/agentMessage/delta', params: {
          turnId, itemId: 'final', delta: 'AFTER_TOOL'
        } },
        { method: 'item/completed', params: { turnId, item: {
          id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'AFTER_TOOL'
        } } },
        { method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } }
      ]);
    });
  }
});
setInterval(function keepAlive() {}, 1000);
`;
}

function legacyToolBoundaryAppServer(logPath) {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const logPath = ${JSON.stringify(logPath)};
function log(value) { fs.appendFileSync(logPath, JSON.stringify(value) + '\\n'); }
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
let turnId = '';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', function onLine(line) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'codex_cli_rs/0.143.0' } });
    return;
  }
  if (message.method === 'thread/start') {
    const hasRawEvents = Object.hasOwn(message.params, 'experimentalRawEvents');
    log({ event: 'thread_start', hasRawEvents });
    if (hasRawEvents) {
      send({ id: message.id, error: {
        code: -32602,
        message: 'unknown field experimentalRawEvents'
      } });
      return;
    }
    send({ id: message.id, result: { thread: { id: 'thread-legacy-' + process.pid } } });
    return;
  }
  if (message.method === 'turn/start') {
    turnId = 'turn-legacy-' + process.pid;
    send({ id: message.id, result: { turn: { id: turnId } } });
    send({ id: 911, method: 'item/tool/call', params: {
      turnId,
      callId: 'call_legacy',
      tool: 'ext_tool_001',
      arguments: { command: 'printf legacy' }
    } });
    return;
  }
  if (message.id === 911 && message.result) {
    log({ event: 'tool_result', text: message.result.contentItems?.[0]?.text });
    send({ method: 'item/completed', params: { turnId, item: {
      id: 'legacy-final', type: 'agentMessage', text: 'LEGACY_AFTER_TOOL'
    } } });
    send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });
  }
});
setInterval(function keepAlive() {}, 1000);
`;
}

function structuredOutputRetryAppServer(logPath) {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const logPath = ${JSON.stringify(logPath)};
function log(value) { fs.appendFileSync(logPath, JSON.stringify(value) + '\\n'); }
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
function completeResponse(turnId, responseId) {
  send({ method: 'rawResponse/completed', params: {
    threadId: 'thread-structured',
    turnId,
    responseId,
    usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }
  } });
}
const turnId = 'turn-structured';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', function onLine(line) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'codex_cli_rs/0.145.0' } });
    return;
  }
  if (message.method === 'thread/start') {
    log({ event: 'thread_start' });
    send({ id: message.id, result: { thread: { id: 'thread-structured' } } });
    return;
  }
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: turnId } } });
    completeResponse(turnId, 'response-invalid');
    send({ id: 921, method: 'item/tool/call', params: {
      turnId,
      callId: 'structured_invalid',
      tool: 'StructuredOutput',
      arguments: { answer: 42 }
    } });
    return;
  }
  if (message.id === 921 && message.result) {
    log({ event: 'first_result', success: message.result.success });
    completeResponse(turnId, 'response-corrected');
    send({ id: 922, method: 'item/tool/call', params: {
      turnId,
      callId: 'structured_corrected',
      tool: 'StructuredOutput',
      arguments: { answer: 'corrected' }
    } });
    return;
  }
  if (message.id === 922 && message.result) {
    log({ event: 'second_result', success: message.result.success });
  }
});
setInterval(function keepAlive() {}, 1000);
`;
}

async function testPhaseAwareAgentMessages() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-provider-agent-phases-'));
  const command = path.join(tempDir, 'fake-codex');
  await makeExecutable(command, phaseAwareAppServer());
  const manager = trackManager(new CodexSessionManager(managerConfig(command, tempDir)));
  try {
    const phaseEvents = [];
    const phaseOutcome = await manager.streamRequest(
      request('phase-aware'),
      body('phase-aware-case'),
      route(),
      function collect(event) {
        phaseEvents.push(event);
      }
    );
    assert.equal(phaseOutcome.text, 'DIRECT_FINAL');
    assert.equal(
      phaseEvents.filter((event) => event.type === 'text_delta').map((event) => event.text).join(''),
      'DIRECT_FINAL'
    );
    assert.equal(JSON.stringify(phaseEvents).includes('INTERNAL_COMMENTARY'), false);
    assert.equal(JSON.stringify(phaseEvents).includes('SUPERSEDED_FINAL'), false);
    assert.equal(JSON.stringify(phaseEvents).includes('LEGACY_MUST_NOT_REPLACE_FINAL'), false);

    const legacyEvents = [];
    const legacyOutcome = await manager.streamRequest(
      request('legacy-stream'),
      body('legacy-stream-case'),
      route(),
      function collect(event) {
        legacyEvents.push(event);
      }
    );
    assert.equal(legacyOutcome.text, 'LEGACY_DIRECT');
    assert.equal(
      legacyEvents.filter((event) => event.type === 'text_delta').map((event) => event.text).join(''),
      'LEGACY_DIRECT'
    );

    const selectedLegacyEvents = [];
    const selectedLegacy = await manager.streamRequest(
      request('legacy-selection'),
      body('legacy-selection-case'),
      route(),
      function collect(event) {
        selectedLegacyEvents.push(event);
      }
    );
    assert.equal(selectedLegacy.text, 'LEGACY_LAST');
    assert.equal(
      selectedLegacyEvents
        .filter((event) => event.type === 'text_delta')
        .map((event) => event.text)
        .join(''),
      'LEGACY_LAST'
    );
    assert.equal(JSON.stringify(selectedLegacyEvents).includes('LEGACY_FIRST'), false);

    const commentaryOnly = await manager.processRequest(
      request('commentary-only'),
      body('commentary-only-case'),
      route()
    );
    assert.equal(commentaryOnly.text, '');
  } finally {
    await manager.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function testToolBoundaryCompletesWithoutFixedDelay() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-provider-tool-boundary-'));
  const command = path.join(tempDir, 'fake-codex');
  const logPath = path.join(tempDir, 'app-server.jsonl');
  await makeExecutable(command, immediateToolAppServer(logPath));
  const tools = [
    {
      name: 'Bash',
      description: 'Run a shell command.',
      input_schema: { type: 'object', properties: { command: { type: 'string' } } },
    },
  ];
  const manager = trackManager(new CodexSessionManager(managerConfig(command, tempDir)));
  try {
    const immediateRequest = request('immediate-tool');
    const immediateBody = body('Run the tool immediately.', tools);
    const immediateRoute = route();
    const session = manager.ensureSession(immediateRequest, immediateBody, immediateRoute);
    await session.ensureThread();

    const startedAt = performance.now();
    const first = await manager.processRequest(
      immediateRequest,
      immediateBody,
      immediateRoute
    );
    const elapsedMs = performance.now() - startedAt;
    assert.equal(first.type, 'tool_use');
    assert.equal(first.toolCall.id, 'call_immediate');
    assert.equal(elapsedMs < 1_500, true, `tool boundary took ${elapsedMs}ms`);
    assert.deepEqual(first.usage, {
      input_tokens: 25,
      output_tokens: 5,
      cache_read_input_tokens: 5,
      total_tokens: 35,
    });
    const boundaryEntries = await readJsonLines(logPath);
    assert.equal(
      boundaryEntries.every((entry) => entry.experimentalRawEvents === false),
      true,
      'canonical app-server threads must not request removed experimental raw events'
    );
    await waitFor(async function pendingNotificationsHandled() {
      const entries = await readJsonLines(logPath);
      return entries.some((entry) => entry.event === 'rpc_rejected' && entry.id === 904);
    }, 'parallel tool and non-terminal notifications after the first Claude boundary');

    const second = await manager.processRequest(
      request('immediate-tool'),
      toolResultBody('call_immediate', 'IMMEDIATE_RESULT', tools),
      route()
    );
    assert.equal(second.type, 'tool_use');
    assert.equal(second.toolCall.id, 'call_parallel');
    const continued = await manager.processRequest(
      request('immediate-tool'),
      toolResultBody('call_parallel', 'PARALLEL_RESULT', tools),
      route()
    );
    assert.equal(continued.type, 'final');
    assert.equal(continued.text, 'AFTER_TOOL');
    assert.deepEqual(continued.usage, {
      input_tokens: 17,
      output_tokens: 3,
      total_tokens: 20,
    });
    const entries = await readJsonLines(logPath);
    const results = entries.filter((entry) => entry.event === 'tool_result');
    assert.deepEqual(results.map((entry) => entry.text), ['IMMEDIATE_RESULT', 'PARALLEL_RESULT']);
  } finally {
    await manager.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function testLegacyToolBoundaryCompletesWithoutRawEvents() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-provider-legacy-boundary-'));
  const command = path.join(tempDir, 'fake-codex');
  const logPath = path.join(tempDir, 'app-server.jsonl');
  await makeExecutable(command, legacyToolBoundaryAppServer(logPath));
  const tools = [
    {
      name: 'Bash',
      description: 'Run a shell command.',
      input_schema: { type: 'object', properties: { command: { type: 'string' } } },
    },
  ];
  const manager = trackManager(new CodexSessionManager(managerConfig(command, tempDir)));
  try {
    const legacyRequest = request('legacy-tool');
    const legacyBody = body('Run the legacy tool.', tools);
    const legacyRoute = route();
    const session = manager.ensureSession(legacyRequest, legacyBody, legacyRoute);
    await session.ensureThread();

    const startedAt = performance.now();
    const first = await manager.processRequest(
      legacyRequest,
      legacyBody,
      legacyRoute
    );
    const elapsedMs = performance.now() - startedAt;
    assert.equal(first.type, 'tool_use');
    assert.equal(first.toolCall.id, 'call_legacy');
    assert.equal(elapsedMs < 1_000, true, `legacy tool boundary took ${elapsedMs}ms`);

    const threadStarts = (await readJsonLines(logPath)).filter(
      (entry) => entry.event === 'thread_start'
    );
    assert.deepEqual(threadStarts.map((entry) => entry.hasRawEvents), [false]);

    const continued = await manager.processRequest(
      request('legacy-tool'),
      toolResultBody('call_legacy', 'LEGACY_RESULT', tools),
      route()
    );
    assert.equal(continued.type, 'final');
    assert.equal(continued.text, 'LEGACY_AFTER_TOOL');
    const entries = await readJsonLines(logPath);
    assert.deepEqual(
      entries.filter((entry) => entry.event === 'tool_result').map((entry) => entry.text),
      ['LEGACY_RESULT']
    );
  } finally {
    await manager.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function testStructuredOutputSchemaRetryStaysOnLiveTurn() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-provider-structured-retry-'));
  const command = path.join(tempDir, 'fake-codex');
  const logPath = path.join(tempDir, 'app-server.jsonl');
  await makeExecutable(command, structuredOutputRetryAppServer(logPath));
  const tools = [
    {
      name: 'StructuredOutput',
      description: 'Return the typed result.',
      input_schema: {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
        additionalProperties: false,
      },
    },
  ];
  const manager = trackManager(new CodexSessionManager(managerConfig(command, tempDir)));
  try {
    const initialBody = body('Return the typed result.', tools);
    const invalid = await manager.processRequest(
      request('structured-retry'),
      initialBody,
      route()
    );
    assert.deepEqual(invalid.toolCall, {
      id: 'structured_invalid',
      name: 'StructuredOutput',
      input: { answer: 42 },
    });
    assert.equal(manager.sessions.size, 1);

    const corrected = await manager.processRequest(
      request('structured-retry'),
      {
        model: MODEL,
        messages: [
          ...initialBody.messages,
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'structured_invalid',
                name: 'StructuredOutput',
                input: { answer: 42 },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'structured_invalid',
                is_error: true,
                content: 'answer must be a string',
              },
            ],
          },
        ],
        tools,
      },
      route()
    );
    assert.deepEqual(corrected.toolCall, {
      id: 'structured_corrected',
      name: 'StructuredOutput',
      input: { answer: 'corrected' },
    });
    assert.equal(manager.sessions.size, 1);

    const entries = await readJsonLines(logPath);
    assert.equal(entries.filter((entry) => entry.event === 'thread_start').length, 1);
    assert.deepEqual(
      entries.filter((entry) => entry.event === 'first_result').map((entry) => entry.success),
      [false]
    );
  } finally {
    await manager.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function testCoalescedStreamingEvents() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-provider-coalesced-stream-'));
  const command = path.join(tempDir, 'fake-codex');
  await makeExecutable(command, coalescedStreamingAppServer());
  const manager = trackManager(new CodexSessionManager(managerConfig(command, tempDir)));
  const events = [];
  try {
    const outcome = await manager.streamRequest(
      request('coalesced-stream'),
      body('Stream an immediate response.'),
      route(),
      function collect(event) {
        events.push(event);
      }
    );
    assert.equal(outcome.type, 'final');
    assert.equal(outcome.text, 'COALESCED_STREAM');
    assert.deepEqual(events.map((event) => event.type), ['usage', 'text_delta', 'boundary']);
    assert.equal(events[1].text, 'COALESCED_STREAM');
    assert.equal(events.at(-1).outcome.text, 'COALESCED_STREAM');
  } finally {
    await manager.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function testDynamicToolsOnlyThreadMode() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-provider-environments-'));
  const command = path.join(tempDir, 'fake-codex');
  const logPath = path.join(tempDir, 'app-server.jsonl');
  await makeExecutable(command, finalAppServer(logPath));

  const previousKimiApiKey = process.env.KIMI_API_KEY;
  const previousGatewayKimiApiKey = process.env.ULTRATHINK_GATEWAY_KIMI_API_KEY;
  const previousGatewaySharedSecret = process.env.ULTRATHINK_GATEWAY_SHARED_SECRET;
  const previousAnthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const previousAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
  const previousDeepSeekApiKey = process.env.DEEPSEEK_API_KEY;
  const previousGlmApiKey = process.env.GLM_API_KEY;
  const previousOpenAiApiKey = process.env.OPENAI_API_KEY;
  const previousZaiApiKey = process.env.ZAI_API_KEY;
  const qwenCredentials = {
    BAILIAN_TOKEN_PLAN_API_KEY: 'sk-sp-test-bailian-app-server-key',
    DASHSCOPE_API_KEY: 'test-dashscope-app-server-key',
    QWEN_API_KEY: 'sk-sp-test-qwen-fallback-app-server-key',
    ULTRATHINK_GATEWAY_QWEN_API_KEY: 'sk-sp-test-qwen-app-server-key',
  };
  const previousQwenCredentials = Object.fromEntries(
    Object.keys(qwenCredentials).map((name) => [name, process.env[name]])
  );
  process.env.KIMI_API_KEY = 'test-kimi-app-server-fallback-key';
  process.env.ULTRATHINK_GATEWAY_KIMI_API_KEY = 'test-kimi-app-server-key';
  process.env.ULTRATHINK_GATEWAY_SHARED_SECRET = 'test-gateway-shared-secret';
  process.env.ANTHROPIC_AUTH_TOKEN = 'test-anthropic-app-server-token';
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-app-server-key';
  process.env.DEEPSEEK_API_KEY = 'test-deepseek-app-server-key';
  process.env.GLM_API_KEY = 'test-glm-app-server-key';
  process.env.OPENAI_API_KEY = 'test-openai-app-server-key';
  process.env.ZAI_API_KEY = 'test-zai-app-server-key';
  Object.assign(process.env, qwenCredentials);

  const configuredManager = trackManager(
    new CodexSessionManager(managerConfig(command, tempDir, { dynamicToolsOnly: false }))
  );
  const dynamicOnlyManager = trackManager(
    new CodexSessionManager(managerConfig(command, tempDir, { dynamicToolsOnly: true }))
  );
  try {
    await configuredManager.processRequest(request('configured-cwd'), body('Configured cwd.'), route());
    await dynamicOnlyManager.processRequest(
      request('dynamic-only'),
      body('Dynamic tools only.', [
        {
          name: 'Read',
          description: 'Read a bounded file range.',
          input_schema: {
            type: 'object',
            properties: { file_path: { type: 'string' } },
            required: ['file_path'],
          },
        },
      ]),
      route()
    );

    const threadStarts = (await readJsonLines(logPath)).filter(function thread(entry) {
      return entry.event === 'thread';
    });
    assert.equal(threadStarts.length, 2);
    const turns = (await readJsonLines(logPath)).filter(function turn(entry) {
      return entry.event === 'turn';
    });
    assert.equal(turns.length, 2);
    assert.equal(Object.hasOwn(threadStarts[0], 'environments'), false);
    assert.deepEqual(threadStarts[1].environments, []);
    assert.equal(Object.hasOwn(threadStarts[0], 'selectedCapabilityRoots'), false);
    assert.deepEqual(threadStarts[1].selectedCapabilityRoots, []);
    assert.deepEqual(
      threadStarts[1].dynamicTools.map((tool) => tool.name),
      ['ext_tool_001']
    );
    const configReads = (await readJsonLines(logPath)).filter(function configRead(entry) {
      return entry.event === 'config_read';
    });
    assert.equal(configReads.length, 1);
    assert.deepEqual(configReads[0].params, { cwd: tempDir, includeLayers: true });
    const isolationConfig = threadStarts[1].config;
    assert.equal(isolationConfig['agents.enabled'], false);
    assert.equal(isolationConfig['orchestrator.skills.enabled'], false);
    assert.equal(isolationConfig['orchestrator.mcp.enabled'], false);
    assert.equal(isolationConfig['memories.use_memories'], false);
    assert.equal(isolationConfig['memories.dedicated_tools'], false);
    assert.deepEqual(isolationConfig['features.code_mode'], {
      enabled: false,
      direct_only_tool_namespaces: ['functions'],
    });
    assert.deepEqual(isolationConfig['features.current_time_reminder'], {
      enabled: false,
      sleep_tool: false,
    });
    assert.equal(isolationConfig['features.memories'], false);
    assert.equal(isolationConfig['features.context_management'], false);
    assert.equal(isolationConfig['features.sleep_tool'], false);
    assert.equal(Object.hasOwn(isolationConfig, 'features.memory_tool'), false);
    assert.equal(Object.hasOwn(isolationConfig, 'features.write_stdin_approval'), false);
    assert.deepEqual(isolationConfig.mcp_servers, {
      'configured.server.with.dots': { enabled: false },
    });
    assert.deepEqual(isolationConfig.plugins, {
      'configured-plugin@test': { enabled: false },
    });
    assert.equal(turns[0].effort, 'max');
    assert.equal(turns[1].effort, 'max');
    assert.equal(threadStarts[0].config.model_verbosity, 'low');
    assert.equal(threadStarts[1].config.model_verbosity, 'low');
    const processes = (await readJsonLines(logPath)).filter(function processEntry(entry) {
      return entry.event === 'process';
    });
    assert.equal(processes.length, 2);
    assert.equal(processes.every((entry) => entry.hasKimiApiKey === false), true);
    assert.equal(processes.every((entry) => entry.hasGatewayKimiApiKey === false), true);
    assert.equal(processes.every((entry) => entry.hasGatewaySharedSecret === false), true);
    assert.equal(processes.every((entry) => entry.hasAnthropicAuthToken === false), true);
    assert.equal(processes.every((entry) => entry.hasAnthropicApiKey === false), true);
    assert.equal(processes.every((entry) => entry.hasDeepSeekApiKey === false), true);
    assert.equal(processes.every((entry) => entry.hasGlmApiKey === false), true);
    assert.equal(processes.every((entry) => entry.hasOpenAiApiKey === false), true);
    assert.equal(processes.every((entry) => entry.hasZaiApiKey === false), true);
    assert.equal(processes.every((entry) => entry.qwenCredentialCount === 0), true);
  } finally {
    await Promise.all([configuredManager.close(), dynamicOnlyManager.close()]);
    if (previousKimiApiKey === undefined) {
      delete process.env.KIMI_API_KEY;
    } else {
      process.env.KIMI_API_KEY = previousKimiApiKey;
    }
    if (previousGatewayKimiApiKey === undefined) {
      delete process.env.ULTRATHINK_GATEWAY_KIMI_API_KEY;
    } else {
      process.env.ULTRATHINK_GATEWAY_KIMI_API_KEY = previousGatewayKimiApiKey;
    }
    if (previousGatewaySharedSecret === undefined) {
      delete process.env.ULTRATHINK_GATEWAY_SHARED_SECRET;
    } else {
      process.env.ULTRATHINK_GATEWAY_SHARED_SECRET = previousGatewaySharedSecret;
    }
    if (previousAnthropicAuthToken === undefined) {
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    } else {
      process.env.ANTHROPIC_AUTH_TOKEN = previousAnthropicAuthToken;
    }
    if (previousAnthropicApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = previousAnthropicApiKey;
    }
    for (const [name, value] of [
      ['DEEPSEEK_API_KEY', previousDeepSeekApiKey],
      ['GLM_API_KEY', previousGlmApiKey],
      ['OPENAI_API_KEY', previousOpenAiApiKey],
      ['ZAI_API_KEY', previousZaiApiKey],
      ...Object.entries(previousQwenCredentials),
    ]) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function testDynamicToolsOnlyVersionGate() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-provider-version-'));
  const command = path.join(tempDir, 'fake-codex-old');
  const logPath = path.join(tempDir, 'app-server.jsonl');
  await makeExecutable(
    command,
    finalAppServer(
      logPath,
      'claude_workflow_gateway/0.143.0 (Linux 6.6; x86_64) ' +
        'terminal/999.0.0 (claude_workflow_gateway; 0.1.0)'
    )
  );
  const manager = trackManager(
    new CodexSessionManager(managerConfig(command, tempDir, { dynamicToolsOnly: true }))
  );
  try {
    await assert.rejects(
      manager.processRequest(request('old-dynamic-only'), body('Reject old Codex.'), route()),
      /requires Codex CLI 0\.171\.0 or newer/u
    );
  } finally {
    await manager.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function testPendingToolRetentionAndHardCapacity() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-provider-pending-'));
  const command = path.join(tempDir, 'fake-codex');
  const logPath = path.join(tempDir, 'app-server.jsonl');
  await makeExecutable(command, toolAppServer(logPath));
  const tools = [
    {
      name: 'Bash',
      description: 'Run a shell command.',
      input_schema: { type: 'object', properties: { command: { type: 'string' } } },
    },
  ];
  const manager = trackManager(
    new CodexSessionManager(
      managerConfig(command, tempDir, {
        idleTimeoutMs: 15,
        forkIdleTimeoutMs: 15,
        pendingToolTimeoutMs: 500,
        maxSessions: 1,
      })
    )
  );

  try {
    const pendingRequest = request('pending-session');
    const pendingBody = body('Run the external tool.', tools);
    const pendingRoute = route();
    const session = manager.ensureSession(pendingRequest, pendingBody, pendingRoute);
    await session.ensureThread();

    const startedAt = performance.now();
    const first = await manager.processRequest(
      pendingRequest,
      pendingBody,
      pendingRoute
    );
    const elapsedMs = performance.now() - startedAt;
    assert.equal(first.type, 'tool_use');
    assert.equal(first.toolCall.id, 'call_pending');
    assert.equal(
      elapsedMs < 1_500,
      true,
      `token-usage tool boundary fell through to the legacy timer after ${elapsedMs}ms`
    );

    await new Promise(function waitPastIdle(resolve) {
      setTimeout(resolve, 60);
    });
    assert.equal(manager.sessions.size, 1, 'pending tool call expired on the ordinary idle timer');

    await assert.rejects(
      manager.processRequest(request('capacity-session'), body('A second session.', tools), route()),
      function atCapacity(error) {
        return error?.status === 503 && /max_sessions=1/u.test(error.message);
      }
    );
    assert.equal(manager.sessions.size, 1);
    const processesBeforeContinuation = (await readJsonLines(logPath)).filter(function processEntry(entry) {
      return entry.event === 'process';
    });
    assert.equal(processesBeforeContinuation.length, 1, 'capacity rejection spawned another app-server');

    const continued = await manager.processRequest(
      request('pending-session'),
      toolResultBody('call_pending', 'TOOL_RESULT_OK', tools),
      route()
    );
    assert.equal(continued.type, 'final');
    assert.equal(continued.text, 'CONTINUED');
    const toolResults = (await readJsonLines(logPath)).filter(function result(entry) {
      return entry.event === 'tool_result';
    });
    assert.deepEqual(toolResults.map(function text(entry) { return entry.text; }), ['TOOL_RESULT_OK']);
  } finally {
    await manager.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function testCappedImageResultRecovery() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-capped-image-'));
  const command = path.join(dir, 'fake-codex');
  const log = path.join(dir, 'events.jsonl');
  const manager = trackManager(new CodexSessionManager(managerConfig(command, dir, {
    toolResultMaxBytes: 2048, toolResultWindowMaxBytes: 160,
  })));
  try {
    await makeExecutable(command, toolAppServer(log));
    const tools = [{ name: 'Bash', input_schema: { type: 'object' } }];
    const transcript = body('Run the tool.', tools);
    const run = () => manager.processRequest(request('images'), structuredClone(transcript), route());
    for (const content of ['x'.repeat(96), [
      { type: 'text', text: 'PRIVATE_IMAGE_RESULT' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWFh'.repeat(20) } },
    ]]) {
      const call = await run();
      transcript.messages.push(
        { role: 'assistant', content: [{ type: 'tool_use', ...call.toolCall }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.toolCall.id, content }] }
      );
      const result = await run();
      assert.equal(result.text, 'CONTINUED');
      transcript.messages.push({ role: 'assistant', content: result.text }, { role: 'user', content: 'Continue.' });
    }
    const outputs = (await readJsonLines(log)).filter(e => e.event === 'tool_result');
    assert.deepEqual(outputs.map(e => e.success), [true, false]);
    assert.match(outputs[1].text, /^Image omitted:/u);
    assert.ok(Buffer.byteLength(outputs[1].text) <= 64);
    await manager.processRequest(request('images-replay'), transcript, route());
    const replay = (await readJsonLines(log)).filter(e => e.event === 'turn_input').at(-1).input;
    assert.deepEqual(replay.map(part => part.type), ['text']);
    assert.ok(replay[0].text.includes('[tool_result call_pending error]\n' + outputs[1].text));
    assert.doesNotMatch(replay[0].text, /PRIVATE_IMAGE_RESULT|YWFh/u);
  } finally {
    await manager.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function testUnsupportedToolResults() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-unsupported-tool-results-'));
  const command = path.join(dir, 'fake-codex');
  const log = path.join(dir, 'events.jsonl');
  const manager = trackManager(new CodexSessionManager(managerConfig(command, dir)));
  try {
    await makeExecutable(command, toolAppServer(log));
    const tools = [{ name: 'Read', input_schema: { type: 'object' } }];
    const cases = [
      { type: 'image', source: { type: 'url', url: 'https://example.invalid/PRIVATE_TOOL_DATA' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '**PRIVATE_TOOL_DATA**' } },
      { type: 'resource', resource: { uri: 'file:///PRIVATE_TOOL_DATA', text: 'do not expose' } },
      { type: 'tool_reference', tool_name: null },
    ];
    const history = [];
    for (const [index, unsupported] of cases.entries()) {
      const req = request('unsupported-' + index);
      const transcript = body('Call the tool.', tools);
      const call = await manager.processRequest(req, transcript, route());
      const continuation = { ...transcript, messages: [...transcript.messages,
        { role: 'assistant', content: [{ type: 'tool_use', ...call.toolCall }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.toolCall.id,
          content: [{ type: 'text', text: 'PRIVATE_TOOL_DATA' }, unsupported] }] },
      ] };
      assert.equal((await manager.processRequest(req, continuation, route())).text, 'CONTINUED');
      const result = (await readJsonLines(log)).filter(e => e.event === 'tool_result').at(-1);
      assert.equal(result.success, false);
      assert.match(result.text, /No content was forwarded/u);
      assert.doesNotMatch(result.text, /PRIVATE_TOOL_DATA/u);
      history.push(...continuation.messages);
    }
    await manager.processRequest(request('unsupported-replay'), {
      ...body('Continue.', tools), messages: [...history, { role: 'user', content: 'Continue.' }],
    }, route());
    const replay = (await readJsonLines(log)).filter(e => e.event === 'turn_input').at(-1).input;
    assert.deepEqual(replay.map(part => part.type), ['text']);
    assert.equal(replay[0].text.match(/No content was forwarded/gu)?.length, cases.length);
    assert.doesNotMatch(replay[0].text, /PRIVATE_TOOL_DATA/u);
  } finally {
    await manager.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function testPdfToolResultRecovery() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-pdf-recovery-'));
  const command = path.join(tempDir, 'fake-codex');
  const logPath = path.join(tempDir, 'app-server.jsonl');
  const manager = trackManager(new CodexSessionManager(managerConfig(command, tempDir)));
  try {
    await makeExecutable(command, toolAppServer(logPath));
    const tools = [{ name: 'Read', input_schema: { type: 'object' } }];
    // This is the wire shape Claude Read uses for a whole PDF (not a pages read).
    const pdf = { type: 'document', source: {
      type: 'base64', media_type: 'application/pdf', data: 'JVBERi0xLjQK'.repeat(10_000),
    } };
    const attachment = { model: MODEL, messages: [{ role: 'user', content: [pdf] }], tools };
    await assert.rejects(manager.processRequest(request('pdf-attachment'), attachment, route()),
      error => error.status === 400 && /direct document attachments/u.test(error.message));
    assert.throws(() => estimateCodexRequestTokens(attachment), /direct document attachments/u);
    assert.deepEqual(await readJsonLines(logPath), [], 'no app-server process for invalid attachments');

    const firstBody = body('Read the PDF.', tools);
    const first = await manager.processRequest(request('pdf-live'), firstBody, route());
    assert.equal(first.toolCall.name, 'Read');
    const continuation = { ...firstBody, messages: [...firstBody.messages,
      { role: 'assistant', content: [{ type: 'tool_use', ...first.toolCall }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: first.toolCall.id,
        content: [{ type: 'text', text: 'PDF file read: example.pdf' }, pdf] }] },
    ] };
    assert.ok(estimateCodexRequestTokens(continuation) < 1000, 'unused PDF transport bytes are not model input');
    const last = await manager.processRequest(request('pdf-live'), continuation, route());
    assert.equal(last.text, 'CONTINUED');
    const forwarded = (await readJsonLines(logPath)).find(event => event.event === 'tool_result');
    assert.equal(forwarded.success, false);
    assert.match(forwarded.text, /No PDF content was forwarded.+Read.+pages range/u);
    assert.doesNotMatch(forwarded.text, /JVBERi|PDF file read/u);

    // A new session rebuilding full Claude history must see the same result.
    const replay = { ...continuation, messages: [...continuation.messages,
      { role: 'assistant', content: 'I need the pages.' }, { role: 'user', content: 'Continue.' }] };
    await manager.processRequest(request('pdf-replay'), replay, route());
    const { input } = (await readJsonLines(logPath)).filter(event => event.event === 'turn_input').at(-1);
    assert.ok(input[0].text.includes('[tool_result call_pending error]\n' + forwarded.text));
    assert.doesNotMatch(input[0].text, /JVBERi|PDF file read/u);
  } finally {
    await manager.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function testTerminatedTurnDoesNotReplayTools() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-terminal-tool-'));
  try {
    const tools = [{ name: 'Bash', input_schema: { type: 'object' } }];
    for (const terminal of ['completed', 'failed', 'interrupted', 'error']) {
      const command = path.join(directory, 'fake-' + terminal);
      const log = path.join(directory, terminal + '.jsonl');
      await makeExecutable(command, immediateToolAppServer(log, terminal));
      const manager = trackManager(new CodexSessionManager(managerConfig(command, directory, { maxSessions: 1 })));
      try {
        const req = request('ended-' + terminal);
        const initial = body('Run the tool immediately.', tools);
        const exposed = await manager.processRequest(req, initial, route());
        assert.equal(exposed.toolCall.id, 'call_immediate');
        await waitFor(async () => (await readJsonLines(log)).some(e => e.event === 'rpc_rejected' && e.id === 903),
          'confirmation of the terminal notification and rejected late call');
        // Neither a continuation nor retrying the previously delivered response
        // may send a stale result, expose call_parallel, or repeat the first tool.
        for (const retry of [toolResultBody(exposed.toolCall.id, 'already ran', tools), initial]) {
          await assert.rejects(manager.processRequest(req, retry, route()),
            error => error.status === 400 && /tool may already have run/u.test(error.message));
        }
        const events = await readJsonLines(log);
        assert.deepEqual(events.filter(e => e.event === 'rpc_rejected').map(e => e.id), [901, 902, 903]);
        assert.equal(events.filter(e => e.event === 'thread_start').length, 1);
        assert.equal(events.some(e => e.event === 'tool_result'), false);
        const newWork = await manager.processRequest(req, body('Start a different task.', tools), route());
        assert.equal(newWork.type, 'tool_use', 'terminal calls must not block independent work at capacity');
      } finally {
        await manager.close();
      }
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function testPendingToolTimeout() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-provider-pending-timeout-'));
  const command = path.join(tempDir, 'fake-codex');
  const logPath = path.join(tempDir, 'app-server.jsonl');
  await makeExecutable(command, toolAppServer(logPath));
  const tools = [{ name: 'Bash', description: 'Run.', input_schema: { type: 'object' } }];
  const manager = trackManager(
    new CodexSessionManager(
      managerConfig(command, tempDir, {
        idleTimeoutMs: 5,
        pendingToolTimeoutMs: 50,
        maxSessions: 1,
      })
    )
  );

  try {
    const outcome = await manager.processRequest(
      request('pending-timeout'),
      body('Leave the tool pending.', tools),
      route()
    );
    assert.equal(outcome.type, 'tool_use');
    await waitFor(
      function expired() {
        return manager.sessions.size === 0;
      },
      'pending tool timeout'
    );
    await manager.close();
    const processes = (await readJsonLines(logPath)).filter((entry) => entry.event === 'process');
    assert.equal(processes.length, 1);
    await waitFor(
      function appServerExited() {
        return !processExists(processes[0].pid);
      },
      'pending-timeout app-server exit'
    );
  } finally {
    await manager.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function testStdinEpipeDoesNotCrashGateway() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-provider-epipe-'));
  const command = path.join(tempDir, 'fake-codex');
  await makeExecutable(command, closedStdinAppServer());
  const manager = trackManager(new CodexSessionManager(managerConfig(command, tempDir)));

  try {
    await assert.rejects(
      manager.processRequest(request('stdin-epipe'), body('Trigger EPIPE.'), route()),
      /stdin failed|EPIPE|not available|timed out while waiting for thread\/start/u
    );
    await waitFor(
      function evicted() {
        return manager.sessions.size === 0;
      },
      'EPIPE session eviction'
    );
  } finally {
    await manager.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function testProviderInChildProcess() {
  if (process.argv.includes('--epipe-child')) {
    await testStdinEpipeDoesNotCrashGateway();
    return true;
  }
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--epipe-child'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', function collect(chunk) {
    stderr += chunk.toString();
  });
  const result = await new Promise(function wait(resolve, reject) {
    child.once('error', reject);
    child.once('close', function closed(code, signal) {
      resolve({ code, signal });
    });
  });
  assert.deepEqual(result, { code: 0, signal: null }, stderr);
  return false;
}

const watchdog = setTimeout(function hardeningWatchdogExpired() {
  const diagnostics = Array.from(activeSessions, (session) => ({
    disposed: session.disposed,
    pendingToolCall: Boolean(session.pendingToolCall),
    childPid: session.connection?.child?.pid || null,
    childExitCode: session.connection?.child?.exitCode ?? null,
    childSignalCode: session.connection?.child?.signalCode ?? null,
    pendingRequests: session.connection?.pendingRequests?.size ?? null,
  }));
  forceKillTrackedAppServers();
  process.stderr.write(
    `FAIL Codex provider hardening exceeded its 20-second watchdog during ${currentStage}: ` +
      `${JSON.stringify(diagnostics)}\n`
  );
  process.exit(1);
}, 20_000);

try {
  beginStage('EPIPE child process');
  const epipeChild = await testProviderInChildProcess();
  if (!epipeChild) {
    beginStage('phase-aware agent messages');
    await testPhaseAwareAgentMessages();
    beginStage('immediate tool boundary');
    await testToolBoundaryCompletesWithoutFixedDelay();
    beginStage('legacy tool boundary');
    await testLegacyToolBoundaryCompletesWithoutRawEvents();
    beginStage('StructuredOutput schema retry');
    await testStructuredOutputSchemaRetryStaysOnLiveTurn();
    beginStage('coalesced streaming events');
    await testCoalescedStreamingEvents();
    beginStage('dynamic-tools thread mode');
    await testDynamicToolsOnlyThreadMode();
    beginStage('dynamic-tools version gate');
    await testDynamicToolsOnlyVersionGate();
    beginStage('PDF tool recovery and transcript replay');
    await testPdfToolResultRecovery();
    beginStage('capped tool image recovery');
    await testCappedImageResultRecovery();
    beginStage('unsupported tool results');
    await testUnsupportedToolResults();
    beginStage('terminal notifications while Claude owns a tool');
    await testTerminatedTurnDoesNotReplayTools();
    beginStage('pending-tool retention and capacity');
    await testPendingToolRetentionAndHardCapacity();
    beginStage('pending-tool timeout');
    await testPendingToolTimeout();
    process.stdout.write('PASS Codex provider environment, capacity, pending-tool, and EPIPE hardening\n');
  }
} finally {
  clearTimeout(watchdog);
}
