import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CodexSessionManager } from '../js/gateway/codex-provider.js';

const CLAUDE_MODEL = 'claude-sonnet-4-7';

function request(sessionId, abortSignal = null) {
  const headers = {
    'x-claude-code-session-id': sessionId,
  };
  return {
    ...(abortSignal ? { abortSignal } : {}),
    get(name) {
      return headers[String(name).toLowerCase()] || '';
    },
  };
}

function body(text) {
  return {
    model: CLAUDE_MODEL,
    messages: [{ role: 'user', content: text }],
    tools: [],
  };
}

function authoritativeReplayBody(label) {
  return {
    model: CLAUDE_MODEL,
    messages: [
      { role: 'user', content: `${label}_ORIGINAL_USER` },
      { role: 'assistant', content: `${label}_CLAUDE_CANCELLED_MARKER` },
      { role: 'user', content: `${label}_FOLLOW_UP` },
    ],
    tools: [],
  };
}

function route() {
  return {
    provider: 'codex',
    requestedModel: CLAUDE_MODEL,
    upstreamModel: 'gpt-5.6-terra',
    sandbox: 'workspace-write',
    approvalPolicy: 'never',
    reasoningEffort: 'max',
    verbosity: 'low',
  };
}

function managerConfig(command, cwd) {
  return {
    requestTimeoutMs: 2_000,
    codex: {
      command,
      cwd,
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
      idleTimeoutMs: 0,
      closeKillTimeoutMs: 100,
      pendingToolTimeoutMs: 1_000,
      maxSessions: 4,
    },
  };
}

async function makeExecutable(filePath, source) {
  await fs.writeFile(filePath, source, { mode: 0o755 });
  await fs.chmod(filePath, 0o755);
}

async function readJsonLines(filePath) {
  try {
    return (await fs.readFile(filePath, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function waitFor(check, description, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise(function pause(resolve) {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`timed out waiting for ${description}`);
}

function collectingTracer(events) {
  return {
    scope() {
      return this;
    },
    log(event, details) {
      events.push({ event, details });
    },
  };
}

function protocolAppServer(logPath) {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const logPath = ${JSON.stringify(logPath)};
function log(value) { fs.appendFileSync(logPath, JSON.stringify(value) + '\\n'); }
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
function sendBatch(values) {
  process.stdout.write(values.map((value) => JSON.stringify(value) + '\\n').join(''));
}
const threadId = 'thread-protocol';
const turnId = 'turn-protocol';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', function onLine(line) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    log({ event: 'initialize', message });
    send({ id: message.id, result: { userAgent: 'codex_cli_rs/0.150.1' } });
    return;
  }
  if (message.method === 'initialized') {
    log({ event: 'initialized', message });
    return;
  }
  if (message.method === 'thread/start') {
    log({ event: 'thread_start', message });
    send({
      id: message.id,
      result: { thread: { id: threadId }, model: 'gpt-5.6-sol' }
    });
    return;
  }
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: turnId } } });
    process.stderr.write('remote app server websocket transport failed\\n');
    send({
      id: 700,
      method: 'item/tool/requestUserInput',
      params: { threadId, turnId, itemId: 'question', questions: [] }
    });
    return;
  }
  if (message.id === 700) {
    log({ event: 'unknown_response', message });
    sendBatch([
      { method: 'model/rerouted', params: {
        threadId, turnId, fromModel: 'gpt-5.6-sol', toModel: 'gpt-5.6-luna', reason: 'safety'
      } },
      { method: 'item/started', params: {
        threadId, turnId, item: { id: 'compact', type: 'contextCompaction' }
      } },
      { method: 'item/completed', params: {
        threadId, turnId, item: { id: 'compact', type: 'contextCompaction' }
      } },
      { method: 'item/started', params: { threadId, turnId, item: {
        id: 'async-final', type: 'agentMessage', phase: 'final_answer', delivery: 'async', text: ''
      } } },
      { method: 'item/agentMessage/delta', params: {
        threadId, turnId, itemId: 'async-final', delta: 'ASYNC_MUST_NOT_BE_FINAL'
      } },
      { method: 'item/completed', params: { threadId, turnId, item: {
        id: 'async-final', type: 'agentMessage', phase: 'final_answer', delivery: 'async',
        text: 'ASYNC_MUST_NOT_BE_FINAL'
      } } },
      { method: 'item/started', params: { threadId, turnId, item: {
        id: 'sync-final', type: 'agentMessage', phase: 'final_answer', text: ''
      } } },
      { method: 'item/agentMessage/delta', params: {
        threadId, turnId, itemId: 'sync-final', delta: 'SYNC'
      } }
    ]);
    setTimeout(function streamSuffix() {
      send({ method: 'item/agentMessage/delta', params: {
        threadId, turnId, itemId: 'sync-final', delta: '_FINAL'
      } });
    }, 10);
    setTimeout(function completeTurn() {
      sendBatch([
        { method: 'item/completed', params: { threadId, turnId, item: {
          id: 'sync-final', type: 'agentMessage', phase: 'final_answer', text: 'SYNC_FINAL'
        } } },
        { method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: {
          total: {
            inputTokens: 100, cachedInputTokens: 80, cacheWriteInputTokens: 80,
            outputTokens: 10, reasoningOutputTokens: 5, totalTokens: 110
          },
          last: {
            inputTokens: 100, cachedInputTokens: 80, cacheWriteInputTokens: 80,
            outputTokens: 10, reasoningOutputTokens: 5, totalTokens: 110
          },
          modelContextWindow: 828400
        } } },
        { method: 'turn/completed', params: {
          threadId, turn: { id: turnId, status: 'completed' }
        } }
      ]);
    }, 20);
  }
});
setInterval(function keepAlive() {}, 1000);
`;
}

function rpcOverloadAppServer(logPath) {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const logPath = ${JSON.stringify(logPath)};
function log(value) { fs.appendFileSync(logPath, JSON.stringify(value) + '\\n'); }
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', function onLine(line) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'codex_cli_rs/0.150.1' } });
    return;
  }
  if (message.method === 'thread/start') {
    log({ event: 'thread_start' });
    send({ id: message.id, error: {
      code: -32001,
      message: 'Server overloaded; retry later.',
      data: { retryAfterMs: 250, queue: 'primary' }
    } });
  }
});
setInterval(function keepAlive() {}, 1000);
`;
}

function typedTurnErrorAppServer(logPath, errorType, errorViaNotification, mode = 'always') {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const logPath = ${JSON.stringify(logPath)};
const errorType = ${JSON.stringify(errorType)};
const errorViaNotification = ${JSON.stringify(errorViaNotification)};
const mode = ${JSON.stringify(mode)};
function log(value) { fs.appendFileSync(logPath, JSON.stringify(value) + '\\n'); }
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
function sendBatch(values) {
  process.stdout.write(values.map((value) => JSON.stringify(value) + '\\n').join(''));
}
const threadId = 'thread-error';
const turnId = 'turn-error';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', function onLine(line) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'codex_cli_rs/0.150.1' } });
    return;
  }
  if (message.method === 'thread/start') {
    log({ event: 'thread_start' });
    send({ id: message.id, result: { thread: { id: threadId } } });
    return;
  }
  if (message.method === 'turn/start' || ([901, 902].includes(message.id) && message.result)) {
    if (message.method === 'turn/start') {
      const hadTurn = fs.readFileSync(logPath, 'utf8').includes('"event":"turn_start"');
      log({ event: 'turn_start', input: message.params.input });
      if (hadTurn && mode !== 'always') {
        sendBatch([
          { id: message.id, result: { turn: { id: turnId } } },
          { method: 'item/completed', params: { threadId, turnId,
            item: { id: 'answer', type: 'agentMessage', text: 'Recovered.' } } },
          { method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } }
        ]);
        return;
      }
      send({ id: message.id, result: { turn: { id: turnId } } });
      if (mode === 'after_tool' || mode === 'after_parallel') {
        send({ id: 901, method: 'item/tool/call', params: {
          threadId, turnId, callId: 'once', tool: 'ext_tool_001', arguments: {}
        } });
        if (mode === 'after_parallel') send({ id: 902, method: 'item/tool/call', params: {
          threadId, turnId, callId: 'twice', tool: 'ext_tool_001', arguments: {}
        } });
        return;
      }
    } else {
      log({ event: 'tool_result' });
      if (mode === 'after_parallel' && message.id === 901) return;
      if (errorType === 'transport_exit') process.exit(2);
    }
    const errorMessages = {
      serverOverloaded: 'typed overload',
      rateLimitExceeded: 'typed rate limit',
      usageLimitExceeded: 'typed usage limit'
    };
    const turnError = {
      message: errorMessages[errorType] || 'typed context overflow',
      codexErrorInfo: errorType,
      additionalDetails: 'typed-details'
    };
    const events = [
      { method: 'thread/tokenUsage/updated', params: {
        threadId, turnId, tokenUsage: {
          last: { inputTokens: 10, outputTokens: 1, totalTokens: 11 }
        }
      } }
    ];
    if (errorViaNotification) {
      events.push({ method: 'error', params: {
        threadId, turnId, willRetry: false, error: turnError
      } });
    } else {
      events.push({ method: 'turn/completed', params: {
        threadId, turn: { id: turnId, status: 'failed', error: turnError }
      } });
    }
    sendBatch(events);
  }
});
setInterval(function keepAlive() {}, 1000);
`;
}

function gracefulInterruptAppServer(logPath) {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const logPath = ${JSON.stringify(logPath)};
function log(value) { fs.appendFileSync(logPath, JSON.stringify(value) + '\\n'); }
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
function sendBatch(values) {
  process.stdout.write(values.map((value) => JSON.stringify(value) + '\\n').join(''));
}
let threadCount = 0;
let turnCount = 0;
let activeThreadId = '';
let activeTurnId = '';
log({ event: 'process', pid: process.pid });
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', function onLine(line) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    log({ event: 'initialize', pid: process.pid });
    send({ id: message.id, result: { userAgent: 'codex_cli_rs/0.150.1' } });
    return;
  }
  if (message.method === 'thread/start') {
    threadCount += 1;
    activeThreadId = 'thread-' + threadCount;
    log({
      event: 'thread_start',
      pid: process.pid,
      threadId: activeThreadId,
      threadIndex: threadCount,
      message
    });
    send({
      id: message.id,
      result: { thread: { id: activeThreadId }, model: 'gpt-5.6-terra' }
    });
    return;
  }
  if (message.method === 'turn/start') {
    turnCount += 1;
    activeTurnId = 'turn-' + turnCount;
    log({
      event: 'turn_start',
      pid: process.pid,
      threadId: message.params.threadId,
      turnId: activeTurnId,
      input: message.params.input && message.params.input[0]
        ? message.params.input[0].text
        : ''
    });
    if (turnCount === 1) {
      sendBatch([
        { id: message.id, result: { turn: { id: activeTurnId } } },
        { method: 'item/started', params: {
          threadId: activeThreadId,
          turnId: activeTurnId,
          item: {
            id: 'partial-agent-message',
            type: 'agentMessage',
            phase: 'final_answer',
            text: ''
          }
        } },
        { method: 'item/agentMessage/delta', params: {
          threadId: activeThreadId,
          turnId: activeTurnId,
          itemId: 'partial-agent-message',
          delta: 'PARTIAL_CODEX_OUTPUT_MUST_NOT_REPLAY'
        } }
      ]);
      return;
    }
    sendBatch([
      { id: message.id, result: { turn: { id: activeTurnId } } },
      { method: 'item/completed', params: {
        threadId: activeThreadId,
        turnId: activeTurnId,
        item: {
          id: 'final-agent-message',
          type: 'agentMessage',
          phase: 'final_answer',
          text: 'AFTER_GRACEFUL_INTERRUPT'
        }
      } },
      { method: 'turn/completed', params: {
        threadId: activeThreadId,
        turn: { id: activeTurnId, status: 'completed', error: null }
      } }
    ]);
    return;
  }
  if (message.method === 'turn/interrupt') {
    log({ event: 'interrupt', pid: process.pid, message });
    sendBatch([
      { method: 'turn/completed', params: {
        threadId: activeThreadId,
        turn: { id: activeTurnId, status: 'interrupted', error: null }
      } },
      { id: message.id, result: {} }
    ]);
  }
  if (message.method === 'thread/unsubscribe') {
    log({ event: 'unsubscribe', pid: process.pid, message });
    send({ id: message.id, result: { status: 'unsubscribed' } });
  }
});
setInterval(function keepAlive() {}, 1000);
`;
}

function fallbackInterruptAppServer(logPath, statePath, mode) {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const logPath = ${JSON.stringify(logPath)};
const statePath = ${JSON.stringify(statePath)};
const mode = ${JSON.stringify(mode)};
function log(value) { fs.appendFileSync(logPath, JSON.stringify(value) + '\\n'); }
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
function sendBatch(values) {
  process.stdout.write(values.map((value) => JSON.stringify(value) + '\\n').join(''));
}
let processOrdinal = 1;
try {
  processOrdinal = Number(fs.readFileSync(statePath, 'utf8')) + 1;
} catch {}
fs.writeFileSync(statePath, String(processOrdinal));
let threadCount = 0;
let turnCount = 0;
let activeThreadId = '';
let activeTurnId = '';
log({ event: 'process', pid: process.pid, processOrdinal, mode });
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', function onLine(line) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    log({ event: 'initialize', pid: process.pid, processOrdinal });
    send({ id: message.id, result: { userAgent: 'codex_cli_rs/0.150.1' } });
    return;
  }
  if (message.method === 'thread/start') {
    threadCount += 1;
    activeThreadId = 'thread-' + processOrdinal + '-' + threadCount;
    log({
      event: 'thread_start',
      pid: process.pid,
      processOrdinal,
      threadId: activeThreadId,
      message
    });
    send({ id: message.id, result: { thread: { id: activeThreadId } } });
    return;
  }
  if (message.method === 'turn/start') {
    turnCount += 1;
    activeTurnId = 'turn-' + processOrdinal + '-' + turnCount;
    log({
      event: 'turn_start',
      pid: process.pid,
      processOrdinal,
      threadId: message.params.threadId,
      turnId: activeTurnId,
      input: message.params.input && message.params.input[0]
        ? message.params.input[0].text
        : ''
    });
    if (processOrdinal === 1) {
      sendBatch([
        { id: message.id, result: { turn: { id: activeTurnId } } },
        { method: 'item/started', params: {
          threadId: activeThreadId,
          turnId: activeTurnId,
          item: {
            id: 'fallback-partial',
            type: 'agentMessage',
            phase: 'final_answer',
            text: ''
          }
        } },
        { method: 'item/agentMessage/delta', params: {
          threadId: activeThreadId,
          turnId: activeTurnId,
          itemId: 'fallback-partial',
          delta: 'FALLBACK_PARTIAL_CODEX_OUTPUT_MUST_NOT_REPLAY'
        } }
      ]);
      return;
    }
    sendBatch([
      { id: message.id, result: { turn: { id: activeTurnId } } },
      { method: 'item/completed', params: {
        threadId: activeThreadId,
        turnId: activeTurnId,
        item: {
          id: 'fallback-final',
          type: 'agentMessage',
          phase: 'final_answer',
          text: 'AFTER_INTERRUPT_FALLBACK_' + mode.toUpperCase()
        }
      } },
      { method: 'turn/completed', params: {
        threadId: activeThreadId,
        turn: { id: activeTurnId, status: 'completed', error: null }
      } }
    ]);
    return;
  }
  if (message.method === 'turn/interrupt') {
    log({ event: 'interrupt', pid: process.pid, processOrdinal, message });
    if (mode === 'reject') {
      send({
        id: message.id,
        error: { code: -32603, message: 'interrupt rejected by fake server' }
      });
    } else if (mode.startsWith('unsubscribe')) {
      sendBatch([
        { id: message.id, result: {} },
        { method: 'turn/completed', params: { threadId: activeThreadId,
          turn: { id: activeTurnId, status: 'interrupted', error: null } } },
      ]);
    }
  }
  if (message.method === 'thread/unsubscribe') {
    log({ event: 'unsubscribe', pid: process.pid, message });
    if (mode === 'unsubscribe_rejected') send({ id: message.id, error: { code: -32603, message: 'cannot release' } });
    else send({ id: message.id, result: { status: 'unknown-status' } });
  }
});
setInterval(function keepAlive() {}, 1000);
`;
}

test('Codex app-server protocol handshake and notifications are handled canonically', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-protocol-contract-'));
  const command = path.join(tempDir, 'fake-codex');
  const logPath = path.join(tempDir, 'events.jsonl');
  const traces = [];
  await makeExecutable(command, protocolAppServer(logPath));
  const manager = new CodexSessionManager(managerConfig(command, tempDir), {
    tracer: collectingTracer(traces),
  });

  try {
    const streamedEvents = [];
    const outcome = await manager.streamRequest(
      request('protocol-contract'),
      body('Exercise the protocol contract.'),
      route(),
      function collectEvent(event) {
        streamedEvents.push(event);
      }
    );
    assert.equal(outcome.type, 'final');
    assert.equal(outcome.text, 'SYNC_FINAL');
    assert.equal(outcome.text.includes('ASYNC_MUST_NOT_BE_FINAL'), false);
    assert.deepEqual(
      streamedEvents.filter((event) => event.type === 'text_delta').map((event) => event.text),
      ['SYNC', '_FINAL']
    );
    assert.deepEqual(outcome.usage, {
      input_tokens: 0,
      output_tokens: 10,
      cache_read_input_tokens: 80,
      cache_write_input_tokens: 20,
      reasoning_output_tokens: 5,
      total_tokens: 110,
    });

    const entries = await readJsonLines(logPath);
    const initialize = entries.find((entry) => entry.event === 'initialize').message;
    assert.deepEqual(initialize.params.capabilities, {
      experimentalApi: true,
      requestAttestation: false,
    });
    const initialized = entries.find((entry) => entry.event === 'initialized').message;
    assert.deepEqual(initialized, { method: 'initialized' });
    const threadStart = entries.find((entry) => entry.event === 'thread_start').message;
    assert.equal(Object.hasOwn(threadStart.params, 'experimentalRawEvents'), false);
    assert.equal(entries.filter((entry) => entry.event === 'thread_start').length, 1);
    const unknownResponse = entries.find((entry) => entry.event === 'unknown_response').message;
    assert.equal(unknownResponse.error.code, -32601);
    assert.match(unknownResponse.error.message, /item\/tool\/requestUserInput/u);

    const session = Array.from(manager.sessions.values())[0];
    assert.equal(session.actualModel, 'gpt-5.6-luna');
    assert.equal(session.knownModelContextWindow(), 828_400);
    assert.equal(
      traces.some((entry) => entry.event === 'codex.context_compaction.started'),
      true
    );
    assert.equal(
      traces.some((entry) => entry.event === 'codex.context_compaction.completed'),
      true
    );
    assert.equal(traces.some((entry) => entry.event === 'codex.model.rerouted'), true);
  } finally {
    await manager.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('JSON-RPC admission overload preserves code/data and retries with a finite cap', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rpc-overload-'));
  const command = path.join(tempDir, 'fake-codex');
  const logPath = path.join(tempDir, 'events.jsonl');
  await makeExecutable(command, rpcOverloadAppServer(logPath));
  const manager = new CodexSessionManager(managerConfig(command, tempDir));

  try {
    await assert.rejects(
      manager.processRequest(request('rpc-overload'), body('Overload once.'), route()),
      (error) => {
        assert.equal(error.status, 503);
        assert.equal(error.type, 'overloaded_error');
        assert.equal(error.code, -32001);
        assert.deepEqual(error.data, { retryAfterMs: 250, queue: 'primary' });
        assert.equal(error.codexRpcCode, -32001);
        assert.deepEqual(error.codexRpcData, { retryAfterMs: 250, queue: 'primary' });
        assert.equal(error.retryable, true);
        return true;
      }
    );
    const entries = await readJsonLines(logPath);
    assert.equal(entries.filter((entry) => entry.event === 'thread_start').length, 5);
  } finally {
    await manager.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('typed serverOverloaded notifications map to retryable 503 without replay', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-typed-overload-'));
  const command = path.join(tempDir, 'fake-codex');
  const logPath = path.join(tempDir, 'events.jsonl');
  await makeExecutable(command, typedTurnErrorAppServer(logPath, 'serverOverloaded', true));
  const manager = new CodexSessionManager(managerConfig(command, tempDir));

  try {
    await assert.rejects(
      manager.processRequest(request('typed-overload'), body('Typed overload.'), route()),
      (error) => {
        assert.equal(error.status, 503);
        assert.equal(error.type, 'overloaded_error');
        assert.equal(error.codexErrorInfo, 'serverOverloaded');
        assert.equal(error.codexErrorType, 'serverOverloaded');
        assert.equal(error.codexAdditionalDetails, 'typed-details');
        assert.equal(error.retryable, true);
        return true;
      }
    );
    const entries = await readJsonLines(logPath);
    assert.equal(entries.filter((entry) => entry.event === 'turn_start').length, 1);
  } finally {
    await manager.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('typed rateLimitExceeded maps to retryable 429 without replay', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-typed-rate-limit-'));
  const command = path.join(tempDir, 'fake-codex');
  const logPath = path.join(tempDir, 'events.jsonl');
  await makeExecutable(command, typedTurnErrorAppServer(logPath, 'rateLimitExceeded', true, 'once'));
  const manager = new CodexSessionManager(managerConfig(command, tempDir));

  try {
    await assert.rejects(
      manager.processRequest(request('typed-rate-limit'), body('Typed rate limit.'), route()),
      (error) => {
        assert.equal(error.status, 429);
        assert.equal(error.type, 'rate_limit_error');
        assert.equal(error.codexErrorInfo, 'rateLimitExceeded');
        assert.equal(error.codexErrorType, 'rateLimitExceeded');
        assert.equal(error.codexAdditionalDetails, 'typed-details');
        assert.equal(error.retryable, true);
        return true;
      }
    );
    const entries = await readJsonLines(logPath);
    assert.equal(entries.filter((entry) => entry.event === 'turn_start').length, 1);
    const retried = await manager.processRequest(request('typed-rate-limit'), body('Typed rate limit.'), route());
    assert.equal(retried.text, 'Recovered.');
    const afterRetry = await readJsonLines(logPath);
    assert.deepEqual(afterRetry.map(entry => entry.event), ['thread_start', 'turn_start', 'thread_start', 'turn_start']);
    assert.deepEqual(afterRetry[3].input, afterRetry[1].input);
  } finally {
    await manager.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

for (const [errorType, status, mode] of [
  ['rateLimitExceeded', 429, 'after_tool'], ['contextWindowExceeded', 400, 'after_parallel'],
  ['serverOverloaded', 503, 'after_tool'], ['transport_exit', 502, 'after_tool'],
]) test(`post-tool ${errorType} cannot replay after unrelated work or pool eviction`, async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-post-tool-limit-'));
  const command = path.join(cwd, 'fake-codex');
  const log = path.join(cwd, 'events');
  await makeExecutable(command, typedTurnErrorAppServer(log, errorType, false, mode));
  const manager = new CodexSessionManager(managerConfig(command, cwd));
  t.after(async () => { await manager.close(); await fs.rm(cwd, { recursive: true, force: true }); });

  const req = request('post-tool-limit');
  const original = { ...body('Record the marker.'), tools: [
    { name: 'Record', description: 'Record one marker.', input_schema: { type: 'object' } },
  ] };
  const first = await manager.processRequest(req, original, route());
  assert.equal(first.type, 'tool_use');
  function resultBody(previous, { id, name, input }) {
    return { ...original, messages: [...previous.messages,
    { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'recorded marker' }] },
    ] };
  }
  const firstResult = resultBody(original, first.toolCall);
  let continuation = firstResult;
  if (mode === 'after_parallel') {
    const queued = await manager.processRequest(req, firstResult, route());
    assert.equal(queued.toolCall.id, 'twice');
    continuation = resultBody(firstResult, queued.toolCall);
  }
  const blocked = candidate =>
    assert.rejects(manager.processRequest(req, candidate, route()), error => {
      assert.equal(error.status, status);
      assert.equal(error.retryable, false);
      assert.match(error.message, /check its effects/iu);
      return true;
    });
  for (const candidate of [continuation, original, firstResult]) await blocked(candidate);
  const before = (await readJsonLines(log)).map(e => e.event);
  assert.deepEqual(before, ['thread_start', 'turn_start', 'tool_result', ...(mode === 'after_parallel' ? ['tool_result'] : [])]);
  const corrected = { ...original, messages: [...continuation.messages,
    { role: 'user', content: 'I checked the marker; just summarize.' },
  ] };
  assert.equal((await manager.processRequest(req, corrected, route())).text, 'Recovered.');
  const events = await readJsonLines(log);
  assert.equal(events.filter(e => e.event === 'thread_start').length, 2);
  assert.match(events.at(-1).input[0].text, /recorded marker/u);
  for (const candidate of [original, firstResult, continuation]) await blocked(candidate);
  const altered = structuredClone(continuation);
  altered.messages.at(-1).content[0].content += ' (late duplicate with changed content)';
  await blocked(altered);
  assert.equal((await readJsonLines(log)).length, events.length);
  assert.equal((await manager.processRequest(request('different-identity'), original, route())).text, 'Recovered.');
});

test('post-tool replay protection expires, is bounded per identity, and retains no payload', (t) => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const cache = new CodexSessionManager({ codex: {} }).failedToolTurns;
  const failure = { status: 503, type: 'overloaded_error', message: 'private provider payload' };
  cache.remember('one', ['first'], ['private tool identifier'], failure);
  cache.rejectReplay('two', 'first', []);
  const blocked = () => cache.rejectReplay('one', 'different', ['private tool identifier']);
  assert.throws(blocked, error => error.status === 503 && error.retryable === false &&
    !error.message.includes('private'));
  const snapshot = JSON.stringify([...cache.identities.get('one')]);
  assert.doesNotMatch(snapshot, /private|provider payload/u);
  now += 29 * 60_000;
  cache.remember('one', ['first'], ['private tool identifier'], { status: 504, type: 'api_error' });
  assert.throws(blocked, error => error.status === 503);
  now += 60_000;
  assert.doesNotThrow(blocked);
  cache.remember('one', Array.from({ length: 1025 }, (_, i) => String(i)), [], failure);
  assert.doesNotThrow(() => cache.rejectReplay('one', '0', []));
  assert.throws(() => cache.rejectReplay('one', '1', []));
  for (let i = 0; i < 256; i++) cache.remember(`other-${i}`, ['first'], [], failure);
  assert.doesNotThrow(() => cache.rejectReplay('one', '1', []));
});

test('typed usageLimitExceeded maps to non-retryable 429 without replay', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-typed-usage-limit-'));
  const command = path.join(tempDir, 'fake-codex');
  const logPath = path.join(tempDir, 'events.jsonl');
  await makeExecutable(command, typedTurnErrorAppServer(logPath, 'usageLimitExceeded', true));
  const manager = new CodexSessionManager(managerConfig(command, tempDir));

  try {
    await assert.rejects(
      manager.processRequest(request('typed-usage-limit'), body('Typed usage limit.'), route()),
      (error) => {
        assert.equal(error.status, 429);
        assert.equal(error.type, 'rate_limit_error');
        assert.equal(error.codexErrorInfo, 'usageLimitExceeded');
        assert.equal(error.codexErrorType, 'usageLimitExceeded');
        assert.equal(error.codexAdditionalDetails, 'typed-details');
        assert.equal(error.retryable, false);
        return true;
      }
    );
    const entries = await readJsonLines(logPath);
    assert.equal(entries.filter((entry) => entry.event === 'turn_start').length, 1);
  } finally {
    await manager.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('typed contextWindowExceeded remains identifiable after gateway formatting', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-typed-context-'));
  const command = path.join(tempDir, 'fake-codex');
  const logPath = path.join(tempDir, 'events.jsonl');
  await makeExecutable(
    command,
    typedTurnErrorAppServer(logPath, 'contextWindowExceeded', false)
  );
  const manager = new CodexSessionManager(managerConfig(command, tempDir));

  try {
    await assert.rejects(
      manager.streamRequest(
        request('typed-context'),
        body('Typed context overflow.'),
        route(),
        function consumeEvent() {}
      ),
      (error) => {
        assert.equal(error.status, 400);
        assert.equal(error.type, 'invalid_request_error');
        assert.equal(error.codexErrorInfo, 'contextWindowExceeded');
        assert.equal(error.codexErrorType, 'contextWindowExceeded');
        assert.equal(error.retryable, false);
        assert.match(error.message, /Codex context window exceeded/u);
        return true;
      }
    );
    const entries = await readJsonLines(logPath);
    assert.equal(entries.filter((entry) => entry.event === 'turn_start').length, 1);
  } finally {
    await manager.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('graceful turn interruption reuses the process and replays into a fresh thread', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-graceful-interrupt-'));
  const command = path.join(tempDir, 'fake-codex');
  const logPath = path.join(tempDir, 'events.jsonl');
  await makeExecutable(command, gracefulInterruptAppServer(logPath));
  const manager = new CodexSessionManager(managerConfig(command, tempDir));
  const controller = new AbortController();

  try {
    const firstRequest = manager.processRequest(
      request('graceful-interrupt', controller.signal),
      body('GRACEFUL_ORIGINAL_USER'),
      route()
    );
    const firstRejected = assert.rejects(firstRequest, (error) => {
      assert.equal(error.status, 499);
      assert.match(error.message, /aborted/u);
      return true;
    });

    let originalSession = null;
    await waitFor(() => {
      originalSession = Array.from(manager.sessions.values())[0] || null;
      return originalSession?.activeBoundary?.turnId === 'turn-1';
    }, 'first Codex turn to become interruptible');
    const originalPid = originalSession.connection.child.pid;

    controller.abort(new Error('test cancellation'));
    await firstRejected;

    assert.equal(manager.sessions.size, 1);
    const retainedSession = Array.from(manager.sessions.values())[0];
    assert.equal(retainedSession, originalSession);
    assert.equal(retainedSession.connection.child.pid, originalPid);
    assert.equal(retainedSession.connection.child.exitCode, null);
    assert.equal(retainedSession.threadId, null);
    assert.equal(retainedSession.activeBoundary, null);

    const secondOutcome = await manager.processRequest(
      request('graceful-interrupt'),
      authoritativeReplayBody('GRACEFUL'),
      route()
    );
    assert.equal(secondOutcome.type, 'final');
    assert.equal(secondOutcome.text, 'AFTER_GRACEFUL_INTERRUPT');

    const reusedSession = Array.from(manager.sessions.values())[0];
    assert.equal(reusedSession, originalSession);
    assert.equal(reusedSession.connection.child.pid, originalPid);

    const entries = await readJsonLines(logPath);
    assert.equal(entries.filter((entry) => entry.event === 'process').length, 1);
    assert.equal(entries.filter((entry) => entry.event === 'initialize').length, 1);
    const threadStarts = entries.filter((entry) => entry.event === 'thread_start');
    assert.deepEqual(threadStarts.map((entry) => entry.threadId), ['thread-1', 'thread-2']);
    assert.equal(threadStarts.every((entry) => entry.pid === originalPid), true);

    const interrupt = entries.find((entry) => entry.event === 'interrupt');
    assert.deepEqual(interrupt.message.params, {
      threadId: 'thread-1',
      turnId: 'turn-1',
    });
    assert.deepEqual(entries.filter(e => e.event === 'unsubscribe').map(e => e.message.params),
      [{ threadId: 'thread-1' }]);

    const turnStarts = entries.filter((entry) => entry.event === 'turn_start');
    assert.equal(turnStarts[1].threadId, 'thread-2');
    assert.match(turnStarts[1].input, /GRACEFUL_ORIGINAL_USER/u);
    assert.match(turnStarts[1].input, /GRACEFUL_CLAUDE_CANCELLED_MARKER/u);
    assert.match(turnStarts[1].input, /GRACEFUL_FOLLOW_UP/u);
    assert.equal(turnStarts[1].input.includes('PARTIAL_CODEX_OUTPUT_MUST_NOT_REPLAY'), false);
  } finally {
    await manager.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

for (const interruptMode of ['reject', 'timeout', 'unsubscribe_rejected', 'unsubscribe_unknown']) {
  test(`failed ${interruptMode} interruption evicts the process before authoritative replay`, async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), `codex-interrupt-${interruptMode}-`)
    );
    const command = path.join(tempDir, 'fake-codex');
    const logPath = path.join(tempDir, 'events.jsonl');
    const statePath = path.join(tempDir, 'process-count');
    const label = `FALLBACK_${interruptMode.toUpperCase()}`;
    await makeExecutable(
      command,
      fallbackInterruptAppServer(logPath, statePath, interruptMode)
    );
    const manager = new CodexSessionManager(managerConfig(command, tempDir));
    const controller = new AbortController();

    try {
      const firstRequest = manager.processRequest(
        request(`interrupt-${interruptMode}`, controller.signal),
        body(`${label}_ORIGINAL_USER`),
        route()
      );
      const firstRejected = assert.rejects(firstRequest, (error) => {
        assert.equal(error.status, 499);
        return true;
      });

      let originalSession = null;
      await waitFor(() => {
        originalSession = Array.from(manager.sessions.values())[0] || null;
        return Boolean(originalSession?.activeBoundary?.turnId);
      }, `${interruptMode} turn to become interruptible`);
      const originalPid = originalSession.connection.child.pid;
      const abortStartedAt = Date.now();

      controller.abort(new Error(`test ${interruptMode} cancellation`));
      await firstRejected;
      const abortElapsedMs = Date.now() - abortStartedAt;
      if (interruptMode === 'timeout') {
        assert.equal(
          abortElapsedMs >= 1_500,
          true,
          `interrupt timeout fallback returned too early after ${abortElapsedMs}ms`
        );
      }
      assert.equal(manager.sessions.size, 0);

      const secondOutcome = await manager.processRequest(
        request(`interrupt-${interruptMode}`),
        authoritativeReplayBody(label),
        route()
      );
      assert.equal(secondOutcome.type, 'final');
      assert.equal(
        secondOutcome.text,
        `AFTER_INTERRUPT_FALLBACK_${interruptMode.toUpperCase()}`
      );

      const replacementSession = Array.from(manager.sessions.values())[0];
      assert.notEqual(replacementSession.connection.child.pid, originalPid);

      const entries = await readJsonLines(logPath);
      const processes = entries.filter((entry) => entry.event === 'process');
      assert.deepEqual(processes.map((entry) => entry.processOrdinal), [1, 2]);
      assert.notEqual(processes[0].pid, processes[1].pid);
      assert.equal(entries.filter((entry) => entry.event === 'initialize').length, 2);

      const interrupt = entries.find((entry) => entry.event === 'interrupt');
      assert.deepEqual(interrupt.message.params, {
        threadId: 'thread-1-1',
        turnId: 'turn-1-1',
      });

      const turnStarts = entries.filter((entry) => entry.event === 'turn_start');
      const replacementTurn = turnStarts.find((entry) => entry.processOrdinal === 2);
      assert.match(replacementTurn.input, new RegExp(`${label}_ORIGINAL_USER`, 'u'));
      assert.match(
        replacementTurn.input,
        new RegExp(`${label}_CLAUDE_CANCELLED_MARKER`, 'u')
      );
      assert.match(replacementTurn.input, new RegExp(`${label}_FOLLOW_UP`, 'u'));
      assert.equal(
        replacementTurn.input.includes('FALLBACK_PARTIAL_CODEX_OUTPUT_MUST_NOT_REPLAY'),
        false
      );
    } finally {
      await manager.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
}
