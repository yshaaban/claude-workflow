import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { createGatewayServer } from '../js/gateway/server.js';
import { resolveModelRoute } from '../js/gateway/model-routing.js';
import { buildWorkflowClientEnv, buildWorkflowGatewayConfig, buildWorkflowModelPicker, defaultWorkflowAnthropicPassthroughModels } from '../js/gateway/workflow-config.js';
import { managedWorkflowEnvironmentCleanupShell, serializeWorkflowEnvironment } from '../js/cli/claude-workflow-daemon.js';
import {
  buildClaudeSettingsOverrideEnvironment,
  createPrivateClaudeSettingsOverride,
} from '../js/utils/claude-config.js';
import { CLAUDE_TERMINAL_TITLE_ENV_NAME, environmentWithoutManagedWorkflowEnvironment } from '../js/utils/child-env.js';
import { installedCliPolicy } from './helpers/installed-cli-policy.js';

const CLAUDE_CLI = installedCliPolicy({ command: 'claude', displayName: 'Claude Code' });
const MODEL = 'claude-fable-5-1';
const RESULT = 'FABLE_NATIVE_TOOL_LOOP_OK';

function fakeCodexCommand(logPath) {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
if (process.argv[2] === '--version') { process.stdout.write('codex-cli 0.153.4\\n'); process.exit(0); }
if (process.argv[2] === 'debug' && process.argv[3] === 'models') {
  process.stdout.write(JSON.stringify({ models: [{
    slug: 'gpt-6-astra', display_name: 'GPT-6 Astra',
    context_window: 272000, max_context_window: 872000,
    supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(effort => ({ effort })),
    experimental_supported_tools: ['send_user_message_async', 'clock'],
    supports_image_detail_original: true
  }] }));
  process.exit(0);
}
if (process.argv[2] !== 'app-server') { process.stdout.write('[]\\n'); process.exit(0); }
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const log = value => fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(value) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'claude_workflow_gateway/0.153.4' } });
  } else if (message.method === 'config/read') {
    send({ id: message.id, result: { layers: [] } });
  } else if (message.method === 'thread/start') {
    log({ event: 'thread', model: message.params.model });
    send({ id: message.id, result: { thread: { id: 'thread-native-agent' } } });
  } else if (message.method === 'turn/start') {
    log({ event: 'turn', effort: message.params.effort });
    const turnId = 'turn-native-agent';
    const item = { id: 'answer-native-agent', type: 'agentMessage', phase: 'final_answer', text: 'NATIVE_CODEX_AGENT_OK' };
    send({ id: message.id, result: { turn: { id: turnId } } });
    send({ method: 'item/started', params: { turnId, item: { ...item, text: '' } } });
    send({ method: 'item/agentMessage/delta', params: { turnId, itemId: item.id, delta: item.text } });
    send({ method: 'item/completed', params: { turnId, item } });
    send({ method: 'thread/tokenUsage/updated', params: { turnId, tokenUsage: { last: { inputTokens: 24, outputTokens: 5, totalTokens: 29 } } } });
    send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });
  }
});
`;
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.closeAllConnections?.();
    server.close((error) => error ? reject(error) : resolve());
  });
}

function runClaude(args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1_000).unref();
    }, 25_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

function respondWithMessage(response, requestBody, content, stopReason, stopDetails = null) {
  const message = {
    id: `msg_fable_${stopReason}`,
    type: 'message',
    role: 'assistant',
    model: requestBody.model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details: stopDetails,
    usage: { input_tokens: 100, output_tokens: stopReason === 'refusal' ? 0 : 20 },
  };
  if (!requestBody.stream) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(message));
    return;
  }
  const events = [];
  function event(type, data) {
    events.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  }
  event('message_start', { message: { ...message, content: [], stop_reason: null, stop_details: null, usage: { input_tokens: 100, output_tokens: 0 } } });
  for (const [index, block] of content.entries()) {
    if (block.type === 'thinking') {
      event('content_block_start', { index, content_block: { type: 'thinking', thinking: '' } });
      event('content_block_delta', { index, delta: { type: 'signature_delta', signature: block.signature } });
    } else if (block.type === 'tool_use') {
      event('content_block_start', { index, content_block: { ...block, input: {} } });
      event('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    } else {
      event('content_block_start', { index, content_block: { type: 'text', text: '' } });
      event('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } });
    }
    event('content_block_stop', { index });
  }
  event('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null, stop_details: stopDetails }, usage: { output_tokens: message.usage.output_tokens } });
  event('message_stop', {});
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  response.end(events.join(''));
}

function isolatedEnvironment(extra = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(?:ANTHROPIC_|CLAUDE_|CLAUDECODE$|CODEX_|DEEPSEEK_|GLM_|KIMI_|OPENAI_|QWEN_|ULTRATHINK_|ZAI_)/u.test(name)) {
      delete env[name];
    }
  }
  return { ...env, ...extra };
}

function withEnvironment(env, callback) {
  const previous = { ...process.env };
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, env);
  try {
    return callback();
  } finally {
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, previous);
  }
}

async function nativeFixture(t, reply, options = {}) {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'claude-workflow-native-fable-'));
    const fixtureHome = path.join(root, 'home');
    const cwd = path.join(root, 'repo');
    await fsp.mkdir(fixtureHome);
    await fsp.mkdir(path.join(cwd, '.git'), { recursive: true });
    const fixtureFile = path.join(cwd, 'fixture.txt');
    await fsp.writeFile(fixtureFile, 'Native Fable tool output.\n');
    t.after(() => fsp.rm(root, { recursive: true, force: true }));

    const requests = [];
    const paths = [];
    const upstream = http.createServer(async function handle(request, response) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
      paths.push(pathname);
      if (pathname.endsWith('/count_tokens')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ input_tokens: 100 }));
        return;
      }
      if (pathname !== '/v1/messages') {
        response.writeHead(404);
        response.end();
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(body);
      response.setHeader('request-id', `req_native_fable_${requests.length}`);
      reply(response, body, { fixtureFile, requests });
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    t.after(() => closeServer(upstream));
    const codexCommand = path.join(root, 'codex-must-not-run');
    const codexLog = path.join(root, 'codex.jsonl');
    if (options.fakeCodex) {
      await fsp.writeFile(codexCommand, fakeCodexCommand(codexLog), { mode: 0o755 });
      await fsp.chmod(codexCommand, 0o755);
    }
    const workflow = withEnvironment(isolatedEnvironment({
      ULTRATHINK_GATEWAY_MAIN_MODEL_ID: MODEL,
      ULTRATHINK_GATEWAY_SHARED_SECRET: 'test-local-fable-key',
      ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY: 'test-upstream-fable-key',
      ULTRATHINK_GATEWAY_ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
      // Any unintended Codex route fails locally; no installed provider can
      // turn this account-free compatibility check into a paid model call.
      ULTRATHINK_GATEWAY_CODEX_COMMAND: codexCommand,
      ...options.workflowEnv,
    }), () => buildWorkflowGatewayConfig({ host: '127.0.0.1', port: 0 }));
    const { config, mainModelId, subagentModelId } = workflow;
    const gateway = createGatewayServer(config);
    if (!gateway.server.listening) await once(gateway.server, 'listening');
    t.after(() => gateway.close());
    const clientEnv = buildWorkflowClientEnv(
      config, `http://127.0.0.1:${gateway.server.address().port}`, subagentModelId, mainModelId
    );
    const env = isolatedEnvironment({
      HOME: fixtureHome,
      USERPROFILE: fixtureHome,
      CLAUDE_CONFIG_DIR: path.join(fixtureHome, '.claude'),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_MAX_RETRIES: '0',
      [CLAUDE_TERMINAL_TITLE_ENV_NAME]: '1',
      NO_PROXY: '127.0.0.1',
      no_proxy: '127.0.0.1',
      ...options.inheritedEnv,
    });
    for (const [name, value] of Object.entries(clientEnv)) {
      if (value === null || value === undefined) delete env[name];
      else env[name] = String(value);
    }
    const settings = createPrivateClaudeSettingsOverride(
      buildClaudeSettingsOverrideEnvironment(clientEnv, env),
      { options: [{ model: mainModelId, label: 'Fable 5.1' }, { model: subagentModelId, label: 'Codex' }], replaceBuiltInOptions: true }
    );
    t.after(() => settings.cleanup());
    await fsp.mkdir(env.CLAUDE_CONFIG_DIR, { recursive: true });
    await fsp.writeFile(path.join(env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify({
      switchModelsOnFlag: true,
      ...options.settings,
    }));
    return {
      clientEnv, codexLog, config, fixtureFile, paths, requests, subagentModelId,
      userSettingsPath: path.join(env.CLAUDE_CONFIG_DIR, 'settings.json'),
      run(prompt) {
        return runClaude([
          '--print', '--output-format', 'json', '--model', mainModelId,
          ...(options.effort === null ? [] : ['--effort', options.effort || 'max']),
          '--settings', settings.path, '--dangerously-skip-permissions',
          ...(options.agents ? ['--agents', JSON.stringify(options.agents)] : []),
          '--tools', options.tools || 'Read',
          '--', prompt,
        ], { cwd, env });
      },
    };
}

test('installed Claude uses native Fable 5.1 adaptive thinking and replays a tool turn through the gateway',
  { skip: CLAUDE_CLI.skip }, async function (t) {
    const thinking = { type: 'thinking', thinking: '', signature: 'opaque-fable-5-1-prefix-signature' };
    let tool;
    const fixture = await nativeFixture(t, (response, body, { fixtureFile, requests }) => {
      tool = { type: 'tool_use', id: 'toolu_native_fable', name: 'Read', input: { file_path: fixtureFile } };
      respondWithMessage(response, body,
        requests.length === 1 ? [thinking, tool] : [{ type: 'text', text: RESULT }],
        requests.length === 1 ? 'tool_use' : 'end_turn');
    });
    const { requests, paths } = fixture;
    const result = await fixture.run(`Read ${fixture.fixtureFile}, then reply with exactly ${RESULT}.`);
    assert.equal(result.signal, null, result.stderr || result.stdout);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, new RegExp(RESULT, 'u'));
    assert.equal(requests.length, 2, 'one inference for the tool call and one after its result; no rewriting request');
    for (const request of requests) {
      assert.equal(request.model, MODEL);
      assert.equal(request.thinking?.type, 'adaptive');
      assert.equal(request.output_config?.effort, 'max');
      assert.equal(['any', 'tool'].includes(request.tool_choice?.type), false);
    }
    assert.deepEqual(requests[1].system, requests[0].system, 'the signed system prefix stays stable across the tool turn');
    assert.deepEqual(requests[1].tools, requests[0].tools, 'the signed tool definitions stay stable across the tool turn');
    const replayed = requests[1].messages.flatMap((message) => Array.isArray(message.content) ? message.content : []);
    assert.deepEqual(replayed.find((block) => block.type === 'thinking'), thinking);
    assert.deepEqual(replayed.find((block) => block.type === 'tool_use'), tool);
    const toolResult = replayed.find((block) => block.type === 'tool_result' && block.tool_use_id === tool.id);
    assert.ok(toolResult, 'Claude must execute the native tool and continue the conversation');
    assert.match(JSON.stringify(toolResult.content), /Native Fable tool output\./u);
    assert.equal(toolResult.is_error === true, false);
    assert.equal(paths.some((entry) => entry.endsWith('/models')), false);
  });

for (const [category, expectedModel] of [['bio', 'claude-opus-5'], ['cyber', 'claude-opus-4-8']]) {
  test(`installed Claude preserves the native Fable ${category} fallback on Anthropic`,
    { skip: CLAUDE_CLI.skip }, async function (t) {
      const fixture = await nativeFixture(t, (response, body, { requests }) => {
        if (requests.length === 1) {
          respondWithMessage(response, body, [], 'refusal', {
            type: 'refusal', category, explanation: 'Synthetic classifier refusal for an account-free compatibility test.',
          });
        } else {
          respondWithMessage(response, body, [{ type: 'text', text: RESULT }], 'end_turn');
        }
      });
      const result = await fixture.run(`Reply with exactly ${RESULT}.`);
      assert.equal(result.signal, null, result.stderr || result.stdout);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, new RegExp(RESULT, 'u'));
      assert.deepEqual(fixture.requests.map((request) => request.model), [MODEL, expectedModel]);
      assert.equal(fixture.clientEnv.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude-opus-5');
      assert.equal(fixture.clientEnv.CLAUDE_CODE_SUBAGENT_MODEL, fixture.subagentModelId);
      assert.equal(fixture.clientEnv.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, '1');
    });
}

test('installed Claude keeps an explicitly Opus-pinned subagent at Codex max while the coordinator uses xhigh',
  { skip: CLAUDE_CLI.skip || (process.platform === 'win32' && 'requires a POSIX executable fixture') }, async function (t) {
    const agentCall = {
      type: 'tool_use', id: 'toolu_forced_agent', name: 'Agent',
      input: {
        subagent_type: 'opus-pinned', description: 'Check the agent model',
        prompt: 'Reply with exactly NATIVE_CODEX_AGENT_OK.', run_in_background: false,
      },
    };
    const fixture = await nativeFixture(t, (response, body, { requests }) => {
      respondWithMessage(response, body,
        requests.length === 1 ? [agentCall] : [{ type: 'text', text: RESULT }],
        requests.length === 1 ? 'tool_use' : 'end_turn');
    }, {
      fakeCodex: true,
      effort: 'xhigh',
      tools: 'Agent,Read',
      agents: { 'opus-pinned': { description: 'Check the configured model.', prompt: 'Return the requested test marker.', model: 'opus' } },
    });
    const result = await fixture.run(`Use opus-pinned to check the agent model, then reply with exactly ${RESULT}.`);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.signal, null, result.stderr || result.stdout);
    assert.deepEqual(fixture.requests.map((request) => request.model), [MODEL, MODEL],
      'the Opus-pinned agent must not make a third Anthropic request');
    assert.deepEqual(fixture.requests.map((request) => request.output_config?.effort), ['xhigh', 'xhigh']);
    const resultBlocks = fixture.requests[1].messages.flatMap((message) => Array.isArray(message.content) ? message.content : []);
    const resultBlock = resultBlocks.find((block) => block.type === 'tool_result' && block.tool_use_id === agentCall.id);
    assert.ok(resultBlock);
    assert.equal(resultBlock.is_error === true, false, JSON.stringify(resultBlock));
    assert.match(JSON.stringify(resultBlock.content), /NATIVE_CODEX_AGENT_OK/u);
    const agentEvents = (await fsp.readFile(fixture.codexLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(agentEvents, [
      { event: 'thread', model: 'gpt-6-astra' },
      { event: 'turn', effort: 'max' },
    ]);
  });

test('installed Claude preserves refusals that have no native category fallback',
  { skip: CLAUDE_CLI.skip }, async function (t) {
    const fixture = await nativeFixture(t, (response, body) => {
      respondWithMessage(response, body, [], 'refusal', {
        type: 'refusal', category: 'general_harms', explanation: 'Synthetic refusal with no configured fallback.',
      });
    });
    const result = await fixture.run('Return a test marker.');
    assert.equal(result.signal, null, result.stderr || result.stdout);
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const body = JSON.parse(result.stdout);
    assert.equal(body.stop_reason, 'refusal');
    assert.equal(body.is_error, true);
    assert.equal(fixture.requests.length, 1, 'no fallback is invented for an unmapped category');
  });

test('installed Claude can enable ultracode without a workflow effort override',
  { skip: CLAUDE_CLI.skip }, async function (t) {
    const fixture = await nativeFixture(t, (response, body) => {
      respondWithMessage(response, body, [{ type: 'text', text: RESULT }], 'end_turn');
    }, {
      effort: null,
      inheritedEnv: { CLAUDE_CODE_EFFORT_LEVEL: 'max' },
      settings: { enableWorkflows: true, env: { CLAUDE_CODE_EFFORT_LEVEL: 'max' } },
    });
    const before = await fsp.readFile(fixture.userSettingsPath, 'utf8');
    const result = await fixture.run('/effort ultracode');
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.doesNotMatch(result.stdout + result.stderr, /CLAUDE_CODE_EFFORT_LEVEL=.*overrides/u);
    assert.match(result.stdout, /Set effort level to ultracode/u);
    assert.equal(fixture.requests.length, 0, 'the native effort command needs no inference');
    assert.equal(resolveModelRoute(fixture.subagentModelId, fixture.config).reasoningEffort, 'max');
    assert.equal(await fsp.readFile(fixture.userSettingsPath, 'utf8'), before);
  });

test('installed Claude honors a native saved effort without adopting the Codex effort',
  { skip: CLAUDE_CLI.skip }, async function (t) {
    const fixture = await nativeFixture(t, (response, body) => {
      respondWithMessage(response, body, [{ type: 'text', text: RESULT }], 'end_turn');
    }, { effort: null, settings: { effortLevel: 'high' } });
    const result = await fixture.run(`Reply with exactly ${RESULT}.`);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0].output_config?.effort, 'high');
    assert.equal(resolveModelRoute(fixture.subagentModelId, fixture.config).reasoningEffort, 'max');
  });

for (const [codexEffort, claudeEffort, extra] of [
  ['max', 'xhigh', {}],
  ['ultra', 'high', {}],
  ['minimal', 'low', { ULTRATHINK_GATEWAY_SUBAGENT_UPSTREAM_MODEL: 'gpt-custom', ULTRATHINK_GATEWAY_CODEX_MODEL: 'gpt-custom' }],
]) {
  test(`installed Claude keeps native Fable ${claudeEffort} independent of Codex ${codexEffort}`,
    { skip: CLAUDE_CLI.skip }, async function (t) {
    const fixture = await nativeFixture(t, (response, body) => {
      respondWithMessage(response, body, [{ type: 'text', text: RESULT }], 'end_turn');
    }, { effort: claudeEffort, workflowEnv: { ULTRATHINK_GATEWAY_SUBAGENT_REASONING_EFFORT: codexEffort, ...extra } });
    const result = await fixture.run(`Reply with exactly ${RESULT}.`);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0].output_config?.effort, claudeEffort);
    assert.equal(resolveModelRoute(fixture.subagentModelId, fixture.config).reasoningEffort, codexEffort);
  });
}

function workflowForTest(extra = {}) {
  return withEnvironment(isolatedEnvironment({
    ULTRATHINK_GATEWAY_MAIN_MODEL_ID: MODEL,
    ULTRATHINK_GATEWAY_CODEX_COMMAND: 'claude-workflow-test-codex-unavailable',
    ...extra,
  }), () => buildWorkflowGatewayConfig());
}

test('workflow fallback defaults are exact, preserve picker scope, and do not change non-Anthropic routes', function () {
  const { config, mainModelId, subagentModelId } = workflowForTest();
  assert.deepEqual(config.anthropicPassthroughModels, [
    'claude-fable-5-1*', 'claude-opus-5', 'claude-opus-5[1m]', 'claude-opus-4-8', 'claude-opus-4-8[1m]',
  ]);
  for (const model of ['claude-opus-5', 'claude-opus-4-8']) {
    for (const alias of [model, `${model}[1m]`]) {
      const route = resolveModelRoute(alias, config);
      assert.equal(route.provider, 'anthropic');
      assert.equal(route.upstreamModel, model);
    }
  }
  assert.equal(resolveModelRoute('claude-opus-5-99', config).provider, 'codex');
  assert.equal(resolveModelRoute('claude-sonnet-5', config).provider, 'codex');
  assert.deepEqual(buildWorkflowModelPicker(config, mainModelId, subagentModelId).options.map((entry) => entry.model), [mainModelId, subagentModelId]);
  assert.deepEqual(defaultWorkflowAnthropicPassthroughModels('claude-opus-5'), [
    'claude-opus-5*', 'claude-opus-4-8', 'claude-opus-4-8[1m]',
  ]);
  const codexOnly = workflowForTest({ ULTRATHINK_GATEWAY_MAIN_PROVIDER: 'codex', ULTRATHINK_GATEWAY_MAIN_MODEL_ID: 'codex' });
  assert.deepEqual(codexOnly.config.anthropicPassthroughModels, []);
});

test('workflow refuses conflicting native fallback overrides without replacing operator routes', function () {
  for (const routeMap of [
    { 'claude-opus-5': { provider: 'codex', model: 'gpt-6-astra' } },
    { 'claude-opus-*': { provider: 'codex', model: 'gpt-6-astra' } },
    { 'claude-opus-4-8*': { provider: 'anthropic', model: 'claude-opus-5' } },
    { 'claude-opus-5[1m]': { provider: 'codex', model: 'gpt-6-astra' } },
  ]) {
    assert.throws(() => workflowForTest({ ULTRATHINK_GATEWAY_ROUTE_MAP_JSON: JSON.stringify(routeMap) }), /Native fallback.*route unchanged to Anthropic/u);
  }
  assert.throws(() => workflowForTest({ ULTRATHINK_GATEWAY_ANTHROPIC_PASSTHROUGH_MODELS: 'claude-fable-5-1*' }), /Native fallback.*route unchanged to Anthropic/u);
  const explicitRoutes = {
    'claude-opus-5*': { provider: 'anthropic', model: 'claude-opus-5', displayName: 'Operator fallback' },
    'claude-opus-4-8*': { provider: 'anthropic', model: 'claude-opus-4-8' },
    'custom-agent': { provider: 'codex', model: 'gpt-5.6-terra', reasoningEffort: 'high' },
  };
  const explicit = workflowForTest({
    ULTRATHINK_GATEWAY_ANTHROPIC_PASSTHROUGH_MODELS: 'none',
    ULTRATHINK_GATEWAY_ROUTE_MAP_JSON: JSON.stringify(explicitRoutes),
  });
  for (const [model, route] of Object.entries(explicitRoutes)) assert.deepEqual(explicit.config.routeMap[model], route);
});

test('forced agent routing is managed in settings and restored by session and shell cleanup',
  { skip: process.platform === 'win32' }, function () {
    const { config, mainModelId, subagentModelId } = workflowForTest();
    const clientEnv = buildWorkflowClientEnv(config, 'http://127.0.0.1:4318', subagentModelId, mainModelId);
    const settingsEnv = buildClaudeSettingsOverrideEnvironment(clientEnv, clientEnv);
    assert.equal(clientEnv.CLAUDE_CODE_EFFORT_LEVEL, null);
    assert.equal(settingsEnv.CLAUDE_CODE_EFFORT_LEVEL, '');
    assert.equal(settingsEnv.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, '1');
    assert.equal(settingsEnv.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude-opus-5');
    const overlay = serializeWorkflowEnvironment({
      CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5',
      CLAUDE_CODE_EFFORT_LEVEL: null,
    });
    const capture = 'const values = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(CLAUDE_CODE_EFFORT_LEVEL|CLAUDE_CODE_SUBAGENT_MODEL_FORCE|ANTHROPIC_DEFAULT_OPUS_MODEL|CLAUDE_WORKFLOW_GATEWAY_)/.test(key))); process.stdout.write(JSON.stringify(values));';
    const probe = [
      overlay,
      'test "$CLAUDE_CODE_SUBAGENT_MODEL_FORCE" = 1 || exit 10',
      'test "${CLAUDE_CODE_EFFORT_LEVEL+x}" != x || exit 13',
      '"$1" -e "$2"',
      managedWorkflowEnvironmentCleanupShell(),
      'test "$CLAUDE_CODE_SUBAGENT_MODEL_FORCE" = 0 || exit 11',
      'test "$ANTHROPIC_DEFAULT_OPUS_MODEL" = user-opus || exit 12',
      'test "$CLAUDE_CODE_EFFORT_LEVEL" = high || exit 14',
    ].join('\n');
    const result = spawnSync('bash', ['--noprofile', '--norc', '-c', probe, '_', process.execPath, capture], {
      encoding: 'utf8', env: isolatedEnvironment({ CLAUDE_CODE_EFFORT_LEVEL: 'high', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '0', ANTHROPIC_DEFAULT_OPUS_MODEL: 'user-opus' }),
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const restored = environmentWithoutManagedWorkflowEnvironment(JSON.parse(result.stdout));
    assert.deepEqual(restored, { CLAUDE_CODE_EFFORT_LEVEL: 'high', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '0', ANTHROPIC_DEFAULT_OPUS_MODEL: 'user-opus' });
  });
