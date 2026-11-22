#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { translateAnthropicMessagesRequestWithOptions } from '../js/gateway/anthropic-format.js';
import { serializeWorkflowEnvironment } from '../js/cli/claude-workflow-daemon.js';
import { loadGatewayConfig } from '../js/gateway/config.js';
import { buildCodexDynamicToolRegistry, CodexSessionManager } from '../js/gateway/codex-provider.js';
import {
  buildWorkflowClientEnv,
  buildWorkflowGatewayConfig,
  defaultWorkflowAnthropicPassthroughModels,
} from '../js/gateway/workflow-config.js';
import {
  GatewayError,
  modelIdWithoutBracketQualifiers,
  resolveModelRoute,
} from '../js/gateway/model-routing.js';
import {
  noProxyMatchesUrl,
  proxyExclusionEnvForHost,
  proxyUrlForTarget,
} from '../js/gateway/proxy.js';
import {
  createGatewayApp,
  createGatewayServer,
  summarizeRequestBody,
  summarizeGatewayTraceContext,
  withAbortSignal,
  writeSseEvent,
} from '../js/gateway/server.js';
import { assert, ok, runTest } from './lifecycle/_helpers.js';

function sleep(ms) {
  return new Promise(function wait(resolve) {
    setTimeout(resolve, ms);
  });
}

async function freePort() {
  return new Promise(function resolvePort(resolve, reject) {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', function onListen() {
      const address = server.address();
      server.close(function onClose() {
        resolve(address.port);
      });
    });
  });
}

async function waitForListening(server) {
  if (server.listening) {
    return;
  }

  await new Promise(function resolveListen(resolve, reject) {
    server.once('listening', resolve);
    server.once('error', reject);
  });
}

async function closeServer(server) {
  await new Promise(function close(resolve) {
    server.close(resolve);
  });
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function jsonHeaders(extraHeaders = {}) {
  return {
    'content-type': 'application/json',
    ...extraHeaders,
  };
}

async function makeExecutable(filePath, content) {
  await fs.writeFile(filePath, content, { encoding: 'utf8', mode: 0o755 });
  await fs.chmod(filePath, 0o755);
}

async function makeClaudeExecutable(filePath, content, version = '2.1.330') {
  const firstNewline = content.indexOf('\n');
  assert.notEqual(firstNewline, -1, 'fake Claude executable must start with a shebang');
  const versionProbe = content.startsWith('#!/usr/bin/env node')
    ? `if (process.argv[2] === '--version') { process.stdout.write(${JSON.stringify(
        `${version} (Claude Code)\n`
      )}); process.exit(0); }\n`
    : `if [ "\${1:-}" = "--version" ]; then echo ${JSON.stringify(
        `${version} (Claude Code)`
      )}; exit 0; fi\n`;
  await makeExecutable(
    filePath,
    `${content.slice(0, firstNewline + 1)}${versionProbe}${content.slice(firstNewline + 1)}`
  );
}

async function makeCodexLoginStatusCommand(filePath, statusText = 'Logged in', exitCode = 0) {
  await makeExecutable(
    filePath,
    '#!/bin/bash\n' +
      'if [ "$1" = "login" ] && [ "$2" = "status" ]; then\n' +
      `  echo ${JSON.stringify(statusText)}\n` +
      `  exit ${exitCode}\n` +
      'fi\n' +
      'exit 0\n'
  );
}

async function makeClaudeShouldNotRunCommand(filePath) {
  await makeClaudeExecutable(
    filePath,
    '#!/bin/bash\n' +
      'echo "CLAUDE SHOULD NOT RUN" >&2\n' +
      'exit 99\n'
  );
}

async function runProcess(command, args, env, options = {}) {
  return new Promise(function wait(resolve, reject) {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', function onStdout(chunk) {
      stdout += chunk.toString();
    });
    child.stderr.on('data', function onStderr(chunk) {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', function onClose(code, signal) {
      let exitCode = code ?? 0;
      if (signal) {
        exitCode = 128;
      }

      resolve({
        code: exitCode,
        stdout,
        stderr,
      });
    });
  });
}

async function waitForFile(filePath, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      await sleep(25);
    }
  }

  throw new Error(`Timed out waiting for ${filePath}`);
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function waitForProcessExit(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) {
      return;
    }
    await sleep(25);
  }

  throw new Error(`Timed out waiting for process ${String(pid)} to exit`);
}

function parseSsePayloads(text) {
  return text
    .split(/\r?\n\r?\n/u)
    .map(function trimEvent(eventText) {
      return eventText.trim();
    })
    .filter(Boolean)
    .map(function parseEvent(eventText) {
      const event = {
        name: '',
        payload: null,
      };

      for (const line of eventText.split(/\r?\n/u)) {
        if (line.startsWith('event: ')) {
          event.name = line.slice('event: '.length);
          continue;
        }
        if (line.startsWith('data: ')) {
          const data = line.slice('data: '.length);
          if (data === '[DONE]') {
            event.payload = '[DONE]';
          } else {
            event.payload = JSON.parse(data);
          }
        }
      }

      return event;
    });
}

const CODEX_REQUEST_MODEL = 'claude-sonnet-4-7';
// These wire-format fixtures intentionally pin an older supported model;
// assertions about loadGatewayConfig defaults must not use this fixture ID.
const CODEX_FIXTURE_UPSTREAM_MODEL = 'gpt-5.6-terra';
const WORKFLOW_DISPLAY_SUBAGENT_MODEL = 'codex-astra';
const CLEAN_PROXY_ENV = Object.freeze({
  HTTP_PROXY: '',
  http_proxy: '',
  HTTPS_PROXY: '',
  https_proxy: '',
  ALL_PROXY: '',
  all_proxy: '',
  NO_PROXY: '',
  no_proxy: '',
});
const CLEAN_WORKFLOW_ENV = Object.freeze({
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: '',
  CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '',
  CLAUDE_CODE_EFFORT_LEVEL: '',
  CLAUDE_CODE_MAX_CONTEXT_TOKENS: '',
  CLAUDE_WORKFLOW_GATEWAY_MANAGED_TERMINAL_TITLE: '',
  CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_TERMINAL_TITLE: '',
  CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_TERMINAL_TITLE_SET: '',
  CLAUDE_WORKFLOW_MAIN_PROVIDER: '',
  CLAUDE_WORKFLOW_SUBAGENT_MODEL_ID: '',
  DEEPSEEK_API_KEY: '',
  DEEPSEEK_BASE_URL: '',
  DEEPSEEK_DEFAULT_MODEL_ID: '',
  GLM_API_KEY: '',
  GLM_BASE_URL: '',
  GLM_DEFAULT_MODEL_ID: '',
  KIMI_API_KEY: '',
  ZAI_API_KEY: '',
  ZAI_BASE_URL: '',
  ZAI_DEFAULT_MODEL_ID: '',
  ZAI_REASONING_EFFORT: '',
  ULTRATHINK_GATEWAY_ANTHROPIC_PASSTHROUGH_MODELS: '',
  ULTRATHINK_GATEWAY_CODEX_AUTO_COMPACT_TOKEN_LIMIT: '',
  ULTRATHINK_GATEWAY_CODEX_AUTO_COMPACT_TOKEN_LIMIT_SCOPE: '',
  ULTRATHINK_GATEWAY_CODEX_MODEL: '',
  ULTRATHINK_GATEWAY_CODEX_REASONING_EFFORT: '',
  ULTRATHINK_GATEWAY_CODEX_VERBOSITY: '',
  ULTRATHINK_GATEWAY_CODEX_INPUT_MAX_TOKENS: '',
  ULTRATHINK_GATEWAY_CODEX_TOOL_RESULT_MAX_BYTES: '',
  ULTRATHINK_GATEWAY_CODEX_TOOL_RESULT_WINDOW_MAX_BYTES: '',
  ULTRATHINK_GATEWAY_DEEPSEEK_API_KEY: '',
  ULTRATHINK_GATEWAY_DEEPSEEK_BASE_URL: '',
  ULTRATHINK_GATEWAY_DEEPSEEK_MODEL: '',
  ULTRATHINK_GATEWAY_DEEPSEEK_REASONING_EFFORT: '',
  ULTRATHINK_GATEWAY_GLM_API_KEY: '',
  ULTRATHINK_GATEWAY_GLM_BASE_URL: '',
  ULTRATHINK_GATEWAY_GLM_MODEL: '',
  ULTRATHINK_GATEWAY_GLM_REASONING_EFFORT: '',
  ULTRATHINK_GATEWAY_MAIN_MODEL_ID: '',
  ULTRATHINK_GATEWAY_MAIN_PROVIDER: '',
  ULTRATHINK_GATEWAY_MAIN_REASONING_EFFORT: '',
  ULTRATHINK_GATEWAY_MAIN_UPSTREAM_MODEL: '',
  ULTRATHINK_GATEWAY_KIMI_API_KEY: '',
  ULTRATHINK_GATEWAY_KIMI_BASE_URL: '',
  ULTRATHINK_GATEWAY_KIMI_CONTEXT_TOKENS: '',
  ULTRATHINK_GATEWAY_KIMI_MODEL: '',
  ULTRATHINK_GATEWAY_KIMI_REASONING_EFFORT: '',
  ULTRATHINK_GATEWAY_KIMI_VERSION: '',
  ULTRATHINK_GATEWAY_OPENAI_MODEL: '',
  ULTRATHINK_GATEWAY_OPENAI_REASONING_EFFORT: '',
  ULTRATHINK_GATEWAY_OPENAI_VERBOSITY: '',
  ULTRATHINK_GATEWAY_SUBAGENT_MODEL_ID: '',
  ULTRATHINK_GATEWAY_SUBAGENT_REASONING_EFFORT: '',
  ULTRATHINK_GATEWAY_SUBAGENT_UPSTREAM_MODEL: '',
  ULTRATHINK_GATEWAY_SUBAGENT_VERBOSITY: '',
  ULTRATHINK_DEEPSEEK_REASONING_EFFORT: '',
  ULTRATHINK_GLM_REASONING_EFFORT: '',
  ULTRATHINK_THINKING_LEVEL: '',
});

function cleanProxyEnv(overrides = {}) {
  return {
    ...CLEAN_PROXY_ENV,
    ...overrides,
  };
}

// Gateway imports load project/user defaults as a side effect. Clear those
// values before running any tests, including keys absent from our explicit
// clean-workflow fixture. Keep blank entries so child CLI loaders cannot
// repopulate the same keys from the user's environment files.
for (const name of Object.keys(process.env)) {
  if (/^(?:ANTHROPIC_|BAILIAN_|CLAUDE_|CLAUDECODE$|CODEX_|DASHSCOPE_|DEEPSEEK_|GLM_|KIMI_|OPENAI_|QWEN_|ULTRATHINK_|ZAI_)/u.test(name)) {
    process.env[name] = '';
  }
}
Object.assign(process.env, cleanProxyEnv(), CLEAN_WORKFLOW_ENV);

function routedResponseModel(route) {
  const effort = route.reasoningEffort ? `/${route.reasoningEffort}` : '';
  return `${route.provider}:${route.upstreamModel}${effort} via ${route.requestedModel}`;
}

function codexRoute(overrides = {}) {
  return {
    requestedModel: CODEX_REQUEST_MODEL,
    upstreamModel: CODEX_FIXTURE_UPSTREAM_MODEL,
    sandbox: 'workspace-write',
    approvalPolicy: 'never',
    reasoningEffort: 'medium',
    ...overrides,
  };
}

function gatewayConfig(overrides = {}) {
  const baseConfig = {
    host: '127.0.0.1',
    port: 0,
    sharedSecret: '',
    requestTimeoutMs: 10_000,
    routeMap: {},
    anthropicPassthroughModels: ['claude-opus-5*'],
    exposedModels: ['claude-sonnet-4-7'],
    codex: {
      enabled: true,
      command: 'codex',
      cwd: process.cwd(),
      model: CODEX_FIXTURE_UPSTREAM_MODEL,
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
      reasoningEffort: 'medium',
      verbosity: 'high',
      toolResultMaxBytes: 10_000,
      toolResultWindowMaxBytes: 64_000,
      autoCompactTokenLimit: 0,
      autoCompactTokenLimitScope: 'body_after_prefix',
      idleTimeoutMs: 60_000,
      forkIdleTimeoutMs: 30_000,
      maxSessions: 16,
    },
    openai: {
      apiKey: '',
      baseUrl: 'http://127.0.0.1:1',
      model: CODEX_FIXTURE_UPSTREAM_MODEL,
      reasoningEffort: 'low',
      verbosity: 'low',
    },
    deepseek: {
      apiKey: '',
      baseUrl: 'http://127.0.0.1:1',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
      thinking: { type: 'enabled' },
    },
    glm: {
      apiKey: '',
      baseUrl: 'http://127.0.0.1:1',
      model: 'glm-5.2',
      reasoningEffort: 'max',
      thinking: {
        type: 'enabled',
        clear_thinking: false,
      },
    },
    anthropic: {
      apiKey: '',
      baseUrl: 'http://127.0.0.1:1',
      version: '2023-06-01',
    },
  };

  return {
    ...baseConfig,
    ...overrides,
    codex: {
      ...baseConfig.codex,
      ...overrides.codex,
    },
    openai: {
      ...baseConfig.openai,
      ...overrides.openai,
    },
    deepseek: {
      ...baseConfig.deepseek,
      ...overrides.deepseek,
    },
    glm: {
      ...baseConfig.glm,
      ...overrides.glm,
    },
    anthropic: {
      ...baseConfig.anthropic,
      ...overrides.anthropic,
    },
  };
}

function lookupWeatherTool() {
  return {
    name: 'lookup_weather',
    description: 'Fetch weather.',
    input_schema: {
      type: 'object',
      properties: {
        city: { type: 'string' },
      },
      required: ['city'],
    },
  };
}

function deepSeekFableGatewayConfig(gatewayPort, deepSeekPort, overrides = {}) {
  const configOverrides = overrides.config || {};
  const deepSeekOverrides = overrides.deepseek || {};
  const routeOverrides = overrides.route || {};

  return gatewayConfig({
    ...configOverrides,
    port: gatewayPort,
    exposedModels: ['claude-fable-5[1m]'],
    routeMap: {
      'claude-fable-5[1m]': {
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
        reasoningEffort: 'max',
        ...routeOverrides,
      },
    },
    anthropicPassthroughModels: ['claude-fable-5*'],
    deepseek: {
      apiKey: 'deepseek-key',
      baseUrl: `http://127.0.0.1:${deepSeekPort}`,
      model: 'deepseek-v4-flash',
      reasoningEffort: 'high',
      thinking: { type: 'enabled' },
      ...deepSeekOverrides,
    },
  });
}

function glmGatewayConfig(gatewayPort, glmPort, overrides = {}) {
  const configOverrides = overrides.config || {};
  const glmOverrides = overrides.glm || {};
  const routeOverrides = overrides.route || {};

  return gatewayConfig({
    ...configOverrides,
    port: gatewayPort,
    exposedModels: ['glm-5.2[1m]'],
    routeMap: {
      'glm-5.2[1m]': {
        provider: 'glm',
        model: 'glm-5.2[1m]',
        reasoningEffort: 'max',
        ...routeOverrides,
      },
    },
    glm: {
      apiKey: 'glm-key',
      baseUrl: `http://127.0.0.1:${glmPort}`,
      model: 'glm-5.2',
      reasoningEffort: 'max',
      thinking: {
        type: 'enabled',
        clear_thinking: false,
      },
      ...glmOverrides,
    },
  });
}

function reasoningReplayHeaders(sessionId) {
  return jsonHeaders({
    'x-claude-code-session-id': sessionId,
    'x-claude-code-agent-id': 'agent-weather',
  });
}

function assertToolCallReasoningReplay(capturedBodies) {
  const assistantMessage = capturedBodies[1].messages.find(function findAssistant(message) {
    return message.role === 'assistant';
  });
  assert.equal(assistantMessage.reasoning_content, 'Need weather.');
  assert.equal(assistantMessage.tool_calls[0].id, 'call_weather');
}

function gatewayRequest(headers = {}) {
  return {
    get(name) {
      return headers[name] || '';
    },
  };
}

function claudeSessionRequest(sessionId, extraHeaders = {}) {
  return gatewayRequest({
    'x-claude-code-session-id': sessionId,
    ...extraHeaders,
  });
}

function emptyUsage() {
  return {
    input_tokens: 0,
    output_tokens: 0,
  };
}

function finalBoundary(usage = emptyUsage()) {
  return {
    type: 'boundary',
    outcome: {
      type: 'final',
      usage,
    },
  };
}

function finalOutcome(usage = emptyUsage()) {
  return {
    type: 'final',
    text: '',
    usage,
  };
}

function codexUserRequest(content) {
  return {
    model: CODEX_REQUEST_MODEL,
    messages: [{ role: 'user', content }],
    tools: [],
  };
}

function isForkSessionKey(sessionKey) {
  return sessionKey.includes(':fork:');
}

function forkBaseSessionKey(sessionKey) {
  const forkIndex = sessionKey.indexOf(':fork:');
  if (forkIndex === -1) {
    return sessionKey;
  }

  return sessionKey.slice(0, forkIndex);
}

function resolveSessionOverrides(sessionKey, options) {
  if (typeof options.sessionOverrides === 'function') {
    return options.sessionOverrides(sessionKey) || {};
  }

  return options.sessionOverrides || {};
}

function stubCodexSession(sessionKey, overrides = {}) {
  return {
    baseSessionKey: forkBaseSessionKey(sessionKey),
    sessionKey,
    pendingToolCall: null,
    activeBoundary: null,
    routingReservation: null,
    lastUsedSequence: 0,
    assertCompatible() {},
    touch() {},
    isDisposableIdle() {
      return !this.routingReservation && !this.pendingToolCall;
    },
    isForkSession() {
      return this.sessionKey !== this.baseSessionKey;
    },
    async advance() {
      return finalOutcome();
    },
    async stream(body, onEvent) {
      onEvent(finalBoundary());
      return { ok: true, body };
    },
    async close() {},
    ...overrides,
  };
}

function stubCodexSessionManager(onCreate, options = {}) {
  return new CodexSessionManager(
    {
      codex: {
        idleTimeoutMs: 60_000,
        forkIdleTimeoutMs: 30_000,
        maxSessions: 16,
        ...(options.codex || {}),
      },
    },
    {
      createSession(route, req, requestBody, sessionKey) {
        const session = stubCodexSession(sessionKey, resolveSessionOverrides(sessionKey, options));
        onCreate?.(sessionKey, session);
        return session;
      },
    }
  );
}

function restoreEnv(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }
}

function captureTracer() {
  const entries = [];

  function scopedTracer(scopeFields = {}) {
    return {
      log(event, details = {}) {
        entries.push({
          event,
          details: {
            ...scopeFields,
            ...details,
          },
        });
      },
      scope(childFields = {}) {
        return scopedTracer({
          ...scopeFields,
          ...childFields,
        });
      },
    };
  }

  return {
    entries,
    tracer: scopedTracer(),
  };
}

async function withTemporaryEnv(updates, run) {
  const previous = {};
  for (const key of Object.keys(updates)) {
    previous[key] = process.env[key];
  }

  try {
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) {
        delete process.env[key];
        continue;
      }

      process.env[key] = value;
    }

    return await run();
  } finally {
    restoreEnv(previous);
  }
}

function observedTimeoutForSession(observedTimeouts, predicate) {
  const entry = Array.from(observedTimeouts.entries()).find(function findMatchingTimeout([
    sessionKey,
  ]) {
    return predicate(sessionKey);
  });
  return entry?.[1];
}

async function observeForkIdleTimeouts(codexConfig, sessionId) {
  const observedTimeouts = new Map();
  const manager = stubCodexSessionManager(null, {
    codex: codexConfig,
    sessionOverrides: {
      touch(onExpire, timeoutMs) {
        observedTimeouts.set(this.sessionKey, timeoutMs);
      },
    },
  });
  const route = codexRoute();
  const req = claudeSessionRequest(sessionId);
  const canonicalBody = codexUserRequest('Primary request.');

  await manager.processRequest(req, canonicalBody, route);
  const canonical = manager.ensureSession(req, canonicalBody, route);
  canonical.pendingToolCall = { callId: 'call_pending' };

  await manager.processRequest(req, codexUserRequest('Unrelated side request.'), route);

  return observedTimeouts;
}

function pooledCodexSessionManager(codexConfig, onSession) {
  const createdSessionKeys = [];
  const closedSessions = [];
  const manager = stubCodexSessionManager(
    function recordSession(sessionKey, session) {
      createdSessionKeys.push(sessionKey);
      session.close = async function close(reason) {
        closedSessions.push({
          sessionKey,
          message: reason?.message || '',
        });
      };
      onSession?.(sessionKey, session);
    },
    {
      codex: codexConfig,
    }
  );

  return {
    closedSessions,
    createdSessionKeys,
    manager,
  };
}

async function processCodexSessionIds(manager, sessionIds, requestBody) {
  const route = codexRoute();
  for (const sessionId of sessionIds) {
    await manager.processRequest(claudeSessionRequest(sessionId), requestBody, route);
  }
}

async function waitForClosedSession(closedSessions) {
  for (let attempt = 0; attempt < 20 && closedSessions.length === 0; attempt += 1) {
    await sleep(5);
  }
}

await runTest('gateway proxy helpers resolve proxy and no_proxy environment rules', async function testGatewayProxyHelpers() {
  assert.equal(
    proxyUrlForTarget('http://api.anthropic.com/v1/messages', {
      HTTP_PROXY: 'proxy.local:8080',
    }),
    'http://proxy.local:8080'
  );
  assert.equal(
    proxyUrlForTarget('https://api.anthropic.com/v1/messages', {
      HTTPS_PROXY: 'http://upper-proxy.local:8443',
      https_proxy: 'http://lower-proxy.local:8443',
    }),
    'http://lower-proxy.local:8443'
  );
  assert.equal(
    proxyUrlForTarget('https://api.anthropic.com/v1/messages', {
      HTTP_PROXY: 'http://http-only-proxy.local:8080',
      ALL_PROXY: 'http://fallback-proxy.local:8080',
    }),
    'http://fallback-proxy.local:8080'
  );
  assert.equal(
    proxyUrlForTarget('https://api.anthropic.com/v1/messages', {
      HTTP_PROXY: 'http://http-only-proxy.local:8080',
    }),
    ''
  );
  assert.equal(
    proxyUrlForTarget('http://api.local/v1/messages', {
      HTTPS_PROXY: 'http://secure-proxy.local:8443',
      ALL_PROXY: 'http://fallback-proxy.local:8080',
    }),
    'http://fallback-proxy.local:8080'
  );
  assert.equal(
    proxyUrlForTarget('https://api.anthropic.com/v1/messages', {
      HTTPS_PROXY: 'http://proxy.local:8443',
      NO_PROXY: 'api.anthropic.com',
    }),
    ''
  );
  assert.equal(
    proxyUrlForTarget('https://api.anthropic.com/v1/messages', {
      HTTPS_PROXY: 'http://proxy.local:8443',
      NO_PROXY: '*',
    }),
    ''
  );
  assert.equal(
    noProxyMatchesUrl('https://sub.example.com:443/v1/messages', {
      NO_PROXY: '.example.com',
    }),
    true
  );
  assert.equal(
    noProxyMatchesUrl('http://127.0.0.1:4318/v1/messages', {
      NO_PROXY: '127.0.0.0/8',
    }),
    true
  );
  assert.equal(
    noProxyMatchesUrl('http://[::1]:4318/v1/messages', {
      NO_PROXY: '::1/128',
    }),
    true
  );
  assert.deepEqual(
    proxyExclusionEnvForHost('127.0.0.1', {
      HTTP_PROXY: 'http://proxy.local:8080',
      NO_PROXY: 'localhost',
    }),
    {
      NO_PROXY: 'localhost,127.0.0.1',
      no_proxy: 'localhost,127.0.0.1',
    }
  );
  assert.deepEqual(
    proxyExclusionEnvForHost('127.0.0.1', {
      HTTP_PROXY: 'http://proxy.local:8080',
      NO_PROXY: '127.0.0.1',
    }),
    {
      NO_PROXY: '127.0.0.1',
      no_proxy: '127.0.0.1',
    }
  );
  assert.deepEqual(
    proxyExclusionEnvForHost('127.0.0.1', {
      HTTP_PROXY: 'http://proxy.local:8080',
      NO_PROXY: '127.0.0.1',
      no_proxy: '127.0.0.1',
    }),
    {}
  );
  assert.deepEqual(
    proxyExclusionEnvForHost('127.0.0.1', {
      HTTP_PROXY: 'http://proxy.local:8080',
      NO_PROXY: '127.0.0.0/8',
    }),
    {
      NO_PROXY: '127.0.0.0/8',
      no_proxy: '127.0.0.0/8',
    }
  );
  assert.deepEqual(
    proxyExclusionEnvForHost('127.0.0.1', {
      HTTP_PROXY: 'http://proxy.local:8080',
      NO_PROXY: '127.0.0.1:9999',
    }),
    {
      NO_PROXY: '127.0.0.1:9999,127.0.0.1',
      no_proxy: '127.0.0.1:9999,127.0.0.1',
    }
  );
  ok('proxy env parsing handles proxy selection, bypasses, and child gateway exclusions');
});

await runTest('gateway config prefers Codex-profile aliases for the OpenAI remap target', async function testCodexAliases() {
  const previous = {
    ULTRATHINK_GATEWAY_CODEX_API_KEY: process.env.ULTRATHINK_GATEWAY_CODEX_API_KEY,
    ULTRATHINK_GATEWAY_OPENAI_API_KEY: process.env.ULTRATHINK_GATEWAY_OPENAI_API_KEY,
    ULTRATHINK_GATEWAY_CODEX_MODEL: process.env.ULTRATHINK_GATEWAY_CODEX_MODEL,
    ULTRATHINK_GATEWAY_OPENAI_MODEL: process.env.ULTRATHINK_GATEWAY_OPENAI_MODEL,
    ULTRATHINK_GATEWAY_CODEX_REASONING_EFFORT:
      process.env.ULTRATHINK_GATEWAY_CODEX_REASONING_EFFORT,
    ULTRATHINK_GATEWAY_OPENAI_REASONING_EFFORT:
      process.env.ULTRATHINK_GATEWAY_OPENAI_REASONING_EFFORT,
    ULTRATHINK_GATEWAY_CODEX_VERBOSITY: process.env.ULTRATHINK_GATEWAY_CODEX_VERBOSITY,
    ULTRATHINK_GATEWAY_OPENAI_VERBOSITY: process.env.ULTRATHINK_GATEWAY_OPENAI_VERBOSITY,
    ULTRATHINK_GATEWAY_ROUTE_MAP_JSON: process.env.ULTRATHINK_GATEWAY_ROUTE_MAP_JSON,
    ULTRATHINK_GATEWAY_EXPOSED_MODELS: process.env.ULTRATHINK_GATEWAY_EXPOSED_MODELS,
  };

  try {
    process.env.ULTRATHINK_GATEWAY_CODEX_API_KEY = 'codex-key';
    process.env.ULTRATHINK_GATEWAY_OPENAI_API_KEY = 'legacy-openai-key';
    process.env.ULTRATHINK_GATEWAY_CODEX_MODEL = 'gpt-5.6-sol';
    process.env.ULTRATHINK_GATEWAY_OPENAI_MODEL = 'should-not-win';
    process.env.ULTRATHINK_GATEWAY_CODEX_REASONING_EFFORT = 'low';
    process.env.ULTRATHINK_GATEWAY_OPENAI_REASONING_EFFORT = 'high';
    process.env.ULTRATHINK_GATEWAY_CODEX_VERBOSITY = 'low';
    process.env.ULTRATHINK_GATEWAY_OPENAI_VERBOSITY = 'high';

    const config = loadGatewayConfig();
    assert.equal(config.openai.apiKey, 'codex-key');
    assert.equal(config.openai.model, 'gpt-5.6-sol');
    assert.equal(config.openai.reasoningEffort, 'low');
    assert.equal(config.openai.verbosity, 'low');
    ok('Codex-profile aliases override legacy OpenAI-prefixed env vars');
  } finally {
    restoreEnv(previous);
  }
});

await runTest('gateway config reads an independent DeepSeek route profile', async function testDeepSeekGatewayProfile() {
  await withTemporaryEnv(
    {
      ULTRATHINK_GATEWAY_DEEPSEEK_API_KEY: 'gateway-deepseek-key',
      DEEPSEEK_API_KEY: 'ambient-deepseek-key',
      ULTRATHINK_GATEWAY_DEEPSEEK_BASE_URL: 'http://127.0.0.1:9876',
      DEEPSEEK_BASE_URL: 'http://should-not-win',
      ULTRATHINK_GATEWAY_DEEPSEEK_MODEL: 'deepseek-v4-pro',
      DEEPSEEK_DEFAULT_MODEL_ID: 'deepseek-v4-flash',
      ULTRATHINK_GATEWAY_DEEPSEEK_REASONING_EFFORT: 'high',
      ULTRATHINK_DEEPSEEK_REASONING_EFFORT: 'max',
      ULTRATHINK_THINKING_LEVEL: 'OFF',
    },
    async function assertDeepSeekGatewayProfile() {
      const config = loadGatewayConfig();

      assert.equal(config.deepseek.apiKey, 'gateway-deepseek-key');
      assert.equal(config.deepseek.baseUrl, 'http://127.0.0.1:9876');
      assert.equal(config.deepseek.model, 'deepseek-v4-pro');
      assert.equal(config.deepseek.reasoningEffort, 'high');
      assert.equal(config.deepseek.thinking.type, 'disabled');
      ok('DeepSeek gateway routing has its own credentials, endpoint, model, and thinking profile');
    }
  );
});

await runTest('gateway defaults DeepSeek routes to enabled max reasoning', async function testDeepSeekGatewayDefaults() {
  await withTemporaryEnv(
    {
      ULTRATHINK_GATEWAY_DEEPSEEK_REASONING_EFFORT: '',
      ULTRATHINK_DEEPSEEK_REASONING_EFFORT: '',
      ULTRATHINK_THINKING_LEVEL: '',
    },
    async function assertDeepSeekGatewayDefaults() {
      const config = loadGatewayConfig();

      assert.equal(config.deepseek.reasoningEffort, 'max');
      assert.equal(config.deepseek.thinking.type, 'enabled');
      ok('DeepSeek gateway routes default to enabled max reasoning');
    }
  );
});

await runTest('gateway config reads an independent GLM route profile', async function testGlmGatewayProfile() {
  await withTemporaryEnv(
    {
      ULTRATHINK_GATEWAY_GLM_API_KEY: 'gateway-glm-key',
      ZAI_API_KEY: 'ambient-zai-key',
      GLM_API_KEY: 'ambient-glm-key',
      ULTRATHINK_GATEWAY_GLM_BASE_URL: 'http://127.0.0.1:9877',
      ZAI_BASE_URL: 'http://should-not-win',
      GLM_BASE_URL: 'http://also-should-not-win',
      ULTRATHINK_GATEWAY_GLM_MODEL: 'glm-5.2',
      GLM_DEFAULT_MODEL_ID: 'glm-other',
      ZAI_DEFAULT_MODEL_ID: 'zai-other',
      ULTRATHINK_GATEWAY_GLM_REASONING_EFFORT: 'high',
      ULTRATHINK_GLM_REASONING_EFFORT: 'max',
      ZAI_REASONING_EFFORT: 'low',
      ULTRATHINK_THINKING_LEVEL: 'OFF',
    },
    async function assertGlmGatewayProfile() {
      const config = loadGatewayConfig();

      assert.equal(config.glm.apiKey, 'gateway-glm-key');
      assert.equal(config.glm.baseUrl, 'http://127.0.0.1:9877');
      assert.equal(config.glm.model, 'glm-5.2');
      assert.equal(config.glm.reasoningEffort, 'high');
      assert.deepEqual(config.glm.thinking, { type: 'disabled' });
      ok('GLM gateway routing has its own credentials, endpoint, model, and thinking profile');
    }
  );
});

await runTest('gateway defaults GLM routes to max preserved thinking', async function testGlmGatewayDefaults() {
  await withTemporaryEnv(
    {
      GLM_BASE_URL: '',
      GLM_DEFAULT_MODEL_ID: '',
      ZAI_BASE_URL: '',
      ZAI_DEFAULT_MODEL_ID: '',
      ULTRATHINK_GATEWAY_GLM_REASONING_EFFORT: '',
      ULTRATHINK_GATEWAY_GLM_BASE_URL: '',
      ULTRATHINK_GATEWAY_GLM_MODEL: '',
      ULTRATHINK_GLM_REASONING_EFFORT: '',
      ZAI_REASONING_EFFORT: '',
      ULTRATHINK_THINKING_LEVEL: '',
    },
    async function assertGlmGatewayDefaults() {
      const config = loadGatewayConfig();

      assert.equal(config.glm.baseUrl, 'https://api.z.ai/api/coding/paas/v4');
      assert.equal(config.glm.model, 'glm-5.2');
      assert.equal(config.glm.reasoningEffort, 'max');
      assert.deepEqual(config.glm.thinking, {
        type: 'enabled',
        clear_thinking: false,
      });
      ok('GLM gateway routes default to Z.ai coding endpoint with max preserved thinking');
    }
  );
});

await runTest('gateway defaults Codex-backed routes to writable never-approval sessions', async function testCodexSessionDefaults() {
  const previous = {
    ULTRATHINK_GATEWAY_CODEX_ENABLED: process.env.ULTRATHINK_GATEWAY_CODEX_ENABLED,
    ULTRATHINK_GATEWAY_CODEX_SANDBOX: process.env.ULTRATHINK_GATEWAY_CODEX_SANDBOX,
    ULTRATHINK_GATEWAY_CODEX_APPROVAL_POLICY: process.env.ULTRATHINK_GATEWAY_CODEX_APPROVAL_POLICY,
    ULTRATHINK_GATEWAY_CODEX_MODEL: process.env.ULTRATHINK_GATEWAY_CODEX_MODEL,
    ULTRATHINK_GATEWAY_CODEX_CLOSE_KILL_TIMEOUT_MS:
      process.env.ULTRATHINK_GATEWAY_CODEX_CLOSE_KILL_TIMEOUT_MS,
  };

  try {
    process.env.ULTRATHINK_GATEWAY_CODEX_ENABLED = 'true';
    process.env.ULTRATHINK_GATEWAY_CODEX_SANDBOX = 'workspace-write';
    process.env.ULTRATHINK_GATEWAY_CODEX_APPROVAL_POLICY = 'never';
    process.env.ULTRATHINK_GATEWAY_CODEX_MODEL = 'gpt-5.6-sol';
    delete process.env.ULTRATHINK_GATEWAY_CODEX_CLOSE_KILL_TIMEOUT_MS;

    const config = loadGatewayConfig();
    const route = resolveModelRoute('claude-sonnet-4-7', config);
    assert.equal(route.provider, 'codex');
    assert.equal(route.sandbox, 'workspace-write');
    assert.equal(route.approvalPolicy, 'never');
    assert.equal(config.codex.closeKillTimeoutMs, 2_000);
    ok('Codex-backed gateway routes default to writable never-approval threads');
  } finally {
    restoreEnv(previous);
  }
});

await runTest('gateway treats blank numeric env values as unset', async function testBlankNumericConfig() {
  await withTemporaryEnv(
    {
      ULTRATHINK_GATEWAY_PORT: '',
      ULTRATHINK_GATEWAY_REQUEST_TIMEOUT_MS: '   ',
      ULTRATHINK_GATEWAY_AUTH_FAILURE_RATE_LIMIT_WINDOW_MS: '',
      ULTRATHINK_GATEWAY_AUTH_FAILURE_RATE_LIMIT_MAX_REQUESTS: '',
      ULTRATHINK_GATEWAY_MAX_CONCURRENT_REQUESTS: '',
      ULTRATHINK_GATEWAY_CODEX_INPUT_MAX_TOKENS: '',
      ULTRATHINK_GATEWAY_CODEX_MAX_SESSIONS: '',
      ULTRATHINK_GATEWAY_CODEX_PENDING_TOOL_TIMEOUT_MS: '',
      ULTRATHINK_GATEWAY_TRACE_MAX_BYTES: '0',
    },
    async function assertBlankNumericFallbacks() {
      const config = loadGatewayConfig();
      assert.equal(config.port, 4319);
      assert.equal(config.requestTimeoutMs, 5 * 60_000);
      assert.equal(config.authFailureRateLimitWindowMs, 60_000);
      assert.equal(config.authFailureRateLimitMaxRequests, 60);
      assert.equal(config.maxConcurrentRequests, 32);
      assert.equal(config.codex.inputMaxTokens, 0);
      assert.equal(config.codex.capabilities.inputBudgetTokens > 0, true);
      assert.equal(config.codex.maxSessions, 16);
      assert.equal(config.codex.pendingToolTimeoutMs, 10 * 60_000);
      assert.equal(config.traceMaxBytes, 256);
      ok('blank numeric environment variables no longer clamp to their minimum values');
    }
  );
});

await runTest('gateway accepts conventional false values for Codex routing', async function testCodexEnabledFlag() {
  for (const disabledValue of ['0', 'false', 'no', 'off']) {
    await withTemporaryEnv(
      { ULTRATHINK_GATEWAY_CODEX_ENABLED: disabledValue },
      async function assertDisabledFlag() {
        assert.equal(loadGatewayConfig().codex.enabled, false);
      }
    );
  }
  ok('Codex routing boolean parsing is consistent with the other gateway flags');
});

await runTest('gateway can make a configured frontier model the only Anthropic passthrough default', async function testConfigurableAnthropicPassthroughModels() {
  await withTemporaryEnv(
    {
      ULTRATHINK_GATEWAY_ANTHROPIC_PASSTHROUGH_MODELS: 'claude-fable-5*',
    },
    async function assertConfigurablePassthroughModels() {
      const config = loadGatewayConfig();
      const frontierRoute = resolveModelRoute('claude-fable-5', config);
      const olderOpusRoute = resolveModelRoute('claude-opus-5', config);

      assert.deepEqual(config.anthropicPassthroughModels, ['claude-fable-5*']);
      assert.equal(frontierRoute.provider, 'anthropic');
      assert.equal(frontierRoute.upstreamModel, 'claude-fable-5');
      assert.equal(olderOpusRoute.provider, 'codex');
      assert.equal(olderOpusRoute.upstreamModel, 'gpt-6.2-astra');
      ok('only the configured frontier model stays on Anthropic while older Claude ids route to Codex');
    }
  );
});

await runTest('gateway keeps wildcard Anthropic passthrough defaults for standalone compatibility', async function testDefaultAnthropicPassthroughWildcard() {
  const route = resolveModelRoute('claude-opus-5-20260724', gatewayConfig());

  assert.equal(route.provider, 'anthropic');
  assert.equal(route.upstreamModel, 'claude-opus-5-20260724');
  ok('standalone gateway default still preserves Opus wildcard passthrough');
});

await runTest('gateway strips client-only [1m] qualifiers before Anthropic passthrough', async function testAnthropicPassthroughOneMillionAlias() {
  const opusRoute = resolveModelRoute('claude-opus-5[1m]', gatewayConfig());
  const fableRoute = resolveModelRoute(
    'claude-fable-5[1m]',
    gatewayConfig({
      anthropicPassthroughModels: ['claude-fable-5*'],
    })
  );

  assert.equal(opusRoute.provider, 'anthropic');
  assert.equal(opusRoute.requestedModel, 'claude-opus-5[1m]');
  assert.equal(opusRoute.upstreamModel, 'claude-opus-5');
  assert.equal(fableRoute.provider, 'anthropic');
  assert.equal(fableRoute.requestedModel, 'claude-fable-5[1m]');
  assert.equal(fableRoute.upstreamModel, 'claude-fable-5');
  ok('client-visible [1m] aliases use the plain Anthropic API model id upstream');
});

await runTest(
  'model qualifier stripping stays linear on unmatched attacker input',
  async function testLinearModelQualifierStripping() {
    const examples = new Map([
      [' model[1m] ', 'model'],
      ['model[one][two]', 'model'],
      ['model[]', 'model[]'],
      ['model[[]tail', 'modeltail'],
      ['model[unfinished', 'model[unfinished'],
    ]);
    for (const [modelId, expected] of examples) {
      assert.equal(modelIdWithoutBracketQualifiers(modelId), expected);
    }

    const adversarialModelId = `model-${'['.repeat(50_000)}`;
    const startedAt = performance.now();
    assert.equal(modelIdWithoutBracketQualifiers(adversarialModelId), adversarialModelId);
    const elapsedMs = performance.now() - startedAt;
    assert.equal(
      elapsedMs < 500,
      true,
      `unmatched bracket scan took ${elapsedMs.toFixed(1)}ms`
    );
    ok('untrusted model IDs are processed in one pass without regex backtracking');
  }
);

await runTest('workflow defaults use the canonical Fable 5.2 model id', async function testWorkflowMainAliasStripping() {
  await withTemporaryEnv(CLEAN_WORKFLOW_ENV, async function assertWorkflowMainAlias() {
    const { config, mainModelId } = buildWorkflowGatewayConfig();
    const route = resolveModelRoute(mainModelId, config);
    assert.equal(mainModelId, 'claude-fable-5-2');
    assert.equal(route.provider, 'anthropic');
    assert.equal(route.upstreamModel, 'claude-fable-5-2');
    ok('workflow defaults preserve the native 1M Fable 5.2 API model id');
  });
});

await runTest('gateway wildcard route-map entries override passthrough patterns', async function testWildcardRouteMapEntry() {
  const route = resolveModelRoute(
    'claude-fable-5[1m]',
    gatewayConfig({
      routeMap: {
        'claude-fable-5*': {
          provider: 'deepseek',
          model: 'deepseek-v4-pro',
          reasoningEffort: 'max',
        },
      },
      anthropicPassthroughModels: ['claude-fable-5*'],
      deepseek: {
        apiKey: 'deepseek-key',
        baseUrl: 'http://127.0.0.1:1',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'high',
        thinking: { type: 'enabled' },
      },
    })
  );

  assert.equal(route.provider, 'deepseek');
  assert.equal(route.upstreamModel, 'deepseek-v4-pro');
  assert.equal(route.reasoningEffort, 'max');
  assert.deepEqual(route.thinking, { type: 'enabled' });
  ok('wildcard route-map entries are applied before the Anthropic passthrough fallback');
});

await runTest('gateway strips client-only [1m] qualifiers before GLM upstream calls', async function testGlmOneMillionAlias() {
  const route = resolveModelRoute(
    'glm-5.2[1m]',
    gatewayConfig({
      routeMap: {
        'glm-5.2[1m]': {
          provider: 'glm',
          model: 'glm-5.2[1m]',
          reasoningEffort: 'max',
        },
      },
      glm: {
        apiKey: 'glm-key',
        baseUrl: 'http://127.0.0.1:1',
        model: 'glm-5.2',
        reasoningEffort: 'high',
        thinking: {
          type: 'enabled',
          clear_thinking: false,
        },
      },
    })
  );

  assert.equal(route.provider, 'glm');
  assert.equal(route.requestedModel, 'glm-5.2[1m]');
  assert.equal(route.upstreamModel, 'glm-5.2');
  assert.equal(route.reasoningEffort, 'max');
  assert.deepEqual(route.thinking, {
    type: 'enabled',
    clear_thinking: false,
  });
  ok('GLM routes expose the Claude Code 1m alias while sending the bare Z.ai model id');
});

await runTest('gateway config exposes the Codex close kill timeout knob', async function testCodexCloseKillTimeoutConfig() {
  await withTemporaryEnv(
    { ULTRATHINK_GATEWAY_CODEX_CLOSE_KILL_TIMEOUT_MS: '250' },
    async function assertCloseKillTimeoutConfig() {
      const config = loadGatewayConfig();
      assert.equal(config.codex.closeKillTimeoutMs, 250);
      ok('Codex app-server close kill timeout is configurable through the gateway config');
    }
  );
});

await runTest('gateway config exposes the Codex input budget', async function testCodexInputBudgetConfig() {
  await withTemporaryEnv(
    { ULTRATHINK_GATEWAY_CODEX_INPUT_MAX_TOKENS: '4096' },
    async function assertInputBudgetConfig() {
      const config = loadGatewayConfig();
      assert.equal(config.codex.inputMaxTokens, 4096);
      ok('Codex app-server input budget is configurable through the gateway config');
    }
  );
});

await runTest('gateway config exposes the Codex tool-result byte budget', async function testCodexToolResultBudgetConfig() {
  await withTemporaryEnv(
    { ULTRATHINK_GATEWAY_CODEX_TOOL_RESULT_MAX_BYTES: '2048' },
    async function assertToolResultBudgetConfig() {
      const config = loadGatewayConfig();
      assert.equal(config.codex.toolResultMaxBytes, 2048);
      ok('Codex app-server tool-result byte budget is configurable through the gateway config');
    }
  );
});

await runTest(
  'gateway config exposes Codex context-compaction guardrails',
  async function testCodexCompactionGuardrailConfig() {
    await withTemporaryEnv(
      {
        ULTRATHINK_GATEWAY_CODEX_TOOL_RESULT_WINDOW_MAX_BYTES: '8192',
        ULTRATHINK_GATEWAY_CODEX_AUTO_COMPACT_TOKEN_LIMIT: '123456',
        ULTRATHINK_GATEWAY_CODEX_AUTO_COMPACT_TOKEN_LIMIT_SCOPE: 'total',
      },
      async function assertCompactionGuardrailConfig() {
        const config = loadGatewayConfig();
        assert.equal(config.codex.toolResultWindowMaxBytes, 8192);
        assert.equal(config.codex.autoCompactTokenLimit, 123456);
        assert.equal(config.codex.autoCompactTokenLimitScope, 'total');
        ok('Codex aggregate tool-result and auto-compaction guardrails are configurable');
      }
    );
  }
);

await runTest(
  'gateway config defaults Codex auto-compaction to total scope',
  async function testCodexAutoCompactScopeDefault() {
    await withTemporaryEnv(
      {
        ULTRATHINK_GATEWAY_CODEX_AUTO_COMPACT_TOKEN_LIMIT_SCOPE: undefined,
      },
      async function assertAutoCompactScopeDefault() {
        const config = loadGatewayConfig();
        assert.equal(config.codex.autoCompactTokenLimitScope, 'total');
        ok('explicit Codex compaction limits use the upstream total-context contract');
      }
    );
  }
);

await runTest(
  'claude-workflow defaults Codex context ownership to the upstream app-server',
  async function testWorkflowCodexContextDefaults() {
    await withTemporaryEnv(
      CLEAN_WORKFLOW_ENV,
      async function assertWorkflowCodexContextDefaults() {
        const { config } = buildWorkflowGatewayConfig();
        assert.equal(config.codex.inputMaxTokens, 0);
        assert.equal(config.codex.autoCompactTokenLimit, 0);
        assert.equal(config.codex.autoCompactTokenLimitScope, 'total');
        assert.equal(config.codex.capabilities.inputBudgetTokens, 752_800);
        assert.equal(config.codex.toolResultMaxBytes, 0);
        assert.equal(config.codex.toolResultWindowMaxBytes, 0);
        ok('workflow Codex sessions use upstream token-aware tool-output truncation by default');
      }
    );
  }
);

await runTest(
  'claude-workflow direct Codex main uses a private client credential',
  async function testWorkflowDirectCodexClientCredential() {
    await withTemporaryEnv(
      {
        ...CLEAN_WORKFLOW_ENV,
        ULTRATHINK_GATEWAY_MAIN_MODEL_ID: 'codex',
        ULTRATHINK_GATEWAY_MAIN_PROVIDER: 'codex',
        ULTRATHINK_GATEWAY_ROUTE_MAP_JSON: '',
        ULTRATHINK_GATEWAY_SHARED_SECRET: '',
      },
      async function assertDirectCodexClientCredential() {
        const workflow = buildWorkflowGatewayConfig();
        const clientEnv = buildWorkflowClientEnv(
          workflow.config,
          'http://127.0.0.1:4318',
          workflow.subagentModelId,
          workflow.mainModelId
        );

        assert.equal(workflow.mainModelId, 'codex-astra');
        assert.equal(workflow.config.routeMap[workflow.mainModelId].provider, 'codex');
        assert.equal(workflow.config.routeMap[workflow.mainModelId].verbosity, 'high');
        assert.equal(
          workflow.config.routeMap[workflow.mainModelId].displayName,
          'Codex Main and Subagent Route'
        );
        assert.equal(workflow.config.anthropicPassthroughModels.length, 0);
        assert.equal(workflow.config.sharedSecret.length > 0, true);
        assert.equal(clientEnv.ANTHROPIC_AUTH_TOKEN, workflow.config.sharedSecret);
        assert.equal(clientEnv.ANTHROPIC_API_KEY, workflow.config.sharedSecret);
        assert.equal(clientEnv.CLAUDE_CODE_DISABLE_TERMINAL_TITLE, '1');
        assert.equal(
          clientEnv.ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES,
          'effort,xhigh_effort,max_effort'
        );
        ok('direct Codex main satisfies Claude client authentication without an Anthropic login');
      }
    );

    await withTemporaryEnv(
      {
        ...CLEAN_WORKFLOW_ENV,
        ULTRATHINK_GATEWAY_MAIN_MODEL_ID: 'route-overridden-main',
        ULTRATHINK_GATEWAY_MAIN_PROVIDER: 'anthropic',
        ULTRATHINK_GATEWAY_ROUTE_MAP_JSON: JSON.stringify({
          'route-overridden-main': { provider: 'codex' },
        }),
        ULTRATHINK_GATEWAY_SHARED_SECRET: '',
      },
      async function assertResolvedProviderOwnsClientAuthentication() {
        const workflow = buildWorkflowGatewayConfig();

        assert.equal(workflow.config.routeMap['route-overridden-main'].provider, 'codex');
        assert.equal(workflow.config.anthropicPassthroughModels.length, 0);
        assert.equal(workflow.config.sharedSecret.length > 0, true);
        const clientEnv = buildWorkflowClientEnv(
          workflow.config,
          'http://127.0.0.1:4318',
          workflow.subagentModelId,
          workflow.mainModelId
        );
        assert.equal(clientEnv.CLAUDE_CODE_DISABLE_TERMINAL_TITLE, '1');
        ok('client authentication follows the resolved main route instead of the provider hint');
      }
    );

    await withTemporaryEnv(
      CLEAN_WORKFLOW_ENV,
      async function assertAnthropicMainClearsDirectOnlyClientSettings() {
        const workflow = buildWorkflowGatewayConfig();
        const clientEnv = buildWorkflowClientEnv(
          workflow.config,
          'http://127.0.0.1:4318',
          workflow.subagentModelId,
          workflow.mainModelId
        );

        assert.equal(
          Object.hasOwn(clientEnv, 'CLAUDE_CODE_DISABLE_TERMINAL_TITLE'),
          false
        );
        ok('an Anthropic main route leaves the user-owned Claude Code terminal-title preference unchanged');
      }
    );
  }
);

await runTest(
  'claude-workflow preserves explicit gateway tool-result byte caps',
  async function testWorkflowCodexToolResultOverrides() {
    await withTemporaryEnv(
      {
        ...CLEAN_WORKFLOW_ENV,
        ULTRATHINK_GATEWAY_CODEX_TOOL_RESULT_MAX_BYTES: '2048',
        ULTRATHINK_GATEWAY_CODEX_TOOL_RESULT_WINDOW_MAX_BYTES: '8192',
      },
      async function assertWorkflowCodexToolResultOverrides() {
        const { config } = buildWorkflowGatewayConfig();
        assert.equal(config.codex.toolResultMaxBytes, 2048);
        assert.equal(config.codex.toolResultWindowMaxBytes, 8192);
        ok('operators can opt workflow sessions back into gateway byte caps');
      }
    );
  }
);

await runTest('gateway config exposes the Codex session pool cap', async function testCodexMaxSessionsConfig() {
  await withTemporaryEnv(
    { ULTRATHINK_GATEWAY_CODEX_MAX_SESSIONS: '3' },
    async function assertMaxSessionsConfig() {
      const config = loadGatewayConfig();
      assert.equal(config.codex.maxSessions, 3);
      ok('Codex app-server pool size is configurable through the gateway config');
    }
  );
});

await runTest('gateway config exposes the Codex fork idle timeout', async function testCodexForkIdleTimeoutConfig() {
  await withTemporaryEnv(
    { ULTRATHINK_GATEWAY_CODEX_FORK_IDLE_TIMEOUT_MS: '2500' },
    async function assertForkIdleTimeoutConfig() {
      const config = loadGatewayConfig();
      assert.equal(config.codex.forkIdleTimeoutMs, 2500);
      ok('Codex fork session idle recycling is configurable through the gateway config');
    }
  );
});

await runTest('gateway config exposes the pending Codex tool timeout', async function testCodexPendingToolTimeoutConfig() {
  await withTemporaryEnv(
    { ULTRATHINK_GATEWAY_CODEX_PENDING_TOOL_TIMEOUT_MS: '25000' },
    async function assertPendingToolTimeoutConfig() {
      const config = loadGatewayConfig();
      assert.equal(config.codex.pendingToolTimeoutMs, 25_000);
      ok('pending dynamic-tool sessions have an independent bounded lifetime');
    }
  );
});

await runTest('gateway config exposes the Codex idle-pool defaults', async function testCodexIdlePoolDefaults() {
  await withTemporaryEnv(
    {
      ULTRATHINK_GATEWAY_CODEX_FORK_IDLE_TIMEOUT_MS: undefined,
      ULTRATHINK_GATEWAY_CODEX_MAX_SESSIONS: undefined,
      ULTRATHINK_GATEWAY_CODEX_PENDING_TOOL_TIMEOUT_MS: undefined,
    },
    async function assertIdlePoolDefaults() {
      const config = loadGatewayConfig();
      assert.equal(config.codex.forkIdleTimeoutMs, 30_000);
      assert.equal(config.codex.maxSessions, 16);
      assert.equal(config.codex.pendingToolTimeoutMs, 10 * 60_000);
      ok('Codex idle-pool defaults are explicit in gateway config');
    }
  );
});

await runTest('gateway config expands home-relative Codex and trace paths', async function testGatewayConfigExpandsHomePaths() {
  const previous = {
    ULTRATHINK_GATEWAY_TRACE_DIR: process.env.ULTRATHINK_GATEWAY_TRACE_DIR,
    ULTRATHINK_GATEWAY_CODEX_CWD: process.env.ULTRATHINK_GATEWAY_CODEX_CWD,
  };

  try {
    process.env.ULTRATHINK_GATEWAY_TRACE_DIR = '~/ultrathink-gateway-trace';
    process.env.ULTRATHINK_GATEWAY_CODEX_CWD = '~/ultrathink-codex-cwd';
    const config = loadGatewayConfig();
    assert.equal(
      config.traceDir,
      path.resolve(path.join(os.homedir(), 'ultrathink-gateway-trace'))
    );
    assert.equal(
      config.codex.cwd,
      path.resolve(path.join(os.homedir(), 'ultrathink-codex-cwd'))
    );
    ok('gateway config expands home-relative trace and Codex cwd paths');
  } finally {
    restoreEnv(previous);
  }
});

await runTest('gateway finish events clear request timers without aborting successful streams', async function testGatewayFinishDoesNotAbort() {
  const req = new EventEmitter();
  const res = new EventEmitter();
  res.writableEnded = true;

  const signal = withAbortSignal(req, res, 60_000);
  res.emit('finish');

  assert.equal(signal.aborted, false);
  ok('normal response completion no longer aborts the routed Codex session');
});

await runTest('gateway SSE writer emits atomic events and honors response backpressure', async function testSseWriterBackpressure() {
  const res = new EventEmitter();
  const chunks = [];
  let resolved = false;
  res.destroyed = false;
  res.write = function write(chunk) {
    chunks.push(chunk);
    return false;
  };

  const promise = writeSseEvent(res, 'message_delta', { type: 'message_delta' }).then(
    function markResolved() {
      resolved = true;
    }
  );
  await sleep(10);
  assert.equal(resolved, false);
  assert.equal(chunks.length, 1);
  assert.match(chunks[0], /^event: message_delta\ndata: \{"type":"message_delta"\}\n\n$/u);

  res.emit('drain');
  await promise;
  assert.equal(resolved, true);

  const closedRes = new EventEmitter();
  closedRes.destroyed = true;
  closedRes.write = function failUnexpectedWrite() {
    throw new Error('write should not be called after response destruction');
  };

  await assert.rejects(
    writeSseEvent(closedRes, 'ping', { type: 'ping' }),
    /response stream closed before write completed/u
  );
  ok('SSE writes stay atomic while still waiting for drain and rejecting closed responses');
});

await runTest('gateway traces client-aborted Codex turns separately from failures', async function testGatewayAbortTraceClassification() {
  const gatewayPort = await freePort();
  const traceEvents = [];
  const tracer = {
    createId() {
      return 'abort-request';
    },
    scope(details) {
      return {
        log(event, payload) {
          traceEvents.push({ event, ...details, ...payload });
        },
      };
    },
  };
  const codexSessions = {
    async streamRequest(req) {
      return new Promise(function waitForAbort(resolve, reject) {
        req.abortSignal.addEventListener(
          'abort',
          function rejectAbort() {
            reject(
              new GatewayError(
                499,
                'api_error',
                'gateway request aborted before Codex turn completed'
              )
            );
          },
          { once: true }
        );
      });
    },
  };
  const app = createGatewayApp(
    gatewayConfig({
      requestTimeoutMs: 60_000,
      exposedModels: [],
    }),
    codexSessions,
    tracer
  );
  const server = app.listen(gatewayPort, '127.0.0.1');
  await waitForListening(server);

  try {
    await new Promise(function sendAndAbort(resolve) {
      const clientRequest = http.request({
        host: '127.0.0.1',
        port: gatewayPort,
        path: '/v1/messages',
        method: 'POST',
        headers: jsonHeaders(),
      });
      clientRequest.on('error', resolve);
      clientRequest.write(
        JSON.stringify({
          model: 'claude-sonnet-4-7',
          stream: true,
          messages: [{ role: 'user', content: 'Abort this routed Codex request.' }],
        })
      );
      clientRequest.end();
      setTimeout(function abortClientRequest() {
        clientRequest.destroy();
        resolve();
      }, 20);
    });

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (
        traceEvents.some(function hasAbortEvent(event) {
          return event.event === 'gateway.request.aborted';
        })
      ) {
        break;
      }
      await sleep(25);
    }

    assert.equal(
      traceEvents.some(function hasAbortEvent(event) {
        return event.event === 'gateway.request.aborted';
      }),
      true
    );
    assert.equal(
      traceEvents.some(function hasFailureEvent(event) {
        return event.event === 'gateway.request.failed';
      }),
      false
    );
    ok('client-aborted routed Codex turns are traceable without being counted as gateway failures');
  } finally {
    await closeServer(server);
  }
});

await runTest('gateway request timeouts remain distinct from client-aborted Codex turns', async function testGatewayTimeoutClassification() {
  const gatewayPort = await freePort();
  const traceEvents = [];
  const tracer = {
    createId() {
      return 'timeout-request';
    },
    scope(details) {
      return {
        log(event, payload) {
          traceEvents.push({ event, ...details, ...payload });
        },
      };
    },
  };
  const codexSessions = {
    async processRequest(req) {
      return new Promise(function rejectOnAbort(resolve, reject) {
        req.abortSignal.addEventListener(
          'abort',
          function rejectTimeout() {
            reject(req.abortSignal.reason);
          },
          { once: true }
        );
      });
    },
  };
  const app = createGatewayApp(
    gatewayConfig({
      requestTimeoutMs: 20,
      exposedModels: [],
    }),
    codexSessions,
    tracer
  );
  const server = app.listen(gatewayPort, '127.0.0.1');
  await waitForListening(server);

  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        model: 'claude-sonnet-4-7',
        messages: [{ role: 'user', content: 'Timeout this routed Codex request.' }],
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 504);
    assert.match(payload.error.message, /timed out/u);
    assert.equal(
      traceEvents.some(function hasTimeoutFailure(event) {
        return event.event === 'gateway.request.failed' && event.gateway_error_status === 504;
      }),
      true
    );
    assert.equal(
      traceEvents.some(function hasAbortEvent(event) {
        return event.event === 'gateway.request.aborted';
      }),
      false
    );
    ok('gateway timeouts report as 504 failures instead of client-abort noise');
  } finally {
    await closeServer(server);
  }
});

await runTest('gateway can expose routed Codex response model metadata', async function testCodexDisplayRoutedModelJson() {
  const gatewayPort = await freePort();
  let seenRoute = null;
  let seenRequestBody = null;

  const codexSessions = {
    async processRequest(req, requestBody, route) {
      seenRequestBody = requestBody;
      seenRoute = route;
      return {
        type: 'final',
        text: 'DISPLAY_MODEL_OK',
        usage: {
          input_tokens: 9,
          output_tokens: 3,
          cache_read_input_tokens: 4,
          reasoning_output_tokens: 2,
          total_tokens: 14,
        },
      };
    },
  };
  const app = createGatewayApp(
    gatewayConfig({
      displayRoutedModel: true,
      exposedModels: ['claude-sonnet-4-7'],
      routeMap: {
        'claude-sonnet-4-7': {
          provider: 'codex',
          model: 'gpt-5.6-sol',
          reasoningEffort: 'medium',
          verbosity: 'high',
        },
      },
    }),
    codexSessions
  );
  const server = app.listen(gatewayPort, '127.0.0.1');
  await waitForListening(server);

  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        model: 'claude-sonnet-4-7',
        messages: [{ role: 'user', content: 'Say DISPLAY_MODEL_OK.' }],
      }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();

    assert.equal(seenRequestBody.model, 'claude-sonnet-4-7');
    assert.equal(seenRoute.provider, 'codex');
    assert.equal(payload.model, routedResponseModel(seenRoute));
    assert.equal(payload.content[0].text, 'DISPLAY_MODEL_OK');
    assert.deepEqual(payload.usage, {
      input_tokens: 9,
      output_tokens: 3,
      cache_read_input_tokens: 4,
    });
    ok('Codex JSON responses can report routed provider/upstream metadata without changing the request');
  } finally {
    await closeServer(server);
  }
});

await runTest('gateway refuses unauthenticated non-loopback binds', async function testGatewayRefusesUnsafeBind() {
  assert.throws(
    function constructUnsafeGateway() {
      createGatewayApp({
        host: '0.0.0.0',
        sharedSecret: '',
      });
    },
    /Refusing to start unauthenticated gateway on non-loopback host 0\.0\.0\.0/u
  );

  for (const host of ['127', '127.999.999.999']) {
    assert.throws(
      function constructAmbiguousGateway() {
        createGatewayApp({
          host,
          sharedSecret: '',
        });
      },
      new RegExp(`Refusing to start unauthenticated gateway on non-loopback host ${host.replaceAll('.', '\\.')}`, 'u')
    );
  }

  ok('non-loopback gateway binds require an explicit shared secret');
});

await runTest('gateway trace context keeps Claude session and routed model identity', async function testGatewayTraceContext() {
  const req = claudeSessionRequest('session-trace', {
    'x-claude-code-agent-id': 'agent-1',
    'x-claude-code-parent-agent-id': 'parent-1',
  });
  const route = codexRoute({
    provider: 'codex',
  });

  assert.deepEqual(summarizeGatewayTraceContext(req, route), {
    claude_session_id: 'session-trace',
    claude_agent_id: 'agent-1',
    claude_parent_agent_id: 'parent-1',
    provider: 'codex',
    requested_model: 'claude-sonnet-4-7',
    upstream_model: CODEX_FIXTURE_UPSTREAM_MODEL,
    sandbox: 'workspace-write',
    approval_policy: 'never',
  });
  ok('trace context carries enough identity to tie request completion/failure back to one Claude workflow session');
});

await runTest('gateway request summaries cap historical tool_result ids while keeping the total count', async function testGatewayRequestSummaryCapsToolResults() {
  const messages = [{ role: 'user', content: [] }];
  for (let index = 1; index <= 20; index += 1) {
    messages[0].content.push({
      type: 'tool_result',
      tool_use_id: `call_${String(index).padStart(2, '0')}`,
      content: `result ${index}`,
    });
  }

  const summary = summarizeRequestBody({
    model: 'claude-sonnet-4-7',
    messages,
    tools: [],
  });

  assert.equal(summary.tool_result_count, 20);
  assert.equal(summary.tool_result_ids.length, 16);
  assert.deepEqual(summary.tool_result_ids.slice(0, 3), ['call_05', 'call_06', 'call_07']);
  assert.deepEqual(summary.tool_result_ids.slice(-3), ['call_18', 'call_19', 'call_20']);
  ok('long workflow traces keep recent tool results without dumping every historical id');
});

await runTest(
  'Codex dynamic tool registry preserves StructuredOutput and annotates collision-safe aliases',
  async function testCodexToolAliasing() {
    const registry = buildCodexDynamicToolRegistry([
      {
        name: 'mcp__claude_ai_Gmail__authenticate',
        description: 'OAuth bootstrap tool',
        input_schema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      },
      {
        name: 'Workflow',
        description: 'Workflow launcher',
        input_schema: {
          type: 'object',
          properties: {
            script: {
              type: 'string',
            },
          },
          required: ['script'],
          additionalProperties: false,
        },
      },
      {
        name: 'StructuredOutput',
        description: 'Return structured output in the requested format',
        input_schema: {
          type: 'object',
          properties: {
            answer: {
              type: 'string',
            },
          },
          required: ['answer'],
          additionalProperties: false,
        },
      },
      {
        name: 'StructuredOutput',
        description: 'Duplicate names must still remain collision-safe',
        input_schema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      },
    ]);

    assert.equal(registry.dynamicTools.length, 4);
    assert.equal(registry.dynamicTools.every((tool) => tool.type === 'function'), true);
    assert.equal(registry.dynamicTools[0].name, 'ext_tool_001');
    assert.equal(registry.dynamicTools[1].name, 'ext_tool_002');
    assert.equal(registry.dynamicTools[2].name, 'StructuredOutput');
    assert.equal(registry.dynamicTools[3].name, 'ext_tool_004');
    assert.match(
      registry.dynamicTools[0].description,
      /Claude Code tool name: mcp__claude_ai_Gmail__authenticate\./u
    );
    assert.match(registry.dynamicTools[1].description, /Claude Code tool name: Workflow\./u);
    assert.equal(
      registry.dynamicTools[2].description,
      'Return structured output in the requested format'
    );
    assert.match(
      registry.dynamicTools[3].description,
      /Claude Code tool name: StructuredOutput\./u
    );
    assert.equal(
      registry.byInternalName.get('ext_tool_001')?.originalName,
      'mcp__claude_ai_Gmail__authenticate'
    );
    assert.equal(registry.byInternalName.get('ext_tool_002')?.originalName, 'Workflow');
    assert.equal(registry.byInternalName.get('StructuredOutput')?.originalName, 'StructuredOutput');
    assert.equal(registry.byInternalName.get('ext_tool_004')?.originalName, 'StructuredOutput');
    ok(
      'StructuredOutput remains directly callable while every other Claude tool stays collision-safe'
    );
  }
);

await runTest(
  'Codex session manager retains StructuredOutput for schema-rejection follow-up',
  async function testStructuredOutputSchemaRejectionFollowUp() {
    const closedSessions = [];
    let advanceCalls = 0;
    const manager = stubCodexSessionManager(null, {
      sessionOverrides: {
        ephemeralThread: true,
        async advance(requestBody) {
          advanceCalls += 1;
          if (advanceCalls === 1) {
            this.pendingToolCall = {
              callId: 'structured_output_1',
              tool: 'StructuredOutput',
            };
            return {
              type: 'tool_use',
              text: '',
              toolCall: {
                id: 'structured_output_1',
                name: 'StructuredOutput',
                input: { answer: 42 },
              },
              usage: emptyUsage(),
            };
          }

          assert.equal(
            requestBody.messages.at(-1).content[0].tool_use_id,
            this.pendingToolCall.callId
          );
          this.pendingToolCall = null;
          return {
            type: 'final',
            text: 'corrected',
            usage: emptyUsage(),
          };
        },
        async close(reason) {
          closedSessions.push(reason?.message || '');
        },
      },
    });

    const outcome = await manager.processRequest(
      claudeSessionRequest('structured-output-session', {
        'x-claude-code-agent-id': 'structured-output-agent',
      }),
      {
        model: CODEX_REQUEST_MODEL,
        messages: [{ role: 'user', content: 'Return the typed result.' }],
        tools: [
          {
            name: 'StructuredOutput',
            description: 'Return structured output in the requested format',
            input_schema: {
              type: 'object',
              properties: { answer: { type: 'string' } },
              required: ['answer'],
              additionalProperties: false,
            },
          },
        ],
      },
      codexRoute()
    );

    assert.equal(outcome.type, 'tool_use');
    assert.equal(outcome.toolCall.name, 'StructuredOutput');
    assert.equal(manager.sessions.size, 1);
    assert.deepEqual(closedSessions, []);

    const corrected = await manager.processRequest(
      claudeSessionRequest('structured-output-session', {
        'x-claude-code-agent-id': 'structured-output-agent',
      }),
      {
        model: CODEX_REQUEST_MODEL,
        messages: [
          { role: 'user', content: 'Return the typed result.' },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'structured_output_1',
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
                tool_use_id: 'structured_output_1',
                is_error: true,
                content: 'answer must be a string',
              },
            ],
          },
        ],
        tools: [
          {
            name: 'StructuredOutput',
            description: 'Return structured output in the requested format',
            input_schema: {
              type: 'object',
              properties: { answer: { type: 'string' } },
              required: ['answer'],
              additionalProperties: false,
            },
          },
        ],
      },
      codexRoute()
    );

    assert.equal(corrected.type, 'final');
    assert.equal(corrected.text, 'corrected');
    assert.equal(advanceCalls, 2);
    assert.equal(manager.sessions.size, 1);
    await manager.close();
    assert.deepEqual(closedSessions, ['']);
    ok('schema rejection continues on the live Codex session before eventual cleanup');
  }
);

await runTest('Codex dynamic Read tool metadata teaches safe paging', async function testCodexReadToolGuidance() {
  const readSchema = {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
      offset: { type: 'integer', description: 'Old offset docs.' },
      limit: { type: 'integer', description: 'Old limit docs.' },
      pages: { type: 'string' },
    },
    required: ['file_path'],
    additionalProperties: false,
  };
  const registry = buildCodexDynamicToolRegistry([
    {
      name: 'Read',
      description: 'Reads a file.',
      input_schema: readSchema,
    },
  ]);
  const tool = registry.dynamicTools[0];

  assert.equal(tool.name, 'ext_tool_001');
  assert.equal(registry.byInternalName.get('ext_tool_001')?.originalName, 'Read');
  assert.match(tool.description, /Codex Read guidance/u);
  assert.match(tool.description, /1-based source line/u);
  assert.match(tool.description, /25,000 tokens or 256 KB/u);
  assert.match(tool.inputSchema.properties.offset.description, /Old offset docs/u);
  assert.match(tool.inputSchema.properties.offset.description, /1-based source line/u);
  assert.match(tool.inputSchema.properties.limit.description, /Old limit docs/u);
  assert.match(tool.inputSchema.properties.limit.description, /small explicit range/u);
  assert.equal(readSchema.properties.offset.description, 'Old offset docs.');
  ok('Read tools receive source-accurate paging guidance without mutating Claude tool schemas');
});

await runTest('Codex dynamic shell tools teach bounded diff inspection', async function testCodexLargeOutputToolGuidance() {
  const registry = buildCodexDynamicToolRegistry([
    { name: 'Bash', description: 'Runs a command.', input_schema: { type: 'object' } },
    { name: 'Grep', description: 'Searches files.', input_schema: { type: 'object' } },
  ]);

  for (const tool of registry.dynamicTools) {
    assert.match(tool.description, /Codex large-output guidance/u);
    assert.match(tool.description, /git diff --stat/u);
    assert.match(tool.description, /every hunk can be accounted for/u);
    assert.match(tool.description, /partial or truncated result as incomplete/u);
  }
  ok('Bash and Grep advertise a gap-aware large-diff protocol to routed Codex sessions');
});

await runTest('Codex session manager reuses the pending session when a matching tool_result arrives', async function testToolResultSessionReuse() {
  const createdSessions = [];
  const manager = stubCodexSessionManager(function recordSession(sessionKey, session) {
    createdSessions.push(session);
  });
  const route = codexRoute();
  const req = claudeSessionRequest('session-1');

  const canonicalBody = {
    model: CODEX_REQUEST_MODEL,
    messages: [{ role: 'user', content: 'Run the tool.' }],
    tools: [],
  };
  const canonical = manager.ensureSession(req, canonicalBody, route);
  canonical.pendingToolCall = { callId: 'call_123' };

  const result = await manager.streamRequest(
    req,
    {
      model: CODEX_REQUEST_MODEL,
      messages: [
        { role: 'user', content: 'Run the tool.' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_123', name: 'Workflow', input: {} }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_123', content: 'tool complete', is_error: false }],
        },
      ],
      tools: [],
    },
    route,
    function noop() {}
  );

  assert.equal(createdSessions.length, 1);
  assert.equal(result.ok, true);
  ok('matching tool_result requests are routed back to the original pending Codex session');
});

await runTest('Codex session manager forks unrelated side requests while a tool_result is pending', async function testPendingForking() {
  const createdSessionKeys = [];
  const manager = stubCodexSessionManager(function recordSessionKey(sessionKey) {
    createdSessionKeys.push(sessionKey);
  });
  const route = codexRoute();
  const req = claudeSessionRequest('session-2');

  const canonicalBody = {
    model: CODEX_REQUEST_MODEL,
    system: 'Shared workflow instructions.',
    messages: [
      { role: 'user', content: 'Primary request.' },
    ],
    tools: [],
  };
  const canonical = manager.ensureSession(req, canonicalBody, route);
  canonical.pendingToolCall = { callId: 'call_pending' };

  await manager.streamRequest(
    req,
    {
      model: CODEX_REQUEST_MODEL,
      system: 'Shared workflow instructions.',
      messages: [
        { role: 'user', content: 'A different in-session request arrived before the tool_result.' },
      ],
      tools: [],
    },
    route,
    function noop() {}
  );

  assert.equal(createdSessionKeys.length, 2);
  assert.match(createdSessionKeys[1], /:fork:[0-9a-f]{64}$/u);
  ok('side requests no longer collide with a pending tool_result in the canonical Codex session');
});

await runTest('Codex session manager forks unrelated tool_result requests while a tool_result is pending', async function testPendingForkingWithDifferentToolResult() {
  const createdSessionKeys = [];
  const manager = stubCodexSessionManager(function recordSessionKey(sessionKey) {
    createdSessionKeys.push(sessionKey);
  });
  const route = codexRoute();
  const req = claudeSessionRequest('session-2b');

  const canonical = manager.ensureSession(
    req,
    {
      model: CODEX_REQUEST_MODEL,
      system: 'Shared workflow instructions.',
      messages: [
        { role: 'user', content: 'Primary request.' },
      ],
      tools: [],
    },
    route
  );
  canonical.pendingToolCall = { callId: 'call_pending' };

  await manager.streamRequest(
    req,
    {
      model: CODEX_REQUEST_MODEL,
      system: 'Shared workflow instructions.',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_other', name: 'Read', input: {} }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_other', content: 'other result' }],
        },
      ],
      tools: [],
    },
    route,
    function noop() {}
  );

  assert.equal(createdSessionKeys.length, 2);
  assert.match(createdSessionKeys[1], /:fork:/u);
  ok('unrelated tool_result requests no longer collide with a different pending tool_result');
});

await runTest('Codex tool_result routing ignores matching ids outside the latest user turn', async function testHistoricalToolResultDoesNotMatchPendingCall() {
  const createdSessionKeys = [];
  const manager = stubCodexSessionManager(function recordSessionKey(sessionKey) {
    createdSessionKeys.push(sessionKey);
  });
  const route = codexRoute();
  const req = claudeSessionRequest('session-historical-tool-result');
  const canonical = manager.ensureSession(req, codexUserRequest('Primary request.'), route);
  canonical.pendingToolCall = { callId: 'call_reused' };

  await manager.processRequest(
    req,
    {
      model: CODEX_REQUEST_MODEL,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call_reused', content: 'stale old result' },
          ],
        },
        { role: 'assistant', content: 'That result belongs to an older turn.' },
        { role: 'user', content: 'Unrelated current request.' },
      ],
      tools: [],
    },
    route
  );

  assert.equal(createdSessionKeys.length, 2);
  assert.match(createdSessionKeys[1], /:fork:/u);
  assert.equal(canonical.pendingToolCall.callId, 'call_reused');
  ok('historical tool results cannot hijack a pending call with a colliding id');
});

await runTest('Codex session manager forks unrelated side requests while the canonical turn is still in progress', async function testActiveBoundaryForking() {
  const createdSessionKeys = [];
  const manager = stubCodexSessionManager(function recordSessionKey(sessionKey) {
    createdSessionKeys.push(sessionKey);
  });
  const route = codexRoute();
  const req = claudeSessionRequest('session-active-boundary');

  const canonical = manager.ensureSession(
    req,
    {
      model: CODEX_REQUEST_MODEL,
      messages: [{ role: 'user', content: 'Primary request.' }],
      tools: [],
    },
    route
  );
  canonical.activeBoundary = {
    requestFingerprint: 'primary-fingerprint',
    finished: false,
  };

  await manager.streamRequest(
    req,
    {
      model: CODEX_REQUEST_MODEL,
      messages: [{ role: 'user', content: 'Different side request while the first routed turn is still running.' }],
      tools: [],
    },
    route,
    function noop() {}
  );

  assert.equal(createdSessionKeys.length, 2);
  assert.match(createdSessionKeys[1], /:fork:/u);
  ok('side requests no longer 409 when the canonical routed turn is still in progress');
});

await runTest('Codex session manager starts abortable runs synchronously after selection', async function testAbortableRunsStartSynchronously() {
  let advanceCalls = 0;
  const manager = stubCodexSessionManager(null, {
    sessionOverrides: {
      async advance() {
        advanceCalls += 1;
        return finalOutcome();
      },
    },
  });
  const route = codexRoute();
  const controller = new AbortController();
  const req = claudeSessionRequest('session-sync-abortable-start');
  Object.assign(req, {
    abortSignal: controller.signal,
  });

  const promise = manager.processRequest(req, codexUserRequest('Start immediately.'), route);

  assert.equal(advanceCalls, 1);
  await promise;
  ok('abortable session requests now mark session state before another same-tick selection can run');
});

await runTest('Codex session manager forks side requests while canonical startup is reserved', async function testRoutingReservationForking() {
  const createdSessionKeys = [];
  const advanceCalls = [];
  const advanceResolvers = [];
  const manager = stubCodexSessionManager(
    function recordSessionKey(sessionKey) {
      createdSessionKeys.push(sessionKey);
    },
    {
      sessionOverrides: {
        advance(body) {
          advanceCalls.push({
            sessionKey: this.sessionKey,
            content: body.messages[0].content,
          });
          return new Promise(function waitForTest(resolve) {
            advanceResolvers.push(resolve);
          });
        },
      },
    }
  );
  const route = codexRoute();
  const req = claudeSessionRequest('session-routing-reservation');

  const first = manager.processRequest(req, codexUserRequest('Primary request.'), route);
  assert.equal(advanceCalls.length, 1);
  assert.equal(createdSessionKeys.length, 1);
  assert.equal(manager.sessions.get(createdSessionKeys[0])?.routingReservation?.requestFingerprint !== undefined, true);

  const second = manager.processRequest(
    req,
    codexUserRequest('Different same-session side request during startup.'),
    route
  );

  assert.equal(createdSessionKeys.length, 2);
  assert.match(createdSessionKeys[1], /:fork:/u);
  assert.equal(advanceCalls[1].sessionKey, createdSessionKeys[1]);

  for (const resolve of advanceResolvers) {
    resolve(finalOutcome());
  }
  await Promise.all([first, second]);

  for (const session of manager.sessions.values()) {
    assert.equal(session.routingReservation, null);
  }
  ok('startup reservations are visible to routing and cleared after the request settles');
});

await runTest('Codex session manager clears startup reservations after synchronous request failure', async function testRoutingReservationClearedOnSynchronousFailure() {
  let selectedSession = null;
  const manager = stubCodexSessionManager(
    function recordSession(sessionKey, session) {
      selectedSession = session;
    },
    {
      sessionOverrides: {
        advance() {
          throw new GatewayError(400, 'invalid_request_error', 'synthetic startup failure');
        },
      },
    }
  );
  const route = codexRoute();
  const req = claudeSessionRequest('session-routing-reservation-failure');

  await assert.rejects(
    manager.processRequest(req, codexUserRequest('Fail before boundary.'), route),
    /synthetic startup failure/u
  );

  assert.equal(selectedSession?.routingReservation, null);
  assert.equal(manager.sessions.size, 1);
  ok('non-evicted sessions do not keep stale routing reservations after request startup fails');
});

await runTest('Codex session manager rejects admission while the pool is startup-reserved', async function testRoutingReservationBlocksPoolEviction() {
  const createdSessionKeys = [];
  const closedSessionKeys = [];
  let reservedStartupResolve = null;
  const manager = stubCodexSessionManager(
    function recordSession(sessionKey, session) {
      createdSessionKeys.push(sessionKey);
      session.close = async function close() {
        closedSessionKeys.push(sessionKey);
      };
    },
    {
      codex: {
        maxSessions: 1,
      },
      sessionOverrides: {
        advance(body) {
          if (body.messages[0].content === 'Reserved startup.') {
            return new Promise(function waitForStartup(resolve) {
              reservedStartupResolve = resolve;
            });
          }

          return finalOutcome();
        },
      },
    }
  );
  const route = codexRoute();

  const first = manager.processRequest(
    claudeSessionRequest('session-reserved-pool-1'),
    codexUserRequest('Reserved startup.'),
    route
  );
  assert.equal(createdSessionKeys.length, 1);
  assert.equal(manager.sessions.get(createdSessionKeys[0])?.routingReservation?.requestFingerprint !== undefined, true);

  await assert.rejects(
    manager.processRequest(
      claudeSessionRequest('session-reserved-pool-2'),
      codexUserRequest('Second request.'),
      route
    ),
    /max_sessions=1/u
  );
  await sleep(0);

  assert.deepEqual(closedSessionKeys, []);
  assert.equal(manager.sessions.size, 1);

  reservedStartupResolve(finalOutcome());
  await first;
  await sleep(0);

  assert.deepEqual(closedSessionKeys, []);
  ok('hard pool admission preserves the reserved session without exceeding max_sessions');
});

await runTest('Codex session manager uses a shorter idle timeout for fork sessions', async function testForkSessionIdleTimeout() {
  const observedTimeouts = await observeForkIdleTimeouts(
    {
      idleTimeoutMs: 60_000,
      forkIdleTimeoutMs: 25,
    },
    'session-fork-timeout'
  );
  const canonicalTimeout = observedTimeoutForSession(observedTimeouts, function isCanonical(
    sessionKey
  ) {
    return !isForkSessionKey(sessionKey);
  });
  const forkTimeout = observedTimeoutForSession(observedTimeouts, isForkSessionKey);

  assert.equal(canonicalTimeout, 60_000);
  assert.equal(forkTimeout, 25);
  ok('canonical sessions stay reusable while fork sessions recycle quickly');
});

await runTest('Codex session manager defaults fork recycling when manual configs omit it', async function testForkSessionDefaultIdleTimeout() {
  const observedTimeouts = await observeForkIdleTimeouts(
    {
      forkIdleTimeoutMs: undefined,
      idleTimeoutMs: 60_000,
    },
    'session-fork-default-timeout'
  );
  const forkTimeout = observedTimeoutForSession(observedTimeouts, isForkSessionKey);

  assert.equal(forkTimeout, 30_000);
  ok('manual gateway configs still use the default fork recycle timeout');
});

await runTest('Codex session manager treats blank manual fork timeouts as unset', async function testForkSessionBlankIdleTimeout() {
  const observedTimeouts = await observeForkIdleTimeouts(
    {
      forkIdleTimeoutMs: '',
      idleTimeoutMs: 60_000,
    },
    'session-fork-blank-timeout'
  );
  const forkTimeout = observedTimeoutForSession(observedTimeouts, isForkSessionKey);

  assert.equal(forkTimeout, 30_000);
  ok('blank manual fork timeout values do not disable fork recycling');
});

await runTest('Codex session manager isolates materially different system instructions', async function testSystemPromptChanges() {
  const createdSessionKeys = [];
  const manager = stubCodexSessionManager(
    function recordSessionKey(sessionKey) {
      createdSessionKeys.push(sessionKey);
    },
    {
      sessionOverrides: {
        async stream(body, onEvent) {
          onEvent(finalBoundary({ input_tokens: 0, output_tokens: 1 }));
          return { ok: true, body };
        },
      },
    }
  );
  const route = codexRoute();
  const req = claudeSessionRequest('session-system-churn');

  await manager.streamRequest(
    req,
    {
      model: CODEX_REQUEST_MODEL,
      system: 'Claude Code attribution block A',
      messages: [{ role: 'user', content: 'First request.' }],
      tools: [],
    },
    route,
    function noop() {}
  );

  await manager.streamRequest(
    req,
    {
      model: CODEX_REQUEST_MODEL,
      system: 'Claude Code attribution block B',
      messages: [{ role: 'user', content: 'Second request.' }],
      tools: [],
    },
    route,
    function noop() {}
  );

  assert.equal(createdSessionKeys.length, 2);
  assert.notEqual(createdSessionKeys[0], createdSessionKeys[1]);
  ok('changed system instructions cannot reuse a Codex thread pinned to stale developer instructions');
});

await runTest('Codex session manager aborts and evicts a live session when the gateway request is aborted', async function testAbortEvictsLiveSession() {
  let closeCalls = 0;
  let closeReason = null;
  let pendingResolve = null;
  const manager = stubCodexSessionManager(null, {
    sessionOverrides: {
      async stream() {
        return new Promise(function captureResolve(resolve) {
          pendingResolve = resolve;
        });
      },
      async close(reason) {
        closeCalls += 1;
        closeReason = reason;
        pendingResolve?.({ ok: false });
      },
    },
  });

  const route = codexRoute();
  const controller = new AbortController();
  const req = claudeSessionRequest('session-abort');
  Object.assign(req, {
    abortSignal: controller.signal,
  });

  const promise = manager.streamRequest(
    req,
    {
      model: CODEX_REQUEST_MODEL,
      messages: [{ role: 'user', content: 'Long running review.' }],
      tools: [],
    },
    route,
    function noop() {}
  );

  controller.abort();

  await assert.rejects(promise, /gateway request aborted before Codex turn completed/u);
  assert.equal(closeCalls, 1);
  assert.match(closeReason?.message || '', /gateway request aborted before Codex turn completed/u);
  assert.equal(manager.sessions.size, 0);
  ok('aborted gateway requests now stop the Codex session instead of leaking work');
});

await runTest('Codex session manager does not start turns for pre-aborted requests', async function testPreAbortedRequestsDoNotStartTurns() {
  let advanceCalls = 0;
  let closeCalls = 0;
  const manager = stubCodexSessionManager(null, {
    sessionOverrides: {
      async advance() {
        advanceCalls += 1;
        return finalOutcome();
      },
      async close() {
        closeCalls += 1;
      },
    },
  });
  const controller = new AbortController();
  controller.abort(new GatewayError(499, 'api_error', 'pre-aborted request'));
  const req = claudeSessionRequest('session-pre-abort');
  Object.assign(req, {
    abortSignal: controller.signal,
  });

  await assert.rejects(
    manager.processRequest(
      req,
      {
        model: CODEX_REQUEST_MODEL,
        messages: [{ role: 'user', content: 'This should never start.' }],
        tools: [],
      },
      codexRoute()
    ),
    /pre-aborted request/u
  );

  assert.equal(advanceCalls, 0);
  assert.equal(closeCalls, 1);
  assert.equal(manager.sessions.size, 0);
  ok('already-aborted requests evict without starting a new Codex turn');
});

await runTest('Codex session manager evicts failed app-server sessions from the pool', async function testFailedCodexSessionsAreEvicted() {
  let closeCalls = 0;
  const manager = stubCodexSessionManager(null, {
    sessionOverrides: {
      async stream() {
        throw new GatewayError(502, 'api_error', 'dead Codex app-server');
      },
      async close() {
        closeCalls += 1;
      },
    },
  });

  await assert.rejects(
    manager.streamRequest(
      claudeSessionRequest('session-dead'),
      {
        model: CODEX_REQUEST_MODEL,
        messages: [{ role: 'user', content: 'Trigger a dead session.' }],
        tools: [],
      },
      codexRoute(),
      function noop() {}
    ),
    /dead Codex app-server/u
  );

  assert.equal(closeCalls, 1);
  assert.equal(manager.sessions.size, 0);
  ok('failed Codex sessions are removed before another request can reuse them');
});

await runTest('Codex session manager caps old idle Codex app-server sessions', async function testMaxSessionPoolEvictsOldIdleSessions() {
  const { closedSessions, createdSessionKeys, manager } = pooledCodexSessionManager({
    maxSessions: 2,
  });

  await processCodexSessionIds(
    manager,
    ['pool-a', 'pool-b', 'pool-c'],
    codexUserRequest('Finish quickly.')
  );
  await waitForClosedSession(closedSessions);

  assert.equal(closedSessions.length, 1);
  assert.equal(closedSessions[0].sessionKey, createdSessionKeys[0]);
  assert.match(closedSessions[0].message, /max_sessions=2/u);
  assert.equal(manager.sessions.size, 2);
  await manager.close();
  ok('idle Codex app-server pressure is bounded by closing the oldest disposable sessions');
});

await runTest('Codex session LRU remains correct when the WSL wall clock rolls back', async function testSessionLruIgnoresWallClockRollback() {
  const originalNow = Date.now;
  let wallClock = 10_000;
  Date.now = () => wallClock;

  const { closedSessions, createdSessionKeys, manager } = pooledCodexSessionManager({
    maxSessions: 2,
  });
  const route = codexRoute();
  const requestBody = codexUserRequest('Finish quickly.');

  try {
    await manager.processRequest(claudeSessionRequest('rollback-a'), requestBody, route);
    wallClock = 20_000;
    await manager.processRequest(claudeSessionRequest('rollback-b'), requestBody, route);

    wallClock = 500;
    await manager.processRequest(claudeSessionRequest('rollback-a'), requestBody, route);
    wallClock = 600;
    await manager.processRequest(claudeSessionRequest('rollback-c'), requestBody, route);
    await waitForClosedSession(closedSessions);

    assert.equal(closedSessions.length, 1);
    assert.equal(closedSessions[0].sessionKey, createdSessionKeys[1]);
    assert.equal(manager.sessions.has(createdSessionKeys[0]), true);
    assert.equal(manager.sessions.has(createdSessionKeys[2]), true);
  } finally {
    Date.now = originalNow;
    await manager.close();
  }

  ok('manager-owned monotonic sequencing evicts the true least-recently-used session');
});

await runTest('Codex session manager keeps pending tool_result sessions within the hard pool cap', async function testMaxSessionPoolKeepsPendingToolResultSessions() {
  let firstSession = null;
  const { closedSessions, manager } = pooledCodexSessionManager(
    { maxSessions: 1 },
    function captureFirstSession(sessionKey, session) {
      firstSession ||= session;
    }
  );
  const route = codexRoute();
  const requestBody = codexUserRequest('Finish quickly.');

  await manager.processRequest(claudeSessionRequest('pool-pending'), requestBody, route);
  firstSession.pendingToolCall = { callId: 'call_waiting' };

  await assert.rejects(
    manager.processRequest(claudeSessionRequest('pool-new'), requestBody, route),
    /max_sessions=1/u
  );
  await sleep(25);

  assert.equal(closedSessions.length, 0);
  assert.equal(manager.sessions.size, 1);
  await manager.close();
  ok('pool pressure rejects new admission instead of closing or exceeding a pending session');
});

await runTest('Codex session manager treats blank manual pool caps as unset', async function testBlankMaxSessionPoolDefaults() {
  const { closedSessions, createdSessionKeys, manager } = pooledCodexSessionManager({
    maxSessions: '',
  });
  const sessionIds = Array.from({ length: 17 }, function buildSessionId(_, index) {
    return `pool-default-${index}`;
  });

  await processCodexSessionIds(manager, sessionIds, codexUserRequest('Finish quickly.'));
  await waitForClosedSession(closedSessions);

  assert.equal(closedSessions.length, 1);
  assert.equal(closedSessions[0].sessionKey, createdSessionKeys[0]);
  assert.match(closedSessions[0].message, /max_sessions=16/u);
  assert.equal(manager.sessions.size, 16);
  await manager.close();
  ok('blank manual pool caps use the default max session limit');
});

await runTest('Codex session manager arms idle timers only after active turns finish', async function testIdleTimerArmsAfterTurn() {
  let finishTurn = null;
  let touchCalls = 0;
  let clearIdleCalls = 0;
  const manager = stubCodexSessionManager(null, {
    sessionOverrides: {
      clearIdleTimer() {
        clearIdleCalls += 1;
      },
      touch() {
        touchCalls += 1;
      },
      async stream() {
        return new Promise(function waitForTurn(resolve) {
          finishTurn = resolve;
        });
      },
    },
  });

  const promise = manager.streamRequest(
    claudeSessionRequest('session-idle'),
    {
      model: CODEX_REQUEST_MODEL,
      messages: [{ role: 'user', content: 'Keep this turn active.' }],
      tools: [],
    },
    codexRoute(),
    function noop() {}
  );

  await sleep(25);
  assert.equal(clearIdleCalls, 1);
  assert.equal(touchCalls, 0);

  finishTurn(finalOutcome({ input_tokens: 1, output_tokens: 1 }));
  await promise;

  assert.equal(touchCalls, 1);
  ok('idle expiration cannot close a session while a routed Codex turn is active');
});

await runTest('Codex session identity keys cannot collide through raw header separators', async function testSessionIdentityKeySeparatorSafety() {
  const createdSessionKeys = [];
  const manager = stubCodexSessionManager(function recordSessionKey(sessionKey) {
    createdSessionKeys.push(sessionKey);
  });
  const requestBody = {
    model: CODEX_REQUEST_MODEL,
    messages: [{ role: 'user', content: 'Same transcript, ambiguous headers.' }],
    tools: [],
  };

  await manager.processRequest(
    claudeSessionRequest('s', {
      'x-claude-code-agent-id': 'a:b',
      'x-claude-code-parent-agent-id': 'c',
    }),
    requestBody,
    codexRoute()
  );
  await manager.processRequest(
    claudeSessionRequest('s:a', {
      'x-claude-code-agent-id': 'b',
      'x-claude-code-parent-agent-id': 'c',
    }),
    requestBody,
    codexRoute()
  );

  assert.equal(createdSessionKeys.length, 2);
  for (const sessionKey of createdSessionKeys) {
    assert.match(
      sessionKey,
      /^identity:[0-9a-f]{64}:[0-9a-f]{64}:[0-9a-f]{64}$/u
    );
  }
  assert.notEqual(createdSessionKeys[0], createdSessionKeys[1]);
  ok('full SHA-256 session digests prevent weak-hash and raw-header separator collisions');
});

await runTest(
  'Codex app-server marks Claude workflow agent threads as ephemeral subagents',
  async function testCodexWorkflowAgentThreadStartMetadata() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-codex-thread-source-'));
    const codexPath = path.join(tempDir, 'codex-thread-source');
    const recordsPath = path.join(tempDir, 'records.jsonl');

    try {
      await makeExecutable(
        codexPath,
        '#!/usr/bin/env node\n' +
          "const fs = require('node:fs');\n" +
          "const readline = require('node:readline');\n" +
          'const recordsPath = process.env.ULTRATHINK_TEST_CODEX_THREAD_RECORDS;\n' +
          'let threadCount = 0;\n' +
          'let turnCount = 0;\n' +
          'function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }\n' +
          'function record(message) {\n' +
          "  fs.appendFileSync(recordsPath, `${JSON.stringify({ method: message.method, params: message.params })}\\n`, 'utf8');\n" +
          '}\n' +
          'const rl = readline.createInterface({ input: process.stdin });\n' +
          "rl.on('line', function onLine(line) {\n" +
          '  const message = JSON.parse(line);\n' +
          "  if (message.method === 'initialize') {\n" +
          '    send({ id: message.id, result: { protocolVersion: 2 } });\n' +
          '    return;\n' +
          '  }\n' +
          "  if (message.method === 'thread/start') {\n" +
          '    record(message);\n' +
          '    threadCount += 1;\n' +
          "    send({ id: message.id, result: { thread: { id: `thread-${threadCount}` } } });\n" +
          '    return;\n' +
          '  }\n' +
          "  if (message.method === 'turn/start') {\n" +
          '    record(message);\n' +
          '    turnCount += 1;\n' +
          '    const turnId = `turn-${turnCount}`;\n' +
          '    send({ id: message.id, result: { turn: { id: turnId } } });\n' +
          "    setTimeout(function completeTurn() { send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } }); }, 5);\n" +
          '  }\n' +
          '});\n' +
          'setInterval(function keepAlive() {}, 1000);\n'
      );

      const previousRecordsPath = process.env.ULTRATHINK_TEST_CODEX_THREAD_RECORDS;
      process.env.ULTRATHINK_TEST_CODEX_THREAD_RECORDS = recordsPath;
      const manager = new CodexSessionManager({
        requestTimeoutMs: 5_000,
        codex: {
          command: codexPath,
          cwd: tempDir,
          idleTimeoutMs: 0,
          closeKillTimeoutMs: 50,
        },
      });
      try {
        await manager.processRequest(gatewayRequest(), codexUserRequest('Root chat'), codexRoute());
        await manager.processRequest(
          claudeSessionRequest('session-agent', {
            'x-claude-code-agent-id': 'agent-1',
            'x-claude-code-parent-agent-id': 'parent-1',
          }),
          codexUserRequest('Agent chat'),
          codexRoute()
        );
      } finally {
        await manager.close();
        if (previousRecordsPath === undefined) {
          delete process.env.ULTRATHINK_TEST_CODEX_THREAD_RECORDS;
        } else {
          process.env.ULTRATHINK_TEST_CODEX_THREAD_RECORDS = previousRecordsPath;
        }
      }

      const recordsText = await fs.readFile(recordsPath, 'utf8');
      const records = recordsText
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(function parseRecord(line) {
          return JSON.parse(line);
        });
      const threadStarts = records.filter(function isThreadStart(record) {
        return record.method === 'thread/start';
      });

      assert.equal(threadStarts.length, 2);
      assert.equal(threadStarts[0].params.threadSource, 'user');
      assert.equal(threadStarts[0].params.ephemeral, undefined);
      assert.equal(
        Object.hasOwn(
          threadStarts[0].params.config || {},
          'model_auto_compact_token_limit_scope'
        ),
        false
      );
      assert.equal(threadStarts[1].params.threadSource, 'subagent');
      assert.equal(threadStarts[1].params.ephemeral, true);
      assert.equal(
        Object.hasOwn(
          threadStarts[1].params.config || {},
          'model_auto_compact_token_limit_scope'
        ),
        false
      );
      ok('Claude workflow agent Codex threads are pathless/non-resumable app-server threads');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
);

await runTest(
  'Codex app-server parallel tool calls round-trip on the same turn in order',
  async function testCodexParallelToolCallsDoNotClobberPendingCall() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-codex-parallel-tool-'));
    const codexPath = path.join(tempDir, 'codex-parallel-tool');
    const responsesPath = path.join(tempDir, 'tool-responses.json');

    try {
      await makeExecutable(
        codexPath,
        '#!/usr/bin/env node\n' +
          "const fs = require('node:fs');\n" +
          "const readline = require('node:readline');\n" +
          'const responsesPath = process.env.ULTRATHINK_TEST_CODEX_TOOL_RESPONSES;\n' +
          'const responses = [];\n' +
          'const turnId = "turn-1";\n' +
          'function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }\n' +
          'function record(message) {\n' +
          '  responses.push(message);\n' +
          "  fs.writeFileSync(responsesPath, JSON.stringify(responses), 'utf8');\n" +
          '}\n' +
          'const rl = readline.createInterface({ input: process.stdin });\n' +
          "rl.on('line', function onLine(line) {\n" +
          '  const message = JSON.parse(line);\n' +
          "  if (message.method === 'initialize') {\n" +
          '    send({ id: message.id, result: { protocolVersion: 2 } });\n' +
          '    return;\n' +
          '  }\n' +
          "  if (message.method === 'thread/start') {\n" +
          "    send({ id: message.id, result: { thread: { id: 'thread-1' } } });\n" +
          '    return;\n' +
          '  }\n' +
          "  if (message.method === 'turn/start') {\n" +
          '    send({ id: message.id, result: { turn: { id: turnId } } });\n' +
          '    setTimeout(function emitToolCalls() {\n' +
          "      send({ id: 'tool_req_1', method: 'item/tool/call', params: { turnId, callId: 'call_first', tool: 'ext_tool_001', arguments: { value: 'first' } } });\n" +
          "      send({ id: 'tool_req_2', method: 'item/tool/call', params: { turnId, callId: 'call_second', tool: 'ext_tool_001', arguments: { value: 'second' } } });\n" +
          "      send({ id: 'unregistered', method: 'item/tool/call', params: { turnId, callId: 'call_unknown', tool: 'NotFromClaude', arguments: {} } });\n" +
          "      send({ id: 'duplicate', method: 'item/tool/call', params: { turnId, callId: 'call_second', tool: 'ext_tool_001', arguments: {} } });\n" +
          '    }, 5);\n' +
          '    return;\n' +
          '  }\n' +
          "  if (['tool_req_1', 'tool_req_2', 'unregistered', 'duplicate'].includes(message.id)) {\n" +
          '    record(message);\n' +
          "    if (message.id === 'tool_req_2' && message.result) {\n" +
          '      setTimeout(function completeTurn() {\n' +
          "        send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });\n" +
          '      }, 5);\n' +
          '    }\n' +
          '  }\n' +
          '});\n' +
          'setInterval(function keepAlive() {}, 1000);\n'
      );

      const previousPath = process.env.ULTRATHINK_TEST_CODEX_TOOL_RESPONSES;
      process.env.ULTRATHINK_TEST_CODEX_TOOL_RESPONSES = responsesPath;
      let manager = null;
      try {
        manager = new CodexSessionManager({
          requestTimeoutMs: 5_000,
          codex: {
            command: codexPath,
            cwd: tempDir,
            idleTimeoutMs: 0,
          },
        });
        const initialRequest = {
          model: CODEX_REQUEST_MODEL,
          messages: [{ role: 'user', content: 'Call the lookup tool.' }],
          tools: [
            {
              name: 'lookup',
              input_schema: {
                type: 'object',
                properties: {
                  value: { type: 'string' },
                },
              },
            },
          ],
        };

        const toolUse = await manager.processRequest(gatewayRequest(), initialRequest, codexRoute());
        assert.equal(toolUse.type, 'tool_use');
        assert.deepEqual(toolUse.toolCall, {
          id: 'call_first',
          name: 'lookup',
          input: { value: 'first' },
        });
        await waitForFile(responsesPath); // the third call has arrived and was rejected
        const second = await manager.processRequest(
          gatewayRequest(),
          {
            model: CODEX_REQUEST_MODEL,
            messages: [
              { role: 'user', content: 'Call the lookup tool.' },
              {
                role: 'assistant',
                content: [
                  {
                    type: 'tool_use',
                    id: 'call_first',
                    name: 'lookup',
                    input: { value: 'first' },
                  },
                ],
              },
              {
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: 'call_first',
                    content: 'first complete',
                  },
                ],
              },
            ],
            tools: initialRequest.tools,
          },
          codexRoute()
        );
        assert.deepEqual(second.toolCall, {
          id: 'call_second', name: 'lookup', input: { value: 'second' },
        });
        assert.deepEqual(second.usage, { input_tokens: 0, output_tokens: 0 });
        const finalOutcome = await manager.processRequest(gatewayRequest(), {
          ...initialRequest,
          messages: [{ role: 'user', content: [{
            type: 'tool_result', tool_use_id: 'call_second', content: [
              { type: 'text', text: 'before' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } },
              { type: 'tool_reference', tool_name: 'mcp__test__search' },
            ],
          }] }],
        }, codexRoute());
        const finalResponses = JSON.parse(await fs.readFile(responsesPath, 'utf8'));
        const continuedFirstCall = finalResponses.find(function findFirstResponse(message) {
          return message.id === 'tool_req_1';
        });

        assert.equal(finalOutcome.type, 'final');
        assert.equal(continuedFirstCall.result.success, true);
        assert.deepEqual(continuedFirstCall.result.contentItems, [
          {
            type: 'inputText',
            text: 'first complete',
          },
        ]);
        assert.deepEqual(finalResponses.map((response) => response.id), ['unregistered', 'duplicate', 'tool_req_1', 'tool_req_2']);
        assert.deepEqual(finalResponses.slice(0, 2).map((response) => response.error.code), [-32602, -32602]);
        assert.deepEqual(finalResponses.at(-1).result, {
          success: true, contentItems: [
            { type: 'inputText', text: 'before' },
            { type: 'inputImage', imageUrl: 'data:image/png;base64,aW1hZ2U=' },
            { type: 'inputText', text: '[Claude tool reference: "mcp__test__search"]' },
          ],
        });
        ok('parallel calls receive both original results, including ordered image and tool reference blocks');
      } finally {
        await manager?.close();
        if (previousPath === undefined) {
          delete process.env.ULTRATHINK_TEST_CODEX_TOOL_RESPONSES;
        } else {
          process.env.ULTRATHINK_TEST_CODEX_TOOL_RESPONSES = previousPath;
        }
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
);

await runTest(
  'Codex app-server preserves Read arguments and returns paging feedback',
  async function testCodexReadArgumentsAndFeedback() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-codex-read-feedback-'));
    const codexPath = path.join(tempDir, 'codex-read-feedback');
    const responsesPath = path.join(tempDir, 'tool-responses.json');

    try {
      await makeExecutable(
        codexPath,
        '#!/usr/bin/env node\n' +
          "const fs = require('node:fs');\n" +
          "const readline = require('node:readline');\n" +
          'const responsesPath = process.env.ULTRATHINK_TEST_CODEX_TOOL_RESPONSES;\n' +
          'const responses = [];\n' +
          'const turnId = "turn-read-feedback";\n' +
          'function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }\n' +
          'function record(message) {\n' +
          '  responses.push(message);\n' +
          "  fs.writeFileSync(responsesPath, JSON.stringify(responses), 'utf8');\n" +
          '}\n' +
          'const rl = readline.createInterface({ input: process.stdin });\n' +
          "rl.on('line', function onLine(line) {\n" +
          '  const message = JSON.parse(line);\n' +
          "  if (message.method === 'initialize') {\n" +
          '    send({ id: message.id, result: { protocolVersion: 2 } });\n' +
          '    return;\n' +
          '  }\n' +
          "  if (message.method === 'thread/start') {\n" +
          "    send({ id: message.id, result: { thread: { id: 'thread-1' } } });\n" +
          '    return;\n' +
          '  }\n' +
          "  if (message.method === 'turn/start') {\n" +
          '    send({ id: message.id, result: { turn: { id: turnId } } });\n' +
          '    setTimeout(function emitToolCall() {\n' +
          "      send({ id: 'tool_req_read', method: 'item/tool/call', params: { turnId, callId: 'call_read', tool: 'ext_tool_001', arguments: { file_path: '/tmp/example.txt', offset: 1300000, limit: '20', pages: '' } } });\n" +
          '    }, 5);\n' +
          '    return;\n' +
          '  }\n' +
          "  if (message.id === 'tool_req_read') {\n" +
          '    record(message);\n' +
          '    if (message.result) {\n' +
          '      setTimeout(function completeTurn() {\n' +
          "        send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });\n" +
          '      }, 5);\n' +
          '    }\n' +
          '  }\n' +
          '});\n' +
          'setInterval(function keepAlive() {}, 1000);\n'
      );

      const previousPath = process.env.ULTRATHINK_TEST_CODEX_TOOL_RESPONSES;
      process.env.ULTRATHINK_TEST_CODEX_TOOL_RESPONSES = responsesPath;
      let manager = null;
      try {
        const { entries, tracer } = captureTracer();
        manager = new CodexSessionManager(
          {
            requestTimeoutMs: 5_000,
            codex: {
              command: codexPath,
              cwd: tempDir,
              idleTimeoutMs: 0,
              inputMaxTokens: 10_000,
              toolResultMaxBytes: 10_000,
            },
          },
          { tracer }
        );
        const tools = [
          {
            name: 'Read',
            description: 'Reads a file.',
            input_schema: {
              type: 'object',
              properties: {
                file_path: { type: 'string' },
                offset: { type: 'integer' },
                limit: { type: 'integer' },
                pages: { type: 'string' },
              },
              required: ['file_path'],
              additionalProperties: false,
            },
          },
        ];
        const initialRequest = {
          model: CODEX_REQUEST_MODEL,
          messages: [{ role: 'user', content: 'Read the file carefully.' }],
          tools,
        };

        const toolUse = await manager.processRequest(gatewayRequest(), initialRequest, codexRoute());
        assert.deepEqual(toolUse.toolCall, {
          id: 'call_read',
          name: 'Read',
          input: {
            file_path: '/tmp/example.txt',
            offset: 1300000,
            limit: '20',
            pages: '',
          },
        });

        const finalOutcome = await manager.processRequest(
          gatewayRequest(),
          {
            model: CODEX_REQUEST_MODEL,
            messages: [
              { role: 'user', content: 'Read the file carefully.' },
              {
                role: 'assistant',
                content: [
                  {
                    type: 'tool_use',
                    id: 'call_read',
                    name: 'Read',
                    input: toolUse.toolCall.input,
                  },
                ],
              },
              {
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: 'call_read',
                    content: 'File has 331 lines, but offset 1300000 was requested.',
                    is_error: true,
                  },
                ],
              },
            ],
            tools,
          },
          codexRoute()
        );
        const responses = JSON.parse(await fs.readFile(responsesPath, 'utf8'));
        const continuedCall = responses.find(function findReadResponse(message) {
          return message.id === 'tool_req_read';
        });
        const continuedText = continuedCall.result.contentItems[0].text;
        const sanitizeTrace = entries.find(function findSanitizeTrace(entry) {
          return entry.event === 'codex.read_tool.arguments_sanitized';
        });
        const inputTrace = entries.find(function findInputTrace(entry) {
          return entry.event === 'codex.turn.input_prepared';
        });
        const resultTrace = entries.find(function findResultTrace(entry) {
          return entry.event === 'codex.tool_result.continued';
        });

        assert.equal(finalOutcome.type, 'final');
        assert.equal(continuedCall.result.success, false);
        assert.doesNotMatch(continuedText, /Proxy Read offset note:/u);
        assert.match(continuedText, /Codex Read guidance:/u);
        assert.match(continuedText, /1-based source line/u);
        assert.equal(sanitizeTrace, undefined);
        assert.equal(inputTrace.details.summary.message_count, 1);
        assert.equal(inputTrace.details.summary.text_bytes > 0, true);
        assert.equal(resultTrace.details.read_result_feedback.guidanceAppended, true);
        assert.equal(resultTrace.details.read_sanitization.changed, false);
        assert.equal(resultTrace.details.read_sanitization.original_offset, 1300000);
        assert.equal(resultTrace.details.read_sanitization.sanitized_offset, 1300000);
        assert.equal(resultTrace.details.read_sanitization.sanitized_limit, '20');
        assert.equal(resultTrace.details.read_sanitization.offset_removed, false);
        ok('Read arguments pass through unchanged while failures receive source-accurate guidance');
      } finally {
        await manager?.close();
        if (previousPath === undefined) {
          delete process.env.ULTRATHINK_TEST_CODEX_TOOL_RESPONSES;
        } else {
          process.env.ULTRATHINK_TEST_CODEX_TOOL_RESPONSES = previousPath;
        }
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
);

await runTest(
  'Codex correlates Claude 2.1.250 Read partial metadata and keeps a contiguous prefix',
  async function testCodexReadResultTruncation() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-codex-read-truncate-'));
    const codexPath = path.join(tempDir, 'codex-read-truncate');
    const responsesPath = path.join(tempDir, 'tool-responses.json');

    try {
      await makeExecutable(
        codexPath,
        '#!/usr/bin/env node\n' +
          "const fs = require('node:fs');\n" +
          "const readline = require('node:readline');\n" +
          'const responsesPath = process.env.ULTRATHINK_TEST_CODEX_TOOL_RESPONSES;\n' +
          'const responses = [];\n' +
          'const turnId = "turn-read-truncate";\n' +
          'function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }\n' +
          'function record(message) {\n' +
          '  responses.push(message);\n' +
          "  fs.writeFileSync(responsesPath, JSON.stringify(responses), 'utf8');\n" +
          '}\n' +
          'const rl = readline.createInterface({ input: process.stdin });\n' +
          "rl.on('line', function onLine(line) {\n" +
          '  const message = JSON.parse(line);\n' +
          "  if (message.method === 'initialize') {\n" +
          '    send({ id: message.id, result: { protocolVersion: 2 } });\n' +
          '    return;\n' +
          '  }\n' +
          "  if (message.method === 'thread/start') {\n" +
          "    record({ event: 'thread_start', params: message.params });\n" +
          "    send({ id: message.id, result: { thread: { id: 'thread-1' } } });\n" +
          '    return;\n' +
          '  }\n' +
          "  if (message.method === 'turn/start') {\n" +
          '    send({ id: message.id, result: { turn: { id: turnId } } });\n' +
          '    setTimeout(function emitToolCall() {\n' +
          "      send({ id: 'tool_req_read_truncate', method: 'item/tool/call', params: { turnId, callId: 'call_read_truncate', tool: 'ext_tool_001', arguments: { file_path: '/Users/yshaaban/src/ultrathink/js/gateway/codex-provider.js' } } });\n" +
          '    }, 5);\n' +
          '    return;\n' +
          '  }\n' +
          "  if (message.id === 'tool_req_read_truncate') {\n" +
          '    record(message);\n' +
          '    if (message.result) {\n' +
          '      setTimeout(function completeTurn() {\n' +
          "        send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });\n" +
          '      }, 5);\n' +
          '    }\n' +
          '  }\n' +
          '});\n' +
          'setInterval(function keepAlive() {}, 1000);\n'
      );

      const previousPath = process.env.ULTRATHINK_TEST_CODEX_TOOL_RESPONSES;
      process.env.ULTRATHINK_TEST_CODEX_TOOL_RESPONSES = responsesPath;
      let manager = null;
      try {
        const { entries, tracer } = captureTracer();
        manager = new CodexSessionManager(
          {
            requestTimeoutMs: 5_000,
            codex: {
              command: codexPath,
              cwd: tempDir,
              idleTimeoutMs: 0,
              inputMaxTokens: 10_000,
              toolResultMaxBytes: 0,
            },
          },
          { tracer }
        );
        const tools = [
          {
            name: 'Read',
            input_schema: {
              type: 'object',
              properties: {
                file_path: { type: 'string' },
                offset: { type: 'integer' },
                limit: { type: 'integer' },
              },
            },
          },
        ];
        const initialRequest = {
          model: CODEX_REQUEST_MODEL,
          messages: [{ role: 'user', content: 'Read a large file.' }],
          tools,
        };
        const rawResult = Array.from({ length: 2_339 }, function line(_, index) {
          return `${String(index + 1)}\tline-${String(index + 1).padStart(4, '0')} ${'x'.repeat(24)}`;
        }).join('\n');

        const toolUse = await manager.processRequest(gatewayRequest(), initialRequest, codexRoute());
        assert.deepEqual(toolUse.toolCall, {
          id: 'call_read_truncate',
          name: 'Read',
          input: {
            file_path: '/Users/yshaaban/src/ultrathink/js/gateway/codex-provider.js',
          },
        });

        const finalOutcome = await manager.processRequest(
          gatewayRequest(),
          {
            model: CODEX_REQUEST_MODEL,
            messages: [
              { role: 'user', content: 'Read a large file.' },
              {
                role: 'assistant',
                content: [
                  {
                    type: 'tool_use',
                    id: 'call_read_truncate',
                    name: 'Read',
                    input: toolUse.toolCall.input,
                  },
                ],
              },
              {
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: 'call_read_truncate',
                    content: rawResult,
                  },
                ],
              },
              {
                role: 'system',
                content: [
                  {
                    type: 'text',
                    text:
                      '[Truncated: PARTIAL view — /Users/yshaaban/src/ultrathink/js/gateway/codex-provider.js: showing lines 1-2339 of 4403 total (40000 tokens, cap 25000). Call Read with offset=2340 limit=2339 for the next page, or Grep to find a specific section. Do NOT answer from this page alone if the answer may be further in the file.]\n\n<total_tokens>14999979 tokens left</total_tokens>',
                  },
                ],
              },
            ],
            tools,
          },
          codexRoute()
        );
        const responses = JSON.parse(await fs.readFile(responsesPath, 'utf8'));
        const continuedCall = responses.find(function findReadResponse(message) {
          return message.id === 'tool_req_read_truncate';
        });
        const threadStart = responses.find(function findThreadStart(message) {
          return message.event === 'thread_start';
        });
        const continuedText = continuedCall.result.contentItems[0].text;
        const resultTrace = entries.find(function findResultTrace(entry) {
          return entry.event === 'codex.tool_result.continued';
        });

        assert.equal(finalOutcome.type, 'final');
        assert.equal(threadStart.params.config.tool_output_token_limit, 10_000);
        assert.match(continuedText, /^1\tline-0001/u);
        assert.match(continuedText, /\[Codex Read page metadata\]/u);
        const metadata = JSON.parse(
          continuedText.split('[Codex Read page metadata]\n')[1].split('\n')[0]
        );
        assert.equal(metadata.path, '/Users/yshaaban/src/ultrathink/js/gateway/codex-provider.js');
        assert.equal(metadata.covered_start, 1);
        assert.equal(metadata.covered_end < 2_339, true);
        assert.equal(metadata.source_total_lines, 4_403);
        assert.equal(metadata.next_offset, metadata.covered_end + 1);
        assert.equal(metadata.next_limit, metadata.covered_end);
        assert.equal(metadata.contiguous, true);
        assert.equal(metadata.source_complete, false);
        assert.equal(continuedText.includes(`${metadata.covered_end}\tline-`), true);
        assert.equal(continuedText.includes(`${metadata.covered_end + 1}\tline-`), false);
        assert.equal(continuedText.includes('2339\tline-2339'), false);
        assert.equal(continuedText.includes('<total_tokens>'), false);
        assert.equal(Buffer.byteLength(continuedText, 'utf8') <= 36_000, true);
        assert.equal(resultTrace.details.read_tool_result, true);
        assert.equal(resultTrace.details.read_coverage_verified, true);
        assert.equal(resultTrace.details.read_notice_status, 'validated');
        assert.equal(resultTrace.details.tool_result_truncated, true);
        assert.equal(resultTrace.details.raw_result_bytes > resultTrace.details.result_bytes, true);
        ok('only validated canonical paging metadata follows the contiguous Read prefix');
      } finally {
        await manager?.close();
        if (previousPath === undefined) {
          delete process.env.ULTRATHINK_TEST_CODEX_TOOL_RESPONSES;
        } else {
          process.env.ULTRATHINK_TEST_CODEX_TOOL_RESPONSES = previousPath;
        }
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
);

await runTest(
  'Codex app-server tool_result payloads are truncated before continuing dynamic tools',
  async function testCodexToolResultsAreTruncatedBeforeContinue() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-codex-tool-result-budget-'));
    const codexPath = path.join(tempDir, 'codex-tool-result-budget');
    const responsesPath = path.join(tempDir, 'tool-responses.json');

    try {
      await makeExecutable(
        codexPath,
        '#!/usr/bin/env node\n' +
          "const fs = require('node:fs');\n" +
          "const readline = require('node:readline');\n" +
          'const responsesPath = process.env.ULTRATHINK_TEST_CODEX_TOOL_RESPONSES;\n' +
          'const responses = [];\n' +
          'const turnId = "turn-large-result";\n' +
          'function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }\n' +
          'function record(message) {\n' +
          '  responses.push(message);\n' +
          "  fs.writeFileSync(responsesPath, JSON.stringify(responses), 'utf8');\n" +
          '}\n' +
          'const rl = readline.createInterface({ input: process.stdin });\n' +
          "rl.on('line', function onLine(line) {\n" +
          '  const message = JSON.parse(line);\n' +
          "  if (message.method === 'initialize') {\n" +
          '    send({ id: message.id, result: { protocolVersion: 2 } });\n' +
          '    return;\n' +
          '  }\n' +
          "  if (message.method === 'thread/start') {\n" +
          "    send({ id: message.id, result: { thread: { id: 'thread-1' } } });\n" +
          '    return;\n' +
          '  }\n' +
          "  if (message.method === 'turn/start') {\n" +
          '    send({ id: message.id, result: { turn: { id: turnId } } });\n' +
          '    setTimeout(function emitToolCall() {\n' +
          "      send({ id: 'tool_req_large', method: 'item/tool/call', params: { turnId, callId: 'call_large', tool: 'ext_tool_001', arguments: {} } });\n" +
          '    }, 5);\n' +
          '    return;\n' +
          '  }\n' +
          "  if (message.id === 'tool_req_large') {\n" +
          '    record(message);\n' +
          '    if (message.result) {\n' +
          '      setTimeout(function completeTurn() {\n' +
          "        send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });\n" +
          '      }, 5);\n' +
          '    }\n' +
          '  }\n' +
          '});\n' +
          'setInterval(function keepAlive() {}, 1000);\n'
      );

      const previousPath = process.env.ULTRATHINK_TEST_CODEX_TOOL_RESPONSES;
      process.env.ULTRATHINK_TEST_CODEX_TOOL_RESPONSES = responsesPath;
      let manager = null;
      try {
        manager = new CodexSessionManager({
          requestTimeoutMs: 5_000,
          codex: {
            command: codexPath,
            cwd: tempDir,
            idleTimeoutMs: 0,
            inputMaxTokens: 10_000,
            toolResultMaxBytes: 160,
          },
        });
        const initialRequest = {
          model: CODEX_REQUEST_MODEL,
          messages: [{ role: 'user', content: 'Call the lookup tool.' }],
          tools: [
            {
              name: 'lookup',
              input_schema: {
                type: 'object',
                properties: {},
              },
            },
          ],
        };

        const toolUse = await manager.processRequest(gatewayRequest(), initialRequest, codexRoute());
        assert.equal(toolUse.type, 'tool_use');
        assert.deepEqual(toolUse.toolCall, {
          id: 'call_large',
          name: 'lookup',
          input: {},
        });

        const rawResult = `${'A'.repeat(80)}MIDDLE_SHOULD_BE_REMOVED${'B'.repeat(80)}`;
        const finalOutcome = await manager.processRequest(
          gatewayRequest(),
          {
            model: CODEX_REQUEST_MODEL,
            messages: [
              { role: 'user', content: 'Call the lookup tool.' },
              {
                role: 'assistant',
                content: [
                  {
                    type: 'tool_use',
                    id: 'call_large',
                    name: 'lookup',
                    input: {},
                  },
                ],
              },
              {
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: 'call_large',
                    content: rawResult,
                  },
                ],
              },
            ],
            tools: initialRequest.tools,
          },
          codexRoute()
        );
        const finalResponses = JSON.parse(await fs.readFile(responsesPath, 'utf8'));
        const continuedCall = finalResponses.find(function findLargeResponse(message) {
          return message.id === 'tool_req_large';
        });
        const continuedText = continuedCall.result.contentItems[0].text;

        assert.equal(finalOutcome.type, 'final');
        assert.equal(continuedCall.result.success, true);
        assert.match(continuedText, /^Warning: truncated output/u);
        assert.match(continuedText, /output omitted to fit byte budget/u);
        assert.equal(continuedText.includes('MIDDLE_SHOULD_BE_REMOVED'), false);
        assert.equal(continuedText.includes('AAAAAAAA'), true);
        assert.equal(continuedText.includes('BBBBBBBB'), true);
        assert.equal(Buffer.byteLength(continuedText, 'utf8') <= 160, true);
        assert.equal(continuedText.length < rawResult.length, true);
        ok('large Claude tool_result payloads are bounded before they enter Codex app-server history');
      } finally {
        await manager?.close();
        if (previousPath === undefined) {
          delete process.env.ULTRATHINK_TEST_CODEX_TOOL_RESPONSES;
        } else {
          process.env.ULTRATHINK_TEST_CODEX_TOOL_RESPONSES = previousPath;
        }
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
);

await runTest(
  'Codex app-server dynamic tool_result payloads share a session byte budget',
  async function testCodexToolResultsShareSessionBudget() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-codex-tool-result-window-'));
    const codexPath = path.join(tempDir, 'codex-tool-result-window');
    const responsesPath = path.join(tempDir, 'tool-responses.json');

    try {
      await makeExecutable(
        codexPath,
        '#!/usr/bin/env node\n' +
          "const fs = require('node:fs');\n" +
          "const readline = require('node:readline');\n" +
          'const responsesPath = process.env.ULTRATHINK_TEST_CODEX_TOOL_RESPONSES;\n' +
          'const responses = [];\n' +
          'const turnId = "turn-tool-window";\n' +
          'let nextCall = 1;\n' +
          'function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }\n' +
          'function record(message) {\n' +
          '  responses.push(message);\n' +
          "  fs.writeFileSync(responsesPath, JSON.stringify(responses), 'utf8');\n" +
          '}\n' +
          'function sendToolCall() {\n' +
          '  const index = nextCall;\n' +
          '  nextCall += 1;\n' +
          "  send({ id: `tool_req_${index}`, method: 'item/tool/call', params: { turnId, callId: `call_${index}`, tool: 'ext_tool_001', arguments: { index } } });\n" +
          '}\n' +
          'const rl = readline.createInterface({ input: process.stdin });\n' +
          "rl.on('line', function onLine(line) {\n" +
          '  const message = JSON.parse(line);\n' +
          "  if (message.method === 'initialize') {\n" +
          '    send({ id: message.id, result: { protocolVersion: 2 } });\n' +
          '    return;\n' +
          '  }\n' +
          "  if (message.method === 'thread/start') {\n" +
          "    send({ id: message.id, result: { thread: { id: 'thread-1' } } });\n" +
          '    return;\n' +
          '  }\n' +
          "  if (message.method === 'turn/start') {\n" +
          '    send({ id: message.id, result: { turn: { id: turnId } } });\n' +
          '    setTimeout(sendToolCall, 5);\n' +
          '    return;\n' +
          '  }\n' +
          "  if (message.id && message.id.startsWith('tool_req_')) {\n" +
          '    record(message);\n' +
          '    if (responses.length < 3) {\n' +
          '      setTimeout(sendToolCall, 5);\n' +
          '    } else {\n' +
          '      setTimeout(function completeTurn() {\n' +
          "        send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });\n" +
          '      }, 5);\n' +
          '    }\n' +
          '  }\n' +
          '});\n' +
          'setInterval(function keepAlive() {}, 1000);\n'
      );

      const previousPath = process.env.ULTRATHINK_TEST_CODEX_TOOL_RESPONSES;
      process.env.ULTRATHINK_TEST_CODEX_TOOL_RESPONSES = responsesPath;
      let manager = null;
      try {
        manager = new CodexSessionManager({
          requestTimeoutMs: 5_000,
          codex: {
            command: codexPath,
            cwd: tempDir,
            idleTimeoutMs: 0,
            inputMaxTokens: 10_000,
            toolResultMaxBytes: 100,
            toolResultWindowMaxBytes: 70,
          },
        });
        const tools = [
          {
            name: 'lookup',
            input_schema: {
              type: 'object',
              properties: {},
            },
          },
        ];
        const initialRequest = {
          model: CODEX_REQUEST_MODEL,
          messages: [{ role: 'user', content: 'Call the lookup tool repeatedly.' }],
          tools,
        };
        function toolResultRequest(callId, text) {
          return {
            model: CODEX_REQUEST_MODEL,
            messages: [
              { role: 'user', content: 'Call the lookup tool repeatedly.' },
              {
                role: 'assistant',
                content: [
                  {
                    type: 'tool_use',
                    id: callId,
                    name: 'lookup',
                    input: {},
                  },
                ],
              },
              {
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: callId,
                    content: text,
                  },
                ],
              },
            ],
            tools,
          };
        }

        const firstToolUse = await manager.processRequest(
          gatewayRequest(),
          initialRequest,
          codexRoute()
        );
        assert.equal(firstToolUse.toolCall.id, 'call_1');

        const secondToolUse = await manager.processRequest(
          gatewayRequest(),
          toolResultRequest('call_1', 'A'.repeat(40)),
          codexRoute()
        );
        assert.equal(secondToolUse.toolCall.id, 'call_2');

        const thirdToolUse = await manager.processRequest(
          gatewayRequest(),
          toolResultRequest('call_2', 'B'.repeat(40)),
          codexRoute()
        );
        assert.equal(thirdToolUse.toolCall.id, 'call_3');

        const finalOutcome = await manager.processRequest(
          gatewayRequest(),
          toolResultRequest('call_3', 'C'.repeat(40)),
          codexRoute()
        );
        assert.equal(finalOutcome.type, 'final');

        const responses = JSON.parse(await fs.readFile(responsesPath, 'utf8'));
        const continuedTexts = responses.map(function responseText(message) {
          return message.result.contentItems[0].text;
        });

        assert.equal(continuedTexts[0], 'A'.repeat(40));
        assert.match(continuedTexts[1], /^Warning: truncated output/u);
        assert.equal(Buffer.byteLength(continuedTexts[1], 'utf8'), 30);
        assert.equal(continuedTexts[2], '');
        assert.equal(
          continuedTexts.reduce(function sumBytes(total, text) {
            return total + Buffer.byteLength(text, 'utf8');
          }, 0),
          70
        );
        ok('aggregate dynamic-tool output, including truncation metadata, obeys the hard session cap');
      } finally {
        await manager?.close();
        if (previousPath === undefined) {
          delete process.env.ULTRATHINK_TEST_CODEX_TOOL_RESPONSES;
        } else {
          process.env.ULTRATHINK_TEST_CODEX_TOOL_RESPONSES = previousPath;
        }
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
);

await runTest(
  'Codex app-server usage reports per-boundary input cache and reasoning deltas',
  async function testCodexUsageDeltas() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-codex-usage-delta-'));
    const codexPath = path.join(tempDir, 'codex-usage-delta');

    try {
      await makeExecutable(
        codexPath,
        '#!/usr/bin/env node\n' +
          "const readline = require('node:readline');\n" +
          'let turnCount = 0;\n' +
          'function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }\n' +
          'const usages = [\n' +
          '  { inputTokens: 100, cachedInputTokens: 20, outputTokens: 30, reasoningOutputTokens: 5, totalTokens: 115 },\n' +
          '  { inputTokens: 160, cachedInputTokens: 50, outputTokens: 45, reasoningOutputTokens: 7, totalTokens: 162 },\n' +
          '];\n' +
          'const rl = readline.createInterface({ input: process.stdin });\n' +
          "rl.on('line', function onLine(line) {\n" +
          '  const message = JSON.parse(line);\n' +
          "  if (message.method === 'initialize') {\n" +
          '    send({ id: message.id, result: { protocolVersion: 2 } });\n' +
          '    return;\n' +
          '  }\n' +
          "  if (message.method === 'thread/start') {\n" +
          "    send({ id: message.id, result: { thread: { id: 'thread-usage' } } });\n" +
          '    return;\n' +
          '  }\n' +
          "  if (message.method === 'turn/start') {\n" +
          '    const turnId = `turn-${turnCount + 1}`;\n' +
          '    const usage = usages[turnCount];\n' +
          '    turnCount += 1;\n' +
          '    send({ id: message.id, result: { turn: { id: turnId } } });\n' +
          '    setTimeout(function completeTurn() {\n' +
          "      send({ method: 'item/agentMessage/delta', params: { turnId, itemId: `${turnId}-message`, delta: `done ${turnId}` } });\n" +
          "      send({ method: 'thread/tokenUsage/updated', params: { turnId, tokenUsage: { total: usage } } });\n" +
          "      send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });\n" +
          '    }, 5);\n' +
          '  }\n' +
          '});\n' +
          'setInterval(function keepAlive() {}, 1000);\n'
      );

      const manager = new CodexSessionManager({
        requestTimeoutMs: 5_000,
        codex: {
          command: codexPath,
          cwd: tempDir,
          idleTimeoutMs: 0,
        },
      });

      try {
        const req = claudeSessionRequest('codex-usage-delta');
        const firstOutcome = await manager.processRequest(
          req,
          codexUserRequest('First usage turn.'),
          codexRoute()
        );
        const secondOutcome = await manager.processRequest(
          req,
          {
            model: CODEX_REQUEST_MODEL,
            messages: [
              { role: 'user', content: 'First usage turn.' },
              { role: 'assistant', content: [{ type: 'text', text: firstOutcome.text }] },
              { role: 'user', content: 'Second usage turn.' },
            ],
            tools: [],
          },
          codexRoute()
        );

        assert.deepEqual(firstOutcome.usage, {
          input_tokens: 80,
          output_tokens: 30,
          cache_read_input_tokens: 20,
          reasoning_output_tokens: 5,
          total_tokens: 115,
        });
        assert.deepEqual(secondOutcome.usage, {
          input_tokens: 30,
          output_tokens: 15,
          cache_read_input_tokens: 30,
          reasoning_output_tokens: 2,
          total_tokens: 47,
        });
        ok('Codex cumulative usage is translated into per-response Claude usage deltas');
      } finally {
        await manager.close();
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
);

await runTest(
  'Codex app-server usage uses the cumulative total delta when last is also present',
  async function testCodexUsagePrefersLastSnapshot() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-codex-usage-last-total-'));
    const codexPath = path.join(tempDir, 'codex-usage-last-total');

    try {
      await makeExecutable(
        codexPath,
        '#!/usr/bin/env node\n' +
          "const readline = require('node:readline');\n" +
          'function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }\n' +
          'let turnCount = 0;\n' +
          'const rl = readline.createInterface({ input: process.stdin });\n' +
          "rl.on('line', function onLine(line) {\n" +
          '  const message = JSON.parse(line);\n' +
          "  if (message.method === 'initialize') {\n" +
          '    send({ id: message.id, result: { protocolVersion: 2 } });\n' +
          '    return;\n' +
          '  }\n' +
          "  if (message.method === 'thread/start') {\n" +
          "    send({ id: message.id, result: { thread: { id: 'thread-usage-last-total' } } });\n" +
          '    return;\n' +
          '  }\n' +
          "  if (message.method === 'turn/start') {\n" +
          '    turnCount += 1;\n' +
          "    const turnId = `turn-${turnCount}`;\n" +
          '    send({ id: message.id, result: { turn: { id: turnId } } });\n' +
          '    setTimeout(function completeTurn() {\n' +
          "      send({ method: 'item/agentMessage/delta', params: { turnId, itemId: 'message-1', delta: 'done' } });\n" +
          '      if (turnCount === 1) {\n' +
          '        const tokenUsage = {\n' +
          '          total: { inputTokens: 1000, cachedInputTokens: 500, outputTokens: 200, reasoningOutputTokens: 50, totalTokens: 1200 },\n' +
          '          last: { inputTokens: 1000, cachedInputTokens: 500, outputTokens: 200, reasoningOutputTokens: 50, totalTokens: 1200 },\n' +
          '        };\n' +
          "        send({ method: 'thread/tokenUsage/updated', params: { turnId, tokenUsage } });\n" +
          '      } else {\n' +
          '        const firstUpdate = {\n' +
          '          total: { inputTokens: 1120, cachedInputTokens: 540, cacheWriteInputTokens: 20, outputTokens: 209, reasoningOutputTokens: 53, totalTokens: 1329 },\n' +
          '          last: { inputTokens: 120, cachedInputTokens: 40, cacheWriteInputTokens: 20, outputTokens: 9, reasoningOutputTokens: 3, totalTokens: 129 },\n' +
          '        };\n' +
          "        send({ method: 'thread/tokenUsage/updated', params: { turnId, tokenUsage: firstUpdate } });\n" +
          '        const finalUpdate = {\n' +
          '          total: { inputTokens: 1200, cachedInputTokens: 560, cacheWriteInputTokens: 30, outputTokens: 220, reasoningOutputTokens: 57, totalTokens: 1420 },\n' +
          '          last: { inputTokens: 80, cachedInputTokens: 20, cacheWriteInputTokens: 10, outputTokens: 11, reasoningOutputTokens: 4, totalTokens: 91 },\n' +
          '        };\n' +
          "        send({ method: 'thread/tokenUsage/updated', params: { turnId, tokenUsage: finalUpdate } });\n" +
          '      }\n' +
          "      send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });\n" +
          '    }, 5);\n' +
          '  }\n' +
          '});\n' +
          'setInterval(function keepAlive() {}, 1000);\n'
      );

      const manager = new CodexSessionManager({
        requestTimeoutMs: 5_000,
        codex: {
          command: codexPath,
          cwd: tempDir,
          idleTimeoutMs: 0,
        },
      });

      try {
        const baseline = await manager.processRequest(
          claudeSessionRequest('codex-usage-last-total'),
          codexUserRequest('Establish a cumulative usage baseline.'),
          codexRoute()
        );
        assert.equal(baseline.usage.total_tokens, 1200);

        const outcome = await manager.processRequest(
          claudeSessionRequest('codex-usage-last-total'),
          {
            model: CODEX_REQUEST_MODEL,
            messages: [
              { role: 'user', content: 'Establish a cumulative usage baseline.' },
              { role: 'assistant', content: 'done' },
              { role: 'user', content: 'Mixed total and last usage turn.' },
            ],
            tools: [],
          },
          codexRoute()
        );

        assert.deepEqual(outcome.usage, {
          input_tokens: 110,
          output_tokens: 20,
          cache_read_input_tokens: 60,
          cache_write_input_tokens: 30,
          reasoning_output_tokens: 7,
          total_tokens: 220,
        });
        ok('Codex total deltas include every upstream response in the Claude turn');
      } finally {
        await manager.close();
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
);

await runTest(
  'Codex app-server last-only usage snapshots do not double count session totals',
  async function testCodexLastUsageSnapshotsDoNotDoubleCountTotals() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-codex-last-usage-'));
    const codexPath = path.join(tempDir, 'codex-last-usage');

    try {
      await makeExecutable(
        codexPath,
        '#!/usr/bin/env node\n' +
          "const readline = require('node:readline');\n" +
          'let turnCount = 0;\n' +
          'function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }\n' +
          'const rl = readline.createInterface({ input: process.stdin });\n' +
          "rl.on('line', function onLine(line) {\n" +
          '  const message = JSON.parse(line);\n' +
          "  if (message.method === 'initialize') {\n" +
          '    send({ id: message.id, result: { protocolVersion: 2 } });\n' +
          '    return;\n' +
          '  }\n' +
          "  if (message.method === 'thread/start') {\n" +
          "    send({ id: message.id, result: { thread: { id: 'thread-last-usage' } } });\n" +
          '    return;\n' +
          '  }\n' +
          "  if (message.method === 'turn/start') {\n" +
          '    const turnId = `turn-${turnCount + 1}`;\n' +
          '    turnCount += 1;\n' +
          '    send({ id: message.id, result: { turn: { id: turnId } } });\n' +
          '    setTimeout(function completeTurn() {\n' +
          "      send({ method: 'item/agentMessage/delta', params: { turnId, itemId: `${turnId}-message`, delta: `done ${turnId}` } });\n" +
          '      if (turnCount === 1) {\n' +
          "        send({ method: 'thread/tokenUsage/updated', params: { turnId, tokenUsage: { last: { inputTokens: 5, outputTokens: 2 } } } });\n" +
          "        send({ method: 'thread/tokenUsage/updated', params: { turnId, tokenUsage: { last: { inputTokens: 7, outputTokens: 3 } } } });\n" +
          '      } else {\n' +
          "        send({ method: 'thread/tokenUsage/updated', params: { turnId, tokenUsage: { total: { inputTokens: 20, outputTokens: 8 } } } });\n" +
          '      }\n' +
          "      send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });\n" +
          '    }, 5);\n' +
          '  }\n' +
          '});\n' +
          'setInterval(function keepAlive() {}, 1000);\n'
      );

      const manager = new CodexSessionManager({
        requestTimeoutMs: 5_000,
        codex: {
          command: codexPath,
          cwd: tempDir,
          idleTimeoutMs: 0,
        },
      });

      try {
        const req = claudeSessionRequest('codex-last-usage');
        const firstOutcome = await manager.processRequest(
          req,
          codexUserRequest('First last-only usage turn.'),
          codexRoute()
        );
        const secondOutcome = await manager.processRequest(
          req,
          {
            model: CODEX_REQUEST_MODEL,
            messages: [
              { role: 'user', content: 'First last-only usage turn.' },
              { role: 'assistant', content: [{ type: 'text', text: firstOutcome.text }] },
              { role: 'user', content: 'Second cumulative usage turn.' },
            ],
            tools: [],
          },
          codexRoute()
        );

        assert.deepEqual(firstOutcome.usage, {
          input_tokens: 7,
          output_tokens: 3,
        });
        assert.deepEqual(secondOutcome.usage, {
          input_tokens: 13,
          output_tokens: 5,
        });
        ok('repeated last-only usage snapshots update the per-session baseline once per turn');
      } finally {
        await manager.close();
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
);

await runTest('Codex app-server invalid JSON rejects startup without crashing the gateway', async function testCodexInvalidJsonRejectsStartup() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-codex-invalid-json-'));
  const codexPath = path.join(tempDir, 'codex-invalid-json');

  try {
    await makeExecutable(
      codexPath,
      '#!/usr/bin/env node\n' +
        "process.stdout.write('not-json\\n');\n" +
        'setInterval(function keepAlive() {}, 1000);\n'
    );

    const manager = new CodexSessionManager({
      requestTimeoutMs: 5_000,
      codex: {
        command: codexPath,
        cwd: tempDir,
        idleTimeoutMs: 0,
      },
    });

    await assert.rejects(
      manager.processRequest(
        gatewayRequest(),
        {
          model: CODEX_REQUEST_MODEL,
          messages: [{ role: 'user', content: 'Trigger invalid JSON.' }],
          tools: [],
        },
        codexRoute()
      ),
      /invalid JSON/u
    );
    await manager.close();
    ok('invalid Codex app-server stdout rejects the request path instead of emitting an unhandled error');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await runTest('Codex app-server stderr stays diagnostic until the process exits', async function testCodexControlSocketResetEvictsSession() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-codex-control-reset-'));
  const codexPath = path.join(tempDir, 'codex-control-reset');

  try {
    await makeExecutable(
      codexPath,
      '#!/usr/bin/env node\n' +
        "import readline from 'node:readline';\n" +
        'const rl = readline.createInterface({ input: process.stdin });\n' +
        'function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }\n' +
        "rl.on('line', function onLine(line) {\n" +
        '  const message = JSON.parse(line);\n' +
        "  if (message.method === 'initialize') {\n" +
        '    send({ id: message.id, result: { protocolVersion: 2 } });\n' +
        '    return;\n' +
        '  }\n' +
        "  if (message.method === 'thread/start') {\n" +
        "    process.stderr.write('ERROR: remote app server at `unix:///tmp/app-server-control.sock` transport failed: WebSocket protocol error: Connection reset without closing handshake\\n');\n" +
        '    setTimeout(function exitAfterDiagnostic() { process.exit(1); }, 10);\n' +
        '  }\n' +
        '});\n' +
        'setInterval(function keepAlive() {}, 1000);\n'
    );

    const manager = new CodexSessionManager({
      requestTimeoutMs: 5_000,
      codex: {
        command: codexPath,
        closeKillTimeoutMs: 50,
        cwd: tempDir,
        idleTimeoutMs: 0,
      },
    });

    await assert.rejects(
      manager.processRequest(
        gatewayRequest(),
        {
          model: CODEX_REQUEST_MODEL,
          messages: [{ role: 'user', content: 'Trigger Codex control socket reset.' }],
          tools: [],
        },
        codexRoute()
      ),
      /exited unexpectedly/u
    );
    assert.equal(manager.sessions.size, 0);
    await manager.close();
    ok('diagnostic stderr does not corrupt JSON-RPC while a real process exit still evicts promptly');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await runTest('Codex app-server signal exits reject pending startup requests', async function testCodexSignalExitRejectsStartup() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-codex-signal-exit-'));
  const codexPath = path.join(tempDir, 'codex-signal-exit');

  try {
    await makeExecutable(
      codexPath,
      '#!/usr/bin/env node\n' +
        "process.kill(process.pid, 'SIGKILL');\n"
    );

    const manager = new CodexSessionManager({
      requestTimeoutMs: 5_000,
      codex: {
        command: codexPath,
        cwd: tempDir,
        idleTimeoutMs: 0,
      },
    });

    await assert.rejects(
      manager.processRequest(
        gatewayRequest(),
        {
          model: CODEX_REQUEST_MODEL,
          messages: [{ role: 'user', content: 'Trigger signal exit.' }],
          tools: [],
        },
        codexRoute()
      ),
      /signal SIGKILL/u
    );
    await manager.close();
    ok('signal-killed Codex app-server processes reject pending requests immediately');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await runTest('Codex app-server clean exits reject pending requests instead of timing out', async function testCodexCleanExitRejectsPendingRequest() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-codex-clean-exit-'));
  const codexPath = path.join(tempDir, 'codex-clean-exit');

  try {
    await makeExecutable(
      codexPath,
      '#!/usr/bin/env node\n' +
        "import readline from 'node:readline';\n" +
        'const rl = readline.createInterface({ input: process.stdin });\n' +
        'function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }\n' +
        "rl.on('line', function onLine(line) {\n" +
        '  const message = JSON.parse(line);\n' +
        "  if (message.method === 'initialize') {\n" +
        '    send({ id: message.id, result: { protocolVersion: 2 } });\n' +
        '    return;\n' +
        '  }\n' +
        "  if (message.method === 'thread/start') {\n" +
        "    send({ id: message.id, result: { thread: { id: 'thread-1' } } });\n" +
        '    return;\n' +
        '  }\n' +
        "  if (message.method === 'turn/start') {\n" +
        '    process.exit(0);\n' +
        '  }\n' +
        '});\n'
    );

    const manager = new CodexSessionManager({
      requestTimeoutMs: 5_000,
      codex: {
        command: codexPath,
        cwd: tempDir,
        idleTimeoutMs: 0,
      },
    });

    await assert.rejects(
      manager.processRequest(
        gatewayRequest(),
        {
          model: CODEX_REQUEST_MODEL,
          messages: [{ role: 'user', content: 'Trigger clean exit.' }],
          tools: [],
        },
        codexRoute()
      ),
      /code 0 before pending requests completed/u
    );
    await manager.close();
    ok('clean app-server exits with pending RPCs are treated as failed requests immediately');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await runTest('Codex app-server clean exits reject active turns after turn/start resolves', async function testCodexCleanExitRejectsActiveTurn() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-codex-clean-midturn-'));
  const codexPath = path.join(tempDir, 'codex-clean-midturn');

  try {
    await makeExecutable(
      codexPath,
      '#!/usr/bin/env node\n' +
        "import readline from 'node:readline';\n" +
        'const rl = readline.createInterface({ input: process.stdin });\n' +
        'function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }\n' +
        "rl.on('line', function onLine(line) {\n" +
        '  const message = JSON.parse(line);\n' +
        "  if (message.method === 'initialize') {\n" +
        '    send({ id: message.id, result: { protocolVersion: 2 } });\n' +
        '    return;\n' +
        '  }\n' +
        "  if (message.method === 'thread/start') {\n" +
        "    send({ id: message.id, result: { thread: { id: 'thread-1' } } });\n" +
        '    return;\n' +
        '  }\n' +
        "  if (message.method === 'turn/start') {\n" +
        "    send({ id: message.id, result: { turn: { id: 'turn-1' } } });\n" +
        '    setTimeout(function exitMidTurn() { process.exit(0); }, 20);\n' +
        '  }\n' +
        '});\n'
    );

    const manager = new CodexSessionManager({
      requestTimeoutMs: 5_000,
      codex: {
        command: codexPath,
        cwd: tempDir,
        idleTimeoutMs: 0,
      },
    });

    await assert.rejects(
      manager.processRequest(
        gatewayRequest(),
        {
          model: CODEX_REQUEST_MODEL,
          messages: [{ role: 'user', content: 'Trigger clean mid-turn exit.' }],
          tools: [],
        },
        codexRoute()
      ),
      /code 0/u
    );
    await manager.close();
    ok('clean app-server exits after turn/start fail the active boundary immediately');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await runTest('Codex app-server close force-kills SIGTERM-resistant children', async function testCodexCloseForceKillsStubbornChild() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-codex-stubborn-close-'));
  const codexPath = path.join(tempDir, 'codex-stubborn-close');
  const helperPidFile =
    process.platform === 'win32' ? null : path.join(tempDir, 'codex-helper.pid');
  const previousHelperPidFile = process.env.CODEX_HELPER_PID_FILE;
  let helperPid = null;

  try {
    if (helperPidFile) {
      process.env.CODEX_HELPER_PID_FILE = helperPidFile;
    }

    await makeExecutable(
      codexPath,
      '#!/usr/bin/env node\n' +
        "import { spawn } from 'node:child_process';\n" +
        "import fs from 'node:fs';\n" +
        "import readline from 'node:readline';\n" +
        "const helperPidFile = process.env.CODEX_HELPER_PID_FILE;\n" +
        'if (helperPidFile) {\n' +
        '  const helper = spawn(process.execPath, [\n' +
        "    '-e',\n" +
        "    \"process.on('SIGTERM', function ignoreSigterm() {}); setInterval(function keepAlive() {}, 1000);\",\n" +
        "  ], { stdio: 'ignore' });\n" +
        '  helper.unref();\n' +
        '  fs.writeFileSync(helperPidFile, String(helper.pid));\n' +
        '}\n' +
        'const rl = readline.createInterface({ input: process.stdin });\n' +
        'function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }\n' +
        "rl.on('line', function onLine(line) {\n" +
        '  const message = JSON.parse(line);\n' +
        "  if (message.method === 'initialize') {\n" +
        '    send({ id: message.id, result: { protocolVersion: 2 } });\n' +
        '  }\n' +
        '});\n' +
        'setInterval(function keepAlive() {}, 1000);\n'
    );

    const manager = new CodexSessionManager({
      requestTimeoutMs: 5_000,
      codex: {
        command: codexPath,
        closeKillTimeoutMs: 50,
        cwd: tempDir,
        idleTimeoutMs: 0,
      },
    });
    const session = manager.ensureSession(
      gatewayRequest(),
      {
        model: CODEX_REQUEST_MODEL,
        messages: [{ role: 'user', content: 'Prepare stubborn child.' }],
        tools: [],
      },
      codexRoute()
    );
    await session.connection.readyPromise;

    if (helperPidFile) {
      await waitForFile(helperPidFile);
      helperPid = Number(await fs.readFile(helperPidFile, 'utf8'));
      assert.equal(processExists(helperPid), true);
    }

    const start = Date.now();
    await manager.close();
    assert.equal(Date.now() - start < 1_000, true);
    if (helperPid !== null) {
      await waitForProcessExit(helperPid);
      assert.equal(processExists(helperPid), false);
    }
    ok('SIGTERM-resistant app-server children do not hang gateway shutdown');
  } finally {
    if (previousHelperPidFile === undefined) {
      delete process.env.CODEX_HELPER_PID_FILE;
    } else {
      process.env.CODEX_HELPER_PID_FILE = previousHelperPidFile;
    }
    if (helperPid !== null && processExists(helperPid)) {
      try {
        process.kill(helperPid, 'SIGKILL');
      } catch {
        // Best-effort cleanup for a failed regression test.
      }
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await runTest('Codex routing rejects invalid named Anthropic tool_choice explicitly', async function testCodexRejectsInvalidToolChoice() {
  let createdSessions = 0;
  const manager = new CodexSessionManager(
    {
      codex: {
        idleTimeoutMs: 0,
      },
    },
    {
      createSession() {
        createdSessions += 1;
        throw new Error('session should not be created');
      },
    }
  );

  await assert.rejects(
      manager.processRequest(
        gatewayRequest(),
        {
          model: CODEX_REQUEST_MODEL,
          tool_choice: { type: 'tool', name: 'MissingTool' },
          messages: [{ role: 'user', content: 'Do not use tools.' }],
          tools: [{ name: 'AvailableTool', input_schema: { type: 'object' } }],
        },
        codexRoute()
      ),
      /selected unknown tool MissingTool/u
  );
  assert.equal(createdSessions, 0);
  ok('invalid Codex tool_choice selections fail before any app-server work starts');
});

await runTest('Codex rejects remote images before opening a thread', async function testCodexRejectsRemoteImages() {
  let createdSessions = 0;
  const manager = new CodexSessionManager(
    {
      codex: {
        idleTimeoutMs: 0,
      },
    },
    {
      createSession() {
        createdSessions += 1;
        throw new Error('session should not be created');
      },
    }
  );

  await assert.rejects(
    manager.processRequest(
      gatewayRequest(),
      {
        model: CODEX_REQUEST_MODEL,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Describe this.' },
              {
                type: 'image',
                source: {
                  type: 'url',
                  url: 'https://example.invalid/image.png',
                },
              },
            ],
          },
        ],
        tools: [],
      },
      codexRoute()
    ),
    /Codex images require inline base64 data/u
  );
  assert.equal(createdSessions, 0);
  ok('remote Codex images fail explicitly without fetching them');
});

await runTest('Codex session keys include effective tool_choice narrowing', async function testCodexToolChoiceSessionKeys() {
  const createdSessionKeys = [];
  const manager = stubCodexSessionManager(function recordSessionKey(sessionKey) {
    createdSessionKeys.push(sessionKey);
  });
  const req = claudeSessionRequest('session-tool-choice');
  const route = codexRoute();
  const tools = [{ name: 'AvailableTool', input_schema: { type: 'object' } }];

  await manager.processRequest(
    req,
    {
      model: CODEX_REQUEST_MODEL,
      tool_choice: { type: 'none' },
      messages: [{ role: 'user', content: 'No tools.' }],
      tools,
    },
    route
  );
  await manager.processRequest(
    req,
    {
      model: CODEX_REQUEST_MODEL,
      tool_choice: { type: 'tool', name: 'AvailableTool' },
      messages: [{ role: 'user', content: 'Use the selected tool.' }],
      tools,
    },
    route
  );

  assert.equal(createdSessionKeys.length, 2);
  assert.notEqual(createdSessionKeys[0], createdSessionKeys[1]);
  ok('different effective Codex tool sets no longer reuse the same app-server thread');
});

await runTest('Codex tool_result routing survives missing follow-up tool_choice', async function testCodexToolResultRoutingIgnoresToolChoiceChurn() {
  const createdSessionKeys = [];
  const manager = stubCodexSessionManager(function recordSessionKey(sessionKey) {
    createdSessionKeys.push(sessionKey);
  });
  const req = claudeSessionRequest('session-tool-result-choice-churn');
  const route = codexRoute();
  const tools = [
    { name: 'SelectedTool', input_schema: { type: 'object' } },
    { name: 'OtherTool', input_schema: { type: 'object' } },
  ];

  const canonical = manager.ensureSession(
    req,
    {
      model: CODEX_REQUEST_MODEL,
      tool_choice: { type: 'tool', name: 'SelectedTool' },
      messages: [{ role: 'user', content: 'Use exactly the selected tool.' }],
      tools,
    },
    route
  );
  canonical.pendingToolCall = { callId: 'call_selected' };

  await manager.streamRequest(
    req,
    {
      model: CODEX_REQUEST_MODEL,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_selected',
              content: 'selected tool result',
            },
          ],
        },
      ],
      tools,
    },
    route,
    function noop() {}
  );

  assert.equal(createdSessionKeys.length, 1);
  ok('tool_result follow-ups return to the pending session even when tool_choice is absent');
});

await runTest('fresh Codex sessions seed the app-server turn with the supplied transcript', async function testCodexFreshSessionIncludesTranscript() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-codex-transcript-'));
  const codexPath = path.join(tempDir, 'codex-transcript');
  const turnParamsPath = path.join(tempDir, 'turn-params.json');

  try {
    await makeExecutable(
      codexPath,
      '#!/usr/bin/env node\n' +
        "import fs from 'node:fs';\n" +
        "import readline from 'node:readline';\n" +
        'const rl = readline.createInterface({ input: process.stdin });\n' +
        'function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }\n' +
        "rl.on('line', function onLine(line) {\n" +
        '  const message = JSON.parse(line);\n' +
        "  if (message.method === 'initialize') {\n" +
        '    send({ id: message.id, result: { protocolVersion: 2 } });\n' +
        '    return;\n' +
        '  }\n' +
        "  if (message.method === 'thread/start') {\n" +
        "    send({ id: message.id, result: { thread: { id: 'thread-1' } } });\n" +
        '    return;\n' +
        '  }\n' +
        "  if (message.method === 'turn/start') {\n" +
        '    fs.writeFileSync(process.env.ULTRATHINK_TEST_CODEX_TURN_PARAMS, JSON.stringify(message.params), "utf8");\n' +
        "    send({ id: message.id, result: { turn: { id: 'turn-1' } } });\n" +
        "    setTimeout(function completeTurn() { send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } }); }, 10);\n" +
        '  }\n' +
        '});\n'
    );

    const previousTarget = process.env.ULTRATHINK_TEST_CODEX_TURN_PARAMS;
    process.env.ULTRATHINK_TEST_CODEX_TURN_PARAMS = turnParamsPath;
    try {
      const manager = new CodexSessionManager({
        requestTimeoutMs: 5_000,
        codex: {
          command: codexPath,
          cwd: tempDir,
          idleTimeoutMs: 0,
        },
      });

      await manager.processRequest(
        gatewayRequest(),
        {
          model: CODEX_REQUEST_MODEL,
          messages: [
            { role: 'user', content: [
              { type: 'text', text: 'First requirement. Keep literal \ue000.' },
              { type: 'tool_result', tool_use_id: 'earlier-image', content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YQ==' } },
              ] },
            ] },
            { role: 'assistant', content: [{ type: 'text', text: 'Prior answer.' }] },
            { role: 'user', content: 'Latest question.' },
          ],
          tools: [],
        },
        codexRoute()
      );

      const turnParams = JSON.parse(await fs.readFile(turnParamsPath, 'utf8'));
      assert.deepEqual(turnParams.input.map((item) => item.type), ['text', 'image', 'text']);
      assert.match(turnParams.input[0].text, /Keep literal \ue000\./u);
      assert.equal(turnParams.input[1].url, 'data:image/png;base64,YQ==');
      const inputText = turnParams.input.filter((item) => item.type === 'text').map((item) => item.text).join('');
      assert.equal(inputText.includes('First requirement.'), true);
      assert.equal(inputText.includes('Prior answer.'), true);
      assert.equal(inputText.includes('Latest question.'), true);
      await manager.close();
      ok('fresh routed Codex sessions no longer discard prior Anthropic transcript messages');
    } finally {
      if (previousTarget === undefined) {
        delete process.env.ULTRATHINK_TEST_CODEX_TURN_PARAMS;
      } else {
        process.env.ULTRATHINK_TEST_CODEX_TURN_PARAMS = previousTarget;
      }
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await runTest('Codex sessions recycle when Claude rewinds or compacts the transcript', async function testCodexTranscriptContinuity() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-codex-continuity-'));
  const codexPath = path.join(tempDir, 'codex-continuity');
  const turnLogPath = path.join(tempDir, 'turn-log.jsonl');
  const { entries, tracer } = captureTracer();

  try {
    await makeExecutable(
      codexPath,
      '#!/usr/bin/env node\n' +
        "import fs from 'node:fs';\n" +
        "import readline from 'node:readline';\n" +
        'const rl = readline.createInterface({ input: process.stdin });\n' +
        'let turnCount = 0;\n' +
        'function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }\n' +
        "rl.on('line', function onLine(line) {\n" +
        '  const message = JSON.parse(line);\n' +
        "  if (message.method === 'initialize') {\n" +
        '    send({ id: message.id, result: { protocolVersion: 2 } });\n' +
        '    return;\n' +
        '  }\n' +
        "  if (message.method === 'thread/start') {\n" +
        '    send({ id: message.id, result: { thread: { id: `thread-${process.pid}` } } });\n' +
        '    return;\n' +
        '  }\n' +
        "  if (message.method === 'turn/start') {\n" +
        '    turnCount += 1;\n' +
        '    const turnId = `turn-${process.pid}-${turnCount}`;\n' +
        '    fs.appendFileSync(process.env.ULTRATHINK_TEST_CODEX_TURN_LOG, `${JSON.stringify({ pid: process.pid, input: message.params.input[0].text })}\\n`, "utf8");\n' +
        '    send({ id: message.id, result: { turn: { id: turnId } } });\n' +
        '    setTimeout(function completeTurn() {\n' +
        '      send({ method: "item/completed", params: { turnId, item: { type: "agentMessage", id: `message-${turnId}`, text: `R${turnCount}` } } });\n' +
        '      send({ method: "turn/completed", params: { turn: { id: turnId, status: "completed" } } });\n' +
        '    }, 10);\n' +
        '  }\n' +
        '});\n'
    );

    const previousTarget = process.env.ULTRATHINK_TEST_CODEX_TURN_LOG;
    process.env.ULTRATHINK_TEST_CODEX_TURN_LOG = turnLogPath;
    const manager = new CodexSessionManager(
      {
        requestTimeoutMs: 5_000,
        codex: {
          command: codexPath,
          cwd: tempDir,
          idleTimeoutMs: 0,
          forkIdleTimeoutMs: 0,
        },
      },
      { tracer }
    );
    const req = claudeSessionRequest('session-transcript-continuity');
    const route = codexRoute();

    try {
      const first = await manager.processRequest(req, codexUserRequest('A'), route);
      assert.equal(first.text, 'R1');
      const second = await manager.processRequest(
        req,
        {
          model: CODEX_REQUEST_MODEL,
          messages: [
            { role: 'user', content: 'A' },
            { role: 'assistant', content: [{ type: 'text', text: 'R1' }] },
            { role: 'user', content: 'B' },
          ],
          tools: [],
        },
        route
      );
      assert.equal(second.text, 'R2');

      await manager.processRequest(
        req,
        {
          model: CODEX_REQUEST_MODEL,
          messages: [
            { role: 'user', content: 'A' },
            { role: 'assistant', content: [{ type: 'text', text: 'R1' }] },
            { role: 'user', content: 'C after rewind' },
          ],
          tools: [],
        },
        route
      );

      await manager.processRequest(
        req,
        {
          model: CODEX_REQUEST_MODEL,
          messages: [
            { role: 'user', content: 'Compacted summary of the authoritative history.' },
            { role: 'user', content: 'D after compaction' },
          ],
          tools: [],
        },
        route
      );

      const turns = (await fs.readFile(turnLogPath, 'utf8'))
        .trim()
        .split(/\n/u)
        .map(function parseTurn(line) {
          return JSON.parse(line);
        });
      assert.equal(turns.length, 4);
      assert.equal(turns[0].pid, turns[1].pid, 'ordinary continuation must reuse one thread');
      assert.equal(turns[1].input.includes('B'), true);
      assert.equal(turns[1].input.includes('A'), false, 'live continuation should send latest-only input');
      assert.notEqual(turns[2].pid, turns[1].pid, 'rewind must replace the stale thread');
      assert.match(turns[2].input, /A/u);
      assert.match(turns[2].input, /R1/u);
      assert.match(turns[2].input, /C after rewind/u);
      assert.equal(turns[2].input.includes('B'), false);
      assert.notEqual(turns[3].pid, turns[2].pid, 'compaction must replace the pre-summary thread');
      assert.match(turns[3].input, /Compacted summary/u);
      assert.match(turns[3].input, /D after compaction/u);
      assert.equal(
        entries.filter(function isDivergence(entry) {
          return entry.event === 'codex.session.transcript_diverged';
        }).length,
        2
      );
      ok('rewinds and compaction replay the current authoritative transcript on clean threads');
    } finally {
      await manager.close();
      if (previousTarget === undefined) {
        delete process.env.ULTRATHINK_TEST_CODEX_TURN_LOG;
      } else {
        process.env.ULTRATHINK_TEST_CODEX_TURN_LOG = previousTarget;
      }
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await runTest('Codex sessions leave live context ownership to native app-server compaction', async function testCodexSessionContextPressureRecycle() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-codex-recycle-'));
  const codexPath = path.join(tempDir, 'codex-recycle');
  const turnLogPath = path.join(tempDir, 'turn-log.json');

  try {
    await makeExecutable(
      codexPath,
      '#!/usr/bin/env node\n' +
        "import fs from 'node:fs';\n" +
        "import readline from 'node:readline';\n" +
        'const rl = readline.createInterface({ input: process.stdin });\n' +
        'function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }\n' +
        'let threadCount = 0;\n' +
        'let turnCount = 0;\n' +
        'function appendTurn(entry) {\n' +
        '  const logPath = process.env.ULTRATHINK_TEST_CODEX_TURN_LOG;\n' +
        '  let turns = [];\n' +
        '  try { turns = JSON.parse(fs.readFileSync(logPath, "utf8")); } catch {}\n' +
        '  turns.push(entry);\n' +
        '  fs.writeFileSync(logPath, JSON.stringify(turns), "utf8");\n' +
        '}\n' +
        "rl.on('line', function onLine(line) {\n" +
        '  const message = JSON.parse(line);\n' +
        "  if (message.method === 'initialize') {\n" +
        '    send({ id: message.id, result: { protocolVersion: 2 } });\n' +
        '    return;\n' +
        '  }\n' +
        "  if (message.method === 'thread/start') {\n" +
        '    threadCount += 1;\n' +
        '    send({ id: message.id, result: { thread: { id: `thread-${threadCount}` } } });\n' +
        '    return;\n' +
        '  }\n' +
        "  if (message.method === 'turn/start') {\n" +
        '    turnCount += 1;\n' +
        '    const turnId = `turn-${turnCount}`;\n' +
        '    appendTurn({ pid: process.pid, input: message.params.input[0].text });\n' +
        '    send({ id: message.id, result: { turn: { id: turnId } } });\n' +
        '    setTimeout(function reportUsage() {\n' +
        "      send({ method: 'thread/tokenUsage/updated', params: { turnId, tokenUsage: { last: { inputTokens: 90, outputTokens: 10 }, modelContextWindow: 120 } } });\n" +
        "      send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });\n" +
        '    }, 10);\n' +
        '  }\n' +
        '});\n'
    );

    const previousTarget = process.env.ULTRATHINK_TEST_CODEX_TURN_LOG;
    process.env.ULTRATHINK_TEST_CODEX_TURN_LOG = turnLogPath;
    try {
      const manager = new CodexSessionManager({
        requestTimeoutMs: 5_000,
        codex: {
          command: codexPath,
          cwd: tempDir,
          idleTimeoutMs: 0,
          inputMaxTokens: 100,
        },
      });

      // First turn reports pressure near the model window. The gateway keeps
      // the live app-server thread and lets native Codex compaction own it.
      await manager.processRequest(
        gatewayRequest(),
        {
          model: CODEX_REQUEST_MODEL,
          messages: [{ role: 'user', content: 'hi' }],
          tools: [],
        },
        codexRoute()
      );

      await manager.processRequest(
        gatewayRequest(),
        {
          model: CODEX_REQUEST_MODEL,
          messages: [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: [] },
            { role: 'user', content: 'again' },
          ],
          tools: [],
        },
        codexRoute()
      );

      const turns = JSON.parse(await fs.readFile(turnLogPath, 'utf8'));
      assert.equal(turns.length, 2);
      assert.equal(turns[0].pid, turns[1].pid);
      assert.equal(turns[1].input.includes('again'), true);
      assert.equal(turns[1].input.includes('hi'), false);
      await manager.close();
      ok('context pressure no longer flattens and replays Claude history into a replacement process');
    } finally {
      if (previousTarget === undefined) {
        delete process.env.ULTRATHINK_TEST_CODEX_TURN_LOG;
      } else {
        process.env.ULTRATHINK_TEST_CODEX_TURN_LOG = previousTarget;
      }
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await runTest(
  'Codex input budgets do not force live process recycling',
  async function testCodexSessionRecycleUsesConfiguredBudget() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-codex-budget-recycle-'));
    const codexPath = path.join(tempDir, 'codex-budget-recycle');
    const turnLogPath = path.join(tempDir, 'turn-log.json');

    try {
      await makeExecutable(
        codexPath,
        '#!/usr/bin/env node\n' +
          "import fs from 'node:fs';\n" +
          "import readline from 'node:readline';\n" +
          'const rl = readline.createInterface({ input: process.stdin });\n' +
          'function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }\n' +
          'function appendTurn(entry) {\n' +
          '  const logPath = process.env.ULTRATHINK_TEST_CODEX_TURN_LOG;\n' +
          '  let turns = [];\n' +
          '  try { turns = JSON.parse(fs.readFileSync(logPath, "utf8")); } catch {}\n' +
          '  turns.push(entry);\n' +
          '  fs.writeFileSync(logPath, JSON.stringify(turns), "utf8");\n' +
          '}\n' +
          "rl.on('line', function onLine(line) {\n" +
          '  const message = JSON.parse(line);\n' +
          "  if (message.method === 'initialize') {\n" +
          '    send({ id: message.id, result: { protocolVersion: 2 } });\n' +
          '    return;\n' +
          '  }\n' +
          "  if (message.method === 'thread/start') {\n" +
          "    send({ id: message.id, result: { thread: { id: `thread-${process.pid}` } } });\n" +
          '    return;\n' +
          '  }\n' +
          "  if (message.method === 'turn/start') {\n" +
          "    const turnId = `turn-${message.id}`;\n" +
          '    appendTurn({ pid: process.pid, input: message.params.input[0].text });\n' +
          '    send({ id: message.id, result: { turn: { id: turnId } } });\n' +
          '    setTimeout(function reportUsage() {\n' +
          '      const tokenUsage = {\n' +
          '        last: { inputTokens: 140, outputTokens: 10, totalTokens: 150 },\n' +
          '        modelContextWindow: 1000000,\n' +
          '      };\n' +
          "      send({ method: 'thread/tokenUsage/updated', params: { turnId, tokenUsage } });\n" +
          "      send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });\n" +
          '    }, 10);\n' +
          '  }\n' +
          '});\n'
      );

      const previousTarget = process.env.ULTRATHINK_TEST_CODEX_TURN_LOG;
      process.env.ULTRATHINK_TEST_CODEX_TURN_LOG = turnLogPath;
      try {
        const manager = new CodexSessionManager({
          requestTimeoutMs: 5_000,
          codex: {
            command: codexPath,
            cwd: tempDir,
            idleTimeoutMs: 0,
            inputMaxTokens: 180,
          },
        });
        const req = claudeSessionRequest('budget-recycle');

        await manager.processRequest(
          req,
          {
            model: CODEX_REQUEST_MODEL,
            messages: [{ role: 'user', content: 'hi' }],
            tools: [],
          },
          codexRoute()
        );
        await manager.processRequest(
          req,
          {
            model: CODEX_REQUEST_MODEL,
            messages: [
              { role: 'user', content: 'hi' },
              { role: 'assistant', content: [] },
              { role: 'user', content: 'again' },
            ],
            tools: [],
          },
          codexRoute()
        );

        const turns = JSON.parse(await fs.readFile(turnLogPath, 'utf8'));
        assert.equal(turns.length, 2);
        assert.equal(turns[0].pid, turns[1].pid);
        assert.equal(turns[1].input.includes('again'), true);
        assert.equal(turns[1].input.includes('hi'), false);
        await manager.close();
        ok('configured input budgets bound payloads without replacing live Codex sessions');
      } finally {
        if (previousTarget === undefined) {
          delete process.env.ULTRATHINK_TEST_CODEX_TURN_LOG;
        } else {
          process.env.ULTRATHINK_TEST_CODEX_TURN_LOG = previousTarget;
        }
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
);

await runTest(
  'Codex keeps 12,001-line Read coverage contiguous on its pending call under stale usage',
  async function testCodexToolResultStaysOnPendingCallUnderStaleUsage() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-codex-tool-result-replay-'));
    const codexPath = path.join(tempDir, 'codex-tool-result-replay');
    const turnLogPath = path.join(tempDir, 'turn-log.json');
    const toolResponsesPath = path.join(tempDir, 'tool-responses.json');
    const replayMarker = 'RESULT_MARKER_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ';
    const largeResult = Array.from({ length: 12_001 }, function resultLine(_, index) {
      const sentinel = index === 6_000 ? replayMarker : 'payload';
      return `${String(index + 1)}\tline-${String(index + 1).padStart(5, '0')} ${sentinel} ${'x'.repeat(32)}`;
    }).join('\n');

    try {
      await fs.writeFile(toolResponsesPath, '[]', 'utf8');
      await makeExecutable(
        codexPath,
        '#!/usr/bin/env node\n' +
          "import fs from 'node:fs';\n" +
          "import readline from 'node:readline';\n" +
          'const rl = readline.createInterface({ input: process.stdin });\n' +
          'const turnLogPath = process.env.ULTRATHINK_TEST_CODEX_TURN_LOG;\n' +
          'const toolResponsesPath = process.env.ULTRATHINK_TEST_CODEX_TOOL_RESPONSES;\n' +
          'function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }\n' +
          'function appendJson(pathname, entry) {\n' +
          '  let items = [];\n' +
          '  try { items = JSON.parse(fs.readFileSync(pathname, "utf8")); } catch {}\n' +
          '  items.push(entry);\n' +
          '  fs.writeFileSync(pathname, JSON.stringify(items), "utf8");\n' +
          '}\n' +
          "rl.on('line', function onLine(line) {\n" +
          '  const message = JSON.parse(line);\n' +
          "  if (message.method === 'initialize') {\n" +
          '    send({ id: message.id, result: { protocolVersion: 2 } });\n' +
          '    return;\n' +
          '  }\n' +
          "  if (message.method === 'thread/start') {\n" +
          '    send({ id: message.id, result: { thread: { id: `thread-${process.pid}` } } });\n' +
          '    return;\n' +
          '  }\n' +
          "  if (message.method === 'turn/start') {\n" +
          '    const input = message.params.input[0].text;\n' +
          '    appendJson(turnLogPath, { pid: process.pid, input });\n' +
          "    const turnId = `turn-${process.pid}`;\n" +
          '    send({ id: message.id, result: { turn: { id: turnId } } });\n' +
          `    if (input.includes(${JSON.stringify(replayMarker)})) {\n` +
          '      setTimeout(function completeReplayTurn() {\n' +
          "        send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });\n" +
          '      }, 5);\n' +
          '      return;\n' +
          '    }\n' +
          '    setTimeout(function emitUsageAndToolCall() {\n' +
          "      send({ method: 'thread/tokenUsage/updated', params: { turnId, tokenUsage: { last: { inputTokens: 5, outputTokens: 1 }, modelContextWindow: 120 } } });\n" +
          "      send({ id: 'tool_req_replay', method: 'item/tool/call', params: { turnId, callId: 'call_replay', tool: 'ext_tool_001', arguments: { file_path: 'C:\\\\Workspace\\\\12001-lines.txt' } } });\n" +
          '    }, 5);\n' +
          '    return;\n' +
          '  }\n' +
          "  if (message.id === 'tool_req_replay') {\n" +
          '    appendJson(toolResponsesPath, { pid: process.pid, message });\n' +
          '    setTimeout(function completeContinuedTurn() {\n' +
          "      send({ method: 'turn/completed', params: { turn: { id: `turn-${process.pid}`, status: 'completed' } } });\n" +
          '    }, 5);\n' +
          '  }\n' +
          '});\n'
      );

      const previousTurnLog = process.env.ULTRATHINK_TEST_CODEX_TURN_LOG;
      const previousToolResponses = process.env.ULTRATHINK_TEST_CODEX_TOOL_RESPONSES;
      process.env.ULTRATHINK_TEST_CODEX_TURN_LOG = turnLogPath;
      process.env.ULTRATHINK_TEST_CODEX_TOOL_RESPONSES = toolResponsesPath;
      let manager = null;
      try {
        manager = new CodexSessionManager({
          requestTimeoutMs: 5_000,
          codex: {
            command: codexPath,
            cwd: tempDir,
            idleTimeoutMs: 0,
            inputMaxTokens: 100,
            toolResultMaxBytes: 0,
            toolResultWindowMaxBytes: 0,
          },
        });

        const tools = [
          {
            name: 'Read',
            input_schema: {
              type: 'object',
              properties: {
                file_path: { type: 'string' },
                offset: { type: 'integer' },
                limit: { type: 'integer' },
              },
            },
          },
        ];
        const openingMessages = [
          { role: 'user', content: 'Background context. '.repeat(8) },
          { role: 'assistant', content: [{ type: 'text', text: 'Prior analysis. '.repeat(4) }] },
          { role: 'user', content: 'Read the whole 12,001-line file and account for every line.' },
        ];
        const initialRequest = {
          model: CODEX_REQUEST_MODEL,
          messages: openingMessages,
          tools,
        };

        const toolUse = await manager.processRequest(gatewayRequest(), initialRequest, codexRoute());
        assert.equal(toolUse.type, 'tool_use');
        assert.deepEqual(toolUse.toolCall, {
          id: 'call_replay',
          name: 'Read',
          input: { file_path: 'C:\\Workspace\\12001-lines.txt' },
        });

        const finalOutcome = await manager.processRequest(
          gatewayRequest(),
          {
            model: CODEX_REQUEST_MODEL,
            messages: [
              ...openingMessages,
              {
                role: 'assistant',
                content: [
                  {
                    type: 'tool_use',
                    id: 'call_replay',
                    name: 'Read',
                    input: { file_path: 'C:\\Workspace\\12001-lines.txt' },
                  },
                ],
              },
              {
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: 'call_replay',
                    content: largeResult,
                  },
                ],
              },
              {
                role: 'system',
                content: [
                  {
                    type: 'text',
                    text:
                      '[Truncated: PARTIAL view — /mnt/c/workspace/12001-lines.txt: showing lines 1-12001 of 20000 total (50000 tokens, cap 25000). Call Read with offset=12002 limit=12001 for the next page, or Grep to find a specific section. Do NOT answer from this page alone if the answer may be further in the file.]',
                  },
                ],
              },
            ],
            tools,
          },
          codexRoute()
        );

        const turns = JSON.parse(await fs.readFile(turnLogPath, 'utf8'));
        const toolResponses = JSON.parse(await fs.readFile(toolResponsesPath, 'utf8'));
        assert.equal(toolResponses.length, 1);
        const continuedText = toolResponses[0].message.result.contentItems[0].text;

        assert.equal(finalOutcome.type, 'final');
        assert.equal(turns.length, 1);
        assert.equal(toolResponses[0].pid, turns[0].pid);
        assert.match(continuedText, /^1\tline-00001/u);
        assert.equal(Buffer.byteLength(continuedText, 'utf8') <= 36_000, true);
        const metadata = JSON.parse(
          continuedText.split('[Codex Read page metadata]\n')[1].split('\n')[0]
        );
        assert.equal(metadata.path, 'C:\\Workspace\\12001-lines.txt');
        assert.equal(metadata.covered_start, 1);
        assert.equal(metadata.covered_end < 12_001, true);
        assert.equal(metadata.source_total_lines, 20_000);
        assert.equal(metadata.next_offset, metadata.covered_end + 1);
        assert.equal(metadata.next_limit, metadata.covered_end);
        assert.equal(metadata.contiguous, true);
        assert.equal(metadata.source_complete, false);
        assert.equal(continuedText.includes(`${metadata.covered_end}\tline-`), true);
        assert.equal(continuedText.includes(`${metadata.covered_end + 1}\tline-`), false);
        assert.equal(continuedText.includes('12001\tline-12001'), false);
        assert.equal(continuedText.includes(replayMarker), false);
        ok(
          'a large Read result exposes only a gap-free prefix and exact next offset on the live call'
        );
      } finally {
        await manager?.close();
        if (previousTurnLog === undefined) {
          delete process.env.ULTRATHINK_TEST_CODEX_TURN_LOG;
        } else {
          process.env.ULTRATHINK_TEST_CODEX_TURN_LOG = previousTurnLog;
        }
        if (previousToolResponses === undefined) {
          delete process.env.ULTRATHINK_TEST_CODEX_TOOL_RESPONSES;
        } else {
          process.env.ULTRATHINK_TEST_CODEX_TOOL_RESPONSES = previousToolResponses;
        }
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
);

await runTest(
  'Codex keeps a matching tool_result on its pending call before usage arrives',
  async function testCodexToolResultStaysOnPendingCallWithoutUsage() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-codex-tool-result-replay-nou-'));
    const codexPath = path.join(tempDir, 'codex-tool-result-replay-no-usage');
    const turnLogPath = path.join(tempDir, 'turn-log.json');
    const toolResponsesPath = path.join(tempDir, 'tool-responses.json');
    const replayMarker = 'RESULT_MARKER_WITHOUT_USAGE_QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ';

    try {
      await fs.writeFile(toolResponsesPath, '[]', 'utf8');
      await makeExecutable(
        codexPath,
        '#!/usr/bin/env node\n' +
          "import fs from 'node:fs';\n" +
          "import readline from 'node:readline';\n" +
          'const rl = readline.createInterface({ input: process.stdin });\n' +
          'const turnLogPath = process.env.ULTRATHINK_TEST_CODEX_TURN_LOG;\n' +
          'const toolResponsesPath = process.env.ULTRATHINK_TEST_CODEX_TOOL_RESPONSES;\n' +
          'function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }\n' +
          'function appendJson(pathname, entry) {\n' +
          '  let items = [];\n' +
          '  try { items = JSON.parse(fs.readFileSync(pathname, "utf8")); } catch {}\n' +
          '  items.push(entry);\n' +
          '  fs.writeFileSync(pathname, JSON.stringify(items), "utf8");\n' +
          '}\n' +
          "rl.on('line', function onLine(line) {\n" +
          '  const message = JSON.parse(line);\n' +
          "  if (message.method === 'initialize') {\n" +
          '    send({ id: message.id, result: { protocolVersion: 2 } });\n' +
          '    return;\n' +
          '  }\n' +
          "  if (message.method === 'thread/start') {\n" +
          '    send({ id: message.id, result: { thread: { id: `thread-${process.pid}` } } });\n' +
          '    return;\n' +
          '  }\n' +
          "  if (message.method === 'turn/start') {\n" +
          '    const input = message.params.input[0].text;\n' +
          '    appendJson(turnLogPath, { pid: process.pid, input });\n' +
          "    const turnId = `turn-${process.pid}`;\n" +
          '    send({ id: message.id, result: { turn: { id: turnId } } });\n' +
          `    if (input.includes(${JSON.stringify(replayMarker)})) {\n` +
          '      setTimeout(function completeReplayTurn() {\n' +
          "        send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });\n" +
          '      }, 5);\n' +
          '      return;\n' +
          '    }\n' +
          '    setTimeout(function emitToolCall() {\n' +
          "      send({ id: 'tool_req_replay_no_usage', method: 'item/tool/call', params: { turnId, callId: 'call_replay_no_usage', tool: 'ext_tool_001', arguments: {} } });\n" +
          '    }, 5);\n' +
          '    return;\n' +
          '  }\n' +
          "  if (message.id === 'tool_req_replay_no_usage') {\n" +
          '    appendJson(toolResponsesPath, { pid: process.pid, message });\n' +
          '    setTimeout(function completeContinuedTurn() {\n' +
          "      send({ method: 'turn/completed', params: { turn: { id: `turn-${process.pid}`, status: 'completed' } } });\n" +
          '    }, 5);\n' +
          '  }\n' +
          '});\n'
      );

      const previousTurnLog = process.env.ULTRATHINK_TEST_CODEX_TURN_LOG;
      const previousToolResponses = process.env.ULTRATHINK_TEST_CODEX_TOOL_RESPONSES;
      process.env.ULTRATHINK_TEST_CODEX_TURN_LOG = turnLogPath;
      process.env.ULTRATHINK_TEST_CODEX_TOOL_RESPONSES = toolResponsesPath;
      let manager = null;
      try {
        manager = new CodexSessionManager({
          requestTimeoutMs: 5_000,
          codex: {
            command: codexPath,
            cwd: tempDir,
            idleTimeoutMs: 0,
            inputMaxTokens: 100,
          },
        });

        const tools = [
          {
            name: 'lookup',
            input_schema: {
              type: 'object',
              properties: {},
            },
          },
        ];
        const openingMessages = [
          { role: 'user', content: 'Background context. '.repeat(8) },
          { role: 'assistant', content: [{ type: 'text', text: 'Prior analysis. '.repeat(4) }] },
          { role: 'user', content: 'Call the lookup tool and wait for the result.' },
        ];

        const toolUse = await manager.processRequest(
          gatewayRequest(),
          {
            model: CODEX_REQUEST_MODEL,
            messages: openingMessages,
            tools,
          },
          codexRoute()
        );
        assert.equal(toolUse.type, 'tool_use');
        assert.deepEqual(toolUse.toolCall, {
          id: 'call_replay_no_usage',
          name: 'lookup',
          input: {},
        });

        const finalOutcome = await manager.processRequest(
          gatewayRequest(),
          {
            model: CODEX_REQUEST_MODEL,
            messages: [
              ...openingMessages,
              {
                role: 'assistant',
                content: [
                  {
                    type: 'tool_use',
                    id: 'call_replay_no_usage',
                    name: 'lookup',
                    input: {},
                  },
                ],
              },
              {
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: 'call_replay_no_usage',
                    content: replayMarker,
                  },
                ],
              },
            ],
            tools,
          },
          codexRoute()
        );

        const turns = JSON.parse(await fs.readFile(turnLogPath, 'utf8'));
        const toolResponses = JSON.parse(await fs.readFile(toolResponsesPath, 'utf8'));
        assert.equal(toolResponses.length, 1);
        const continuedText = toolResponses[0].message.result.contentItems[0].text;

        assert.equal(finalOutcome.type, 'final');
        assert.equal(turns.length, 1);
        assert.equal(toolResponses[0].pid, turns[0].pid);
        assert.equal(continuedText, replayMarker);
        ok(
          'missing usage cannot cause a pending dynamic-tool call to be destroyed and replayed as text'
        );
      } finally {
        await manager?.close();
        if (previousTurnLog === undefined) {
          delete process.env.ULTRATHINK_TEST_CODEX_TURN_LOG;
        } else {
          process.env.ULTRATHINK_TEST_CODEX_TURN_LOG = previousTurnLog;
        }
        if (previousToolResponses === undefined) {
          delete process.env.ULTRATHINK_TEST_CODEX_TOOL_RESPONSES;
        } else {
          process.env.ULTRATHINK_TEST_CODEX_TOOL_RESPONSES = previousToolResponses;
        }
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
);

await runTest('Codex learned context windows bound budgets for later sessions', async function testCodexLearnedWindowBudgets() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-codex-learned-window-'));
  const codexPath = path.join(tempDir, 'codex-learned-window');
  const turnLogPath = path.join(tempDir, 'turn-log.json');

  try {
    await makeExecutable(
      codexPath,
      '#!/usr/bin/env node\n' +
        "import fs from 'node:fs';\n" +
        "import readline from 'node:readline';\n" +
        'const rl = readline.createInterface({ input: process.stdin });\n' +
        'function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }\n' +
        'let turnCount = 0;\n' +
        'function appendTurn(entry) {\n' +
        '  const logPath = process.env.ULTRATHINK_TEST_CODEX_TURN_LOG;\n' +
        '  let turns = [];\n' +
        '  try { turns = JSON.parse(fs.readFileSync(logPath, "utf8")); } catch {}\n' +
        '  turns.push(entry);\n' +
        '  fs.writeFileSync(logPath, JSON.stringify(turns), "utf8");\n' +
        '}\n' +
        "rl.on('line', function onLine(line) {\n" +
        '  const message = JSON.parse(line);\n' +
        "  if (message.method === 'initialize') {\n" +
        '    send({ id: message.id, result: { protocolVersion: 2 } });\n' +
        '    return;\n' +
        '  }\n' +
        "  if (message.method === 'thread/start') {\n" +
        "    send({ id: message.id, result: { thread: { id: 'thread-1' } } });\n" +
        '    return;\n' +
        '  }\n' +
        "  if (message.method === 'turn/start') {\n" +
        '    turnCount += 1;\n' +
        '    const turnId = `turn-${turnCount}`;\n' +
        '    appendTurn({ input: message.params.input[0].text });\n' +
        '    send({ id: message.id, result: { turn: { id: turnId } } });\n' +
        '    setTimeout(function reportUsage() {\n' +
        "      send({ method: 'thread/tokenUsage/updated', params: { turnId, tokenUsage: { last: { inputTokens: 5, outputTokens: 2 }, modelContextWindow: 80 } } });\n" +
        "      send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });\n" +
        '    }, 10);\n' +
        '  }\n' +
        '});\n'
    );

    const previousTarget = process.env.ULTRATHINK_TEST_CODEX_TURN_LOG;
    process.env.ULTRATHINK_TEST_CODEX_TURN_LOG = turnLogPath;
    try {
      const manager = new CodexSessionManager({
        requestTimeoutMs: 5_000,
        codex: {
          command: codexPath,
          cwd: tempDir,
          idleTimeoutMs: 0,
          inputMaxTokens: 10_000,
        },
      });

      // First session teaches the manager the model's 80-token window.
      await manager.processRequest(
        claudeSessionRequest('learned-window-a'),
        {
          model: CODEX_REQUEST_MODEL,
          messages: [{ role: 'user', content: 'hi' }],
          tools: [],
        },
        codexRoute()
      );

      // A brand-new session must render its bootstrap transcript inside the
      // learned effective window with 25% output headroom: 60 tokens.
      await manager.processRequest(
        claudeSessionRequest('learned-window-b'),
        {
          model: CODEX_REQUEST_MODEL,
          messages: [
            { role: 'user', content: 'Ancient history. '.repeat(30) },
            { role: 'assistant', content: [{ type: 'text', text: 'Long prior answer. '.repeat(30) }] },
            { role: 'user', content: 'KEEP' },
          ],
          tools: [],
        },
        codexRoute()
      );

      const turns = JSON.parse(await fs.readFile(turnLogPath, 'utf8'));
      assert.equal(turns.length, 2);
      assert.equal(turns[1].input.length <= 60 * 3, true);
      assert.equal(turns[1].input.includes('KEEP'), true);
      assert.equal(turns[1].input.includes('Ancient history'), false);
      await manager.close();
      ok('later sessions inherit the learned context window and bound their bootstrap render');
    } finally {
      if (previousTarget === undefined) {
        delete process.env.ULTRATHINK_TEST_CODEX_TURN_LOG;
      } else {
        process.env.ULTRATHINK_TEST_CODEX_TURN_LOG = previousTarget;
      }
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await runTest('Codex transcript budget includes omission notices and separators', async function testCodexTranscriptBudgetIncludesNotices() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-codex-budget-'));
  const codexPath = path.join(tempDir, 'codex-budget');
  const turnParamsPath = path.join(tempDir, 'turn-params.json');
  // Small enough to force truncation of the old messages, but large enough
  // (at the conservative 3 chars/token budget) to fit the omission notice
  // plus the newest request.
  const inputMaxTokens = 60;

  try {
    await makeExecutable(
      codexPath,
      '#!/usr/bin/env node\n' +
        "import fs from 'node:fs';\n" +
        "import readline from 'node:readline';\n" +
        'const rl = readline.createInterface({ input: process.stdin });\n' +
        'function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }\n' +
        "rl.on('line', function onLine(line) {\n" +
        '  const message = JSON.parse(line);\n' +
        "  if (message.method === 'initialize') {\n" +
        '    send({ id: message.id, result: { protocolVersion: 2 } });\n' +
        '    return;\n' +
        '  }\n' +
        "  if (message.method === 'thread/start') {\n" +
        "    send({ id: message.id, result: { thread: { id: 'thread-1' } } });\n" +
        '    return;\n' +
        '  }\n' +
        "  if (message.method === 'turn/start') {\n" +
        '    fs.writeFileSync(process.env.ULTRATHINK_TEST_CODEX_TURN_PARAMS, JSON.stringify(message.params), "utf8");\n' +
        "    send({ id: message.id, result: { turn: { id: 'turn-1' } } });\n" +
        "    setTimeout(function completeTurn() { send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } }); }, 10);\n" +
        '  }\n' +
        '});\n'
    );

    const previousTarget = process.env.ULTRATHINK_TEST_CODEX_TURN_PARAMS;
    process.env.ULTRATHINK_TEST_CODEX_TURN_PARAMS = turnParamsPath;
    try {
      const manager = new CodexSessionManager({
        requestTimeoutMs: 5_000,
        codex: {
          command: codexPath,
          cwd: tempDir,
          idleTimeoutMs: 0,
          inputMaxTokens,
        },
      });

      await manager.processRequest(
        gatewayRequest(),
        {
          model: CODEX_REQUEST_MODEL,
          messages: [
            { role: 'user', content: 'Old requirement. '.repeat(40) },
            { role: 'assistant', content: 'Old answer. '.repeat(40) },
            { role: 'user', content: 'Newest request should survive the budget.' },
          ],
          tools: [],
        },
        codexRoute()
      );

      const turnParams = JSON.parse(await fs.readFile(turnParamsPath, 'utf8'));
      const inputText = turnParams.input[0].text;
      assert.equal(inputText.length <= inputMaxTokens * 3, true);
      assert.equal(inputText.includes('survive the budget.'), true);
      await manager.close();
      ok('final Codex transcript bootstrap stays inside the configured input budget');
    } finally {
      if (previousTarget === undefined) {
        delete process.env.ULTRATHINK_TEST_CODEX_TURN_PARAMS;
      } else {
        process.env.ULTRATHINK_TEST_CODEX_TURN_PARAMS = previousTarget;
      }
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await runTest('fresh Codex fork sessions bootstrap from the authoritative request transcript', async function testCodexForkSessionKeepsTranscript() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-codex-fork-input-'));
  const codexPath = path.join(tempDir, 'codex-fork-input');
  const turnParamsPath = path.join(tempDir, 'turn-params.jsonl');

  try {
    await makeExecutable(
      codexPath,
      '#!/usr/bin/env node\n' +
        "import fs from 'node:fs';\n" +
        "import readline from 'node:readline';\n" +
        'const rl = readline.createInterface({ input: process.stdin });\n' +
        'function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }\n' +
        "rl.on('line', function onLine(line) {\n" +
        '  const message = JSON.parse(line);\n' +
        "  if (message.method === 'initialize') {\n" +
        '    send({ id: message.id, result: { protocolVersion: 2 } });\n' +
        '    return;\n' +
        '  }\n' +
        "  if (message.method === 'thread/start') {\n" +
        "    send({ id: message.id, result: { thread: { id: `thread-${message.id}` } } });\n" +
        '    return;\n' +
        '  }\n' +
        "  if (message.method === 'turn/start') {\n" +
        '    fs.appendFileSync(process.env.ULTRATHINK_TEST_CODEX_TURN_PARAMS, `${JSON.stringify(message.params)}\\n`, "utf8");\n' +
        '    const turnId = `turn-${message.id}`;\n' +
        '    send({ id: message.id, result: { turn: { id: turnId } } });\n' +
        "    setTimeout(function completeTurn() { send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } }); }, 10);\n" +
        '  }\n' +
        '});\n'
    );

    const previousTarget = process.env.ULTRATHINK_TEST_CODEX_TURN_PARAMS;
    process.env.ULTRATHINK_TEST_CODEX_TURN_PARAMS = turnParamsPath;
    try {
      const manager = new CodexSessionManager({
        requestTimeoutMs: 5_000,
        codex: {
          command: codexPath,
          cwd: tempDir,
          idleTimeoutMs: 0,
          forkIdleTimeoutMs: 0,
        },
      });
      const req = claudeSessionRequest('session-fork-input');
      const route = codexRoute();
      const firstBody = codexUserRequest('Primary canonical request.');

      await manager.processRequest(req, firstBody, route);
      const canonical = manager.ensureSession(req, firstBody, route);
      canonical.pendingToolCall = { callId: 'call_waiting' };

      await manager.processRequest(
        req,
        {
          model: CODEX_REQUEST_MODEL,
          messages: [
            { role: 'user', content: 'Authoritative workflow context for the fork.' },
            { role: 'assistant', content: 'Prior answer included in the supplied transcript.' },
            { role: 'user', content: 'Current fork side request.' },
          ],
          tools: [],
        },
        route
      );

      const turnParams = (await fs.readFile(turnParamsPath, 'utf8'))
        .trim()
        .split(/\n/u)
        .map(function parseLine(line) {
          return JSON.parse(line);
        });
      const forkInput = turnParams.at(-1).input[0].text;
      assert.equal(forkInput.includes('Current fork side request.'), true);
      assert.equal(forkInput.includes('Authoritative workflow context'), true);
      assert.equal(forkInput.includes('Prior answer included'), true);
      await manager.close();
      ok('fresh fork threads preserve the bounded transcript supplied by Claude');
    } finally {
      if (previousTarget === undefined) {
        delete process.env.ULTRATHINK_TEST_CODEX_TURN_PARAMS;
      } else {
        process.env.ULTRATHINK_TEST_CODEX_TURN_PARAMS = previousTarget;
      }
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await runTest('Codex context-ish 502s that miss recovery matching are traced', async function testCodexContextDriftTracing() {
  const { entries, tracer } = captureTracer();
  const manager = new CodexSessionManager(
    {
      codex: {
        idleTimeoutMs: 0,
        forkIdleTimeoutMs: 0,
        maxSessions: 16,
      },
    },
    {
      tracer,
      createSession(route, req, requestBody, sessionKey) {
        return stubCodexSession(sessionKey, {
          async advance() {
            throw new GatewayError(
              502,
              'api_error',
              'provider input token budget exceeded before generation'
            );
          },
        });
      },
    }
  );

  await assert.rejects(
    manager.processRequest(
      claudeSessionRequest('session-context-drift'),
      codexUserRequest('Trigger unmatched context-ish 502.'),
      codexRoute()
    ),
    /token budget exceeded/u
  );

  assert.equal(
    entries.some(function hasDriftTrace(entry) {
      return entry.event === 'codex.session.context_recovery_unmatched';
    }),
    true
  );
  ok('context-like Codex 502 wording drift is traceable even when recovery does not engage');
});

await runTest(
  'Codex Read diagnostics cannot mask context-like provider failures',
  async function testCodexReadDiagnosticsDoNotThrow() {
    const { entries, tracer } = captureTracer();
    const manager = new CodexSessionManager(
      {
        codex: {
          idleTimeoutMs: 0,
          forkIdleTimeoutMs: 0,
          maxSessions: 16,
        },
      },
      {
        tracer,
        createSession(route, req, requestBody, sessionKey) {
          return stubCodexSession(sessionKey, {
            pendingToolCall: {
              callId: 'call_read_bad_result',
              tool: 'Read',
              readSanitization: null,
            },
            async advance() {
              throw new GatewayError(
                502,
                'api_error',
                'provider input token budget exceeded before generation'
              );
            },
          });
        },
      }
    );

    await assert.rejects(
      manager.processRequest(
        claudeSessionRequest('session-context-read-diagnostics'),
        {
          model: CODEX_REQUEST_MODEL,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'call_read_bad_result',
                  content: [
                    { type: 'unsupported_future_format' },
                  ],
                },
              ],
            },
          ],
          tools: [],
        },
        codexRoute()
      ),
      /token budget exceeded/u
    );

    const driftTrace = entries.find(function findDriftTrace(entry) {
      return entry.event === 'codex.session.context_recovery_unmatched';
    });
    assert.equal(Boolean(driftTrace), true);
    assert.equal(driftTrace.details.read_context.read_tool_result_parse_error, null);
    assert.equal(driftTrace.details.read_context.read_tool_result_is_error, true);
    ok('Read diagnostics recognize unsupported content as a tool error without masking the provider failure');
  }
);

await runTest(
  'successful Codex answers mentioning compaction or context limits are never retried',
  async function testCodexSuccessfulAnswerIsNotAnError() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-codex-successful-answer-'));
    const command = path.join(tempDir, 'codex-successful-answer');
    const callsPath = path.join(tempDir, 'calls');
    const answer = 'Autocompact is thrashing: a tool output is likely too large for the context window. This is a quotation.';
    const manager = new CodexSessionManager({
      requestTimeoutMs: 5_000, codex: { command, cwd: tempDir, idleTimeoutMs: 0 },
    });
    try {
      await makeExecutable(command, `#!/usr/bin/env node
const fs = require('node:fs');
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({id:m.id, result:{}});
  if (m.method === 'thread/start') send({id:m.id, result:{thread:{id:'thread'}}});
  if (m.method === 'turn/start') {
    fs.appendFileSync(${JSON.stringify(callsPath)}, 'turn\\n');
    send({id:m.id,result:{turn:{id:'turn'}}});
    send({method:'item/completed',params:{turnId:'turn',item:{id:'answer',type:'agentMessage',text:${JSON.stringify(answer)}}}});
    send({method:'turn/completed',params:{turn:{id:'turn',status:'completed',error:null}}});
  }
});
`);
      const result = await manager.processRequest(claudeSessionRequest('successful-answer'), {
        model: CODEX_REQUEST_MODEL, messages: [{ role: 'user', content: 'Explain the old log message.' }],
      }, codexRoute());
      assert.equal(result.text, answer);
      assert.equal(await fs.readFile(callsPath, 'utf8'), 'turn\n');
    } finally {
      await manager.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
);

await runTest('Codex first-turn transcript overflow recovers straight to latest-only input', async function testCodexContextWindowRecovery() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-codex-context-retry-'));
  const codexPath = path.join(tempDir, 'codex-context-retry');
  const turnParamsPath = path.join(tempDir, 'turn-params.jsonl');
  const failureMarkerPath = path.join(tempDir, 'failed-once');

  try {
    await makeExecutable(
      codexPath,
      '#!/usr/bin/env node\n' +
        "import fs from 'node:fs';\n" +
        "import readline from 'node:readline';\n" +
        'const rl = readline.createInterface({ input: process.stdin });\n' +
        'function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }\n' +
        "rl.on('line', function onLine(line) {\n" +
        '  const message = JSON.parse(line);\n' +
        "  if (message.method === 'initialize') {\n" +
        '    send({ id: message.id, result: { protocolVersion: 2 } });\n' +
        '    return;\n' +
        '  }\n' +
        "  if (message.method === 'thread/start') {\n" +
        "    send({ id: message.id, result: { thread: { id: `thread-${message.id}` } } });\n" +
        '    return;\n' +
        '  }\n' +
        "  if (message.method === 'turn/start') {\n" +
        '    fs.appendFileSync(process.env.ULTRATHINK_TEST_CODEX_TURN_PARAMS, `${JSON.stringify(message.params)}\\n`, "utf8");\n' +
        '    const turnId = `turn-${message.id}`;\n' +
        '    send({ id: message.id, result: { turn: { id: turnId } } });\n' +
        '    let failCount = 0;\n' +
        '    try { failCount = Number(fs.readFileSync(process.env.ULTRATHINK_TEST_CODEX_FAILURE_MARKER, "utf8")); } catch {}\n' +
        '    if (failCount < 1) {\n' +
        '      fs.writeFileSync(process.env.ULTRATHINK_TEST_CODEX_FAILURE_MARKER, String(failCount + 1), "utf8");\n' +
        '      const error = { message: "prompt is too long: 1017300 tokens > 1000000 maximum" };\n' +
        '      setTimeout(function failTurn() {\n' +
        '        send({ method: "turn/completed", params: { turn: { id: turnId, status: "failed", error } } });\n' +
        '      }, 10);\n' +
        '      return;\n' +
        '    }\n' +
        "    setTimeout(function completeTurn() {\n" +
        "      send({ method: 'item/completed', params: { turnId, item: { id: 'msg-1', type: 'agentMessage', text: 'RECOVERED' } } });\n" +
        "      send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });\n" +
        '    }, 10);\n' +
        '  }\n' +
        '});\n'
    );

    const previous = {
      ULTRATHINK_TEST_CODEX_TURN_PARAMS: process.env.ULTRATHINK_TEST_CODEX_TURN_PARAMS,
      ULTRATHINK_TEST_CODEX_FAILURE_MARKER:
        process.env.ULTRATHINK_TEST_CODEX_FAILURE_MARKER,
    };
    process.env.ULTRATHINK_TEST_CODEX_TURN_PARAMS = turnParamsPath;
    process.env.ULTRATHINK_TEST_CODEX_FAILURE_MARKER = failureMarkerPath;
    try {
      const manager = new CodexSessionManager({
        requestTimeoutMs: 5_000,
        codex: {
          command: codexPath,
          cwd: tempDir,
          idleTimeoutMs: 0,
        },
      });

      const outcome = await manager.processRequest(
        claudeSessionRequest('session-context-retry'),
        {
          model: CODEX_REQUEST_MODEL,
          messages: [
            { role: 'user', content: 'Very old context that should be dropped on recovery.' },
            { role: 'assistant', content: 'Prior answer that exhausted the old thread.' },
            { role: 'user', content: 'Current request after context overflow.' },
          ],
          tools: [],
        },
        codexRoute()
      );

      const turnParams = (await fs.readFile(turnParamsPath, 'utf8'))
        .trim()
        .split(/\n/u)
        .map(function parseLine(line) {
          return JSON.parse(line);
        });
      assert.equal(outcome.text, 'RECOVERED');
      // A first-turn transcript bootstrap that overflowed would fail again
      // byte-identically on a transcript retry, so recovery must skip
      // straight to latest-only input: exactly two turns.
      assert.equal(turnParams.length, 2);
      assert.equal(turnParams[0].input[0].text.includes('Very old context'), true);
      assert.equal(turnParams[1].input[0].text.includes('Current request after context overflow.'), true);
      assert.equal(turnParams[1].input[0].text.includes('Very old context'), false);
      await manager.close();
      ok('first-turn transcript overflow skips the doomed transcript retry and recovers latest-only');
    } finally {
      restoreEnv(previous);
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await runTest('Codex live-session overflow retries with transcript replay before latest-only', async function testCodexLiveSessionOverflowRecovery() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-codex-live-retry-'));
  const codexPath = path.join(tempDir, 'codex-live-retry');
  const turnLogPath = path.join(tempDir, 'turn-log.jsonl');

  try {
    await makeExecutable(
      codexPath,
      '#!/usr/bin/env node\n' +
        "import fs from 'node:fs';\n" +
        "import readline from 'node:readline';\n" +
        'const rl = readline.createInterface({ input: process.stdin });\n' +
        'function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }\n' +
        'let turnCount = 0;\n' +
        "rl.on('line', function onLine(line) {\n" +
        '  const message = JSON.parse(line);\n' +
        "  if (message.method === 'initialize') {\n" +
        '    send({ id: message.id, result: { protocolVersion: 2 } });\n' +
        '    return;\n' +
        '  }\n' +
        "  if (message.method === 'thread/start') {\n" +
        "    send({ id: message.id, result: { thread: { id: `thread-${process.pid}` } } });\n" +
        '    return;\n' +
        '  }\n' +
        "  if (message.method === 'turn/start') {\n" +
        '    turnCount += 1;\n' +
        '    const turnId = `turn-${turnCount}`;\n' +
        '    fs.appendFileSync(process.env.ULTRATHINK_TEST_CODEX_TURN_LOG, `${JSON.stringify({ pid: process.pid, turn: turnCount, input: message.params.input[0].text })}\\n`, "utf8");\n' +
        '    send({ id: message.id, result: { turn: { id: turnId } } });\n' +
        '    if (turnCount === 2) {\n' +
        '      // Overflow only on the live session follow-up turn.\n' +
        "      setTimeout(function failTurn() { send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'failed', error: { message: \"Codex ran out of room in the model's context window.\" } } } }); }, 10);\n" +
        '      return;\n' +
        '    }\n' +
        '    setTimeout(function completeTurn() {\n' +
        "      send({ method: 'thread/tokenUsage/updated', params: { turnId, tokenUsage: { last: { inputTokens: 5, outputTokens: 2 } } } });\n" +
        "      send({ method: 'item/completed', params: { turnId, item: { id: `msg-${turnCount}`, type: 'agentMessage', text: 'OK' } } });\n" +
        "      send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });\n" +
        '    }, 10);\n' +
        '  }\n' +
        '});\n'
    );

    const previousTarget = process.env.ULTRATHINK_TEST_CODEX_TURN_LOG;
    process.env.ULTRATHINK_TEST_CODEX_TURN_LOG = turnLogPath;
    try {
      const manager = new CodexSessionManager({
        requestTimeoutMs: 5_000,
        codex: {
          command: codexPath,
          cwd: tempDir,
          idleTimeoutMs: 0,
        },
      });

      const first = await manager.processRequest(
        claudeSessionRequest('live-retry'),
        {
          model: CODEX_REQUEST_MODEL,
          messages: [{ role: 'user', content: 'Original question about the code.' }],
          tools: [],
        },
        codexRoute()
      );
      assert.equal(first.text, 'OK');

      const second = await manager.processRequest(
        claudeSessionRequest('live-retry'),
        {
          model: CODEX_REQUEST_MODEL,
          messages: [
            { role: 'user', content: 'Original question about the code.' },
            { role: 'assistant', content: [{ type: 'text', text: 'OK' }] },
            { role: 'user', content: 'Follow-up request that overflows.' },
          ],
          tools: [],
        },
        codexRoute()
      );
      assert.equal(second.text, 'OK');

      const turns = (await fs.readFile(turnLogPath, 'utf8'))
        .trim()
        .split(/\n/u)
        .map(function parseLine(line) {
          return JSON.parse(line);
        });
      assert.equal(turns.length, 3);
      // A live session with recorded usage recovers via transcript replay:
      // the retry keeps the prior conversation.
      assert.equal(turns[2].pid === turns[0].pid, false);
      assert.equal(turns[2].input.includes('Original question about the code.'), true);
      assert.equal(turns[2].input.includes('Follow-up request that overflows.'), true);
      await manager.close();
      ok('live-session overflow recovers on a transcript-replay thread with context preserved');
    } finally {
      if (previousTarget === undefined) {
        delete process.env.ULTRATHINK_TEST_CODEX_TURN_LOG;
      } else {
        process.env.ULTRATHINK_TEST_CODEX_TURN_LOG = previousTarget;
      }
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await runTest('claude-workflow-gateway daemon publishes env exports and serves healthz', async function testWorkflowGatewayDaemon() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-workflow-daemon-'));
  const envFile = path.join(tempDir, 'claude-workflow-gateway.env');
  const daemonPath = new URL('../js/cli/claude-workflow-daemon.js', import.meta.url).pathname;
  const port = await freePort();

  const child = spawn(process.execPath, [daemonPath], {
    env: {
      ...process.env,
      ...CLEAN_WORKFLOW_ENV,
      ULTRATHINK_GATEWAY_DAEMON_PORT: String(port),
      CLAUDE_WORKFLOW_GATEWAY_STATE_DIR: tempDir,
      CLAUDE_WORKFLOW_GATEWAY_ENV_FILE: envFile,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', function onStderr(chunk) {
    stderr += chunk.toString();
  });

  try {
    let envText = '';
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        envText = await fs.readFile(envFile, 'utf8');
        break;
      } catch {
        await new Promise(function wait(resolve) {
          setTimeout(resolve, 250);
        });
      }
    }
    assert.notEqual(envText, '', `daemon never wrote env file; stderr: ${stderr}`);
    const baseUrlMatch = envText.match(/^export ANTHROPIC_BASE_URL='([^']+)'$/mu);
    assert.notEqual(baseUrlMatch, null);
    assert.match(envText, /^export CLAUDE_CODE_SUBAGENT_MODEL='[^']+'$/mu);
    assert.match(envText, /^export CLAUDE_CODE_SUBAGENT_MODEL_FORCE='1'$/mu);
    assert.match(envText, /^export ANTHROPIC_DEFAULT_SONNET_MODEL='[^']+'$/mu);
    assert.equal((await fs.stat(envFile)).mode & 0o777, 0o600);

    const health = await fetch(`${baseUrlMatch[1]}/healthz`);
    assert.equal(health.ok, true);
    ok('daemon starts on its managed fixed port, serves healthz, and publishes shell-safe exports');
  } finally {
    child.kill('SIGTERM');
    await new Promise(function waitExit(resolve) {
      child.on('close', resolve);
      setTimeout(resolve, 3_000);
    });
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await runTest('claude-workflow daemon script starts and stops the recorded daemon pid', async function testWorkflowGatewayDaemonScriptLifecycle() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-workflow-daemon-script-'));
  const daemonScript = path.resolve('scripts/claude-workflow-daemon.sh');
  const envFile = path.join(tempDir, 'claude-workflow-gateway.env');
  const pidFile = path.join(tempDir, 'claude-workflow-gateway.pid');
  const port = await freePort();
  let daemonPid = 0;

  const env = {
    ...process.env,
    ...CLEAN_WORKFLOW_ENV,
    CLAUDE_WORKFLOW_GATEWAY_ENV_FILE: envFile,
    CLAUDE_WORKFLOW_GATEWAY_STATE_DIR: tempDir,
    ULTRATHINK_GATEWAY_DAEMON_PORT: String(port),
  };

  try {
    const start = await runProcess('bash', [daemonScript, 'start'], env);
    assert.equal(start.code, 0, start.stderr || start.stdout);
    await waitForFile(envFile);

    daemonPid = Number((await fs.readFile(pidFile, 'utf8')).trim());
    assert.equal(processExists(daemonPid), true);

    const status = await runProcess('bash', [daemonScript, 'status'], env);
    assert.equal(status.code, 0, status.stderr || status.stdout);

    const stop = await runProcess('bash', [daemonScript, 'stop'], env);
    assert.equal(stop.code, 0, stop.stderr || stop.stdout);
    await waitForProcessExit(daemonPid);
    await assert.rejects(fs.access(envFile));
    daemonPid = 0;
    ok('daemon script lifecycle waits for the recorded pid and invalidates stale exports');
  } finally {
    if (daemonPid > 0 && processExists(daemonPid)) {
      try {
        process.kill(daemonPid, 'SIGTERM');
        await waitForProcessExit(daemonPid);
      } catch {
        try {
          process.kill(daemonPid, 'SIGKILL');
        } catch {
          // Best-effort cleanup only.
        }
      }
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await runTest('claude-workflow source hook has no shell-wide routing path', async function testWorkflowGatewayDaemonInstallShell() {
  // Detailed migration matrices live in shell-migration.test.js. This
  // gateway-level assertion keeps the removed route from returning unnoticed.
  const cleanupOnlyHook = await fs.readFile(
    path.resolve('scripts/claude-workflow-gateway.bashrc'),
    'utf8'
  );
  assert.equal(cleanupOnlyHook.includes('claude-workflow-gateway ensure'), false);
  assert.equal(cleanupOnlyHook.includes('CLAUDE_WORKFLOW_ENABLE_LEGACY_SHARED_SHELL_HOOK'), false);
  ok('published source hook is cleanup-only');
  return;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-workflow-shell-hook-'));
  const daemonScript = path.resolve('scripts/claude-workflow-daemon.sh');
  const zshrcPath = path.join(tempDir, '.zshrc');
  const legacyHookEnvironment = {
    ...process.env,
    HOME: tempDir,
    CLAUDE_WORKFLOW_ENABLE_LEGACY_SHARED_SHELL_HOOK: '1',
  };

  try {
    await fs.writeFile(zshrcPath, 'export PRESERVED_SETTING=1\n', {
      encoding: 'utf8',
      mode: 0o644,
    });
    await fs.chmod(zshrcPath, 0o644);
    const zshInstall = await runProcess('bash', [daemonScript, 'install-shell'], {
      ...legacyHookEnvironment,
      SHELL: '/bin/zsh',
    });
    assert.equal(zshInstall.code, 0, zshInstall.stderr || zshInstall.stdout);
    const zshrc = await fs.readFile(zshrcPath, 'utf8');
    assert.match(zshrc, /command -v claude-workflow-gateway/u);
    assert.match(zshrc, /claude-workflow gateway/u);
    assert.equal(zshrc.includes(daemonScript), false);
    assert.equal((await fs.stat(zshrcPath)).mode & 0o777, 0o644);

    const zshReinstall = await runProcess('bash', [daemonScript, 'install-shell'], {
      ...legacyHookEnvironment,
      SHELL: '/bin/zsh',
    });
    assert.equal(zshReinstall.code, 0, zshReinstall.stderr || zshReinstall.stdout);
    const refreshedZshrc = await fs.readFile(zshrcPath, 'utf8');
    assert.equal((refreshedZshrc.match(/# >>> claude-workflow gateway >>>/gu) || []).length, 1);
    assert.equal((await fs.stat(zshrcPath)).mode & 0o777, 0o644);

    const malformedZshrc = `${refreshedZshrc}\n# >>> claude-workflow gateway >>>\nexport IMPORTANT_AFTER=1\n`;
    await fs.writeFile(zshrcPath, malformedZshrc, 'utf8');
    const malformedInstall = await runProcess('bash', [daemonScript, 'install-shell'], {
      ...legacyHookEnvironment,
      SHELL: '/bin/zsh',
    });
    assert.equal(malformedInstall.code, 1);
    assert.match(malformedInstall.stderr, /malformed shell hook markers/u);
    assert.equal(await fs.readFile(zshrcPath, 'utf8'), malformedZshrc);
    await fs.writeFile(zshrcPath, refreshedZshrc, 'utf8');

    const bashInstall = await runProcess('bash', [daemonScript, 'install-shell'], {
      ...legacyHookEnvironment,
      SHELL: '/bin/bash',
    });
    assert.equal(bashInstall.code, 0, bashInstall.stderr || bashInstall.stdout);
    const bashrcPath = path.join(tempDir, '.bashrc');
    const bashrc = await fs.readFile(bashrcPath, 'utf8');
    assert.match(bashrc, /command -v claude-workflow-gateway/u);

    const fakeBin = path.join(tempDir, 'bin');
    const hookState = path.join(tempDir, 'hook-state');
    await fs.mkdir(fakeBin);
    const fakeGatewayManager =
      '#!/usr/bin/env bash\n' +
        'set -u\n' +
        'env_file="$CLAUDE_WORKFLOW_GATEWAY_STATE_DIR/claude-workflow-gateway.env"\n' +
        'case "${1:-}" in\n' +
        '  ensure)\n' +
        '    if [ "${CLAUDE_WORKFLOW_ENABLE_LEGACY_SHARED_SHELL_HOOK:-}" != 1 ]; then exit 1; fi\n' +
        '    if [ "${CLAUDE_WORKFLOW_HOOK_FAIL:-}" = 1 ]; then exit 1; fi\n' +
        '    mkdir -p "$CLAUDE_WORKFLOW_GATEWAY_STATE_DIR"\n' +
        '    printf "%s\\n" "export CLAUDE_WORKFLOW_HOOK_TEST=loaded" >"$env_file"\n' +
        '    chmod 600 "$env_file"\n' +
        '    ;;\n' +
        '  status) exit 0 ;;\n' +
        '  *) exit 1 ;;\n' +
        'esac\n';
    await makeExecutable(
      path.join(fakeBin, 'claude-workflow-gateway'),
      fakeGatewayManager
    );
    await makeExecutable(path.join(fakeBin, 'claude-workflow-daemon.sh'), fakeGatewayManager);
    const plainClaudeEnvPath = path.join(tempDir, 'plain-claude-env.json');
    await makeExecutable(
      path.join(fakeBin, 'claude'),
      '#!/usr/bin/env node\n' +
        "const fs = require('node:fs');\n" +
        "fs.writeFileSync(process.env.ULTRATHINK_TEST_PLAIN_CLAUDE_ENV_PATH, JSON.stringify({\n" +
        "  baseUrl: process.env.ANTHROPIC_BASE_URL || '',\n" +
        "  subagentModel: process.env.CLAUDE_CODE_SUBAGENT_MODEL || '',\n" +
        "}), 'utf8');\n"
    );
    const sourceableHookPath = path.join(fakeBin, 'claude-workflow-gateway.bashrc');
    await fs.copyFile(
      path.resolve('scripts/claude-workflow-gateway.bashrc'),
      sourceableHookPath
    );
    const directSource = await runProcess(
      'bash',
      [
        '--noprofile',
        '--norc',
        '-c',
        '. "$1"; test -z "${CLAUDE_WORKFLOW_HOOK_TEST+x}"',
        '_',
        sourceableHookPath,
      ],
      {
        HOME: tempDir,
        SHELL: '/bin/bash',
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
        CLAUDE_WORKFLOW_GATEWAY_STATE_DIR: hookState,
      }
    );
    assert.equal(directSource.code, 0, directSource.stderr || directSource.stdout);
    await assert.rejects(fs.access(path.join(hookState, 'claude-workflow-gateway.env')));
    const plainLegacyInlineSource = await runProcess(
      'bash',
      [
        '--noprofile',
        '--norc',
        '-c',
        '. "$1"; test -z "${CLAUDE_WORKFLOW_HOOK_TEST+x}"',
        '_',
        bashrcPath,
      ],
      {
        HOME: tempDir,
        SHELL: '/bin/bash',
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
        CLAUDE_WORKFLOW_GATEWAY_STATE_DIR: hookState,
      }
    );
    assert.equal(
      plainLegacyInlineSource.code,
      0,
      plainLegacyInlineSource.stderr || plainLegacyInlineSource.stdout
    );
    const plainClaude = await runProcess(
      'bash',
      ['--noprofile', '--rcfile', bashrcPath, '-ic', 'claude'],
      {
        HOME: tempDir,
        SHELL: '/bin/bash',
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
        CLAUDE_WORKFLOW_GATEWAY_STATE_DIR: hookState,
        ULTRATHINK_TEST_PLAIN_CLAUDE_ENV_PATH: plainClaudeEnvPath,
      }
    );
    assert.equal(plainClaude.code, 0, plainClaude.stderr || plainClaude.stdout);
    assert.deepEqual(JSON.parse(await fs.readFile(plainClaudeEnvPath, 'utf8')), {
      baseUrl: '',
      subagentModel: '',
    });
    const sourceBashrc = await runProcess(
      'bash',
      [
        '--noprofile',
        '--norc',
        '-c',
        '. "$1"; test "$CLAUDE_WORKFLOW_HOOK_TEST" = loaded',
        '_',
        bashrcPath,
      ],
      {
        ...legacyHookEnvironment,
        SHELL: '/bin/bash',
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
        CLAUDE_WORKFLOW_GATEWAY_STATE_DIR: hookState,
      }
    );
    assert.equal(sourceBashrc.code, 0, sourceBashrc.stderr || sourceBashrc.stdout);

    const failedHookState = path.join(tempDir, 'failed-hook-state');
    const managedOverlayPath = path.join(tempDir, 'managed-overlay.env');
    await fs.mkdir(failedHookState);
    await fs.writeFile(
      path.join(failedHookState, 'claude-workflow-gateway.env'),
      'return 1\n',
      'utf8'
    );
    await fs.writeFile(
      managedOverlayPath,
      serializeWorkflowEnvironment({
        ANTHROPIC_API_KEY: 'managed-gateway-token',
        ANTHROPIC_AUTH_TOKEN: 'managed-gateway-token',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:4318',
        ANTHROPIC_MODEL: 'codex',
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: null,
        CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
        CLAUDE_WORKFLOW_GATEWAY_MANAGED_AUTH_TOKEN: 'managed-gateway-token',
        NO_PROXY: 'managed-proxy',
        no_proxy: 'managed-proxy',
      }),
      'utf8'
    );
    const cleanupHookState = path.join(tempDir, 'cleanup-hook-state');
    const cleanupDefaultOverlayCommand = [
      '. "$2"',
      'test "$ANTHROPIC_BASE_URL" = http://127.0.0.1:4318',
      'test "$ANTHROPIC_MODEL" = codex',
      'test "$CLAUDE_CODE_DISABLE_TERMINAL_TITLE" = 1',
      '. "$1"',
      'test -z "${ANTHROPIC_API_KEY+x}"',
      'test -z "${ANTHROPIC_AUTH_TOKEN+x}"',
      'test -z "${ANTHROPIC_BASE_URL+x}"',
      'test -z "${ANTHROPIC_MODEL+x}"',
      'test -z "${CLAUDE_CODE_DISABLE_TERMINAL_TITLE+x}"',
      'test -z "${CLAUDE_WORKFLOW_GATEWAY_MANAGED_ENV_NAMES+x}"',
      'test -z "${CLAUDE_WORKFLOW_GATEWAY_MANAGED_ENV_SET_NAMES+x}"',
      'test -z "${CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_ENV_SET_NAMES+x}"',
    ].join('; ');
    const cleanupDefaultOverlay = await runProcess(
      'bash',
      [
        '--noprofile',
        '--norc',
        '-c',
        cleanupDefaultOverlayCommand,
        '_',
        sourceableHookPath,
        managedOverlayPath,
      ],
      {
        HOME: tempDir,
        SHELL: '/bin/bash',
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
        CLAUDE_WORKFLOW_GATEWAY_STATE_DIR: cleanupHookState,
      }
    );
    assert.equal(
      cleanupDefaultOverlay.code,
      0,
      cleanupDefaultOverlay.stderr || cleanupDefaultOverlay.stdout
    );
    await assert.rejects(
      fs.access(path.join(cleanupHookState, 'claude-workflow-gateway.env'))
    );
    const restoreManagedTitleCommand = [
      '. "$1"',
      'test -z "${ANTHROPIC_AUTH_TOKEN+x}"',
      'test -z "${ANTHROPIC_API_KEY+x}"',
      'test -z "${CLAUDE_WORKFLOW_GATEWAY_MANAGED_AUTH_TOKEN+x}"',
      'test "${CLAUDE_CODE_DISABLE_TERMINAL_TITLE-}" = user-preference',
      'test -z "${CLAUDE_WORKFLOW_GATEWAY_MANAGED_TERMINAL_TITLE+x}"',
      'test -z "${CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_TERMINAL_TITLE+x}"',
      'test -z "${CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_TERMINAL_TITLE_SET+x}"',
    ].join('; ');
    const managedTitleEnvironment = {
      ...process.env,
      HOME: tempDir,
      SHELL: '/bin/bash',
      CLAUDE_WORKFLOW_ENABLE_LEGACY_SHARED_SHELL_HOOK: '1',
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
      CLAUDE_WORKFLOW_GATEWAY_STATE_DIR: failedHookState,
      CLAUDE_WORKFLOW_HOOK_FAIL: '1',
      ANTHROPIC_AUTH_TOKEN: 'managed-gateway-token',
      ANTHROPIC_API_KEY: 'managed-gateway-token',
      CLAUDE_WORKFLOW_GATEWAY_MANAGED_AUTH_TOKEN: 'managed-gateway-token',
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
      CLAUDE_WORKFLOW_GATEWAY_MANAGED_TERMINAL_TITLE: '1',
      CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_TERMINAL_TITLE: 'user-preference',
      CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_TERMINAL_TITLE_SET: '1',
    };
    const missingManagerBin = path.join(tempDir, 'missing-manager-bin');
    const orphanedHookPath = path.join(missingManagerBin, 'claude-workflow-gateway.bashrc');
    await fs.mkdir(missingManagerBin);
    await fs.copyFile(sourceableHookPath, orphanedHookPath);
    const missingManagerEnvironment = {
      ...managedTitleEnvironment,
      PATH: missingManagerBin,
    };
    const missingManagerInstalledBashHook = await runProcess(
      '/bin/bash',
      ['--noprofile', '--norc', '-c', restoreManagedTitleCommand, '_', bashrcPath],
      missingManagerEnvironment
    );
    assert.equal(
      missingManagerInstalledBashHook.code,
      0,
      missingManagerInstalledBashHook.stderr || missingManagerInstalledBashHook.stdout
    );
    const missingManagerSourceableBashHook = await runProcess(
      '/bin/bash',
      ['--noprofile', '--norc', '-c', restoreManagedTitleCommand, '_', orphanedHookPath],
      missingManagerEnvironment
    );
    assert.equal(
      missingManagerSourceableBashHook.code,
      0,
      missingManagerSourceableBashHook.stderr || missingManagerSourceableBashHook.stdout
    );
    const failedInstalledBashHook = await runProcess(
      'bash',
      ['--noprofile', '--norc', '-c', restoreManagedTitleCommand, '_', bashrcPath],
      managedTitleEnvironment
    );
    assert.equal(
      failedInstalledBashHook.code,
      0,
      failedInstalledBashHook.stderr || failedInstalledBashHook.stdout
    );
    const failedSourceableBashHook = await runProcess(
      'bash',
      ['--noprofile', '--norc', '-c', restoreManagedTitleCommand, '_', sourceableHookPath],
      managedTitleEnvironment
    );
    assert.equal(
      failedSourceableBashHook.code,
      0,
      failedSourceableBashHook.stderr || failedSourceableBashHook.stdout
    );

    const restoreCompleteOverlayWithErrexit = [
      'set -eu',
      'export ANTHROPIC_AUTH_TOKEN=user-auth-token',
      'export ANTHROPIC_API_KEY=user-api-key',
      'export ANTHROPIC_BASE_URL=https://api.anthropic.com',
      'export ANTHROPIC_MODEL=user-model',
      'export CLAUDE_CODE_AUTO_COMPACT_WINDOW=user-window',
      'export CLAUDE_CODE_DISABLE_TERMINAL_TITLE=0',
      'export NO_PROXY=user-upper',
      'export no_proxy=user-lower',
      '. "$2"',
      'set -x',
      '. "$1"',
      'case $- in *x*) ;; *) exit 28 ;; esac',
      'set +x',
      'test "$ANTHROPIC_AUTH_TOKEN" = user-auth-token',
      'test "$ANTHROPIC_API_KEY" = user-api-key',
      'test "$ANTHROPIC_BASE_URL" = https://api.anthropic.com',
      'test "$ANTHROPIC_MODEL" = user-model',
      'test "$CLAUDE_CODE_AUTO_COMPACT_WINDOW" = user-window',
      'test "$CLAUDE_CODE_DISABLE_TERMINAL_TITLE" = 0',
      'test "$NO_PROXY" = user-upper',
      'test "$no_proxy" = user-lower',
      'test -z "${CLAUDE_WORKFLOW_GATEWAY_MANAGED_ENV_NAMES+x}"',
      'test -z "${CLAUDE_WORKFLOW_GATEWAY_MANAGED_ENV_SET_NAMES+x}"',
      'test -z "${CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_ENV_SET_NAMES+x}"',
      'test -z "${CLAUDE_WORKFLOW_GATEWAY_MANAGED_AUTH_TOKEN+x}"',
      'printf "SURVIVED\\n"',
    ].join('\n');
    for (const hookPath of [bashrcPath, sourceableHookPath, orphanedHookPath]) {
      const hookEnvironment =
        hookPath === orphanedHookPath ? missingManagerEnvironment : managedTitleEnvironment;
      const guardedBashHook = await runProcess(
        '/bin/bash',
        [
          '--noprofile',
          '--norc',
          '-c',
          restoreCompleteOverlayWithErrexit,
          '_',
          hookPath,
          managedOverlayPath,
        ],
        hookEnvironment
      );
      assert.equal(
        guardedBashHook.code,
        0,
        `${hookPath}: ${guardedBashHook.stderr || guardedBashHook.stdout}`
      );
      assert.equal(guardedBashHook.stdout.trim(), 'SURVIVED');
      for (const secret of ['user-api-key', 'user-auth-token', 'managed-gateway-token']) {
        assert.equal(guardedBashHook.stderr.includes(secret), false, hookPath);
      }
    }

    const preserveChangedTitleCommand = [
      '. "$1"',
      'test -z "${ANTHROPIC_AUTH_TOKEN+x}"',
      'test "${ANTHROPIC_API_KEY-}" = user-api-key',
      'test -z "${CLAUDE_WORKFLOW_GATEWAY_MANAGED_AUTH_TOKEN+x}"',
      'test "${CLAUDE_CODE_DISABLE_TERMINAL_TITLE-}" = user-change',
      'test -z "${CLAUDE_WORKFLOW_GATEWAY_MANAGED_TERMINAL_TITLE+x}"',
      'test -z "${CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_TERMINAL_TITLE+x}"',
      'test -z "${CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_TERMINAL_TITLE_SET+x}"',
    ].join('; ');
    const preserveChangedTitle = await runProcess(
      'bash',
      ['--noprofile', '--norc', '-c', preserveChangedTitleCommand, '_', sourceableHookPath],
      {
        ...managedTitleEnvironment,
        ANTHROPIC_API_KEY: 'user-api-key',
        CLAUDE_CODE_DISABLE_TERMINAL_TITLE: 'user-change',
      }
    );
    assert.equal(
      preserveChangedTitle.code,
      0,
      preserveChangedTitle.stderr || preserveChangedTitle.stdout
    );

    const zshProbe = await runProcess('sh', ['-c', 'command -v zsh'], process.env);
    if (zshProbe.code === 0) {
      const zshPath = zshProbe.stdout.trim();
      const sourceZshrc = await runProcess(
        'zsh',
        [
          '-f',
          '-c',
          'source "$1"; test "$CLAUDE_WORKFLOW_HOOK_TEST" = loaded',
          '_',
          zshrcPath,
        ],
        {
          ...legacyHookEnvironment,
          SHELL: '/bin/zsh',
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
          CLAUDE_WORKFLOW_GATEWAY_STATE_DIR: hookState,
        }
      );
      assert.equal(sourceZshrc.code, 0, sourceZshrc.stderr || sourceZshrc.stdout);

      const failedSourceableZshHook = await runProcess(
        'zsh',
        ['-f', '-c', restoreManagedTitleCommand, '_', sourceableHookPath],
        { ...managedTitleEnvironment, SHELL: '/bin/zsh' }
      );
      assert.equal(
        failedSourceableZshHook.code,
        0,
        failedSourceableZshHook.stderr || failedSourceableZshHook.stdout
      );

      for (const hookPath of [zshrcPath, sourceableHookPath, orphanedHookPath]) {
        const hookEnvironment =
          hookPath === orphanedHookPath
            ? { ...missingManagerEnvironment, SHELL: '/bin/zsh' }
            : { ...managedTitleEnvironment, SHELL: '/bin/zsh' };
        const guardedZshHook = await runProcess(
          zshPath,
          [
            '-f',
            '-c',
            restoreCompleteOverlayWithErrexit,
            '_',
            hookPath,
            managedOverlayPath,
          ],
          hookEnvironment
        );
        assert.equal(
          guardedZshHook.code,
          0,
          `${hookPath}: ${guardedZshHook.stderr || guardedZshHook.stdout}`
        );
        assert.equal(guardedZshHook.stdout.trim(), 'SURVIVED');
        for (const secret of ['user-api-key', 'user-auth-token', 'managed-gateway-token']) {
          assert.equal(guardedZshHook.stderr.includes(secret), false, hookPath);
        }
      }

      const missingManagerInstalledZshHook = await runProcess(
        zshPath,
        ['-f', '-c', restoreManagedTitleCommand, '_', zshrcPath],
        { ...missingManagerEnvironment, SHELL: zshPath }
      );
      assert.equal(
        missingManagerInstalledZshHook.code,
        0,
        missingManagerInstalledZshHook.stderr || missingManagerInstalledZshHook.stdout
      );
    }

    const unsupported = await runProcess('bash', [daemonScript, 'install-shell'], {
      ...legacyHookEnvironment,
      SHELL: '/usr/bin/fish',
    });
    assert.equal(unsupported.code, 1);
    assert.match(unsupported.stderr, /unsupported shell fish/u);

    const defaultInstall = await runProcess('bash', [daemonScript, 'install-shell'], {
      ...process.env,
      HOME: tempDir,
      SHELL: '/bin/zsh',
    });
    assert.equal(defaultInstall.code, 0, defaultInstall.stderr || defaultInstall.stdout);
    assert.match(defaultInstall.stdout, /automatic shell routing is disabled/u);
    const defaultZshrc = await fs.readFile(zshrcPath, 'utf8');
    assert.equal(defaultZshrc.includes('>>> claude-workflow gateway >>>'), false);

    const absentShellHome = path.join(tempDir, 'absent-shell-home');
    await fs.mkdir(absentShellHome);
    const absentDefaultInstall = await runProcess(
      'bash',
      [daemonScript, 'install-shell'],
      {
        ...process.env,
        HOME: absentShellHome,
        SHELL: '/bin/bash',
      }
    );
    assert.equal(
      absentDefaultInstall.code,
      0,
      absentDefaultInstall.stderr || absentDefaultInstall.stdout
    );
    await assert.rejects(fs.access(path.join(absentShellHome, '.bashrc')));

    const uninstall = await runProcess('bash', [daemonScript, 'uninstall-shell'], {
      ...process.env,
      HOME: tempDir,
      SHELL: '/bin/zsh',
    });
    assert.equal(uninstall.code, 0, uninstall.stderr || uninstall.stdout);
    const uninstalledZshrc = await fs.readFile(zshrcPath, 'utf8');
    assert.equal(uninstalledZshrc.includes('>>> claude-workflow gateway >>>'), false);
    ok('plain shells remain direct unless legacy shell routing is explicitly enabled');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await runTest('gateway route-map config can define custom exposed model routes', async function testRouteMapConfig() {
  const previous = {
    ULTRATHINK_GATEWAY_ROUTE_MAP_JSON: process.env.ULTRATHINK_GATEWAY_ROUTE_MAP_JSON,
    ULTRATHINK_GATEWAY_EXPOSED_MODELS: process.env.ULTRATHINK_GATEWAY_EXPOSED_MODELS,
  };

  try {
    delete process.env.ULTRATHINK_GATEWAY_EXPOSED_MODELS;
    process.env.ULTRATHINK_GATEWAY_ROUTE_MAP_JSON = JSON.stringify({
      'claude-codex-review': {
        provider: 'openai',
        model: 'gpt-5.6-sol',
        sandbox: 'workspace-write',
        approvalPolicy: 'never',
        reasoningEffort: 'medium',
        verbosity: 'low',
        displayName: 'Codex Review Route',
      },
    });

    const config = loadGatewayConfig();
    assert.deepEqual(config.exposedModels, ['claude-codex-review']);
    assert.equal(config.routeMap['claude-codex-review'].provider, 'openai');
    assert.equal(config.routeMap['claude-codex-review'].sandbox, 'workspace-write');
    assert.equal(config.routeMap['claude-codex-review'].approvalPolicy, 'never');
    ok('route-map JSON can define custom exposed model ids');
  } finally {
    restoreEnv(previous);
  }
});

await runTest('gateway enforces auth for /v1 and exposes Claude-shaped model discovery', async function testGatewayModels() {
  const gatewayPort = await freePort();
  const runtime = createGatewayServer(gatewayConfig({
    port: gatewayPort,
    sharedSecret: 'test-secret',
    exposedModels: ['claude-opus-5', 'claude-sonnet-4-7'],
    codex: {
      enabled: false,
    },
    openai: {
      apiKey: 'openai-key',
    },
    anthropic: {
      apiKey: 'anthropic-key',
    },
  }));

  await waitForListening(runtime.server);

  try {
    const health = await fetch(`http://127.0.0.1:${gatewayPort}/healthz`);
    assert.equal(health.status, 200);
    const healthPayload = await health.json();
    assert.equal(healthPayload.display_routed_model, false);
    assert.deepEqual(healthPayload.anthropic_passthrough_models, ['claude-opus-5*']);

    const unauthorized = await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`);
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`, {
      headers: { authorization: 'Bearer test-secret' },
    });
    assert.equal(authorized.status, 200);
    const payload = await authorized.json();
    assert.deepEqual(
      payload.data.map(function ids(model) {
        return model.id;
      }),
      ['claude-opus-5', 'claude-sonnet-4-7']
    );
    assert.match(payload.data[1].display_name, /Codex profile gpt-5\.6-terra\/low/u);
    ok('model discovery is Claude-shaped and auth-gated');
  } finally {
    await runtime.close();
  }
});

await runTest('non-loopback health checks hide diagnostics without gateway auth', async function testGatewayHealthPrivacy() {
  const gatewayPort = await freePort();
  const runtime = createGatewayServer(
    gatewayConfig({
      host: '0.0.0.0',
      port: gatewayPort,
      sharedSecret: 'health-secret',
      runtimeRevision: 'private-revision',
      traceDir: '/tmp/private-example-trace',
      anthropicPassthroughModels: [],
    })
  );
  await waitForListening(runtime.server);

  try {
    const unauthenticated = await fetch(`http://127.0.0.1:${gatewayPort}/healthz`);
    assert.deepEqual(await unauthenticated.json(), {
      ok: true,
      service: 'claude-workflow-gateway',
    });

    const authenticated = await fetch(`http://127.0.0.1:${gatewayPort}/healthz`, {
      headers: { authorization: 'Bearer health-secret' },
    });
    const details = await authenticated.json();
    assert.equal(details.runtime_revision, 'private-revision');
    assert.equal(details.trace_dir, '/tmp/private-example-trace');
    ok('public health is minimal while authenticated operators retain diagnostics');
  } finally {
    await runtime.close();
  }
});

await runTest('gateway authenticates before parsing malformed /v1 JSON bodies', async function testGatewayMalformedJsonAuthOrdering() {
  const gatewayPort = await freePort();
  const app = createGatewayApp(
    gatewayConfig({
      sharedSecret: 'test-secret',
      exposedModels: ['claude-sonnet-4-7'],
      openai: {
        apiKey: 'openai-key',
      },
      anthropic: {
        apiKey: 'anthropic-key',
      },
    }),
    null
  );
  const server = app.listen(gatewayPort, '127.0.0.1');
  await waitForListening(server);

  try {
    const unauthorized = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: '{"model":',
    });
    assert.equal(unauthorized.status, 401);

    const malformed = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
      method: 'POST',
      headers: jsonHeaders({
        authorization: 'Bearer test-secret',
      }),
      body: '{"model":',
    });
    assert.equal(malformed.status, 400);
    const payload = await malformed.json();
    assert.equal(payload.type, 'error');
    assert.equal(payload.error.type, 'invalid_request_error');

    const health = await fetch(`http://127.0.0.1:${gatewayPort}/healthz`);
    assert.equal(health.status, 200);
    ok('malformed /v1 JSON is auth-gated first and then returned as an Anthropic-shaped 400');
  } finally {
    await closeServer(server);
  }
});

await runTest('gateway does not forward the shared secret to Anthropic passthrough', async function testGatewaySharedSecretAnthropicPassthrough() {
  const upstreamPort = await freePort();
  let capturedHeaders = null;

  const upstream = http.createServer(async function handleAnthropic(req, res) {
    capturedHeaders = req.headers;
    await readJsonBody(req);
    res.writeHead(200, jsonHeaders());
    res.end(
      JSON.stringify({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    );
  });
  upstream.listen(upstreamPort, '127.0.0.1');
  await waitForListening(upstream);

  const gatewayPort = await freePort();
  const runtime = createGatewayServer(gatewayConfig({
    port: gatewayPort,
    sharedSecret: 'gateway-secret',
    exposedModels: ['claude-opus-5'],
    openai: {
      apiKey: 'openai-key',
    },
    anthropic: {
      apiKey: 'anthropic-key',
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
    },
  }));

  await waitForListening(runtime.server);

  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
      method: 'POST',
      headers: jsonHeaders({
        authorization: 'Bearer gateway-secret',
      }),
      body: JSON.stringify({
        model: 'claude-opus-5',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(capturedHeaders.authorization, undefined);
    assert.equal(capturedHeaders['x-api-key'], 'anthropic-key');
    ok('Anthropic passthrough uses the configured upstream key instead of leaking the gateway secret');
  } finally {
    await runtime.close();
    await closeServer(upstream);
  }
});

await runTest('gateway preserves path prefixes when joining Anthropic upstream URLs', async function testGatewayAnthropicBasePathPrefix() {
  const upstreamPort = await freePort();
  let capturedUrl = null;
  let capturedBody = null;

  const upstream = http.createServer(async function handleAnthropic(req, res) {
    capturedUrl = req.url;
    capturedBody = await readJsonBody(req);
    res.writeHead(200, jsonHeaders());
    res.end(
      JSON.stringify({
        id: 'msg_path_prefix',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    );
  });
  upstream.listen(upstreamPort, '127.0.0.1');
  await waitForListening(upstream);

  const gatewayPort = await freePort();
  const runtime = createGatewayServer(gatewayConfig({
    port: gatewayPort,
    exposedModels: ['claude-opus-5'],
    openai: {
      apiKey: 'openai-key',
    },
    anthropic: {
      apiKey: 'anthropic-key',
      baseUrl: `http://127.0.0.1:${upstreamPort}/proxy`,
    },
  }));

  await waitForListening(runtime.server);

  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        model: 'claude-opus-5',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(capturedUrl, '/proxy/v1/messages');
    assert.equal(capturedBody.model, 'claude-opus-5');
    ok('Anthropic passthrough keeps configured upstream base path prefixes');
  } finally {
    await runtime.close();
    await closeServer(upstream);
  }
});

await runTest('gateway honors HTTP_PROXY and NO_PROXY for upstream JSON requests', async function testGatewayAnthropicPassthroughProxy() {
  const upstreamPort = await freePort();
  const proxyPort = await freePort();
  const gatewayPort = await freePort();
  let capturedUpstreamUrl = null;
  let capturedProxyUrl = null;
  let proxyRequestCount = 0;

  const upstream = http.createServer(async function handleAnthropic(req, res) {
    capturedUpstreamUrl = req.url;
    await readJsonBody(req);
    res.writeHead(200, jsonHeaders());
    res.end(
      JSON.stringify({
        id: 'msg_proxy',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5',
        content: [{ type: 'text', text: 'proxied ok' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    );
  });
  upstream.listen(upstreamPort, '127.0.0.1');
  await waitForListening(upstream);

  const proxy = http.createServer(function handleProxy(req, res) {
    res.writeHead(502, jsonHeaders());
    res.end(JSON.stringify({ error: `unexpected proxy request ${req.method} ${req.url}` }));
  });
  proxy.on('connect', function handleProxyConnect(req, clientSocket, head) {
    proxyRequestCount += 1;
    capturedProxyUrl = req.url;
    const separator = req.url.lastIndexOf(':');
    const hostname = req.url.slice(0, separator);
    const port = Number(req.url.slice(separator + 1));
    const upstreamSocket = net.connect(port, hostname, function connectUpstream() {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) {
        upstreamSocket.write(head);
      }
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    });
    upstreamSocket.on('error', function failProxy() {
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
    clientSocket.on('error', function ignoreClientSocketError() {});
  });
  proxy.listen(proxyPort, '127.0.0.1');
  await waitForListening(proxy);

  function createAnthropicProxyGateway(port) {
    return createGatewayServer(gatewayConfig({
      port,
      exposedModels: ['claude-opus-5'],
      openai: {
        apiKey: 'openai-key',
      },
      anthropic: {
        apiKey: 'anthropic-key',
        baseUrl: `http://127.0.0.1:${upstreamPort}`,
      },
    }));
  }

  function postAnthropicProxyGatewayMessage(port, content) {
    return fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        model: 'claude-opus-5',
        max_tokens: 128,
        messages: [{ role: 'user', content }],
      }),
    });
  }

  try {
    await withTemporaryEnv(
      cleanProxyEnv({
        HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
      }),
      async function assertProxyRouting() {
        const runtime = createAnthropicProxyGateway(gatewayPort);
        await waitForListening(runtime.server);

        try {
          const response = await postAnthropicProxyGatewayMessage(
            gatewayPort,
            'hello through proxy'
          );

          assert.equal(response.status, 200);
          assert.equal(proxyRequestCount, 1);
          assert.equal(capturedProxyUrl, `127.0.0.1:${upstreamPort}`);
          assert.equal(capturedUpstreamUrl, '/v1/messages');
        } finally {
          await runtime.close();
        }
      }
    );

    capturedUpstreamUrl = null;
    await withTemporaryEnv(
      cleanProxyEnv({
        HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
        NO_PROXY: '127.0.0.1',
      }),
      async function assertNoProxyBypass() {
        const noProxyGatewayPort = await freePort();
        const runtime = createAnthropicProxyGateway(noProxyGatewayPort);
        await waitForListening(runtime.server);

        try {
          const response = await postAnthropicProxyGatewayMessage(
            noProxyGatewayPort,
            'hello around proxy'
          );

          assert.equal(response.status, 200);
          assert.equal(proxyRequestCount, 1);
          assert.equal(capturedUpstreamUrl, '/v1/messages');
        } finally {
          await runtime.close();
        }
      }
    );
  } finally {
    await closeServer(proxy);
    await closeServer(upstream);
  }

  ok('Anthropic passthrough upstream requests honor configured HTTP proxy and NO_PROXY settings');
});

await runTest('gateway rejects unsupported proxy URL schemes clearly', async function testGatewayUnsupportedProxyScheme() {
  const gatewayPort = await freePort();

  await withTemporaryEnv(
    cleanProxyEnv({
      ALL_PROXY: 'socks5://127.0.0.1:1080',
    }),
    async function assertUnsupportedProxyScheme() {
      const runtime = createGatewayServer(gatewayConfig({
        port: gatewayPort,
        exposedModels: ['claude-opus-5'],
        openai: {
          apiKey: 'openai-key',
        },
        anthropic: {
          apiKey: 'anthropic-key',
          baseUrl: 'http://127.0.0.1:1',
        },
      }));
      await waitForListening(runtime.server);

      try {
        const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({
            model: 'claude-opus-5',
            max_tokens: 128,
            messages: [{ role: 'user', content: 'hello unsupported proxy' }],
          }),
        });
        const body = await response.json();

        assert.equal(response.status, 502);
        assert.match(
          body.error.message,
          /Unsupported proxy URL scheme "socks5:" for gateway upstream requests/u
        );
      } finally {
        await runtime.close();
      }
    }
  );

  ok('unsupported proxy schemes fail with a clear gateway error');
});

await runTest(
  'gateway emits a stream error event instead of silently truncating a started SSE response',
  async function testGatewayStreamErrorEvent() {
    const gatewayPort = await freePort();
    const codexSessions = {
      async streamRequest(req, requestBody, route, onEvent) {
        onEvent({ type: 'text_delta', text: 'partial' });
        throw new Error('synthetic stream failure');
      },
      async close() {},
    };
    const app = createGatewayApp(
      gatewayConfig({
        port: gatewayPort,
        exposedModels: ['claude-sonnet-4-7'],
        codex: {
          reasoningEffort: 'low',
          verbosity: 'low',
        },
      }),
      codexSessions,
      null
    );
    const server = app.listen(gatewayPort, '127.0.0.1');
    await waitForListening(server);

    try {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          model: 'claude-sonnet-4-7',
          stream: true,
          messages: [{ role: 'user', content: 'Stream through Codex.' }],
        }),
      });
      assert.equal(response.status, 200);
      const bodyText = await response.text();
      const events = parseSsePayloads(bodyText);
      const errorEvent = events.find(function findError(event) {
        return event.name === 'error';
      });
      assert.equal(Boolean(errorEvent), true);
      assert.equal(errorEvent.payload.error.message, 'synthetic stream failure');
      ok('started SSE streams surface a terminal error event instead of truncating silently');
    } finally {
      await closeServer(server);
    }
  }
);

await runTest(
  'claude-workflow requires a gateway-side Anthropic key when a shared secret protects an Anthropic main route',
  async function testWorkflowCliSharedSecretRequiresAnthropicKey() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-cli-shared-secret-'));
    const claudePath = path.join(tempDir, 'claude');
    const codexPath = path.join(tempDir, 'codex-wrapper');

    try {
      await makeClaudeShouldNotRunCommand(claudePath);
      await makeCodexLoginStatusCommand(codexPath);

      const result = await runProcess(
        'node',
        ['js/cli/claude-workflow.js', 'Reply with exactly SHOULD_NOT_RUN.'],
        {
          ...process.env,
          ...CLEAN_WORKFLOW_ENV,
          PATH: `${tempDir}:${process.env.PATH || ''}`,
          ULTRATHINK_GATEWAY_SHARED_SECRET: 'gateway-secret',
          ULTRATHINK_GATEWAY_CODEX_COMMAND: codexPath,
          ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY: '',
          ANTHROPIC_API_KEY: 'test-generic-anthropic-key',
        }
      );

      assert.equal(result.code, 1);
      assert.equal(
        result.stderr.includes('Set ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY'),
        true
      );
      ok(
        'claude-workflow fails fast when a shared-secret gateway would break the default Anthropic main route'
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
);

await runTest(
  'claude-workflow reports missing command and Codex login preflight failures',
  async function testWorkflowCliCommandAndLoginPreflightFailures() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-cli-preflight-'));
    const claudePath = path.join(tempDir, 'claude');
    const loggedInCodexPath = path.join(tempDir, 'codex-logged-in');
    const loggedOutCodexPath = path.join(tempDir, 'codex-logged-out');
    const signedOutCodexPath = path.join(tempDir, 'codex-signed-out');
    const missingCodexPath = path.join(tempDir, 'missing-codex');

    async function runLauncher(envOverrides = {}) {
      return runProcess(
        process.execPath,
        ['js/cli/claude-workflow.js', 'Reply with exactly SHOULD_NOT_RUN.'],
        {
          ...process.env,
          ...CLEAN_WORKFLOW_ENV,
          PATH: tempDir,
          ANTHROPIC_AUTH_TOKEN: '',
          ANTHROPIC_API_KEY: '',
          ...envOverrides,
        }
      );
    }

    try {
      await makeCodexLoginStatusCommand(loggedInCodexPath, 'Authenticated as test-user');
      await makeCodexLoginStatusCommand(loggedOutCodexPath, 'Not logged in');
      await makeCodexLoginStatusCommand(signedOutCodexPath, 'Not signed in');

      const missingClaude = await runLauncher({
        ULTRATHINK_GATEWAY_CODEX_COMMAND: loggedInCodexPath,
      });
      assert.equal(missingClaude.code, 1);
      assert.match(missingClaude.stderr, /claude CLI not found on PATH/u);

      await makeClaudeShouldNotRunCommand(claudePath);

      await makeClaudeExecutable(
        claudePath,
        '#!/bin/bash\n' +
          'echo "CLAUDE SHOULD NOT RUN" >&2\n' +
          'exit 99\n',
        '2.1.249'
      );
      const outdatedClaude = await runLauncher({
        ULTRATHINK_GATEWAY_CODEX_COMMAND: loggedInCodexPath,
      });
      assert.equal(outdatedClaude.code, 1);
      assert.match(outdatedClaude.stderr, /requires Claude Code 2\.1\.325 or newer/u);

      await makeClaudeShouldNotRunCommand(claudePath);

      const missingCodex = await runLauncher({
        ULTRATHINK_GATEWAY_CODEX_COMMAND: missingCodexPath,
      });
      assert.equal(missingCodex.code, 1);
      assert.match(missingCodex.stderr, /missing-codex not found or not executable/u);

      const loggedOutCodex = await runLauncher({
        ULTRATHINK_GATEWAY_CODEX_COMMAND: loggedOutCodexPath,
      });
      assert.equal(loggedOutCodex.code, 1);
      assert.match(loggedOutCodex.stderr, /codex-logged-out is not logged in/u);
      assert.match(loggedOutCodex.stderr, /Run `.*codex-logged-out login` first/u);

      const signedOutCodex = await runLauncher({
        ULTRATHINK_GATEWAY_CODEX_COMMAND: signedOutCodexPath,
      });
      assert.equal(signedOutCodex.code, 1);
      assert.match(signedOutCodex.stderr, /codex-signed-out is not logged in/u);

      ok('claude-workflow fails preflight clearly before launching Claude');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
);

await runTest(
  'claude-workflow injects the gateway shared secret into the child Claude process',
  async function testWorkflowCliInjectsGatewaySecret() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-cli-launch-'));
    const claudePath = path.join(tempDir, 'claude');
    const codexPath = path.join(tempDir, 'codex-wrapper');
    const capturedEnvPath = path.join(tempDir, 'claude-env.json');

    try {
      await makeClaudeExecutable(
        claudePath,
        '#!/usr/bin/env node\n' +
          "import fs from 'node:fs';\n" +
          "const settingsIndex = process.argv.indexOf('--settings');\n" +
          "const settings = settingsIndex >= 0 ? JSON.parse(fs.readFileSync(process.argv[settingsIndex + 1], 'utf8')) : {};\n" +
          'const target = process.env.ULTRATHINK_TEST_CLAUDE_ENV_PATH;\n' +
          'fs.writeFileSync(target, JSON.stringify({\n' +
          "  ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN || '',\n" +
          "  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',\n" +
          "  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL || '',\n" +
          "  CLAUDE_CODE_SUBAGENT_MODEL: process.env.CLAUDE_CODE_SUBAGENT_MODEL || '',\n" +
          "  CLAUDE_CODE_DISABLE_TERMINAL_TITLE: process.env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE || '',\n" +
          "  privateSettingsOwnTerminalTitle: Object.hasOwn(settings.env || {}, 'CLAUDE_CODE_DISABLE_TERMINAL_TITLE'),\n" +
          "  NO_PROXY: process.env.NO_PROXY || '',\n" +
          "  no_proxy: process.env.no_proxy || '',\n" +
          "}), 'utf8');\n" +
          "process.stdout.write('CLI_OK\\n');\n"
      );
      await makeCodexLoginStatusCommand(codexPath);

      const result = await runProcess(
        'node',
        ['js/cli/claude-workflow.js', 'Reply with exactly CLI_OK.'],
        {
          ...process.env,
          ...CLEAN_WORKFLOW_ENV,
          PATH: `${tempDir}:${process.env.PATH || ''}`,
          ULTRATHINK_GATEWAY_SHARED_SECRET: 'gateway-secret',
          ULTRATHINK_GATEWAY_CODEX_COMMAND: codexPath,
          ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY: 'anthropic-key',
          ULTRATHINK_TEST_CLAUDE_ENV_PATH: capturedEnvPath,
          CLAUDE_CODE_DISABLE_TERMINAL_TITLE: 'user-choice',
          ANTHROPIC_AUTH_TOKEN: '',
          ANTHROPIC_API_KEY: '',
          ...cleanProxyEnv({
            HTTP_PROXY: 'http://proxy.local:8080',
            NO_PROXY: 'localhost',
          }),
        }
      );

      assert.equal(result.code, 0);
      const capturedEnv = JSON.parse(await fs.readFile(capturedEnvPath, 'utf8'));
      assert.equal(capturedEnv.ANTHROPIC_AUTH_TOKEN, 'gateway-secret');
      assert.equal(capturedEnv.ANTHROPIC_API_KEY, 'gateway-secret');
      assert.equal(capturedEnv.CLAUDE_CODE_SUBAGENT_MODEL, WORKFLOW_DISPLAY_SUBAGENT_MODEL);
      assert.equal(capturedEnv.CLAUDE_CODE_DISABLE_TERMINAL_TITLE, 'user-choice');
      assert.equal(capturedEnv.privateSettingsOwnTerminalTitle, false);
      assert.equal(capturedEnv.ANTHROPIC_BASE_URL.startsWith('http://127.0.0.1:'), true);
      assert.equal(capturedEnv.NO_PROXY, 'localhost,127.0.0.1');
      assert.equal(capturedEnv.no_proxy, 'localhost,127.0.0.1');
      ok('claude-workflow passes gateway auth and local proxy bypass env to the child Claude process');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
);

await runTest(
  'claude-workflow sends plain Anthropic API model ids for [1m] main aliases',
  async function testWorkflowCliOneMillionAnthropicMainRoute() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-cli-opus-1m-'));
    const claudePath = path.join(tempDir, 'claude');
    const codexPath = path.join(tempDir, 'codex-wrapper');
    const responsePath = path.join(tempDir, 'claude-response.json');
    const anthropicPort = await freePort();
    const seenBodies = [];

    const anthropicServer = http.createServer(async function handleAnthropic(req, res) {
      if (req.method !== 'POST' || req.url !== '/v1/messages') {
        res.writeHead(404);
        res.end();
        return;
      }

      const body = await readJsonBody(req);
      seenBodies.push(body);
      res.writeHead(200, jsonHeaders());
      res.end(
        JSON.stringify({
          id: 'msg_opus_1m',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [{ type: 'text', text: 'OPUS_1M_OK' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 3 },
        })
      );
    });

    await new Promise(function listen(resolve, reject) {
      anthropicServer.once('error', reject);
      anthropicServer.listen(anthropicPort, '127.0.0.1', resolve);
    });

    try {
      await makeClaudeExecutable(
        claudePath,
        '#!/usr/bin/env node\n' +
          "const fs = require('node:fs');\n" +
          'async function main() {\n' +
          '  const response = await fetch(`${process.env.ANTHROPIC_BASE_URL}/v1/messages`, {\n' +
          "    method: 'POST',\n" +
          "    headers: { 'content-type': 'application/json' },\n" +
          '    body: JSON.stringify({\n' +
          "      model: 'claude-opus-5[1m]',\n" +
          "      messages: [{ role: 'user', content: 'Use the 1m alias.' }],\n" +
          '    }),\n' +
          '  });\n' +
          '  const payload = await response.json();\n' +
          "  fs.writeFileSync(process.env.ULTRATHINK_TEST_CLAUDE_RESPONSE_PATH, JSON.stringify(payload), 'utf8');\n" +
          '  if (!response.ok) process.exit(1);\n' +
          '}\n' +
          'main().catch(function onError(error) {\n' +
          '  console.error(error.stack || error.message);\n' +
          '  process.exit(1);\n' +
          '});\n'
      );
      await makeCodexLoginStatusCommand(codexPath);

      const result = await runProcess(
        'node',
        ['js/cli/claude-workflow.js', 'Trigger fake Claude request.'],
        {
          ...process.env,
          ...CLEAN_WORKFLOW_ENV,
          PATH: `${tempDir}:${process.env.PATH || ''}`,
          ULTRATHINK_GATEWAY_CODEX_COMMAND: codexPath,
          ULTRATHINK_GATEWAY_MAIN_MODEL_ID: 'claude-opus-5[1m]',
          ULTRATHINK_GATEWAY_MAIN_PROVIDER: 'anthropic',
          ULTRATHINK_GATEWAY_ANTHROPIC_PASSTHROUGH_MODELS:
            defaultWorkflowAnthropicPassthroughModels('claude-opus-5').join(','),
          ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY: 'anthropic-key',
          ULTRATHINK_GATEWAY_ANTHROPIC_BASE_URL: `http://127.0.0.1:${anthropicPort}`,
          ULTRATHINK_TEST_CLAUDE_RESPONSE_PATH: responsePath,
          ANTHROPIC_AUTH_TOKEN: '',
          ANTHROPIC_API_KEY: '',
        }
      );

      assert.equal(result.code, 0);
      const payload = JSON.parse(await fs.readFile(responsePath, 'utf8'));
      assert.equal(seenBodies.length, 1);
      assert.equal(seenBodies[0].model, 'claude-opus-5');
      assert.equal(payload.model, 'claude-opus-5');
      ok('claude-workflow preserves the [1m] client alias while sending the plain Anthropic API id upstream');
    } finally {
      await closeServer(anthropicServer);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
);

await runTest(
  'claude-workflow preserves concise response model IDs by default',
  async function testWorkflowCliDisplayRoutedModelDefault() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-cli-display-model-'));
    const claudePath = path.join(tempDir, 'claude');
    const codexPath = path.join(tempDir, 'codex-wrapper');
    const workflowHome = path.join(tempDir, 'home');

    async function runLauncherWithDisplayEnv(captureName, envOverrides = {}) {
      const healthPath = path.join(tempDir, captureName);
      const result = await runProcess(
        'node',
        ['js/cli/claude-workflow.js', 'Reply with exactly CLI_OK.'],
        {
          ...process.env,
          ...CLEAN_WORKFLOW_ENV,
          HOME: workflowHome,
          USERPROFILE: workflowHome,
          PATH: `${tempDir}:${process.env.PATH || ''}`,
          ULTRATHINK_GATEWAY_CODEX_COMMAND: codexPath,
          ULTRATHINK_GATEWAY_DISPLAY_ROUTED_MODEL: '',
          CLAUDE_WORKFLOW_DISPLAY_ROUTED_MODEL: '',
          ULTRATHINK_TEST_CLAUDE_HEALTH_PATH: healthPath,
          ANTHROPIC_AUTH_TOKEN: '',
          ANTHROPIC_API_KEY: '',
          ...envOverrides,
        }
      );

      return { healthPath, result };
    }

    async function runWithDisplayEnv(captureName, envOverrides = {}) {
      const { healthPath, result } = await runLauncherWithDisplayEnv(
        captureName,
        envOverrides
      );

      assert.equal(result.code, 0, result.stderr || result.stdout);
      return JSON.parse(await fs.readFile(healthPath, 'utf8'));
    }

    function modelDisplayName(payload, modelId) {
      return payload.models.data.find(function hasModelId(model) {
        return model.id === modelId;
      })?.display_name;
    }

    try {
      await fs.mkdir(workflowHome);
      await fs.writeFile(
        path.join(workflowHome, '.claude.json'),
        '{"hasCompletedOnboarding":true,"penguinModeOrgEnabled":true}\n',
        { mode: 0o600 }
      );
      await makeClaudeExecutable(
        claudePath,
        '#!/usr/bin/env node\n' +
          "const fs = require('node:fs');\n" +
          'async function main() {\n' +
          "  const authToken = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || '';\n" +
          "  const headers = authToken ? { authorization: 'Bearer ' + authToken } : {};\n" +
          '  const response = await fetch(`${process.env.ANTHROPIC_BASE_URL}/healthz`, { headers });\n' +
          '  const health = await response.json();\n' +
          '  const modelsResponse = await fetch(`${process.env.ANTHROPIC_BASE_URL}/v1/models`, { headers });\n' +
          '  const models = await modelsResponse.json();\n' +
          '  const payload = {\n' +
          '    health,\n' +
          '    models,\n' +
          "    subagentModel: process.env.CLAUDE_CODE_SUBAGENT_MODEL || '',\n" +
          "    autoCompactWindow: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || '',\n" +
          '  };\n' +
          "  fs.writeFileSync(process.env.ULTRATHINK_TEST_CLAUDE_HEALTH_PATH, JSON.stringify(payload), 'utf8');\n" +
          "  process.stdout.write('CLI_OK\\n');\n" +
          '}\n' +
          'main().catch(function onError(error) {\n' +
          '  console.error(error.stack || error.message);\n' +
          '  process.exit(1);\n' +
          '});\n'
      );
      await makeCodexLoginStatusCommand(codexPath);

      const defaultHealth = await runWithDisplayEnv('default-health.json');
      const optedInHealth = await runWithDisplayEnv('opted-in-health.json', {
        CLAUDE_WORKFLOW_DISPLAY_ROUTED_MODEL: 'true',
      });
      const workflowOptOutHealth = await runWithDisplayEnv('workflow-opt-out-health.json', {
        CLAUDE_WORKFLOW_DISPLAY_ROUTED_MODEL: 'false',
        ULTRATHINK_GATEWAY_DISPLAY_ROUTED_MODEL: 'true',
      });
      const customRouteHealth = await runWithDisplayEnv('custom-route-health.json', {
        ULTRATHINK_GATEWAY_ROUTE_MAP_JSON: JSON.stringify({
          'claude-sonnet-5': {
            provider: 'codex',
            upstream_model: 'gpt-custom',
            reasoning_effort: 'xhigh',
            verbosity: 'low',
          },
        }),
      });
      const frontierHealth = await runWithDisplayEnv('frontier-health.json', {
        ULTRATHINK_GATEWAY_MAIN_MODEL_ID: 'claude-fable-5',
        ULTRATHINK_GATEWAY_ANTHROPIC_PASSTHROUGH_MODELS:
          defaultWorkflowAnthropicPassthroughModels('claude-fable-5').join(','),
        ULTRATHINK_GATEWAY_CODEX_MODEL: 'gpt-5.6-sol',
        ULTRATHINK_GATEWAY_CODEX_REASONING_EFFORT: 'xhigh',
        ULTRATHINK_GATEWAY_SUBAGENT_UPSTREAM_MODEL: 'gpt-5.6-sol',
        ULTRATHINK_GATEWAY_SUBAGENT_REASONING_EFFORT: 'xhigh',
      });
      const deepSeekMainHealth = await runWithDisplayEnv('deepseek-main-health.json', {
        ULTRATHINK_GATEWAY_MAIN_PROVIDER: 'deepseek',
        ULTRATHINK_GATEWAY_DEEPSEEK_API_KEY: 'deepseek-key',
        ULTRATHINK_GATEWAY_DEEPSEEK_MODEL: 'deepseek-v4-pro',
        ULTRATHINK_GATEWAY_DEEPSEEK_REASONING_EFFORT: 'max',
        ULTRATHINK_GATEWAY_EXPOSED_MODELS: 'claude-opus-5-20260724',
      });
      const glmMainHealth = await runWithDisplayEnv('glm-main-health.json', {
        ULTRATHINK_GATEWAY_MAIN_MODEL_ID: 'glm-5.2',
        ULTRATHINK_GATEWAY_MAIN_PROVIDER: 'glm',
        ULTRATHINK_GATEWAY_GLM_API_KEY: 'glm-key',
        ULTRATHINK_GATEWAY_GLM_MODEL: 'glm-5.2',
        ULTRATHINK_GATEWAY_GLM_REASONING_EFFORT: 'max',
      });
      const collisionHealth = await runWithDisplayEnv('main-subagent-collision-health.json', {
        ULTRATHINK_GATEWAY_MAIN_MODEL_ID: 'claude-sonnet-4-7',
        ULTRATHINK_GATEWAY_SUBAGENT_MODEL_ID: 'claude-sonnet-4-7',
      });
      const invalidRoute = await runLauncherWithDisplayEnv('invalid-route-health.json', {
        ULTRATHINK_GATEWAY_ROUTE_MAP_JSON: JSON.stringify({
          'claude-sonnet-5': {
            provider: 'bogus',
          },
        }),
      });

      assert.equal(defaultHealth.health.display_routed_model, false);
      assert.equal(defaultHealth.subagentModel, WORKFLOW_DISPLAY_SUBAGENT_MODEL);
      assert.equal(defaultHealth.autoCompactWindow, '784800');
      // Native Fable fallback retains its exact Anthropic Opus targets;
      // regular workflow agents stay on the configured Codex Astra route.
      assert.deepEqual(
        defaultHealth.health.anthropic_passthrough_models,
        ['claude-fable-5-2*', 'claude-opus-5', 'claude-opus-5[1m]', 'claude-opus-4-8', 'claude-opus-4-8[1m]']
      );
      assert.equal(
        defaultHealth.health.exposed_models.includes('claude-fable-5-2'),
        true
      );
      assert.equal(defaultHealth.health.codex_target_model, 'gpt-6.2-astra');
      assert.equal(defaultHealth.health.codex_reasoning_effort, 'max');
      assert.match(
        modelDisplayName(defaultHealth, 'claude-sonnet-4-7') || '',
        /Codex gpt-6\.2-astra/u
      );
      assert.equal(optedInHealth.health.display_routed_model, true);
      assert.equal(optedInHealth.subagentModel, 'codex-astra');
      assert.equal(workflowOptOutHealth.health.display_routed_model, false);
      assert.equal(workflowOptOutHealth.subagentModel, 'codex-astra');
      assert.equal(customRouteHealth.subagentModel, 'codex-gpt-custom');
      assert.equal(
        customRouteHealth.health.exposed_models.includes(customRouteHealth.subagentModel),
        true
      );
      assert.deepEqual(
        frontierHealth.health.anthropic_passthrough_models,
        defaultWorkflowAnthropicPassthroughModels('claude-fable-5')
      );
      assert.equal(frontierHealth.health.codex_target_model, 'gpt-5.6-sol');
      assert.equal(frontierHealth.health.codex_reasoning_effort, 'xhigh');
      assert.equal(
        frontierHealth.health.exposed_models.includes('claude-fable-5'),
        true
      );
      assert.equal(
        frontierHealth.subagentModel,
        'codex-sol'
      );
      assert.equal(deepSeekMainHealth.health.deepseek_model, 'deepseek-v4-pro');
      assert.equal(deepSeekMainHealth.health.deepseek_reasoning_effort, 'max');
      assert.equal(deepSeekMainHealth.autoCompactWindow, '784800');
      assert.equal(
        modelDisplayName(deepSeekMainHealth, 'claude-opus-5[1m]'),
        undefined
      );
      assert.equal(
        modelDisplayName(deepSeekMainHealth, 'deepseek-v4-pro'),
        'DeepSeek Main Route'
      );
      assert.equal(
        modelDisplayName(deepSeekMainHealth, 'claude-opus-5'),
        undefined
      );
      assert.equal(glmMainHealth.health.glm_model, 'glm-5.2');
      assert.equal(glmMainHealth.health.glm_reasoning_effort, 'max');
      assert.equal(glmMainHealth.health.glm_thinking, 'enabled');
      assert.equal(glmMainHealth.autoCompactWindow, '784800');
      assert.equal(
        modelDisplayName(glmMainHealth, 'glm-5.2[1m]'),
        undefined
      );
      assert.equal(
        modelDisplayName(glmMainHealth, 'glm-5.2'),
        'GLM Main Route'
      );
      assert.equal(
        modelDisplayName(collisionHealth, 'claude-sonnet-4-7'),
        'Claude Workflow Frontier Route'
      );
      assert.notEqual(invalidRoute.result.code, 0);
      assert.match(
        invalidRoute.result.stderr,
        /entry for claude-sonnet-5 must set provider/u
      );
      ok('claude-workflow keeps concise response IDs by default and supports explicit routed metadata');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
);

await runTest(
  'claude-workflow launches concurrent folders on distinct dynamic ports',
  async function testWorkflowCliConcurrentDynamicPorts() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-cli-dynamic-ports-'));
    const projectA = path.join(tempDir, 'project-a');
    const projectB = path.join(tempDir, 'project-b');
    const claudePath = path.join(tempDir, 'claude');
    const codexPath = path.join(tempDir, 'codex-wrapper');
    const cliPath = path.resolve('js/cli/claude-workflow.js');
    const envAPath = path.join(tempDir, 'claude-env-a.json');
    const envBPath = path.join(tempDir, 'claude-env-b.json');

    try {
      await fs.mkdir(projectA, { recursive: true });
      await fs.mkdir(projectB, { recursive: true });
      await makeClaudeExecutable(
        claudePath,
        '#!/usr/bin/env node\n' +
          "import fs from 'node:fs';\n" +
          'const target = process.env.ULTRATHINK_TEST_CLAUDE_ENV_PATH;\n' +
          'fs.writeFileSync(target, JSON.stringify({\n' +
          "  cwd: process.cwd(),\n" +
          "  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL || '',\n" +
          "  CLAUDE_CODE_SUBAGENT_MODEL: process.env.CLAUDE_CODE_SUBAGENT_MODEL || '',\n" +
          "}), 'utf8');\n" +
          "process.stdout.write('CLI_OK\\n');\n"
      );
      await makeCodexLoginStatusCommand(codexPath);

      const baseEnv = {
        ...process.env,
        ...CLEAN_WORKFLOW_ENV,
        PATH: `${tempDir}:${process.env.PATH || ''}`,
        ULTRATHINK_GATEWAY_CODEX_COMMAND: codexPath,
        ULTRATHINK_GATEWAY_PORT: '',
        ULTRATHINK_GATEWAY_SHARED_SECRET: '',
        ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY: '',
        ANTHROPIC_AUTH_TOKEN: '',
        ANTHROPIC_API_KEY: '',
      };
      const [resultA, resultB] = await Promise.all([
        runProcess(
          'node',
          [cliPath, 'Reply with exactly CLI_OK.'],
          {
            ...baseEnv,
            ULTRATHINK_TEST_CLAUDE_ENV_PATH: envAPath,
          },
          { cwd: projectA }
        ),
        runProcess(
          'node',
          [cliPath, 'Reply with exactly CLI_OK.'],
          {
            ...baseEnv,
            ULTRATHINK_TEST_CLAUDE_ENV_PATH: envBPath,
          },
          { cwd: projectB }
        ),
      ]);

      assert.equal(resultA.code, 0);
      assert.equal(resultB.code, 0);
      const realProjectA = await fs.realpath(projectA);
      const realProjectB = await fs.realpath(projectB);
      const envA = JSON.parse(await fs.readFile(envAPath, 'utf8'));
      const envB = JSON.parse(await fs.readFile(envBPath, 'utf8'));
      assert.equal(envA.cwd, realProjectA);
      assert.equal(envB.cwd, realProjectB);
      assert.equal(envA.CLAUDE_CODE_SUBAGENT_MODEL, WORKFLOW_DISPLAY_SUBAGENT_MODEL);
      assert.equal(envB.CLAUDE_CODE_SUBAGENT_MODEL, WORKFLOW_DISPLAY_SUBAGENT_MODEL);
      assert.equal(envA.ANTHROPIC_BASE_URL.startsWith('http://127.0.0.1:'), true);
      assert.equal(envB.ANTHROPIC_BASE_URL.startsWith('http://127.0.0.1:'), true);
      assert.notEqual(envA.ANTHROPIC_BASE_URL, envB.ANTHROPIC_BASE_URL);
      ok('parallel workflow launchers in different folders get isolated localhost gateway ports');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
);

await runTest(
  'claude-workflow reports fixed gateway port collisions clearly',
  async function testWorkflowCliFixedPortCollision() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-cli-port-collision-'));
    const claudePath = path.join(tempDir, 'claude');
    const codexPath = path.join(tempDir, 'codex-wrapper');
    const gatewayPort = await freePort();
    const blocker = http.createServer(function blockPort(req, res) {
      res.statusCode = 404;
      res.end();
    });

    try {
      await makeClaudeShouldNotRunCommand(claudePath);
      await makeCodexLoginStatusCommand(codexPath);
      blocker.listen(gatewayPort, '127.0.0.1');
      await waitForListening(blocker);

      const result = await runProcess(
        'node',
        ['js/cli/claude-workflow.js', 'Reply with exactly SHOULD_NOT_RUN.'],
        {
          ...process.env,
          ...CLEAN_WORKFLOW_ENV,
          PATH: `${tempDir}:${process.env.PATH || ''}`,
          ULTRATHINK_GATEWAY_CODEX_COMMAND: codexPath,
          ULTRATHINK_GATEWAY_PORT: String(gatewayPort),
          ULTRATHINK_GATEWAY_SHARED_SECRET: '',
          ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY: '',
          ANTHROPIC_AUTH_TOKEN: '',
          ANTHROPIC_API_KEY: '',
        }
      );

      assert.equal(result.code, 1);
      assert.equal(result.stderr.includes(`gateway port ${gatewayPort} is already in use`), true);
      assert.equal(result.stderr.includes('Unset ULTRATHINK_GATEWAY_PORT'), true);
      ok('fixed gateway port collisions point users back to dynamic per-instance ports');
    } finally {
      await closeServer(blocker);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
);

await runTest(
  'claude-workflow rejects unauthenticated non-loopback gateway binds',
  async function testWorkflowCliRejectsUnauthenticatedExternalBind() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-cli-nonloopback-'));
    const claudePath = path.join(tempDir, 'claude');
    const codexPath = path.join(tempDir, 'codex-wrapper');

    try {
      await makeClaudeShouldNotRunCommand(claudePath);
      await makeCodexLoginStatusCommand(codexPath);

      const result = await runProcess(
        'node',
        ['js/cli/claude-workflow.js', 'Reply with exactly SHOULD_NOT_RUN.'],
        {
          ...process.env,
          ...CLEAN_WORKFLOW_ENV,
          PATH: `${tempDir}:${process.env.PATH || ''}`,
          ULTRATHINK_GATEWAY_CODEX_COMMAND: codexPath,
          ULTRATHINK_GATEWAY_HOST: '0.0.0.0',
          ULTRATHINK_GATEWAY_SHARED_SECRET: '',
          ANTHROPIC_AUTH_TOKEN: '',
          ANTHROPIC_API_KEY: '',
        }
      );

      assert.equal(result.code, 1);
      assert.equal(result.stderr.includes('ULTRATHINK_GATEWAY_HOST=0.0.0.0 is not loopback'), true);
      assert.equal(result.stderr.includes('ULTRATHINK_GATEWAY_SHARED_SECRET'), true);

      const ambiguousHostResult = await runProcess(
        'node',
        ['js/cli/claude-workflow.js', 'Reply with exactly SHOULD_NOT_RUN.'],
        {
          ...process.env,
          ...CLEAN_WORKFLOW_ENV,
          PATH: `${tempDir}:${process.env.PATH || ''}`,
          ULTRATHINK_GATEWAY_CODEX_COMMAND: codexPath,
          ULTRATHINK_GATEWAY_HOST: '127',
          ULTRATHINK_GATEWAY_SHARED_SECRET: '',
          ANTHROPIC_AUTH_TOKEN: '',
          ANTHROPIC_API_KEY: '',
        }
      );

      assert.equal(ambiguousHostResult.code, 1);
      assert.equal(
        ambiguousHostResult.stderr.includes('ULTRATHINK_GATEWAY_HOST=127 is not loopback'),
        true
      );
      ok('non-loopback workflow gateway binds require explicit gateway authentication');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
);

await runTest(
  'claude-workflow preserves intentional permission bypass and native passthrough',
  async function testWorkflowCliYoloPermissionFlags() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-cli-yolo-'));
    const claudePath = path.join(tempDir, 'claude');
    const codexPath = path.join(tempDir, 'codex-wrapper');

    async function runWithArgs(args, captureName, envOverrides = {}) {
      const capturedArgsPath = path.join(tempDir, captureName);
      const result = await runProcess(
        'node',
        ['js/cli/claude-workflow.js', ...args],
        {
          ...process.env,
          ...CLEAN_WORKFLOW_ENV,
          PATH: `${tempDir}:${process.env.PATH || ''}`,
          ULTRATHINK_GATEWAY_CODEX_COMMAND: codexPath,
          ULTRATHINK_TEST_CLAUDE_ARGS_PATH: capturedArgsPath,
          ANTHROPIC_AUTH_TOKEN: '',
          ANTHROPIC_API_KEY: '',
          ...envOverrides,
        }
      );

      assert.equal(result.code, 0);
      return JSON.parse(await fs.readFile(capturedArgsPath, 'utf8'));
    }

    function runWithFlag(flag, captureName) {
      return runWithArgs([flag, 'Reply with exactly CLI_OK.'], captureName);
    }

    try {
      await makeClaudeExecutable(
        claudePath,
        '#!/usr/bin/env node\n' +
          "import fs from 'node:fs';\n" +
          'const target = process.env.ULTRATHINK_TEST_CLAUDE_ARGS_PATH;\n' +
          "fs.writeFileSync(target, JSON.stringify(process.argv.slice(2)), 'utf8');\n" +
          "process.stdout.write('CLI_OK\\n');\n"
      );
      await makeCodexLoginStatusCommand(codexPath);

      const interactiveArgs = await runWithArgs([], 'claude-interactive-args.json');
      const defaultPromptArgs = await runWithArgs(
        ['Reply with exactly CLI_OK.'],
        'claude-default-prompt-args.json'
      );
      const yoloArgs = await runWithFlag('--yolo', 'claude-yolo-args.json');
      const dangerousArgs = await runWithFlag(
        '--dangerously-skip-permissions',
        'claude-dangerous-args.json'
      );
      const optedOutArgs = await runWithArgs(
        ['--no-yolo', 'Reply with exactly CLI_OK.'],
        'claude-opted-out-args.json'
      );
      const envOptedOutArgs = await runWithArgs(
        ['Reply with exactly CLI_OK.'],
        'claude-env-opted-out-args.json',
        {
          CLAUDE_WORKFLOW_SKIP_PERMISSIONS: 'false',
        }
      );
      const passthroughHelpArgs = await runWithArgs(
        ['--', 'Explain', '--help'],
        'claude-passthrough-help-args.json'
      );
      const permissionPlanArgs = await runWithArgs(
        ['--', '--permission-mode', 'plan', '--allowedTools', 'Read,Grep'],
        'claude-permission-plan-args.json'
      );
      const oneShotJsonArgs = await runWithArgs(
        ['Reply with exactly CLI_OK.', '--', '--output-format', 'json'],
        'claude-one-shot-json-args.json'
      );
      const variadicPassthroughArgs = await runWithArgs(
        ['--', '--add-dir', 'first', 'second', '--verbose', '--worktree'],
        'claude-variadic-passthrough-args.json'
      );
      const nativeDelimiterArgs = await runWithArgs(
        ['--', '--', '--model'],
        'claude-native-delimiter-args.json'
      );
      const doctorArgs = await runWithArgs(
        ['--', 'doctor'],
        'claude-doctor-args.json'
      );
      const resumeSessionId = 'd3512e5e-c859-4109-aad1-f517c268d1e5';
      const resumeArgs = await runWithArgs(
        ['--resume', resumeSessionId],
        'claude-resume-args.json'
      );
      const resumeWithPromptArgs = await runWithArgs(
        ['-r', resumeSessionId, 'Continue with exactly CLI_OK.'],
        'claude-resume-prompt-args.json'
      );
      const continueForkArgs = await runWithArgs(
        ['--continue', '--fork-session'],
        'claude-continue-fork-args.json'
      );
      const fromPrArgs = await runWithArgs(['--from-pr=42'], 'claude-from-pr-args.json');
      const explicitSessionArgs = await runWithArgs(
        ['--session-id', resumeSessionId],
        'claude-session-id-args.json'
      );

      assert.equal(interactiveArgs.includes('--dangerously-skip-permissions'), true);
      assert.equal(interactiveArgs.includes('-p'), false);
      assert.equal(interactiveArgs.includes('--model'), true);
      for (const args of [defaultPromptArgs, yoloArgs, dangerousArgs, passthroughHelpArgs, doctorArgs]) {
        assert.equal(args.includes('--dangerously-skip-permissions'), true);
        assert.equal(args.includes('--yolo'), false);
      }
      assert.equal(defaultPromptArgs.at(-1), 'Reply with exactly CLI_OK.');
      assert.equal(yoloArgs.at(-1), 'Reply with exactly CLI_OK.');
      assert.equal(dangerousArgs.at(-1), 'Reply with exactly CLI_OK.');
      assert.equal(passthroughHelpArgs.includes('-p'), false);
      assert.deepEqual(passthroughHelpArgs.slice(-2), ['Explain', '--help']);
      assert.equal(permissionPlanArgs.includes('--dangerously-skip-permissions'), false);
      assert.deepEqual(permissionPlanArgs.slice(-4), [
        '--permission-mode',
        'plan',
        '--allowedTools',
        'Read,Grep',
      ]);
      assert.equal(oneShotJsonArgs.includes('-p'), true);
      assert.equal(oneShotJsonArgs.includes('--output-format'), true);
      assert.equal(oneShotJsonArgs.includes('json'), true);
      assert.equal(oneShotJsonArgs.at(-1), 'Reply with exactly CLI_OK.');
      assert.deepEqual(variadicPassthroughArgs.slice(-5), [
        '--add-dir',
        'first',
        'second',
        '--verbose',
        '--worktree',
      ]);
      assert.deepEqual(nativeDelimiterArgs.slice(-2), ['--', '--model']);
      assert.equal(doctorArgs.at(-1), 'doctor');
      assert.equal(optedOutArgs.includes('--dangerously-skip-permissions'), false);
      assert.equal(optedOutArgs.includes('--no-yolo'), false);
      assert.equal(optedOutArgs.at(-1), 'Reply with exactly CLI_OK.');
      assert.equal(envOptedOutArgs.includes('--dangerously-skip-permissions'), false);
      assert.equal(envOptedOutArgs.at(-1), 'Reply with exactly CLI_OK.');
      for (const args of [
        resumeArgs,
        resumeWithPromptArgs,
        continueForkArgs,
        fromPrArgs,
        explicitSessionArgs,
      ]) {
        assert.equal(args.includes('-p'), false);
        assert.equal(args.includes('--model'), true);
        assert.equal(args.includes('--dangerously-skip-permissions'), true);
      }
      assert.equal(resumeArgs.includes('--resume'), true);
      assert.equal(resumeArgs.includes(resumeSessionId), true);
      assert.equal(resumeWithPromptArgs.includes('-r'), true);
      assert.equal(resumeWithPromptArgs.at(-1), 'Continue with exactly CLI_OK.');
      assert.equal(continueForkArgs.includes('--continue'), true);
      assert.equal(continueForkArgs.includes('--fork-session'), true);
      assert.equal(fromPrArgs.includes('--from-pr=42'), true);
      assert.equal(explicitSessionArgs.includes('--session-id'), true);
      assert.equal(explicitSessionArgs.includes(resumeSessionId), true);

      const unknownFlagResult = await runProcess(
        'node',
        ['js/cli/claude-workflow.js', '--effort', 'high'],
        {
          ...process.env,
          ...CLEAN_WORKFLOW_ENV,
          PATH: `${tempDir}:${process.env.PATH || ''}`,
          ULTRATHINK_GATEWAY_CODEX_COMMAND: codexPath,
          ULTRATHINK_TEST_CLAUDE_ARGS_PATH: path.join(tempDir, 'must-not-exist.json'),
          ANTHROPIC_AUTH_TOKEN: '',
          ANTHROPIC_API_KEY: '',
        }
      );
      assert.equal(unknownFlagResult.code, 1);
      assert.match(unknownFlagResult.stderr, /pass Claude CLI options after --/u);
      await assert.rejects(fs.access(path.join(tempDir, 'must-not-exist.json')));

      const modelOverrideResult = await runProcess(
        'node',
        ['js/cli/claude-workflow.js', '--', '--model', 'claude-opus-5'],
        {
          ...process.env,
          ...CLEAN_WORKFLOW_ENV,
          PATH: `${tempDir}:${process.env.PATH || ''}`,
          ULTRATHINK_GATEWAY_CODEX_COMMAND: codexPath,
          ULTRATHINK_TEST_CLAUDE_ARGS_PATH: path.join(tempDir, 'model-must-not-exist.json'),
          ANTHROPIC_AUTH_TOKEN: '',
          ANTHROPIC_API_KEY: '',
        }
      );
      assert.equal(modelOverrideResult.code, 1);
      assert.match(modelOverrideResult.stderr, /managed by claude-workflow/u);
      await assert.rejects(fs.access(path.join(tempDir, 'model-must-not-exist.json')));

      ok(
        'claude-workflow keeps intentional yolo defaults while preserving opt-out, session flags, and explicit Claude passthrough'
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  },
  60_000
);

await runTest(
  'claude-workflow forwards SIGTERM to Claude and exits conventionally',
  async function testWorkflowCliSignalHandling() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-cli-signal-'));
    const claudePath = path.join(tempDir, 'claude');
    const codexPath = path.join(tempDir, 'codex-wrapper');
    const startedPath = path.join(tempDir, 'claude-started');
    const stoppedPath = path.join(tempDir, 'claude-stopped');
    const settingsPathMarker = path.join(tempDir, 'claude-settings-path');

    try {
      await makeClaudeExecutable(
        claudePath,
        '#!/usr/bin/env node\n' +
          "import fs from 'node:fs';\n" +
          "const settingsIndex = process.argv.indexOf('--settings');\n" +
          "if (settingsIndex >= 0) fs.writeFileSync(process.env.ULTRATHINK_TEST_CLAUDE_SETTINGS_PATH, process.argv[settingsIndex + 1], 'utf8');\n" +
          "process.on('SIGTERM', function onSigterm() {\n" +
          '  fs.writeFileSync(process.env.ULTRATHINK_TEST_CLAUDE_STOPPED_PATH, "stopped", "utf8");\n' +
          '  process.exit(0);\n' +
          '});\n' +
          'fs.writeFileSync(process.env.ULTRATHINK_TEST_CLAUDE_STARTED_PATH, "started", "utf8");\n' +
          'setInterval(function keepAlive() {}, 1000);\n'
      );
      await makeCodexLoginStatusCommand(codexPath);

      const child = spawn('node', ['js/cli/claude-workflow.js'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ...CLEAN_WORKFLOW_ENV,
          PATH: `${tempDir}:${process.env.PATH || ''}`,
          ULTRATHINK_GATEWAY_CODEX_COMMAND: codexPath,
          ULTRATHINK_TEST_CLAUDE_STARTED_PATH: startedPath,
          ULTRATHINK_TEST_CLAUDE_STOPPED_PATH: stoppedPath,
          ULTRATHINK_TEST_CLAUDE_SETTINGS_PATH: settingsPathMarker,
          ANTHROPIC_AUTH_TOKEN: '',
          ANTHROPIC_API_KEY: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';
      child.stderr.on('data', function onStderr(chunk) {
        stderr += chunk.toString();
      });
      child.stdout.resume();

      try {
        await waitForFile(startedPath);
        const privateSettingsPath = (await fs.readFile(settingsPathMarker, 'utf8')).trim();
        await fs.access(privateSettingsPath);
        child.kill('SIGTERM');
        const result = await new Promise(function waitForExit(resolve, reject) {
          const timeout = setTimeout(function failSignalTest() {
            reject(new Error(`claude-workflow did not exit after SIGTERM: ${stderr}`));
          }, 5_000);
          child.on('close', function onClose(code, signal) {
            clearTimeout(timeout);
            resolve({ code, signal });
          });
          child.on('error', reject);
        });

        assert.equal(result.code, 143);
        assert.equal(result.signal, null);
        await waitForFile(stoppedPath);
        await assert.rejects(fs.access(privateSettingsPath));
        ok('SIGTERM shuts down the gateway wrapper and the child Claude process cleanly');
      } finally {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
);

await runTest('gateway routes non-frontier requests to the Codex Terra low profile', async function testOpenAiRouting() {
  const openAiPort = await freePort();
  let capturedBody = null;
  let capturedUrl = null;

  const openAiServer = http.createServer(async function handleOpenAi(req, res) {
    capturedUrl = req.url;
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404);
      res.end(JSON.stringify({ error: { message: `Unexpected URL: ${req.url}` } }));
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(404);
      res.end();
      return;
    }

    capturedBody = await readJsonBody(req);
    res.writeHead(200, jsonHeaders());
    res.end(
      JSON.stringify({
        id: 'chatcmpl-openai-text',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'Remapped through the Codex Terra low profile.',
            },
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 6,
        },
      })
    );
  });

  await new Promise(function listen(resolve, reject) {
    openAiServer.once('error', reject);
    openAiServer.listen(openAiPort, '127.0.0.1', resolve);
  });

  const gatewayPort = await freePort();
  const runtime = createGatewayServer(gatewayConfig({
    port: gatewayPort,
    exposedModels: ['claude-sonnet-4-7'],
    codex: {
      enabled: false,
    },
    openai: {
      apiKey: 'openai-key',
      baseUrl: `http://127.0.0.1:${openAiPort}/v1`,
    },
  }));

  await waitForListening(runtime.server);

  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        model: 'claude-sonnet-4-7',
        system: 'You are terse.',
        max_tokens: 256,
        stop_sequences: ['STOP_HERE'],
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Explain the route.' }],
          },
        ],
      }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();

    assert.equal(capturedUrl, '/v1/chat/completions');
    assert.equal(capturedBody.model, 'gpt-5.6-terra');
    assert.equal(capturedBody.reasoning_effort, 'low');
    assert.equal(capturedBody.verbosity, 'low');
    assert.equal(capturedBody.max_completion_tokens, 256);
    assert.deepEqual(capturedBody.stop, ['STOP_HERE']);
    assert.deepEqual(
      capturedBody.messages.map(function roles(message) {
        return message.role;
      }),
      ['developer', 'user']
    );
    assert.equal(payload.model, 'claude-sonnet-4-7');
    assert.equal(payload.stop_reason, 'end_turn');
    assert.deepEqual(payload.content, [
      {
        type: 'text',
        text: 'Remapped through the Codex Terra low profile.',
      },
    ]);
    ok('non-frontier requests remap to the Codex-targeted Terra low profile');
  } finally {
    await runtime.close();
    await closeServer(openAiServer);
  }
});

await runTest(
  'gateway can expose routed OpenAI-compatible response model metadata',
  async function testOpenAiDisplayRoutedModelJson() {
    const openAiPort = await freePort();
    let capturedBody = null;

    const openAiServer = http.createServer(async function handleOpenAi(req, res) {
      capturedBody = await readJsonBody(req);
      res.writeHead(200, jsonHeaders());
      res.end(
        JSON.stringify({
          id: 'chatcmpl-openai-display-model',
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: 'OPENAI_DISPLAY_MODEL_OK',
              },
            },
          ],
          usage: {
            prompt_tokens: 7,
            completion_tokens: 3,
          },
        })
      );
    });

    await new Promise(function listen(resolve, reject) {
      openAiServer.once('error', reject);
      openAiServer.listen(openAiPort, '127.0.0.1', resolve);
    });

    const gatewayPort = await freePort();
    const runtime = createGatewayServer(gatewayConfig({
      displayRoutedModel: true,
      port: gatewayPort,
      exposedModels: ['claude-sonnet-4-7'],
      codex: {
        enabled: false,
      },
      openai: {
        apiKey: 'openai-key',
        baseUrl: `http://127.0.0.1:${openAiPort}/v1`,
      },
    }));

    await waitForListening(runtime.server);

    try {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          model: 'claude-sonnet-4-7',
          messages: [{ role: 'user', content: 'Say OPENAI_DISPLAY_MODEL_OK.' }],
        }),
      });
      assert.equal(response.status, 200);
      const payload = await response.json();

      assert.equal(capturedBody.model, 'gpt-5.6-terra');
      assert.equal(
        payload.model,
        routedResponseModel({
          provider: 'openai',
          upstreamModel: 'gpt-5.6-terra',
          reasoningEffort: 'low',
          requestedModel: 'claude-sonnet-4-7',
        })
      );
      assert.equal(payload.content[0].text, 'OPENAI_DISPLAY_MODEL_OK');
      ok('OpenAI-compatible JSON responses can report routed metadata without changing the upstream request');
    } finally {
      await runtime.close();
      await closeServer(openAiServer);
    }
  }
);

await runTest('gateway translates empty-text assistant tool calls as tool-call-only messages', function testEmptyAssistantToolCallContent() {
  const translated = translateAnthropicMessagesRequestWithOptions(
    {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '' },
            {
              type: 'tool_use',
              id: 'call_empty_text',
              name: 'lookup_weather',
              input: { city: 'San Francisco' },
            },
          ],
        },
      ],
    },
    {
      provider: 'deepseek',
      upstreamModel: 'deepseek-v4-pro',
      reasoningEffort: 'max',
      thinking: { type: 'enabled' },
    }
  );

  const assistantMessage = translated.messages[0];
  assert.equal(assistantMessage.content, null);
  assert.equal(assistantMessage.tool_calls[0].id, 'call_empty_text');
  assert.equal(assistantMessage.tool_calls[0].function.name, 'lookup_weather');
  assert.equal(assistantMessage.tool_calls[0].function.arguments, '{"city":"San Francisco"}');
  ok('empty assistant text blocks do not turn tool-call-only replays into empty-string content');
});

await runTest('gateway translates Anthropic image blocks and disables parallel tool calls for OpenAI', async function testOpenAiImageAndToolParallelTranslation() {
  const openAiPort = await freePort();
  let capturedBody = null;

  const openAiServer = http.createServer(async function handleOpenAi(req, res) {
    capturedBody = await readJsonBody(req);
    res.writeHead(200, jsonHeaders());
    res.end(
      JSON.stringify({
        id: 'chatcmpl-openai-image',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'image ok',
            },
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 2,
        },
      })
    );
  });

  await new Promise(function listen(resolve, reject) {
    openAiServer.once('error', reject);
    openAiServer.listen(openAiPort, '127.0.0.1', resolve);
  });

  const gatewayPort = await freePort();
  const runtime = createGatewayServer(gatewayConfig({
    port: gatewayPort,
    exposedModels: ['claude-sonnet-4-7'],
    codex: {
      enabled: false,
    },
    openai: {
      apiKey: 'openai-key',
      baseUrl: `http://127.0.0.1:${openAiPort}/v1`,
    },
  }));

  await waitForListening(runtime.server);

  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        model: 'claude-sonnet-4-7',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Describe this image.' },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: 'aW1hZ2U=',
                },
              },
            ],
          },
        ],
        tools: [
          {
            name: 'lookup',
            input_schema: {
              type: 'object',
              properties: {},
            },
          },
        ],
        tool_choice: {
          type: 'auto',
          disable_parallel_tool_use: true,
        },
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(capturedBody.messages[0].content, [
      { type: 'text', text: 'Describe this image.' },
      {
        type: 'image_url',
        image_url: {
          url: 'data:image/png;base64,aW1hZ2U=',
        },
      },
    ]);
    assert.equal(capturedBody.tool_choice, 'auto');
    assert.equal(capturedBody.parallel_tool_calls, false);
    ok('Anthropic image blocks and no-parallel tool-choice flags survive OpenAI translation');
  } finally {
    await runtime.close();
    await closeServer(openAiServer);
  }
});

await runTest('gateway accepts Claude-style system role messages inside the message list', async function testSystemRoleRouting() {
  const openAiPort = await freePort();
  let capturedBody = null;

  const openAiServer = http.createServer(async function handleOpenAi(req, res) {
    capturedBody = await readJsonBody(req);
    res.writeHead(200, jsonHeaders());
    res.end(
      JSON.stringify({
        id: 'chatcmpl-openai-system-role',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'SYSTEM_ROLE_OK',
            },
          },
        ],
        usage: {
          prompt_tokens: 18,
          completion_tokens: 4,
        },
      })
    );
  });

  await new Promise(function listen(resolve, reject) {
    openAiServer.once('error', reject);
    openAiServer.listen(openAiPort, '127.0.0.1', resolve);
  });

  const gatewayPort = await freePort();
  const runtime = createGatewayServer(gatewayConfig({
    port: gatewayPort,
    exposedModels: ['claude-sonnet-4-7'],
    codex: {
      enabled: false,
    },
    openai: {
      apiKey: 'openai-key',
      baseUrl: `http://127.0.0.1:${openAiPort}`,
    },
  }));

  await waitForListening(runtime.server);

  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        model: 'claude-sonnet-4-7',
        messages: [
          {
            role: 'system',
            content: 'Treat this as client-supplied system context.',
          },
          {
            role: 'user',
            content: 'Reply with SYSTEM_ROLE_OK.',
          },
        ],
      }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();

    assert.deepEqual(
      capturedBody.messages.map(function summarize(message) {
        return { role: message.role, content: message.content };
      }),
      [
        {
          role: 'developer',
          content: 'Treat this as client-supplied system context.',
        },
        {
          role: 'user',
          content: 'Reply with SYSTEM_ROLE_OK.',
        },
      ]
    );
    assert.equal(payload.content[0].text, 'SYSTEM_ROLE_OK');
    ok('system-role messages from Claude clients are translated into developer messages');
  } finally {
    await runtime.close();
    await closeServer(openAiServer);
  }
});

await runTest('gateway translates Anthropic tool histories and OpenAI tool calls', async function testToolTranslation() {
  const openAiPort = await freePort();
  let capturedBody = null;

  const openAiServer = http.createServer(async function handleOpenAi(req, res) {
    capturedBody = await readJsonBody(req);
    res.writeHead(200, jsonHeaders());
    res.end(
      JSON.stringify({
        id: 'chatcmpl-openai-tool',
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_weather',
                  type: 'function',
                  function: {
                    name: 'lookup_weather',
                    arguments: JSON.stringify({ city: 'SF' }),
                  },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 33,
          completion_tokens: 11,
        },
      })
    );
  });

  await new Promise(function listen(resolve, reject) {
    openAiServer.once('error', reject);
    openAiServer.listen(openAiPort, '127.0.0.1', resolve);
  });

  const gatewayPort = await freePort();
  const runtime = createGatewayServer(gatewayConfig({
    port: gatewayPort,
    exposedModels: ['claude-sonnet-4-7'],
    codex: {
      enabled: false,
    },
    openai: {
      apiKey: 'openai-key',
      baseUrl: `http://127.0.0.1:${openAiPort}`,
    },
  }));

  await waitForListening(runtime.server);

  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        model: 'claude-sonnet-4-7',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Check weather.' }],
          },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_1',
                name: 'lookup_weather',
                input: { city: 'SF' },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_1',
                content: '72F and sunny',
              },
            ],
          },
        ],
        tools: [
          {
            name: 'lookup_weather',
            description: 'Lookup weather.',
            input_schema: {
              type: 'object',
              properties: {
                city: { type: 'string' },
              },
              required: ['city'],
            },
          },
        ],
      }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();

    assert.deepEqual(
      capturedBody.messages.map(function summarize(message) {
        return message.role;
      }),
      ['user', 'assistant', 'tool']
    );
    assert.deepEqual(capturedBody.messages[1].tool_calls, [
      {
        id: 'toolu_1',
        type: 'function',
        function: {
          name: 'lookup_weather',
          arguments: JSON.stringify({ city: 'SF' }),
        },
      },
    ]);
    assert.equal(capturedBody.messages[2].tool_call_id, 'toolu_1');
    assert.equal(payload.stop_reason, 'tool_use');
    assert.deepEqual(payload.content, [
      {
        type: 'tool_use',
        id: 'call_weather',
        name: 'lookup_weather',
        input: { city: 'SF' },
      },
    ]);
    ok('tool histories and tool call outputs translate cleanly');
  } finally {
    await runtime.close();
    await closeServer(openAiServer);
  }
});

await runTest(
  'gateway keeps tool results adjacent to the originating assistant tool call when a mixed user turn also includes text',
  async function testMixedToolResultOrdering() {
    const openAiPort = await freePort();
    let capturedBody = null;

    const openAiServer = http.createServer(async function handleOpenAi(req, res) {
      capturedBody = await readJsonBody(req);
      res.writeHead(200, jsonHeaders());
      res.end(
        JSON.stringify({
          id: 'chatcmpl_mixed_tool_result',
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Processed mixed tool result.',
              },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 4,
          },
        })
      );
    });

    await new Promise(function listen(resolve, reject) {
      openAiServer.once('error', reject);
      openAiServer.listen(openAiPort, '127.0.0.1', resolve);
    });

    const gatewayPort = await freePort();
    const runtime = createGatewayServer(gatewayConfig({
      port: gatewayPort,
      exposedModels: ['claude-sonnet-4-7'],
      codex: {
        enabled: false,
      },
      openai: {
        apiKey: 'openai-key',
        baseUrl: `http://127.0.0.1:${openAiPort}`,
      },
    }));

    await waitForListening(runtime.server);

    try {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          model: 'claude-sonnet-4-7',
          messages: [
            {
              role: 'user',
              content: [{ type: 'text', text: 'Look up the weather.' }],
            },
            {
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  id: 'toolu_mixed',
                  name: 'lookup_weather',
                  input: { city: 'SF' },
                },
              ],
            },
            {
              role: 'user',
              content: [
                { type: 'text', text: 'The tool completed; summarize it after consuming the result.' },
                {
                  type: 'tool_result',
                  tool_use_id: 'toolu_mixed',
                  content: '72F and sunny',
                },
              ],
            },
          ],
          tools: [
            {
              name: 'lookup_weather',
              description: 'Lookup weather.',
              input_schema: {
                type: 'object',
                properties: {
                  city: { type: 'string' },
                },
                required: ['city'],
              },
            },
          ],
        }),
      });

      assert.equal(response.status, 200);
      await response.json();
      assert.deepEqual(
        capturedBody.messages.map(function summarize(message) {
          return message.role;
        }),
        ['user', 'assistant', 'tool', 'user']
      );
      assert.equal(capturedBody.messages[2].tool_call_id, 'toolu_mixed');
      assert.equal(
        capturedBody.messages[3].content,
        'The tool completed; summarize it after consuming the result.'
      );
      ok('mixed text + tool_result user turns preserve tool-result adjacency for OpenAI-compatible upstreams');
    } finally {
      await runtime.close();
      await closeServer(openAiServer);
    }
  }
);

await runTest('gateway applies explicit route-map entries before default routing', async function testExplicitRouteMap() {
  const openAiPort = await freePort();
  const captured = [];

  const openAiServer = http.createServer(async function handleOpenAi(req, res) {
    const body = await readJsonBody(req);
    captured.push(body);
    res.writeHead(200, jsonHeaders());
    res.end(
      JSON.stringify({
        id: 'chatcmpl-route-map',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'Routed through custom profile.',
            },
          },
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 4,
        },
      })
    );
  });

  await new Promise(function listen(resolve, reject) {
    openAiServer.once('error', reject);
    openAiServer.listen(openAiPort, '127.0.0.1', resolve);
  });

  const gatewayPort = await freePort();
  const runtime = createGatewayServer(gatewayConfig({
    port: gatewayPort,
    exposedModels: ['claude-codex-review'],
    routeMap: {
      'claude-codex-review': {
        provider: 'openai',
        model: 'gpt-5.6-sol',
        reasoningEffort: 'medium',
        verbosity: 'high',
        displayName: 'Codex Review Route',
      },
    },
    openai: {
      apiKey: 'openai-key',
      baseUrl: `http://127.0.0.1:${openAiPort}`,
    },
  }));

  await waitForListening(runtime.server);

  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        model: 'claude-codex-review',
        messages: [{ role: 'user', content: 'Use the configured route.' }],
      }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.model, 'claude-codex-review');
    assert.equal(captured[0].model, 'gpt-5.6-sol');
    assert.equal(captured[0].reasoning_effort, 'medium');
    assert.equal(captured[0].verbosity, 'high');

    const modelsResponse = await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`);
    const modelsPayload = await modelsResponse.json();
    assert.equal(modelsPayload.data[0].display_name, 'Codex Review Route');
    ok('explicit route-map entries override the default non-frontier mapping');
  } finally {
    await runtime.close();
    await closeServer(openAiServer);
  }
});

await runTest('gateway routes configured models to DeepSeek-compatible chat completions', async function testDeepSeekGatewayRouting() {
  const deepSeekPort = await freePort();
  let capturedBody = null;
  let capturedUrl = null;
  let capturedAuthorization = '';

  const deepSeekServer = http.createServer(async function handleDeepSeek(req, res) {
    capturedUrl = req.url;
    capturedAuthorization = req.headers.authorization || '';
    capturedBody = await readJsonBody(req);
    res.writeHead(200, jsonHeaders());
    res.end(
      JSON.stringify({
        id: 'chatcmpl-deepseek-route',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'DeepSeek route ok.',
            },
          },
        ],
        usage: {
          prompt_tokens: 21,
          completion_tokens: 5,
        },
      })
    );
  });

  await new Promise(function listen(resolve, reject) {
    deepSeekServer.once('error', reject);
    deepSeekServer.listen(deepSeekPort, '127.0.0.1', resolve);
  });

  const gatewayPort = await freePort();
  const runtime = createGatewayServer(deepSeekFableGatewayConfig(gatewayPort, deepSeekPort, {
    config: {
      displayRoutedModel: true,
      openai: {
        apiKey: 'openai-key-should-not-be-used',
        baseUrl: 'http://127.0.0.1:1',
      },
    },
    route: {
      reasoningEffort: 'high',
      displayName: 'Fable via DeepSeek',
    },
    deepseek: {
      reasoningEffort: 'max',
    },
  }));

  await waitForListening(runtime.server);

  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        model: 'claude-fable-5[1m]',
        system: 'You are terse.',
        max_tokens: 128,
        messages: [
          {
            role: 'user',
            content: 'Use DeepSeek.',
          },
        ],
        tools: [lookupWeatherTool()],
        tool_choice: {
          type: 'tool',
          name: 'lookup_weather',
          disable_parallel_tool_use: true,
        },
      }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();

    assert.equal(capturedUrl, '/chat/completions');
    assert.equal(capturedAuthorization, 'Bearer deepseek-key');
    assert.equal(capturedBody.model, 'deepseek-v4-pro');
    assert.equal(capturedBody.reasoning_effort, 'high');
    assert.equal(capturedBody.max_tokens, 128);
    assert.equal(capturedBody.max_completion_tokens, undefined);
    assert.deepEqual(capturedBody.thinking, { type: 'enabled' });
    assert.equal(capturedBody.tools[0].function.name, 'lookup_weather');
    assert.equal(capturedBody.tool_choice, undefined);
    assert.equal(capturedBody.parallel_tool_calls, undefined);
    assert.deepEqual(
      capturedBody.messages.map(function roles(message) {
        return message.role;
      }),
      ['system', 'user']
    );
    assert.equal(
      payload.model,
      routedResponseModel({
        provider: 'deepseek',
        upstreamModel: 'deepseek-v4-pro',
        reasoningEffort: 'high',
        requestedModel: 'claude-fable-5[1m]',
      })
    );
    assert.equal(payload.usage.input_tokens, 21);
    assert.equal(payload.usage.output_tokens, 5);
    assert.equal(payload.content[0].text, 'DeepSeek route ok.');
    ok('DeepSeek routes use their own credentials, endpoint, request shape, and response metadata');
  } finally {
    await runtime.close();
    await closeServer(deepSeekServer);
  }
});

await runTest('gateway omits DeepSeek reasoning effort when thinking is disabled', async function testDeepSeekDisabledThinkingRouting() {
  const deepSeekPort = await freePort();
  let capturedBody = null;

  const deepSeekServer = http.createServer(async function handleDeepSeek(req, res) {
    capturedBody = await readJsonBody(req);
    res.writeHead(200, jsonHeaders());
    res.end(
      JSON.stringify({
        id: 'chatcmpl-deepseek-disabled-thinking',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'DeepSeek no thinking ok.',
            },
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
        },
      })
    );
  });

  await new Promise(function listen(resolve, reject) {
    deepSeekServer.once('error', reject);
    deepSeekServer.listen(deepSeekPort, '127.0.0.1', resolve);
  });

  const gatewayPort = await freePort();
  const runtime = createGatewayServer(deepSeekFableGatewayConfig(gatewayPort, deepSeekPort, {
    deepseek: {
      thinking: { type: 'disabled' },
    },
  }));

  await waitForListening(runtime.server);

  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        model: 'claude-fable-5[1m]',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Use DeepSeek without thinking.' }],
        tools: [lookupWeatherTool()],
        tool_choice: {
          type: 'auto',
        },
      }),
    });
    assert.equal(response.status, 200);

    assert.equal(capturedBody.reasoning_effort, undefined);
    assert.deepEqual(capturedBody.thinking, { type: 'disabled' });
    assert.equal(capturedBody.tool_choice, 'auto');
    ok('DeepSeek disabled-thinking requests omit reasoning_effort while keeping normal tool_choice translation');
  } finally {
    await runtime.close();
    await closeServer(deepSeekServer);
  }
});

await runTest('gateway routes configured models to GLM-compatible chat completions', async function testGlmGatewayRouting() {
  const glmPort = await freePort();
  let capturedBody = null;
  let capturedUrl = null;
  let capturedAuthorization = '';

  const glmServer = http.createServer(async function handleGlm(req, res) {
    capturedUrl = req.url;
    capturedAuthorization = req.headers.authorization || '';
    capturedBody = await readJsonBody(req);
    res.writeHead(200, jsonHeaders());
    res.end(
      JSON.stringify({
        id: 'chatcmpl-glm-route',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'GLM route ok.',
            },
          },
        ],
        usage: {
          prompt_tokens: 21,
          prompt_tokens_details: {
            cached_tokens: 7,
          },
          completion_tokens: 5,
        },
      })
    );
  });

  await new Promise(function listen(resolve, reject) {
    glmServer.once('error', reject);
    glmServer.listen(glmPort, '127.0.0.1', resolve);
  });

  const gatewayPort = await freePort();
  const runtime = createGatewayServer(glmGatewayConfig(gatewayPort, glmPort, {
    config: {
      displayRoutedModel: true,
      openai: {
        apiKey: 'openai-key-should-not-be-used',
        baseUrl: 'http://127.0.0.1:1',
      },
    },
    route: {
      reasoningEffort: 'max',
      displayName: 'GLM 5.2 Route',
    },
  }));

  await waitForListening(runtime.server);

  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        model: 'glm-5.2[1m]',
        system: 'You are terse.',
        max_tokens: 128,
        messages: [
          {
            role: 'user',
            content: 'Use GLM.',
          },
        ],
        tools: [lookupWeatherTool()],
        tool_choice: {
          type: 'tool',
          name: 'lookup_weather',
          disable_parallel_tool_use: true,
        },
      }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();

    assert.equal(capturedUrl, '/chat/completions');
    assert.equal(capturedAuthorization, 'Bearer glm-key');
    assert.equal(capturedBody.model, 'glm-5.2');
    assert.equal(capturedBody.reasoning_effort, 'max');
    assert.equal(capturedBody.max_tokens, 128);
    assert.equal(capturedBody.max_completion_tokens, undefined);
    assert.deepEqual(capturedBody.thinking, {
      type: 'enabled',
      clear_thinking: false,
    });
    assert.equal(capturedBody.tools[0].function.name, 'lookup_weather');
    assert.deepEqual(capturedBody.tool_choice, {
      type: 'function',
      function: {
        name: 'lookup_weather',
      },
    });
    assert.equal(capturedBody.parallel_tool_calls, false);
    assert.deepEqual(
      capturedBody.messages.map(function roles(message) {
        return message.role;
      }),
      ['system', 'user']
    );
    assert.equal(
      payload.model,
      routedResponseModel({
        provider: 'glm',
        upstreamModel: 'glm-5.2',
        reasoningEffort: 'max',
        requestedModel: 'glm-5.2[1m]',
      })
    );
    assert.equal(payload.usage.input_tokens, 21);
    assert.equal(payload.usage.output_tokens, 5);
    assert.equal(payload.usage.cache_read_input_tokens, 7);
    assert.equal(payload.content[0].text, 'GLM route ok.');
    ok('GLM routes use their own credentials, endpoint, request shape, and response metadata');
  } finally {
    await runtime.close();
    await closeServer(glmServer);
  }
});

await runTest('gateway omits GLM reasoning effort when thinking is disabled', async function testGlmDisabledThinkingRouting() {
  const glmPort = await freePort();
  let capturedBody = null;

  const glmServer = http.createServer(async function handleGlm(req, res) {
    capturedBody = await readJsonBody(req);
    res.writeHead(200, jsonHeaders());
    res.end(
      JSON.stringify({
        id: 'chatcmpl-glm-disabled-thinking',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'GLM no thinking ok.',
            },
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
        },
      })
    );
  });

  await new Promise(function listen(resolve, reject) {
    glmServer.once('error', reject);
    glmServer.listen(glmPort, '127.0.0.1', resolve);
  });

  const gatewayPort = await freePort();
  const runtime = createGatewayServer(glmGatewayConfig(gatewayPort, glmPort, {
    glm: {
      thinking: { type: 'disabled' },
    },
  }));

  await waitForListening(runtime.server);

  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        model: 'glm-5.2[1m]',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Use GLM without thinking.' }],
        tools: [lookupWeatherTool()],
        tool_choice: {
          type: 'auto',
        },
      }),
    });
    assert.equal(response.status, 200);

    assert.equal(capturedBody.reasoning_effort, undefined);
    assert.deepEqual(capturedBody.thinking, { type: 'disabled' });
    assert.equal(capturedBody.tool_choice, 'auto');
    ok('GLM disabled-thinking requests omit reasoning_effort while keeping normal tool_choice translation');
  } finally {
    await runtime.close();
    await closeServer(glmServer);
  }
});

await runTest(
  'gateway translates replayed assistant thinking blocks for DeepSeek routes',
  async function testDeepSeekAssistantThinkingReplay() {
    const deepSeekPort = await freePort();
    let capturedBody = null;

    const deepSeekServer = http.createServer(async function handleDeepSeek(req, res) {
      capturedBody = await readJsonBody(req);
      res.writeHead(200, jsonHeaders());
      res.end(
        JSON.stringify({
          id: 'chatcmpl-deepseek-thinking-replay',
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: 'Continued.',
              },
            },
          ],
          usage: {
            prompt_tokens: 30,
            completion_tokens: 3,
          },
        })
      );
    });

    await new Promise(function listen(resolve, reject) {
      deepSeekServer.once('error', reject);
      deepSeekServer.listen(deepSeekPort, '127.0.0.1', resolve);
    });

    const gatewayPort = await freePort();
    const runtime = createGatewayServer(deepSeekFableGatewayConfig(gatewayPort, deepSeekPort));

    await waitForListening(runtime.server);

    try {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          model: 'claude-fable-5[1m]',
          max_tokens: 256,
          messages: [
            { role: 'user', content: 'Earlier question.' },
            {
              role: 'assistant',
              content: [
                {
                  type: 'thinking',
                  thinking: 'Invisible planning.',
                  signature: 'opaque-thinking-only-signature',
                },
              ],
            },
            { role: 'user', content: 'Keep going.' },
            {
              role: 'assistant',
              content: [
                {
                  type: 'thinking',
                  thinking: 'Need a concise answer.',
                  signature: 'opaque-signature',
                },
                {
                  type: 'redacted_thinking',
                  data: 'opaque-redacted-thinking',
                },
                {
                  type: 'text',
                  text: 'Earlier answer.',
                },
              ],
            },
            { role: 'user', content: 'Continue.' },
          ],
        }),
      });
      assert.equal(response.status, 200);
      const payload = await response.json();

      const assistantMessages = capturedBody.messages.filter(function findAssistant(message) {
        return message.role === 'assistant';
      });
      assert.equal(assistantMessages[0].content, '');
      assert.equal(assistantMessages[0].reasoning_content, 'Invisible planning.');
      assert.equal(assistantMessages[1].content, 'Earlier answer.');
      assert.equal(assistantMessages[1].reasoning_content, 'Need a concise answer.');
      assert.equal(payload.content[0].text, 'Continued.');
      ok('Claude replayed assistant thinking blocks no longer break DeepSeek-routed turns');
    } finally {
      await runtime.close();
      await closeServer(deepSeekServer);
    }
  }
);

await runTest(
  'gateway preserves DeepSeek reasoning content across JSON tool-result turns',
  async function testDeepSeekReasoningToolLoopJson() {
    const deepSeekPort = await freePort();
    const capturedBodies = [];

    const deepSeekServer = http.createServer(async function handleDeepSeek(req, res) {
      capturedBodies.push(await readJsonBody(req));
      res.writeHead(200, jsonHeaders());

      if (capturedBodies.length === 1) {
        res.end(
          JSON.stringify({
            id: 'chatcmpl-deepseek-tool',
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  content: null,
                  reasoning_content: 'Need weather.',
                  tool_calls: [
                    {
                      id: 'call_weather',
                      type: 'function',
                      function: {
                        name: 'lookup_weather',
                        arguments: JSON.stringify({ city: 'SF' }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: {
              prompt_tokens: 20,
              completion_tokens: 6,
            },
          })
        );
        return;
      }

      res.end(
        JSON.stringify({
          id: 'chatcmpl-deepseek-final',
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: 'Weather checked.',
              },
            },
          ],
          usage: {
            prompt_tokens: 35,
            completion_tokens: 4,
          },
        })
      );
    });

    await new Promise(function listen(resolve, reject) {
      deepSeekServer.once('error', reject);
      deepSeekServer.listen(deepSeekPort, '127.0.0.1', resolve);
    });

    const gatewayPort = await freePort();
    const runtime = createGatewayServer(deepSeekFableGatewayConfig(gatewayPort, deepSeekPort));

    await waitForListening(runtime.server);

    const headers = reasoningReplayHeaders('session-deepseek-json-reasoning');

    try {
      const firstResponse = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'claude-fable-5[1m]',
          max_tokens: 256,
          messages: [{ role: 'user', content: 'Check weather.' }],
          tools: [lookupWeatherTool()],
        }),
      });
      assert.equal(firstResponse.status, 200);
      const firstPayload = await firstResponse.json();
      const toolUse = firstPayload.content.find(function findToolUse(block) {
        return block.type === 'tool_use';
      });
      assert.equal(toolUse.id, 'call_weather');

      const secondResponse = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'claude-fable-5[1m]',
          max_tokens: 256,
          messages: [
            { role: 'user', content: 'Check weather.' },
            {
              role: 'assistant',
              content: [toolUse],
            },
            {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'call_weather',
                  content: '72F',
                },
              ],
            },
          ],
        }),
      });
      assert.equal(secondResponse.status, 200);

      assertToolCallReasoningReplay(capturedBodies);
      ok('DeepSeek JSON tool loops replay reasoning_content on the assistant tool-call message');
    } finally {
      await runtime.close();
      await closeServer(deepSeekServer);
    }
  }
);

await runTest(
  'gateway preserves GLM reasoning content across JSON tool-result turns',
  async function testGlmReasoningToolLoopJson() {
    const glmPort = await freePort();
    const capturedBodies = [];

    const glmServer = http.createServer(async function handleGlm(req, res) {
      capturedBodies.push(await readJsonBody(req));
      res.writeHead(200, jsonHeaders());

      if (capturedBodies.length === 1) {
        res.end(
          JSON.stringify({
            id: 'chatcmpl-glm-tool',
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  content: null,
                  reasoning_content: 'Need weather.',
                  tool_calls: [
                    {
                      id: 'call_weather',
                      type: 'function',
                      function: {
                        name: 'lookup_weather',
                        arguments: JSON.stringify({ city: 'SF' }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: {
              prompt_tokens: 20,
              completion_tokens: 6,
            },
          })
        );
        return;
      }

      res.end(
        JSON.stringify({
          id: 'chatcmpl-glm-final',
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: 'Weather checked.',
              },
            },
          ],
          usage: {
            prompt_tokens: 35,
            completion_tokens: 4,
          },
        })
      );
    });

    await new Promise(function listen(resolve, reject) {
      glmServer.once('error', reject);
      glmServer.listen(glmPort, '127.0.0.1', resolve);
    });

    const gatewayPort = await freePort();
    const runtime = createGatewayServer(glmGatewayConfig(gatewayPort, glmPort));

    await waitForListening(runtime.server);

    const headers = reasoningReplayHeaders('session-glm-json-reasoning');

    try {
      const firstResponse = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'glm-5.2[1m]',
          max_tokens: 256,
          messages: [{ role: 'user', content: 'Check weather.' }],
          tools: [lookupWeatherTool()],
        }),
      });
      assert.equal(firstResponse.status, 200);
      const firstPayload = await firstResponse.json();
      const toolUse = firstPayload.content.find(function findToolUse(block) {
        return block.type === 'tool_use';
      });
      assert.equal(toolUse.id, 'call_weather');

      const secondResponse = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'glm-5.2[1m]',
          max_tokens: 256,
          messages: [
            { role: 'user', content: 'Check weather.' },
            {
              role: 'assistant',
              content: [toolUse],
            },
            {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'call_weather',
                  content: '72F',
                },
              ],
            },
          ],
        }),
      });
      assert.equal(secondResponse.status, 200);

      assertToolCallReasoningReplay(capturedBodies);
      ok('GLM JSON tool loops replay reasoning_content on the assistant tool-call message');
    } finally {
      await runtime.close();
      await closeServer(glmServer);
    }
  }
);

await runTest('gateway streams OpenAI chunks as Anthropic SSE events', async function testStreaming() {
  const openAiPort = await freePort();

  const openAiServer = http.createServer(async function handleOpenAi(req, res) {
    await readJsonBody(req);
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
    });
    res.write(
      `data: ${JSON.stringify({
        id: 'chatcmpl-stream',
        choices: [{ delta: { content: 'Hel' }, finish_reason: null }],
      })}\r\n\r\n`
    );
    await sleep(10);
    res.write(
      `data: ${JSON.stringify({
        id: 'chatcmpl-stream',
        choices: [{ delta: { content: 'lo' }, finish_reason: null }],
      })}\r\n\r\n`
    );
    await sleep(10);
    res.write(
      `data: ${JSON.stringify({
        id: 'chatcmpl-stream',
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      })}\r\n\r\n`
    );
    res.write('data: [DONE]\r\n\r\n');
    res.end();
  });

  await new Promise(function listen(resolve, reject) {
    openAiServer.once('error', reject);
    openAiServer.listen(openAiPort, '127.0.0.1', resolve);
  });

  const gatewayPort = await freePort();
  const runtime = createGatewayServer(gatewayConfig({
    displayRoutedModel: true,
    port: gatewayPort,
    exposedModels: ['claude-sonnet-4-7'],
    codex: {
      enabled: false,
    },
    openai: {
      apiKey: 'openai-key',
      baseUrl: `http://127.0.0.1:${openAiPort}`,
    },
  }));

  await waitForListening(runtime.server);

  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        model: 'claude-sonnet-4-7',
        stream: true,
        messages: [{ role: 'user', content: 'Say hello.' }],
      }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    const events = parseSsePayloads(text);
    const messageStart = events.find(function findMessageStart(event) {
      return event.name === 'message_start';
    });
    const terminalDelta = events.find(function findTerminalDelta(event) {
      return (
        event.name === 'message_delta' &&
        event.payload?.delta?.stop_reason === 'end_turn'
      );
    });

    assert.match(text, /event: message_start/u);
    assert.equal(
      messageStart.payload.message.model,
      routedResponseModel({
        provider: 'openai',
        upstreamModel: 'gpt-5.6-terra',
        reasoningEffort: 'low',
        requestedModel: 'claude-sonnet-4-7',
      })
    );
    assert.match(text, /"type":"text_delta","text":"Hel"/u);
    assert.match(text, /"type":"text_delta","text":"lo"/u);
    assert.match(text, /"stop_reason":"end_turn"/u);
    assert.equal(terminalDelta.payload.usage.input_tokens, 10);
    assert.equal(terminalDelta.payload.usage.output_tokens, 5);
    assert.match(text, /event: message_stop/u);
    ok('streaming path emits Anthropic-style SSE events with upstream input and output usage');
  } finally {
    await runtime.close();
    await closeServer(openAiServer);
  }
});

await runTest('gateway maps OpenAI streaming body timeouts to gateway timeout errors', async function testStreamingTimeoutAbortReason() {
  const openAiPort = await freePort();
  let upstreamResponse = null;

  const openAiServer = http.createServer(async function handleOpenAi(req, res) {
    upstreamResponse = res;
    await readJsonBody(req);
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
    });
    res.write(
      `data: ${JSON.stringify({
        id: 'chatcmpl-stream-timeout',
        choices: [{ delta: { content: 'partial' }, finish_reason: null }],
      })}\r\n\r\n`
    );
  });

  await new Promise(function listen(resolve, reject) {
    openAiServer.once('error', reject);
    openAiServer.listen(openAiPort, '127.0.0.1', resolve);
  });

  const gatewayPort = await freePort();
  const runtime = createGatewayServer(gatewayConfig({
    port: gatewayPort,
    requestTimeoutMs: 75,
    exposedModels: ['claude-sonnet-4-7'],
    codex: {
      enabled: false,
    },
    openai: {
      apiKey: 'openai-key',
      baseUrl: `http://127.0.0.1:${openAiPort}`,
    },
  }));

  await waitForListening(runtime.server);

  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        model: 'claude-sonnet-4-7',
        stream: true,
        messages: [{ role: 'user', content: 'Start then timeout.' }],
      }),
    });
    assert.equal(response.status, 200);

    const events = parseSsePayloads(await response.text());
    const errorEvent = events.find(function findErrorEvent(event) {
      return event.name === 'error';
    });

    assert.equal(Boolean(errorEvent), true);
    assert.equal(errorEvent.payload.error.type, 'api_error');
    assert.match(errorEvent.payload.error.message, /gateway request timed out/u);
    ok('streaming upstream aborts preserve the gateway timeout reason');
  } finally {
    upstreamResponse?.destroy();
    openAiServer.closeAllConnections?.();
    await runtime.close();
    await closeServer(openAiServer);
  }
});

await runTest('gateway streams tool calls with Anthropic input_json_delta events', async function testStreamingToolUse() {
  const openAiPort = await freePort();

  const openAiServer = http.createServer(async function handleOpenAi(req, res) {
    await readJsonBody(req);
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
    });
    res.write(
      `data: ${JSON.stringify({
        id: 'chatcmpl-tool-stream',
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_weather',
                  type: 'function',
                  function: {
                    name: 'lookup_weather',
                    arguments: JSON.stringify({ city: 'SF' }),
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })}\r\n\r\n`
    );
    await sleep(10);
    res.write(
      `data: ${JSON.stringify({
        id: 'chatcmpl-tool-stream',
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 15, completion_tokens: 6 },
      })}\r\n\r\n`
    );
    res.write('data: [DONE]\r\n\r\n');
    res.end();
  });

  await new Promise(function listen(resolve, reject) {
    openAiServer.once('error', reject);
    openAiServer.listen(openAiPort, '127.0.0.1', resolve);
  });

  const gatewayPort = await freePort();
  const runtime = createGatewayServer(gatewayConfig({
    port: gatewayPort,
    exposedModels: ['claude-sonnet-4-7'],
    codex: {
      enabled: false,
    },
    openai: {
      apiKey: 'openai-key',
      baseUrl: `http://127.0.0.1:${openAiPort}`,
    },
  }));

  await waitForListening(runtime.server);

  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        model: 'claude-sonnet-4-7',
        stream: true,
        messages: [{ role: 'user', content: 'Use the weather tool.' }],
        tools: [
          {
            name: 'lookup_weather',
            description: 'Fetch weather.',
            input_schema: {
              type: 'object',
              properties: {
                city: { type: 'string' },
              },
              required: ['city'],
            },
          },
        ],
      }),
    });
    assert.equal(response.status, 200);

    const events = parseSsePayloads(await response.text());
    const toolStart = events.find(function findToolStart(event) {
      return (
        event.name === 'content_block_start' &&
        event.payload?.content_block?.type === 'tool_use'
      );
    });
    const toolDelta = events.find(function findToolDelta(event) {
      return event.payload?.delta?.type === 'input_json_delta';
    });
    const messageDelta = events.find(function findMessageDelta(event) {
      return event.name === 'message_delta';
    });

    assert.deepEqual(toolStart.payload.content_block, {
      type: 'tool_use',
      id: 'call_weather',
      name: 'lookup_weather',
      input: {},
    });
    assert.equal(toolDelta.payload.delta.partial_json, JSON.stringify({ city: 'SF' }));
    assert.equal(messageDelta.payload.delta.stop_reason, 'tool_use');
    ok('tool-use streaming path emits Anthropic input_json_delta events');
  } finally {
    await runtime.close();
    await closeServer(openAiServer);
  }
});

await runTest(
  'gateway preserves DeepSeek reasoning content across streamed tool-result turns',
  async function testDeepSeekReasoningToolLoopStream() {
    const deepSeekPort = await freePort();
    const capturedBodies = [];

    const deepSeekServer = http.createServer(async function handleDeepSeek(req, res) {
      capturedBodies.push(await readJsonBody(req));

      if (capturedBodies.length === 1) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
        });
        res.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-deepseek-tool-stream',
            choices: [
              {
                delta: {
                  reasoning_content: 'Need weather.',
                },
                finish_reason: null,
              },
            ],
          })}\r\n\r\n`
        );
        res.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-deepseek-tool-stream',
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_weather',
                      type: 'function',
                      function: {
                        name: 'lookup_weather',
                        arguments: JSON.stringify({ city: 'SF' }),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          })}\r\n\r\n`
        );
        res.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-deepseek-tool-stream',
            choices: [{ delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 15, completion_tokens: 6 },
          })}\r\n\r\n`
        );
        res.write('data: [DONE]\r\n\r\n');
        res.end();
        return;
      }

      res.writeHead(200, jsonHeaders());
      res.end(
        JSON.stringify({
          id: 'chatcmpl-deepseek-stream-final',
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: 'Weather checked.',
              },
            },
          ],
          usage: {
            prompt_tokens: 35,
            completion_tokens: 4,
          },
        })
      );
    });

    await new Promise(function listen(resolve, reject) {
      deepSeekServer.once('error', reject);
      deepSeekServer.listen(deepSeekPort, '127.0.0.1', resolve);
    });

    const gatewayPort = await freePort();
    const runtime = createGatewayServer(deepSeekFableGatewayConfig(gatewayPort, deepSeekPort));

    await waitForListening(runtime.server);

    const headers = reasoningReplayHeaders('session-deepseek-stream-reasoning');

    try {
      const firstResponse = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'claude-fable-5[1m]',
          stream: true,
          max_tokens: 256,
          messages: [{ role: 'user', content: 'Check weather.' }],
          tools: [lookupWeatherTool()],
        }),
      });
      assert.equal(firstResponse.status, 200);

      const events = parseSsePayloads(await firstResponse.text());
      const toolStart = events.find(function findToolStart(event) {
        return (
          event.name === 'content_block_start' &&
          event.payload?.content_block?.type === 'tool_use'
        );
      });
      assert.equal(toolStart.payload.content_block.id, 'call_weather');

      const secondResponse = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'claude-fable-5[1m]',
          max_tokens: 256,
          messages: [
            { role: 'user', content: 'Check weather.' },
            {
              role: 'assistant',
              content: [
                {
                  ...toolStart.payload.content_block,
                  input: { city: 'SF' },
                },
              ],
            },
            {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'call_weather',
                  content: '72F',
                },
              ],
            },
          ],
        }),
      });
      assert.equal(secondResponse.status, 200);

      assertToolCallReasoningReplay(capturedBodies);
      ok('DeepSeek streaming tool loops replay reasoning_content on the assistant tool-call message');
    } finally {
      await runtime.close();
      await closeServer(deepSeekServer);
    }
  }
);

await runTest(
  'gateway streams live Codex usage updates before the terminal boundary',
  async function testCodexUsageStreaming() {
    const gatewayPort = await freePort();
    let seenRoute = null;
    let seenRequestBody = null;

    const fakeCodexSessions = {
      async processRequest() {
        throw new Error('processRequest should not be called for this streaming test');
      },
      async streamRequest(req, requestBody, route, onEvent) {
        seenRequestBody = requestBody;
        seenRoute = route;
        onEvent({
          type: 'usage',
          usage: {
            input_tokens: 42,
            output_tokens: 1,
            cache_read_input_tokens: 5,
          },
        });
        await sleep(5);
        onEvent({
          type: 'text_delta',
          text: 'STREAM_USAGE_OK',
        });
        await sleep(5);
        onEvent({
          type: 'usage',
          usage: {
            input_tokens: 42,
            output_tokens: 7,
            cache_read_input_tokens: 5,
          },
        });
        await sleep(5);
        onEvent({
          type: 'boundary',
          outcome: {
            type: 'final',
            usage: {
              input_tokens: 42,
              output_tokens: 7,
              cache_read_input_tokens: 5,
              reasoning_output_tokens: 3,
              total_tokens: 50,
            },
          },
        });

        return {
          type: 'final',
          usage: {
            input_tokens: 42,
            output_tokens: 7,
            cache_read_input_tokens: 5,
            reasoning_output_tokens: 3,
            total_tokens: 50,
          },
        };
      },
      async close() {
        return undefined;
      },
    };

    const app = createGatewayApp(
      gatewayConfig({
        displayRoutedModel: true,
        port: gatewayPort,
        exposedModels: ['claude-sonnet-4-7'],
        routeMap: {
          'claude-sonnet-4-7': {
            provider: 'codex',
            model: 'gpt-5.6-sol',
            reasoningEffort: 'low',
            verbosity: 'low',
          },
        },
        codex: {
          reasoningEffort: 'low',
          verbosity: 'low',
        },
      }),
      fakeCodexSessions
    );
    const server = app.listen(gatewayPort, '127.0.0.1');
    await waitForListening(server);

    try {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          model: 'claude-sonnet-4-7',
          stream: true,
          messages: [{ role: 'user', content: 'Say STREAM_USAGE_OK.' }],
        }),
      });
      assert.equal(response.status, 200);

      const events = parseSsePayloads(await response.text());
      const messageStart = events.find(function findMessageStart(event) {
        return event.name === 'message_start';
      });
      const nonTerminalDeltas = events.filter(function findUsageDelta(event) {
        return (
          event.name === 'message_delta' &&
          event.payload?.delta?.stop_reason === null
        );
      });
      const terminalDelta = events.find(function findTerminalDelta(event) {
        return (
          event.name === 'message_delta' &&
          event.payload?.delta?.stop_reason === 'end_turn'
        );
      });
      const textDelta = events.find(function findTextDelta(event) {
        return event.payload?.delta?.type === 'text_delta';
      });

      assert.equal(seenRequestBody.model, 'claude-sonnet-4-7');
      assert.equal(seenRoute.provider, 'codex');
      assert.equal(messageStart.payload.message.model, routedResponseModel(seenRoute));
      assert.equal(messageStart.payload.message.usage.input_tokens, 42);
      assert.equal(messageStart.payload.message.usage.output_tokens, 1);
      assert.equal(messageStart.payload.message.usage.cache_read_input_tokens, 5);
      assert.equal(nonTerminalDeltas.length >= 1, true);
      assert.equal(nonTerminalDeltas.at(-1).payload.usage.input_tokens, 42);
      assert.equal(nonTerminalDeltas.at(-1).payload.usage.output_tokens, 7);
      assert.equal(nonTerminalDeltas.at(-1).payload.usage.cache_read_input_tokens, 5);
      assert.equal(textDelta.payload.delta.text, 'STREAM_USAGE_OK');
      assert.equal(terminalDelta.payload.usage.input_tokens, 42);
      assert.equal(terminalDelta.payload.usage.output_tokens, 7);
      assert.equal(terminalDelta.payload.usage.cache_read_input_tokens, 5);
      assert.equal('reasoning_output_tokens' in terminalDelta.payload.usage, false);
      assert.equal('total_tokens' in terminalDelta.payload.usage, false);
      ok('Codex streaming path emits live Anthropic-compatible usage before the terminal boundary');
    } finally {
      await closeServer(server);
    }
  }
);

await runTest('gateway proxies Opus 5 requests and token counts to Anthropic', async function testAnthropicPassthrough() {
  const anthropicPort = await freePort();
  const seen = {
    messages: [],
    countTokens: [],
  };

  const anthropicServer = http.createServer(async function handleAnthropic(req, res) {
    if (req.method === 'POST' && req.url === '/v1/messages') {
      const body = await readJsonBody(req);
      seen.messages.push(body);
      res.writeHead(200, jsonHeaders());
      res.end(
        JSON.stringify({
          id: 'msg_passthrough',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [{ type: 'text', text: 'Direct from Anthropic.' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 4 },
        })
      );
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/messages/count_tokens') {
      seen.countTokens.push(await readJsonBody(req));
      res.writeHead(200, jsonHeaders());
      res.end(JSON.stringify({ input_tokens: 77 }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise(function listen(resolve, reject) {
    anthropicServer.once('error', reject);
    anthropicServer.listen(anthropicPort, '127.0.0.1', resolve);
  });

  const gatewayPort = await freePort();
  const runtime = createGatewayServer(gatewayConfig({
    port: gatewayPort,
    exposedModels: ['claude-opus-5', 'claude-opus-5[1m]'],
    openai: {
      apiKey: 'openai-key',
    },
    anthropic: {
      apiKey: 'anthropic-key',
      baseUrl: `http://127.0.0.1:${anthropicPort}`,
    },
  }));

  await waitForListening(runtime.server);

  try {
    for (const modelId of ['claude-opus-5', 'claude-opus-5[1m]']) {
      const messageResponse = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: 'Stay on Anthropic.' }],
        }),
      });
      assert.equal(messageResponse.status, 200);
      const messagePayload = await messageResponse.json();
      assert.equal(messagePayload.model, 'claude-opus-5');

      const tokenResponse = await fetch(
        `http://127.0.0.1:${gatewayPort}/v1/messages/count_tokens`,
        {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({
            model: modelId,
            messages: [{ role: 'user', content: 'Count me.' }],
          }),
        }
      );
      assert.equal(tokenResponse.status, 200);
      const tokenPayload = await tokenResponse.json();
      assert.deepEqual(tokenPayload, { input_tokens: 77 });
    }

    assert.deepEqual(
      seen.messages.map(function messageModel(body) {
        return body.model;
      }),
      ['claude-opus-5', 'claude-opus-5']
    );
    assert.deepEqual(
      seen.countTokens.map(function tokenCountModel(body) {
        return body.model;
      }),
      ['claude-opus-5', 'claude-opus-5']
    );
    ok('Opus 5 passthrough works for base and [1m] aliases in messages and count_tokens');
  } finally {
    await runtime.close();
    await closeServer(anthropicServer);
  }
});
