import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildWorkflowClientEnv,
  buildWorkflowGatewayConfig,
} from '../js/gateway/workflow-config.js';
import { resolveModelRoute } from '../js/gateway/model-routing.js';
import {
  MANAGED_GATEWAY_AUTH_ENV_NAME,
  environmentWithoutGatewayAndAnthropicCredentials,
} from '../js/utils/child-env.js';
import {
  buildClaudeSettingsOverrideEnvironment,
  prepareClaudeThirdPartyModelSupport,
} from '../js/utils/claude-config.js';
import { installedClaudePolicy } from './helpers/installed-cli-policy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'js', 'cli', 'claude-workflow.js');
const DIRECT_MAIN_MODEL_ID = 'codex';
const DIRECT_RESULT = 'CLEAN_HOME_CODEX_DIRECT_OK';
const CLAUDE_CLI = installedClaudePolicy();
const WORKFLOW_ENV_PREFIXES = Object.freeze([
  'ANTHROPIC_',
  'CLAUDE_CODE_',
  'CLAUDE_WORKFLOW_',
  'CODEX_',
  'DEEPSEEK_',
  'GLM_',
  'KIMI_',
  'OPENAI_',
  'ULTRATHINK_',
  'ZAI_',
]);

function isolatedEnvironment(home, extra = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (WORKFLOW_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      delete env[name];
    }
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    ...extra,
  };
}

async function withProcessEnvironment(env, callback) {
  const previous = { ...process.env };
  for (const name of Object.keys(process.env)) {
    delete process.env[name];
  }
  Object.assign(process.env, env);
  try {
    return await callback();
  } finally {
    for (const name of Object.keys(process.env)) {
      delete process.env[name];
    }
    Object.assign(process.env, previous);
  }
}

function fakeCodexCommand(logPath) {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const args = process.argv.slice(2);
const logPath = ${JSON.stringify(logPath)};

if (args[0] === '--version') {
  process.stdout.write('codex-cli 0.171.0\\n');
  process.exit(0);
}
if (args[0] === 'debug' && args[1] === 'models') {
  process.stdout.write(JSON.stringify({ models: [{
    slug: 'gpt-6.2-astra', context_window: 272000, max_context_window: 872000,
    effective_context_window_percent: 95,
    supported_reasoning_levels: [{ effort: 'max' }],
    experimental_supported_tools: ['send_user_message_async', 'clock']
  }] }));
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') {
  process.stdout.write('Logged in using ChatGPT\\n');
  process.exit(0);
}
if (args[0] !== 'app-server') {
  process.exit(2);
}

function log(value) {
  fs.appendFileSync(logPath, JSON.stringify(value) + '\\n');
}
function send(value) {
  process.stdout.write(JSON.stringify(value) + '\\n');
}
function sendBatch(values) {
  process.stdout.write(values.map((value) => JSON.stringify(value) + '\\n').join(''));
}

log({
  event: 'environment',
  hasAnthropicAuthToken: Object.hasOwn(process.env, 'ANTHROPIC_AUTH_TOKEN'),
  hasAnthropicApiKey: Object.hasOwn(process.env, 'ANTHROPIC_API_KEY'),
  hasManagedGatewayToken: Object.hasOwn(
    process.env,
    ${JSON.stringify(MANAGED_GATEWAY_AUTH_ENV_NAME)}
  ),
  hasGatewaySharedSecret: Object.hasOwn(process.env, 'ULTRATHINK_GATEWAY_SHARED_SECRET')
});

let turnNumber = 0;
const input = readline.createInterface({ input: process.stdin });
input.on('line', function onLine(line) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({
      id: message.id,
      result: {
        userAgent:
          'claude_workflow_gateway/0.171.0 (Linux 6.6; x86_64) ' +
          'terminal/1.0.0 (claude_workflow_gateway; 0.1.0)',
      },
    });
    return;
  }
  if (message.method === 'config/read') {
    send({ id: message.id, result: { layers: [] } });
    return;
  }
  if (message.method === 'thread/start') {
    log({ event: 'thread', model: message.params.model });
    send({ id: message.id, result: { thread: { id: 'thread-clean-home' } } });
    return;
  }
  if (message.method !== 'turn/start') {
    return;
  }

  turnNumber += 1;
  const turnId = 'turn-clean-home-' + turnNumber;
  log({ event: 'turn', effort: message.params.effort });
  sendBatch([
    { id: message.id, result: { turn: { id: turnId } } },
    { method: 'item/started', params: { turnId, item: {
      id: 'final-' + turnNumber,
      type: 'agentMessage',
      phase: 'final_answer',
      text: ''
    } } },
    { method: 'item/agentMessage/delta', params: {
      turnId,
      itemId: 'final-' + turnNumber,
      delta: ${JSON.stringify(DIRECT_RESULT)}
    } },
    { method: 'item/completed', params: { turnId, item: {
      id: 'final-' + turnNumber,
      type: 'agentMessage',
      phase: 'final_answer',
      text: ${JSON.stringify(DIRECT_RESULT)}
    } } },
    { method: 'thread/tokenUsage/updated', params: {
      turnId,
      tokenUsage: { last: { inputTokens: 24, outputTokens: 5, totalTokens: 29 } }
    } },
    { method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } }
  ]);
});
setInterval(function keepAlive() {}, 1000);
`;
}

async function makeExecutable(target, content) {
  await fsp.writeFile(target, content, { mode: 0o755 });
  await fsp.chmod(target, 0o755);
}

function runLauncher(env, cwd) {
  return new Promise(function run(resolve, reject) {
    const child = spawn(process.execPath, [CLI, `Reply with exactly ${DIRECT_RESULT}.`], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(function stopTimedOutLauncher() {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(function forceStopTimedOutLauncher() {
        child.kill('SIGKILL');
      }, 1_000).unref();
    }, 20_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', function launcherError(error) {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', function launcherClosed(status, signal) {
      clearTimeout(timer);
      resolve({ signal, status, stderr, stdout, timedOut });
    });
  });
}

async function readJsonLines(target) {
  const source = await fsp.readFile(target, 'utf8');
  return source
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('direct Codex main generates local client auth and strips it from the Codex process', async function (t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'claude-workflow-codex-auth-'));
  const home = path.join(root, 'home');
  await fsp.mkdir(home);
  t.after(async () => fsp.rm(root, { recursive: true, force: true }));

  await withProcessEnvironment(
    isolatedEnvironment(home, {
      ULTRATHINK_GATEWAY_MAIN_MODEL_ID: DIRECT_MAIN_MODEL_ID,
      ULTRATHINK_GATEWAY_MAIN_PROVIDER: 'codex',
    }),
    async function verifyConfiguration() {
      const { config, mainModelId, subagentModelId } = buildWorkflowGatewayConfig();
      const mainRoute = resolveModelRoute(mainModelId, config);
      assert.equal(mainRoute.provider, 'codex');
      assert.match(config.sharedSecret, /^[A-Za-z0-9_-]{43}$/u);
      assert.deepEqual(config.anthropicPassthroughModels, []);

      const clientEnv = buildWorkflowClientEnv(
        config,
        'http://127.0.0.1:4319',
        subagentModelId,
        mainModelId
      );
      assert.equal(clientEnv.ANTHROPIC_AUTH_TOKEN, config.sharedSecret);
      assert.equal(clientEnv.ANTHROPIC_API_KEY, config.sharedSecret);
      assert.equal(clientEnv[MANAGED_GATEWAY_AUTH_ENV_NAME], config.sharedSecret);
      assert.equal(clientEnv.CLAUDE_CODE_DISABLE_TERMINAL_TITLE, '1');
      assert.equal(clientEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '828400');
      assert.equal(clientEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '784800');
      assert.equal(clientEnv.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK, '1');
      assert.equal(mainModelId, 'codex-astra');
      assert.equal(clientEnv.ANTHROPIC_CUSTOM_MODEL_OPTION, 'codex-astra');
      assert.match(clientEnv.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME, /^Codex /u);
      assert.match(
        clientEnv.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION,
        /^codex:gpt-6\.2-astra\/max through claude-workflow$/u
      );
      assert.equal(
        clientEnv.ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES,
        'effort,xhigh_effort,max_effort'
      );
      assert.equal(
        buildClaudeSettingsOverrideEnvironment(clientEnv, clientEnv)
          .CLAUDE_CODE_DISABLE_TERMINAL_TITLE,
        '1'
      );

      const codexEnv = environmentWithoutGatewayAndAnthropicCredentials({
        ...process.env,
        ...clientEnv,
      });
      assert.equal(Object.hasOwn(codexEnv, 'ANTHROPIC_AUTH_TOKEN'), false);
      assert.equal(Object.hasOwn(codexEnv, 'ANTHROPIC_API_KEY'), false);
      assert.equal(Object.hasOwn(codexEnv, MANAGED_GATEWAY_AUTH_ENV_NAME), false);
      assert.equal(Object.hasOwn(codexEnv, 'ULTRATHINK_GATEWAY_SHARED_SECRET'), false);
    }
  );
});

test('direct Codex keeps explicit Anthropic routes behind a separate upstream credential', async function (t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'claude-workflow-codex-mixed-'));
  const home = path.join(root, 'home');
  await fsp.mkdir(home);
  t.after(async () => fsp.rm(root, { recursive: true, force: true }));

  const mixedRouteEnvironment = isolatedEnvironment(home, {
    ULTRATHINK_GATEWAY_ANTHROPIC_PASSTHROUGH_MODELS: 'claude-fable-5*',
    ULTRATHINK_GATEWAY_MAIN_MODEL_ID: DIRECT_MAIN_MODEL_ID,
    ULTRATHINK_GATEWAY_MAIN_PROVIDER: 'codex',
  });
  await withProcessEnvironment(mixedRouteEnvironment, async function rejectMissingUpstreamAuth() {
    assert.throws(
      () => buildWorkflowGatewayConfig(),
      /ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY.*Codex-only/u
    );
  });

  await withProcessEnvironment(
    {
      ...mixedRouteEnvironment,
      ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY: 'test-dedicated-anthropic-key',
    },
    async function acceptSeparateUpstreamAuth() {
      const { config } = buildWorkflowGatewayConfig();
      assert.match(config.sharedSecret, /^[A-Za-z0-9_-]{43}$/u);
      assert.deepEqual(config.anthropicPassthroughModels, ['claude-fable-5*']);
      assert.equal(config.anthropic.apiKey, 'test-dedicated-anthropic-key');
      assert.notEqual(config.sharedSecret, config.anthropic.apiKey);
    }
  );
});

test(
  'installed Claude accepts direct Codex from a clean home without prepare-state mutation',
  {
    skip:
      CLAUDE_CLI.skip ||
      (process.platform === 'win32' ? 'installed Claude/Codex contract requires POSIX signals' : false),
  },
  async function (t) {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'claude-workflow-clean-codex-'));
    const home = path.join(root, 'home');
    const claudeConfig = path.join(home, 'custom-claude-config');
    const cwd = path.join(root, 'repo');
    const codexCommand = path.join(root, 'fake-codex');
    const codexLog = path.join(root, 'codex.jsonl');
    await fsp.mkdir(home);
    await fsp.mkdir(path.join(cwd, '.git'), { recursive: true });
    await makeExecutable(codexCommand, fakeCodexCommand(codexLog));
    t.after(async () => fsp.rm(root, { recursive: true, force: true }));

    const env = isolatedEnvironment(home, {
      CLAUDE_CONFIG_DIR: claudeConfig,
      ULTRATHINK_GATEWAY_CODEX_COMMAND: codexCommand,
      ULTRATHINK_GATEWAY_MAIN_MODEL_ID: DIRECT_MAIN_MODEL_ID,
      ULTRATHINK_GATEWAY_MAIN_PROVIDER: 'codex',
    });
    const prepared = prepareClaudeThirdPartyModelSupport(env);
    assert.equal(prepared.changed, false);
    assert.equal(prepared.stateChanged, false);
    assert.equal(prepared.settingsChanged, false);
    assert.equal(prepared.backupPath, null);
    await assert.rejects(fsp.access(prepared.path));

    const result = await runLauncher(env, cwd);
    assert.equal(result.timedOut, false, result.stderr || result.stdout);
    assert.equal(result.signal, null, result.stderr || result.stdout);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, new RegExp(DIRECT_RESULT, 'u'));

    const entries = await readJsonLines(codexLog);
    const environmentEntry = entries.find((entry) => entry.event === 'environment');
    assert.ok(environmentEntry, 'fake Codex app-server did not start');
    assert.equal(environmentEntry.hasAnthropicAuthToken, false);
    assert.equal(environmentEntry.hasAnthropicApiKey, false);
    assert.equal(environmentEntry.hasManagedGatewayToken, false);
    assert.equal(environmentEntry.hasGatewaySharedSecret, false);
    assert.equal(
      entries.filter((entry) => entry.event === 'thread').length,
      1,
      'direct Codex should make one total provider request for a plain prompt'
    );
    assert.equal(entries.filter((entry) => entry.event === 'turn').length, 1);
    assert.equal(
      entries.filter((entry) => entry.event === 'thread').every((entry) =>
        entry.model === 'gpt-6.2-astra'
      ),
      true
    );
    assert.equal(
      entries.filter((entry) => entry.event === 'turn').every((entry) => entry.effort === 'max'),
      true
    );
  }
);
