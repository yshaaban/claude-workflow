import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CodexSessionManager } from '../js/gateway/codex-provider.js';
import { createCodexToolCatalog } from '../js/gateway/codex-tool-catalog.js';

const MODEL = 'gpt-6-astra';
const CLAUDE_MODEL = 'claude-astra';
const POSIX_ONLY = { skip: process.platform === 'win32' ? 'POSIX executable fixture' : false };
const CATALOG = { models: [{
  slug: MODEL,
  context_window: 272000,
  max_context_window: 872000,
  model_messages: { instructions_template: 'Preserve these exact upstream instructions.' },
  experimental_supported_tools: ['send_user_message_async', 'request_user_input_async', 'clock', 'test_sync_tool', 'future_tool'],
  apply_patch_tool_type: 'freeform',
  tool_mode: 'code_mode_only',
  future_metadata: { nested: ['retained'] },
}, {
  slug: 'gpt-5.6-terra',
  experimental_supported_tools: [],
}] };

async function fixture(t, { bundled = CATALOG, online = bundled, version = '0.171.0', failStartup = false, holdTurn = false, toolCall = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-tool-catalog-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 3 }));
  const command = path.join(directory, 'codex');
  const logPath = path.join(directory, 'calls.jsonl');
  await fs.writeFile(command, `#!/usr/bin/env node
const fs = require('node:fs');
const log = (value) => fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(value) + '\\n');
if (process.argv[2] === 'debug') {
  log({ event: 'catalog', bundled: process.argv.includes('--bundled') });
  process.stdout.write(JSON.stringify(process.argv.includes('--bundled') ? ${JSON.stringify(bundled)} : ${JSON.stringify(online)}));
  process.exit(0);
}
const setting = process.argv.find((arg) => arg.startsWith('model_catalog_json='));
const catalogPath = setting ? JSON.parse(setting.slice('model_catalog_json='.length)) : null;
log({ event: 'start', catalogPath });
if (${failStartup}) process.exit(1);
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'codex_cli_rs/${version}' } });
  if (message.method === 'config/read') send({ id: message.id, result: { layers: [] } });
  if (message.method === 'thread/start') {
    log({ event: 'thread', params: message.params });
    send({ id: message.id, result: { thread: { id: 'thread' }, model: ${JSON.stringify(MODEL)} } });
  }
  if (message.method === 'turn/start') {
    log({ event: 'turn' });
    send({ id: message.id, result: { turn: { id: 'turn' } } });
    if (${toolCall}) {
      send({ id: 90, method: 'item/tool/call', params: {
        threadId: 'thread', turnId: 'turn', callId: 'call-test', tool: 'ext_tool_001', arguments: {}
      } });
    } else if (!${holdTurn}) {
      send({ method: 'item/completed', params: { threadId: 'thread', turnId: 'turn', item: {
        id: 'answer', type: 'agentMessage', text: 'Done', phase: 'final_answer'
      } } });
      send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } } });
    }
  }
  if (message.method === 'turn/interrupt') {
    send({ id: message.id, result: {} });
    send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'interrupted' } } });
  }
});
`, { mode: 0o755 });
  await fs.chmod(command, 0o755);
  const calls = async () => {
    try {
      return (await fs.readFile(logPath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  };
  return { directory, command, calls, events: [] };
}

function manager(t, f, isolated = true) {
  const instance = new CodexSessionManager({
    requestTimeoutMs: 3000,
    codex: {
      command: f.command, cwd: f.directory, dynamicToolsOnly: isolated,
      idleTimeoutMs: 0, closeKillTimeoutMs: 100, maxSessions: 2,
    },
  }, { tracer: {
    scope() { return this; },
    log(event) { f.events.push(event); },
  } });
  t.after(() => instance.close());
  return instance;
}

function run(instance, abortSignal = null, { stream = false, tools = [], messages = [{ role: 'user', content: 'Complete the test.' }] } = {}) {
  const args = [{ get: () => '', ...(abortSignal ? { abortSignal } : {}) }, {
    model: CLAUDE_MODEL,
    messages,
    tools,
  }, {
    provider: 'codex', requestedModel: CLAUDE_MODEL, upstreamModel: MODEL,
    sandbox: 'workspace-write', approvalPolicy: 'never', reasoningEffort: 'max',
  }];
  return stream ? instance.streamRequest(...args, async () => {}) : instance.processRequest(...args);
}

async function waitForBoundary(f, count = 1) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (f.events.filter((event) => event === 'codex.boundary.started').length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for the active boundary');
}

async function waitForCall(f, event) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const call = (await f.calls()).find((entry) => entry.event === event);
    if (call) return call;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${event}`);
}

test('isolated catalog suppresses current and future native experimental tools while preserving other metadata', POSIX_ONLY, async (t) => {
  const f = await fixture(t);
  const snapshot = await createCodexToolCatalog({ command: f.command, cwd: f.directory, model: MODEL });
  t.after(snapshot.dispose);
  const expected = structuredClone(CATALOG);
  for (const model of expected.models) {
    model.experimental_supported_tools = [];
    model.apply_patch_tool_type = null;
    model.tool_mode = 'direct';
  }
  assert.deepEqual(JSON.parse(await fs.readFile(snapshot.filePath, 'utf8')), expected);
  assert.equal((await fs.stat(snapshot.filePath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(snapshot.filePath))).mode & 0o777, 0o700);
  assert.deepEqual(await f.calls(), [{ event: 'catalog', bundled: true }]);
  await snapshot.dispose();
  await snapshot.dispose();
  await assert.rejects(fs.access(path.dirname(snapshot.filePath)), { code: 'ENOENT' });
});

test('catalog rejects relative TMPDIR before creating storage or launching Codex', POSIX_ONLY, async (t) => {
  const f = await fixture(t);
  t.mock.method(os, 'tmpdir', () => 'relative-temp');
  await assert.rejects(
    createCodexToolCatalog({ command: f.command, cwd: f.directory, model: MODEL }),
    /TMPDIR must be an absolute path/
  );
  assert.deepEqual(await f.calls(), []);
});

test('catalog rejects storage that ignores private permissions or ownership and removes partial snapshots', POSIX_ONLY, async (t) => {
  const f = await fixture(t);
  for (const scenario of ['directory-mode', 'file-mode', 'file-owner']) {
    await t.test(scenario, async (child) => {
      let directory = null;
      const originalMkdtemp = fs.mkdtemp.bind(fs);
      const originalLstat = fs.lstat.bind(fs);
      child.mock.method(fs, 'mkdtemp', async (...args) => {
        directory = await originalMkdtemp(...args);
        return directory;
      });
      child.mock.method(fs, 'lstat', async (target, ...args) => {
        const stats = await originalLstat(target, ...args);
        const targeted = scenario === 'directory-mode' ? target === directory : target === path.join(directory, 'models.json');
        if (!targeted) return stats;
        return Object.assign(Object.create(stats), scenario === 'file-owner'
          ? { uid: stats.uid + 1 }
          : { mode: stats.mode | 0o044 });
      });
      await assert.rejects(
        createCodexToolCatalog({ command: f.command, cwd: f.directory, model: MODEL }),
        /owner-only permissions.*On WSL.*TMPDIR/
      );
      assert.ok(directory);
      await assert.rejects(fs.access(directory), { code: 'ENOENT' });
    });
  }
});

test('catalog discovers absent models online once and fails when no catalog contains the model', POSIX_ONLY, async (t) => {
  const f = await fixture(t, { bundled: { models: [] }, online: CATALOG });
  const snapshots = [];
  t.after(() => Promise.all(snapshots.map((snapshot) => snapshot.dispose())));
  for (let index = 0; index < 2; index += 1) {
    snapshots.push(await createCodexToolCatalog({ command: f.command, cwd: f.directory, model: MODEL }));
  }
  assert.notEqual(snapshots[0].filePath, snapshots[1].filePath);
  assert.deepEqual(await f.calls(), [
    { event: 'catalog', bundled: true }, { event: 'catalog', bundled: false },
  ]);
  const missing = await fixture(t, { bundled: { unexpected: true } });
  const instance = manager(t, missing);
  await assert.rejects(run(instance), /cannot isolate Codex tools/);
  assert.equal((await missing.calls()).some((entry) => entry.event === 'start'), false);
});

test('app-server startup owns the snapshot, disables inherited context management, and cleans up on restart', POSIX_ONLY, async (t) => {
  const f = await fixture(t);
  const snapshots = [];
  for (let index = 0; index < 2; index += 1) {
    const instance = manager(t, f);
    await run(instance);
    const starts = (await f.calls()).filter((entry) => entry.event === 'start');
    const currentPath = starts.at(-1).catalogPath;
    assert.ok(currentPath);
    await fs.access(currentPath);
    snapshots.push(currentPath);
    const thread = (await f.calls()).find((entry) => entry.event === 'thread');
    assert.equal(thread.params.config['features.context_management'], false);
    await instance.close();
    await assert.rejects(fs.access(path.dirname(currentPath)), { code: 'ENOENT' });
  }
  assert.notEqual(snapshots[0], snapshots[1]);
});

test('failed app-server startup and obsolete versions clean their snapshots', POSIX_ONLY, async (t) => {
  for (const options of [{ failStartup: true }, { version: '0.170.0' }]) {
    const f = await fixture(t, options);
    const instance = manager(t, f);
    await assert.rejects(run(instance), options.failStartup ? /exited unexpectedly/ : /0\.171\.0 or newer/);
    await instance.close();
    const start = (await f.calls()).find((entry) => entry.event === 'start');
    assert.ok(start.catalogPath);
    await assert.rejects(fs.access(path.dirname(start.catalogPath)), { code: 'ENOENT' });
  }
});

test('closing during catalog creation cannot start an orphan app-server', POSIX_ONLY, async (t) => {
  const f = await fixture(t);
  const instance = manager(t, f);
  const pending = run(instance);
  pending.catch(() => {});
  await instance.close();
  await assert.rejects(pending, /closed during startup/);
  assert.equal((await f.calls()).some((entry) => entry.event === 'start'), false);
});

test('manager close rejects active text and stream consumers without waiting for upstream notifications', { ...POSIX_ONLY, timeout: 5000 }, async (t) => {
  for (const stream of [false, true]) {
    const f = await fixture(t, { holdTurn: true });
    const instance = manager(t, f);
    const pending = run(instance, null, { stream });
    pending.catch(() => {});
    await waitForBoundary(f);
    await Promise.all([instance.close(), instance.close()]);
    await assert.rejects(pending, /Codex app-server was closed/);
    assert.equal((await f.calls()).filter((entry) => entry.event === 'start').length, 1);
    const start = (await f.calls()).find((entry) => entry.event === 'start');
    await assert.rejects(fs.access(path.dirname(start.catalogPath)), { code: 'ENOENT' });
  }
});

test('manager close rejects a pending tool continuation and cleans its snapshot', { ...POSIX_ONLY, timeout: 5000 }, async (t) => {
  const f = await fixture(t, { toolCall: true });
  const instance = manager(t, f);
  const tools = [{ name: 'Read', description: 'Read a test value.', input_schema: { type: 'object' } }];
  const outcome = await run(instance, null, { tools });
  assert.equal(outcome.type, 'tool_use');
  const pending = run(instance, null, { tools, messages: [
    { role: 'user', content: 'Complete the test.' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call-test', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-test', content: 'Test value.' }] },
  ] });
  pending.catch(() => {});
  await waitForBoundary(f, 2);
  await instance.close();
  await assert.rejects(pending, /Codex app-server was closed/);
  const start = (await f.calls()).find((entry) => entry.event === 'start');
  await assert.rejects(fs.access(path.dirname(start.catalogPath)), { code: 'ENOENT' });
});

test('aborted requests release their isolated catalog and nonisolated requests do not create one', POSIX_ONLY, async (t) => {
  const f = await fixture(t, { holdTurn: true });
  const instance = manager(t, f);
  const controller = new AbortController();
  const pending = run(instance, controller.signal);
  pending.catch(() => {});
  await waitForCall(f, 'turn');
  controller.abort();
  await assert.rejects(pending);
  await instance.close();
  const start = (await f.calls()).find((entry) => entry.event === 'start');
  await assert.rejects(fs.access(path.dirname(start.catalogPath)), { code: 'ENOENT' });

  const ordinary = await fixture(t);
  const nonisolated = manager(t, ordinary, false);
  await run(nonisolated);
  assert.equal((await ordinary.calls()).some((entry) => entry.event === 'catalog'), false);
  assert.equal((await ordinary.calls()).find((entry) => entry.event === 'start').catalogPath, null);
});
