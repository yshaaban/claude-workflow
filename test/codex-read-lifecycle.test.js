import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CodexSessionManager } from '../js/gateway/codex-provider.js';

const CLAUDE_MODEL = 'claude-sonnet-4-7';
const READ_PATH = 'C:\\Workspace\\12001-lines.txt';
const PARTIAL_NOTICE =
  '[Truncated: PARTIAL view — /mnt/c/workspace/12001-lines.txt: showing lines 1-12001 of 20000 total (50000 tokens, cap 25000). ' +
  'Call Read with offset=12002 limit=12001 for the next page, or Grep to find a specific section. ' +
  'Do NOT answer from this page alone if the answer may be further in the file.]';

function request(sessionId) {
  const headers = { 'x-claude-code-session-id': sessionId };
  return {
    get(name) {
      return headers[String(name).toLowerCase()] || '';
    },
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

function readTool() {
  return {
    name: 'Read',
    description: 'Read a file.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        offset: { type: 'integer' },
        limit: { type: 'integer' },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
  };
}

function readMessages(rawResult) {
  return [
    { role: 'user', content: 'READ_LIFECYCLE_START' },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'call_read_lifecycle',
          name: 'Read',
          input: { file_path: READ_PATH },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'call_read_lifecycle',
          content: rawResult,
        },
      ],
    },
    {
      role: 'system',
      content: [
        {
          type: 'text',
          text: `${PARTIAL_NOTICE}\n\n<total_tokens>14999979 tokens left</total_tokens>`,
        },
      ],
    },
  ];
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

function fakeAppServer(logPath) {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const logPath = ${JSON.stringify(logPath)};
function log(event, message) {
  fs.appendFileSync(logPath, JSON.stringify({ event, pid: process.pid, message }) + '\\n');
}
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
let turnSequence = 0;
let activeTurnId = null;
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', function onLine(line) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    log('initialize', message);
    send({ id: message.id, result: { userAgent: 'codex_cli_rs/0.150.1' } });
    return;
  }
  if (message.method === 'initialized') return;
  if (message.method === 'thread/start') {
    log('thread_start', message);
    send({ id: message.id, result: { thread: { id: 'thread-' + String(process.pid) } } });
    return;
  }
  if (message.method === 'turn/start') {
    turnSequence += 1;
    activeTurnId = 'turn-' + String(process.pid) + '-' + String(turnSequence);
    log('turn_start', message);
    send({ id: message.id, result: { turn: { id: activeTurnId } } });
    const input = message.params.input[0].text;
    if (input.includes('AFTER_EVICTION')) {
      send({ method: 'item/completed', params: { turnId: activeTurnId, item: {
        id: 'after-eviction-' + String(turnSequence), type: 'agentMessage',
        phase: 'final_answer', text: 'AFTER_EVICTION_DONE'
      } } });
      send({ method: 'turn/completed', params: { turn: { id: activeTurnId, status: 'completed' } } });
      return;
    }
    if (input.includes('FOLLOW_UP')) {
      send({ method: 'item/completed', params: { turnId: activeTurnId, item: {
        id: 'follow-up-' + String(turnSequence), type: 'agentMessage',
        phase: 'final_answer', text: 'FOLLOW_UP_DONE'
      } } });
      send({ method: 'turn/completed', params: { turn: { id: activeTurnId, status: 'completed' } } });
      return;
    }
    if (input.includes('EVICTOR')) {
      send({ method: 'item/completed', params: { turnId: activeTurnId, item: {
        id: 'evictor-' + String(turnSequence), type: 'agentMessage',
        phase: 'final_answer', text: 'EVICTOR_DONE'
      } } });
      send({ method: 'turn/completed', params: { turn: { id: activeTurnId, status: 'completed' } } });
      return;
    }
    send({ id: 'tool_req_read', method: 'item/tool/call', params: {
      turnId: activeTurnId, callId: 'call_read_lifecycle', tool: 'ext_tool_001',
      arguments: { file_path: ${JSON.stringify(READ_PATH)} }
    } });
    return;
  }
  if (message.id === 'tool_req_read') {
    log('tool_response', message);
    send({ method: 'item/completed', params: { turnId: activeTurnId, item: {
      id: 'read-analysis-' + String(turnSequence), type: 'agentMessage',
      phase: 'final_answer', text: 'READ_ANALYZED'
    } } });
    send({ method: 'turn/completed', params: { turn: { id: activeTurnId, status: 'completed' } } });
  }
});
setInterval(function keepAlive() {}, 1000);
`;
}

test('Read metadata stays transient across live continuity and authoritative replay', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-read-lifecycle-'));
  const command = path.join(tempDir, 'codex-read-lifecycle');
  const logPath = path.join(tempDir, 'app-server.jsonl');
  const rawResult = Array.from({ length: 12_001 }, function numberedLine(_, index) {
    return `${String(index + 1)}\tline-${String(index + 1).padStart(5, '0')} ${'x'.repeat(24)}`;
  }).join('\n');
  let manager = null;

  try {
    await makeExecutable(command, fakeAppServer(logPath));
    manager = new CodexSessionManager({
      requestTimeoutMs: 5_000,
      codex: {
        command,
        cwd: tempDir,
        idleTimeoutMs: 0,
        closeKillTimeoutMs: 100,
        maxSessions: 1,
        toolResultMaxBytes: 0,
        toolResultWindowMaxBytes: 0,
      },
    });

    const durableSystem = 'DURABLE_CALLER_DEVELOPER_INSTRUCTION';
    const tools = [readTool()];
    const initialBody = {
      model: CLAUDE_MODEL,
      system: durableSystem,
      messages: [{ role: 'user', content: 'READ_LIFECYCLE_START' }],
      tools,
    };
    const readCall = await manager.processRequest(request('read-session'), initialBody, route());
    assert.equal(readCall.type, 'tool_use');
    assert.deepEqual(readCall.toolCall, {
      id: 'call_read_lifecycle',
      name: 'Read',
      input: { file_path: READ_PATH },
    });

    const historyAfterRead = readMessages(rawResult);
    const readOutcome = await manager.processRequest(
      request('read-session'),
      {
        model: CLAUDE_MODEL,
        system: durableSystem,
        messages: historyAfterRead,
        tools,
      },
      route()
    );
    assert.equal(readOutcome.text, 'READ_ANALYZED');

    const followUpMessages = [
      ...historyAfterRead,
      { role: 'assistant', content: 'READ_ANALYZED' },
      { role: 'user', content: 'FOLLOW_UP' },
    ];
    const followUp = await manager.processRequest(
      request('read-session'),
      {
        model: CLAUDE_MODEL,
        system: durableSystem,
        messages: followUpMessages,
        tools,
      },
      route()
    );
    assert.equal(followUp.text, 'FOLLOW_UP_DONE');

    let events = await readJsonLines(logPath);
    const initialThreads = events.filter((entry) => entry.event === 'thread_start');
    const liveTurns = events.filter((entry) => entry.event === 'turn_start');
    const liveToolResponse = events.find((entry) => entry.event === 'tool_response');
    assert.equal(initialThreads.length, 1);
    assert.equal(liveTurns.length, 2);
    assert.equal(new Set(liveTurns.map((entry) => entry.pid)).size, 1);
    assert.equal(initialThreads[0].message.params.developerInstructions, durableSystem);
    assert.equal(initialThreads[0].message.params.developerInstructions.includes('PARTIAL'), false);
    assert.equal(liveToolResponse.pid, liveTurns[0].pid);
    const liveReadText = liveToolResponse.message.result.contentItems[0].text;
    assert.match(liveReadText, /\[Codex Read page metadata\]/u);
    assert.equal(liveReadText.includes('<total_tokens>'), false);
    assert.equal(liveReadText.includes('12001\tline-12001'), false);

    await manager.processRequest(
      request('evictor-session'),
      {
        model: CLAUDE_MODEL,
        system: 'OTHER_DURABLE_INSTRUCTION',
        messages: [{ role: 'user', content: 'EVICTOR' }],
        tools,
      },
      route()
    );

    const replayMessages = [
      ...followUpMessages,
      { role: 'assistant', content: 'FOLLOW_UP_DONE' },
      { role: 'user', content: 'AFTER_EVICTION' },
    ];
    const afterEviction = await manager.processRequest(
      request('read-session'),
      {
        model: CLAUDE_MODEL,
        system: durableSystem,
        messages: replayMessages,
        tools,
      },
      route()
    );
    assert.equal(afterEviction.text, 'AFTER_EVICTION_DONE');

    events = await readJsonLines(logPath);
    const replayThread = events
      .filter((entry) => entry.event === 'thread_start')
      .find((entry) => entry.message.params.developerInstructions === durableSystem &&
        entry.pid !== liveTurns[0].pid);
    assert.ok(replayThread, 'eviction must create a fresh Codex process/thread for the replay');
    const replayTurn = events
      .filter((entry) => entry.event === 'turn_start')
      .find((entry) => entry.pid === replayThread.pid);
    assert.ok(replayTurn, 'fresh replay process must receive a turn/start');
    const replayInput = replayTurn.message.params.input[0].text;
    assert.match(replayInput, /^\[user\]\nREAD_LIFECYCLE_START/mu);
    assert.match(replayInput, /\[Codex Read page metadata\]/u);
    assert.match(replayInput, /"covered_start":1/u);
    assert.match(replayInput, /"source_total_lines":20000/u);
    assert.match(replayInput, /AFTER_EVICTION/u);
    assert.equal(replayInput.includes('12001\tline-12001'), false);
    assert.equal(replayInput.includes('[Truncated: PARTIAL view'), false);
    assert.equal(replayInput.includes('<total_tokens>'), false);
    assert.equal(replayThread.message.params.developerInstructions, durableSystem);

    // Once the live session is gone, a smaller bootstrap budget must not
    // turn a verified page into a head/tail preview with its old footer.
    await manager.processRequest(request('second-evictor'), {
      ...initialBody, messages: [{ role: 'user', content: 'EVICTOR' }],
    }, route());
    manager.config.codex.inputMaxTokens = 300;
    const boundedHistory = readMessages(rawResult).slice(0, 3);
    boundedHistory[1].content[0].input.limit = 12_002;
    boundedHistory[2].content.push({ type: 'text', text: 'AFTER_EVICTION_TIGHT' });
    const tight = await manager.processRequest(request('read-session'), {
      ...initialBody, messages: boundedHistory,
    }, route());
    assert.equal(tight.text, 'AFTER_EVICTION_DONE');
    const tightTurn = (await readJsonLines(logPath)).filter(entry => entry.event === 'turn_start').at(-1);
    assert.notEqual(tightTurn.pid, replayTurn.pid);
    const tightInput = tightTurn.message.params.input[0].text;
    assert.ok(tightInput.length <= 900);
    const page = JSON.parse(tightInput.split('[Codex Read page metadata]\n')[1].split('\n')[0]);
    assert.equal(page.covered_start, 1);
    assert.equal(page.source_total_lines, 12_001);
    assert.ok(page.covered_end > 0 && page.covered_end < 12_001);
    assert.equal(page.next_offset, page.covered_end + 1);
    assert.equal(page.reached_eof, false);
    assert.equal(page.source_complete, false);
    assert.deepEqual(tightInput.split('\n').filter(line => /^\d+\t/u.test(line)),
      rawResult.split('\n').slice(0, page.covered_end));
  } finally {
    await manager?.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
