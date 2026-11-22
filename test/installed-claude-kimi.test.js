import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import {
  CLAUDE_WORKFLOW_MANAGED_SETTINGS_ENV_NAMES,
  buildClaudeSettingsOverrideEnvironment,
  createPrivateClaudeSettingsOverride,
  prepareClaudeThirdPartyModelSupport,
} from '../js/utils/claude-config.js';
import { installedClaudePolicy } from './helpers/installed-cli-policy.js';

const CLAUDE_CLI = installedClaudePolicy();

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function runClaude(args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1_000).unref();
    }, 15_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ signal, status, stderr, stdout });
    });
  });
}

function sseEvent(name, data) {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

test(
  'installed Claude accepts plain K3/max through documented settings without state mutation',
  { skip: CLAUDE_CLI.skip },
  async function (t) {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'claude-workflow-clean-kimi-'));
    const home = path.join(root, 'home');
    const claudeConfig = path.join(home, 'custom-claude-config');
    const cwd = path.join(root, 'repo');
    await fsp.mkdir(home);
    await fsp.mkdir(path.join(cwd, '.git'), { recursive: true });
    t.after(async () => fsp.rm(root, { recursive: true, force: true }));

    const settingsPath = path.join(claudeConfig, 'settings.json');
    await fsp.mkdir(path.dirname(settingsPath), { recursive: true });
    const staleSettings = {
      env: {
        ...Object.fromEntries(
          CLAUDE_WORKFLOW_MANAGED_SETTINGS_ENV_NAMES.map((name) => [
            name,
            name.startsWith('CLAUDE_CODE_DISABLE_') || name.startsWith('CLAUDE_CODE_USE_')
              ? '1'
              : name === 'ANTHROPIC_BETAS'
                ? 'unsupported-beta'
                : name === 'ANTHROPIC_CUSTOM_HEADERS'
                  ? 'x-api-key: stale-header-key'
                  : 'stale-value',
          ])
        ),
        ANTHROPIC_API_KEY: 'stale-direct-provider-key',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
        ANTHROPIC_MODEL: 'stale-main-model',
        CLAUDE_CODE_EFFORT_LEVEL: 'low',
        CLAUDE_CODE_SUBAGENT_MODEL: 'stale-agent-model',
        UNRELATED_SETTING: 'preserved',
      },
      theme: 'dark',
    };
    const staleSettingsText = `${JSON.stringify(staleSettings, null, 2)}\n`;
    await fsp.writeFile(settingsPath, staleSettingsText, { mode: 0o644 });
    const projectSettingsPath = path.join(cwd, '.claude', 'settings.json');
    await fsp.mkdir(path.dirname(projectSettingsPath), { recursive: true });
    await fsp.writeFile(projectSettingsPath, staleSettingsText, { mode: 0o644 });
    const prepared = prepareClaudeThirdPartyModelSupport({
      CLAUDE_CONFIG_DIR: claudeConfig,
      HOME: home,
      USERPROFILE: home,
    });
    assert.equal(prepared.changed, false);
    assert.equal(prepared.stateChanged, false);
    assert.equal(prepared.settingsChanged, false);
    assert.equal(prepared.path, path.join(claudeConfig, '.claude.json'));
    assert.equal(prepared.backupPath, null);
    assert.equal(prepared.settingsBackupPath, null);
    await assert.rejects(fsp.access(prepared.path));
    assert.equal(await fsp.readFile(settingsPath, 'utf8'), staleSettingsText);
    assert.equal(await fsp.readFile(projectSettingsPath, 'utf8'), staleSettingsText);
    const requests = [];
    const requestPaths = [];
    const server = http.createServer(async function reply(request, response) {
      const chunks = [];
      for await (const chunk of request) {
        chunks.push(chunk);
      }
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
      requestPaths.push(pathname);
      if (pathname.endsWith('/count_tokens')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ input_tokens: 32 }));
        return;
      }
      if (!pathname.endsWith('/messages')) {
        response.writeHead(404);
        response.end();
        return;
      }

      requests.push({
        beta: request.headers['anthropic-beta'] || '',
        model: body.model,
        outputConfig: body.output_config,
        thinking: body.thinking,
      });
      if (body.stream === false) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            id: 'msg_clean_kimi',
            type: 'message',
            role: 'assistant',
            model: 'k3',
            content: [{ type: 'text', text: 'CLEAN_HOME_KIMI_OK' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 32, output_tokens: 4 },
          })
        );
        return;
      }

      response.writeHead(200, {
        'cache-control': 'no-cache',
        'content-type': 'text/event-stream',
      });
      response.end(
        [
          sseEvent('message_start', {
            type: 'message_start',
            message: {
              id: 'msg_clean_kimi',
              type: 'message',
              role: 'assistant',
              model: 'k3',
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 32, output_tokens: 0 },
            },
          }),
          sseEvent('content_block_start', {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          }),
          sseEvent('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'CLEAN_HOME_KIMI_OK' },
          }),
          sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
          sseEvent('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 4 },
          }),
          sseEvent('message_stop', { type: 'message_stop' }),
        ].join('')
      );
    });
    const address = await listen(server);
    t.after(async () => close(server));

    const env = { ...process.env };
    for (const name of Object.keys(env)) {
      if (
        name.startsWith('ANTHROPIC_') ||
        name.startsWith('CLAUDE_CODE_') ||
        name.startsWith('CLAUDE_WORKFLOW_') ||
        name.startsWith('KIMI_') ||
        name.startsWith('ULTRATHINK_')
      ) {
        delete env[name];
      }
    }
    Object.assign(env, {
      CLAUDE_CONFIG_DIR: claudeConfig,
      HOME: home,
      USERPROFILE: home,
      ANTHROPIC_API_KEY: 'test-local-gateway-key',
      ANTHROPIC_AUTH_TOKEN: 'test-local-gateway-key',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      ANTHROPIC_CUSTOM_MODEL_OPTION: 'k3',
      ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: 'kimi:k3/max through claude-workflow',
      ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: 'Kimi K3 Main Route',
      ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES:
        'effort,xhigh_effort,max_effort,thinking,adaptive_thinking,interleaved_thinking',
      ANTHROPIC_MODEL: 'k3',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '784800',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
      CLAUDE_CODE_EFFORT_LEVEL: 'max',
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '828400',
      CLAUDE_CODE_SUBAGENT_MODEL: 'codex-terra',
      NO_PROXY: '127.0.0.1',
      no_proxy: '127.0.0.1',
    });

    const settingsOverride = createPrivateClaudeSettingsOverride(
      buildClaudeSettingsOverrideEnvironment(env, env),
      {
        options: [
          { model: 'k3', label: 'Kimi K3' },
          { model: 'codex-terra', label: 'Codex Terra' },
        ],
        replaceBuiltInOptions: true,
      }
    );
    t.after(() => settingsOverride.cleanup());

    const result = await runClaude(
      [
        '--print',
        '--output-format',
        'json',
        '--model',
        'k3',
        '--effort',
        'max',
        '--settings',
        settingsOverride.path,
        '--dangerously-skip-permissions',
        'Reply with exactly CLEAN_HOME_KIMI_OK.',
      ],
      { cwd, env }
    );
    assert.equal(result.signal, null, result.stderr || result.stdout);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /CLEAN_HOME_KIMI_OK/u);
    assert.ok(requests.length >= 1);
    assert.equal(requests.every((entry) => entry.model === 'k3'), true);
    assert.equal(requests.every((entry) => entry.thinking?.type === 'adaptive'), true);
    assert.equal(requests.every((entry) => entry.outputConfig?.effort === 'max'), true);
    assert.equal(requests.every((entry) => !/context-1m/u.test(entry.beta)), true);
    assert.equal(
      requestPaths.some((pathname) => pathname.endsWith('/models')),
      false,
      'the private picker must not trigger gateway model discovery'
    );
  }
);
