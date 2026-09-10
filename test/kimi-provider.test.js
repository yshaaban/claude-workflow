import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { serializeWorkflowEnvironment } from '../js/cli/claude-workflow-daemon.js';
import { loadGatewayConfig } from '../js/gateway/config.js';
import {
  buildWorkflowClientEnv,
  buildWorkflowGatewayConfig,
} from '../js/gateway/workflow-config.js';
import { resolveModelRoute } from '../js/gateway/model-routing.js';
import { createGatewayServer } from '../js/gateway/server.js';
import {
  MANAGED_GATEWAY_AUTH_ENV_NAME,
  environmentWithoutGatewayCredentials,
} from '../js/utils/child-env.js';

const KIMI_API_KEY = 'test-kimi-upstream-key';
const GATEWAY_SECRET = 'test-gateway-client-secret';
const KIMI_MODEL_ALIAS = 'k3';
const KIMI_UPSTREAM_MODEL = 'k3';
const KIMI_CONTEXT_TOKENS = 1_048_576;
const CLAUDE_COMMON_CONTEXT_TOKENS = 828_400;
const CLAUDE_COMMON_AUTO_COMPACT_TOKENS = 784_800;
const DAEMON_PATH = fileURLToPath(
  new URL('../js/cli/claude-workflow-daemon.js', import.meta.url)
);

const ISOLATED_ENV_NAMES = Object.freeze([
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_CUSTOM_MODEL_OPTION',
  'ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION',
  'ANTHROPIC_CUSTOM_MODEL_OPTION_NAME',
  'ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_MODEL',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_CODE_DISABLE_TERMINAL_TITLE',
  'CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK',
  'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'CLAUDE_WORKFLOW_DISPLAY_ROUTED_MODEL',
  MANAGED_GATEWAY_AUTH_ENV_NAME,
  'CLAUDE_WORKFLOW_GATEWAY_MANAGED_TERMINAL_TITLE',
  'CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_TERMINAL_TITLE',
  'CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_TERMINAL_TITLE_SET',
  'CLAUDE_WORKFLOW_MAIN_PROVIDER',
  'KIMI_API_KEY',
  'ULTRATHINK_GATEWAY_ANTHROPIC_PASSTHROUGH_MODELS',
  'ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY',
  'ULTRATHINK_GATEWAY_DISPLAY_ROUTED_MODEL',
  'ULTRATHINK_GATEWAY_EXPOSED_MODELS',
  'ULTRATHINK_GATEWAY_KIMI_API_KEY',
  'ULTRATHINK_GATEWAY_KIMI_BASE_URL',
  'ULTRATHINK_GATEWAY_KIMI_CONTEXT_TOKENS',
  'ULTRATHINK_GATEWAY_KIMI_MODEL',
  'ULTRATHINK_GATEWAY_KIMI_REASONING_EFFORT',
  'ULTRATHINK_GATEWAY_KIMI_VERSION',
  'ULTRATHINK_GATEWAY_MAIN_MODEL_ID',
  'ULTRATHINK_GATEWAY_MAIN_PROVIDER',
  'ULTRATHINK_GATEWAY_MAIN_REASONING_EFFORT',
  'ULTRATHINK_GATEWAY_MAIN_UPSTREAM_MODEL',
  'ULTRATHINK_GATEWAY_PASSTHROUGH_MODEL_IDS',
  'ULTRATHINK_GATEWAY_ROUTE_MAP_JSON',
  'ULTRATHINK_GATEWAY_SHARED_SECRET',
  'ULTRATHINK_GATEWAY_SUBAGENT_MODEL_ID',
  'ULTRATHINK_GATEWAY_SUBAGENT_REASONING_EFFORT',
  'ULTRATHINK_GATEWAY_SUBAGENT_UPSTREAM_MODEL',
  'ULTRATHINK_GATEWAY_SUBAGENT_VERBOSITY',
  'ULTRATHINK_THINKING_LEVEL',
]);

function updateEnvironment(updates) {
  const previous = new Map();
  for (const name of Object.keys(updates)) {
    previous.set(name, process.env[name]);
    const value = updates[name];
    if (value === undefined || value === null || value === '') {
      delete process.env[name];
    } else {
      process.env[name] = String(value);
    }
  }

  return function restoreEnvironment() {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };
}

async function withIsolatedEnvironment(overrides, callback) {
  const cleanEnvironment = Object.fromEntries(
    ISOLATED_ENV_NAMES.map(function clearEnvironmentName(name) {
      return [name, undefined];
    })
  );
  const restore = updateEnvironment({ ...cleanEnvironment, ...overrides });
  try {
    return await callback();
  } finally {
    restore();
  }
}

function listen(server) {
  if (server.listening) {
    return Promise.resolve();
  }
  return new Promise(function waitForListening(resolve, reject) {
    server.once('listening', resolve);
    server.once('error', reject);
  });
}

function close(server) {
  return new Promise(function closeServer(resolve, reject) {
    server.close(function serverClosed(error) {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function jsonHeaders(extra = {}) {
  return {
    'content-type': 'application/json',
    ...extra,
  };
}

function assertKimiRoute(route) {
  assert.equal(route.provider, 'kimi');
  assert.equal(route.requestedModel, KIMI_MODEL_ALIAS);
  assert.equal(route.upstreamModel, KIMI_UPSTREAM_MODEL);
  assert.equal(route.reasoningEffort, 'max');
  assert.equal(route.contextTokens, KIMI_CONTEXT_TOKENS);
}

test('Kimi profile uses plain K3 with max thinking and the shared Codex-safe context', async function () {
  await withIsolatedEnvironment(
    {
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'stale-fable-route',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'stale-haiku-route',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'stale-opus-route',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'stale-sonnet-route',
      ANTHROPIC_MODEL: 'stale-main-route',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1',
      CLAUDE_CODE_EFFORT_LEVEL: 'low',
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1',
      KIMI_API_KEY: 'test-fallback-kimi-key',
      ULTRATHINK_GATEWAY_KIMI_API_KEY: KIMI_API_KEY,
      ULTRATHINK_GATEWAY_MAIN_MODEL_ID: KIMI_MODEL_ALIAS,
      ULTRATHINK_GATEWAY_MAIN_PROVIDER: 'kimi',
    },
    async function verifyKimiConfiguration() {
      const loaded = loadGatewayConfig();
      assert.deepEqual(loaded.kimi, {
        apiKey: KIMI_API_KEY,
        baseUrl: 'https://api.kimi.com/coding/',
        model: KIMI_UPSTREAM_MODEL,
        reasoningEffort: 'max',
        contextTokens: KIMI_CONTEXT_TOKENS,
        version: '2023-06-01',
      });

      const workflow = buildWorkflowGatewayConfig();
      assert.equal(workflow.mainModelId, KIMI_MODEL_ALIAS);
      assert.equal(typeof workflow.config.sharedSecret, 'string');
      assert.equal(workflow.config.sharedSecret.length >= 32, true);
      assert.throws(
        function rejectUnauthenticatedKimiGateway() {
          createGatewayServer({ ...workflow.config, sharedSecret: '' });
        },
        /Kimi routes require gateway authentication/u
      );
      assert.equal(
        workflow.config.exposedModels.filter((model) => model === KIMI_MODEL_ALIAS).length,
        1
      );
      assertKimiRoute(resolveModelRoute(KIMI_MODEL_ALIAS, workflow.config));
      assert.equal(
        resolveModelRoute(KIMI_UPSTREAM_MODEL, workflow.config).upstreamModel,
        KIMI_UPSTREAM_MODEL
      );

      const clientEnv = buildWorkflowClientEnv(
        workflow.config,
        'http://127.0.0.1:4318',
        workflow.subagentModelId,
        workflow.mainModelId
      );
      assert.equal(clientEnv.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4318');
      assert.equal(clientEnv.ANTHROPIC_MODEL, KIMI_MODEL_ALIAS);
      assert.equal(clientEnv.ANTHROPIC_DEFAULT_FABLE_MODEL, workflow.subagentModelId);
      assert.equal(clientEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL, workflow.subagentModelId);
      assert.equal(clientEnv.ANTHROPIC_DEFAULT_OPUS_MODEL, workflow.subagentModelId);
      assert.equal(clientEnv.ANTHROPIC_DEFAULT_SONNET_MODEL, workflow.subagentModelId);
      assert.equal(
        clientEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW,
        String(CLAUDE_COMMON_AUTO_COMPACT_TOKENS)
      );
      assert.equal(
        clientEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS,
        String(CLAUDE_COMMON_CONTEXT_TOKENS)
      );
      assert.equal(clientEnv.CLAUDE_CODE_EFFORT_LEVEL, 'max');
      assert.equal(clientEnv.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK, '1');
      assert.equal(clientEnv.CLAUDE_CODE_DISABLE_TERMINAL_TITLE, '1');
      assert.equal(clientEnv.ANTHROPIC_CUSTOM_MODEL_OPTION, KIMI_MODEL_ALIAS);
      assert.equal(clientEnv.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME, 'Kimi K3 Main Route');
      assert.equal(
        clientEnv.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION,
        'kimi:k3/max through claude-workflow'
      );
      assert.equal(
        clientEnv.ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES,
        'effort,xhigh_effort,max_effort,thinking,adaptive_thinking,interleaved_thinking'
      );
      assert.equal(clientEnv.ANTHROPIC_API_KEY, workflow.config.sharedSecret);
      assert.equal(clientEnv.ANTHROPIC_AUTH_TOKEN, workflow.config.sharedSecret);
      assert.equal(
        clientEnv[MANAGED_GATEWAY_AUTH_ENV_NAME],
        workflow.config.sharedSecret
      );
      assert.equal(Object.hasOwn(clientEnv, 'KIMI_API_KEY'), false);
      assert.equal(Object.hasOwn(clientEnv, 'ULTRATHINK_GATEWAY_KIMI_API_KEY'), false);
      assert.equal(Object.values(clientEnv).includes(KIMI_API_KEY), false);

      const daemonEnvironment = serializeWorkflowEnvironment(clientEnv);
      assert.equal(daemonEnvironment.includes(KIMI_API_KEY), false);
      assert.equal(daemonEnvironment.includes('KIMI_API_KEY'), false);
      assert.match(daemonEnvironment, /export ANTHROPIC_MODEL='k3'/u);
      assert.match(
        daemonEnvironment,
        /export CLAUDE_CODE_AUTO_COMPACT_WINDOW='784800'/u
      );
      assert.match(
        daemonEnvironment,
        /export CLAUDE_CODE_MAX_CONTEXT_TOKENS='828400'/u
      );
      assert.match(
        daemonEnvironment,
        /export CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK='1'/u
      );
      assert.match(daemonEnvironment, /export ANTHROPIC_CUSTOM_MODEL_OPTION='k3'/u);
      assert.match(daemonEnvironment, /export CLAUDE_CODE_EFFORT_LEVEL='max'/u);
    }
  );
});

test('Kimi credentials require HTTPS except on loopback development gateways', async function () {
  const commonEnvironment = {
    ULTRATHINK_GATEWAY_KIMI_API_KEY: KIMI_API_KEY,
    ULTRATHINK_GATEWAY_MAIN_MODEL_ID: KIMI_MODEL_ALIAS,
    ULTRATHINK_GATEWAY_MAIN_PROVIDER: 'kimi',
  };

  for (const baseUrl of [
    'https://example.com/coding/',
    'http://localhost:8787/coding/',
    'http://127.0.0.1:8787/coding/',
    'http://[::1]:8787/coding/',
  ]) {
    await withIsolatedEnvironment(
      { ...commonEnvironment, ULTRATHINK_GATEWAY_KIMI_BASE_URL: baseUrl },
      async function acceptSecureOrLoopbackEndpoint() {
        const workflow = buildWorkflowGatewayConfig();
        assert.equal(workflow.config.kimi.baseUrl, baseUrl);
        assert.equal(resolveModelRoute(workflow.mainModelId, workflow.config).provider, 'kimi');
      }
    );
  }

  for (const [baseUrl, expected] of [
    ['not a URL', /requires a valid ULTRATHINK_GATEWAY_KIMI_BASE_URL/u],
    ['ftp://example.com/coding/', /requires an https:\/\/ base URL/u],
    ['http://example.com/coding/', /refuses remote http:\/\/ base URLs/u],
  ]) {
    await withIsolatedEnvironment(
      { ...commonEnvironment, ULTRATHINK_GATEWAY_KIMI_BASE_URL: baseUrl },
      async function rejectCredentialExposingEndpoint() {
        assert.throws(() => {
          const workflow = buildWorkflowGatewayConfig();
          resolveModelRoute(workflow.mainModelId, workflow.config);
        }, expected);
      }
    );
  }
});

test('route switches discard only stale workflow-owned Anthropic credentials', async function () {
  const staleManagedToken = 'test-stale-managed-token';
  await withIsolatedEnvironment(
    {
      [MANAGED_GATEWAY_AUTH_ENV_NAME]: staleManagedToken,
      ANTHROPIC_AUTH_TOKEN: staleManagedToken,
      ANTHROPIC_API_KEY: staleManagedToken,
    },
    async function verifyStaleManagedCredentialIsIgnored() {
      const loaded = loadGatewayConfig();
      assert.equal(loaded.anthropic.apiKey, '');
      const workflow = buildWorkflowGatewayConfig();
      assert.equal(workflow.config.sharedSecret, '');
      const childEnv = environmentWithoutGatewayCredentials(process.env);
      assert.equal(Object.hasOwn(childEnv, 'ANTHROPIC_AUTH_TOKEN'), false);
      assert.equal(Object.hasOwn(childEnv, 'ANTHROPIC_API_KEY'), false);
      assert.equal(Object.hasOwn(childEnv, MANAGED_GATEWAY_AUTH_ENV_NAME), false);
    }
  );

  await withIsolatedEnvironment(
    {
      [MANAGED_GATEWAY_AUTH_ENV_NAME]: staleManagedToken,
      ANTHROPIC_AUTH_TOKEN: staleManagedToken,
      ANTHROPIC_API_KEY: 'test-user-anthropic-key',
    },
    async function verifyUserCredentialIsPreserved() {
      assert.equal(loadGatewayConfig().anthropic.apiKey, 'test-user-anthropic-key');
      const childEnv = environmentWithoutGatewayCredentials(process.env);
      assert.equal(childEnv.ANTHROPIC_API_KEY, 'test-user-anthropic-key');
      assert.equal(Object.hasOwn(childEnv, 'ANTHROPIC_AUTH_TOKEN'), false);
    }
  );
});

test('Kimi and Anthropic mixed routes require separate upstream credentials', async function () {
  const mixedRouteEnvironment = {
    ULTRATHINK_GATEWAY_ANTHROPIC_PASSTHROUGH_MODELS: 'claude-opus-4-8*',
    ULTRATHINK_GATEWAY_KIMI_API_KEY: KIMI_API_KEY,
    ULTRATHINK_GATEWAY_MAIN_MODEL_ID: KIMI_MODEL_ALIAS,
    ULTRATHINK_GATEWAY_MAIN_PROVIDER: 'kimi',
  };

  await withIsolatedEnvironment(mixedRouteEnvironment, async function rejectCredentialReuse() {
    process.env.ANTHROPIC_API_KEY = 'test-generic-anthropic-key';
    assert.throws(
      () => buildWorkflowGatewayConfig(),
      /Kimi route combined with an Anthropic route requires a dedicated gateway-side Anthropic API key/u
    );
  });

  await withIsolatedEnvironment(
    {
      ...mixedRouteEnvironment,
      ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY: 'test-anthropic-upstream-key',
    },
    async function acceptSeparateCredentials() {
      const workflow = buildWorkflowGatewayConfig();
      assert.equal(resolveModelRoute('claude-opus-4-8', workflow.config).provider, 'anthropic');
      assert.equal(workflow.config.anthropic.apiKey, 'test-anthropic-upstream-key');
    }
  );
});

test('raw Kimi-only configuration can disable implicit Anthropic passthrough', async function () {
  await withIsolatedEnvironment(
    {
      ULTRATHINK_GATEWAY_KIMI_API_KEY: KIMI_API_KEY,
      ULTRATHINK_GATEWAY_ROUTE_MAP_JSON: JSON.stringify({
        [KIMI_MODEL_ALIAS]: { provider: 'kimi', model: KIMI_UPSTREAM_MODEL },
      }),
      ULTRATHINK_GATEWAY_SHARED_SECRET: GATEWAY_SECRET,
    },
    async function verifyExplicitEmptyPassthrough() {
      process.env.ULTRATHINK_GATEWAY_ANTHROPIC_PASSTHROUGH_MODELS = 'none';
      const config = loadGatewayConfig();
      assert.deepEqual(config.anthropicPassthroughModels, []);
      assert.equal(resolveModelRoute(KIMI_MODEL_ALIAS, config).provider, 'kimi');
      assert.equal(resolveModelRoute('claude-opus-4-8', config).provider, 'codex');
      config.port = 0;
      const runtime = createGatewayServer(config);
      await runtime.close();
    }
  );
});

test('Kimi client settings follow only the resolved main route', async function () {
  await withIsolatedEnvironment(
    {
      ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY: 'test-anthropic-gateway-key',
      ULTRATHINK_GATEWAY_KIMI_API_KEY: KIMI_API_KEY,
      ULTRATHINK_GATEWAY_ROUTE_MAP_JSON: JSON.stringify({
        'dormant-kimi-route': {
          provider: 'KIMI',
          model: KIMI_UPSTREAM_MODEL,
          reasoningEffort: 'max',
        },
      }),
    },
    async function verifyDormantRouteDoesNotPinNativeEffort() {
      const workflow = buildWorkflowGatewayConfig();
      assert.notEqual(workflow.config.sharedSecret, '');
      assert.equal(
        resolveModelRoute('dormant-kimi-route', workflow.config).provider,
        'kimi'
      );
      const clientEnv = buildWorkflowClientEnv(
        workflow.config,
        'http://127.0.0.1:4318',
        workflow.subagentModelId,
        workflow.mainModelId
      );
      assert.equal(workflow.mainModelId, 'claude-fable-5-1');
      assert.equal(clientEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '828400');
      assert.equal(clientEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '784800');
      assert.equal(clientEnv.CLAUDE_CODE_EFFORT_LEVEL, null);
      assert.equal(clientEnv.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK, '1');
      assert.equal(clientEnv.ANTHROPIC_CUSTOM_MODEL_OPTION, workflow.subagentModelId);
      assert.match(clientEnv.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME, /^Codex /u);
      assert.equal(
        Object.hasOwn(clientEnv, 'CLAUDE_CODE_DISABLE_TERMINAL_TITLE'),
        false
      );
      const serialized = serializeWorkflowEnvironment(clientEnv);
      assert.match(serialized, /export CLAUDE_CODE_AUTO_COMPACT_WINDOW='784800'/u);
      assert.match(serialized, /^unset CLAUDE_CODE_EFFORT_LEVEL\b/mu);
      assert.match(serialized, /export CLAUDE_CODE_MAX_CONTEXT_TOKENS='828400'/u);
    }
  );

  await withIsolatedEnvironment(
    {
      ULTRATHINK_GATEWAY_KIMI_API_KEY: KIMI_API_KEY,
      ULTRATHINK_GATEWAY_KIMI_CONTEXT_TOKENS: '262144',
      ULTRATHINK_GATEWAY_KIMI_REASONING_EFFORT: 'high',
      ULTRATHINK_GATEWAY_MAIN_MODEL_ID: KIMI_UPSTREAM_MODEL,
      ULTRATHINK_GATEWAY_MAIN_PROVIDER: 'kimi',
    },
    async function verifyResolvedKimiProfile() {
      const workflow = buildWorkflowGatewayConfig();
      const route = resolveModelRoute(workflow.mainModelId, workflow.config);
      const clientEnv = buildWorkflowClientEnv(
        workflow.config,
        'http://127.0.0.1:4318',
        workflow.subagentModelId,
        workflow.mainModelId
      );
      assert.equal(route.reasoningEffort, 'high');
      assert.equal(route.contextTokens, 262_144);
      assert.equal(clientEnv.CLAUDE_CODE_EFFORT_LEVEL, 'high');
      assert.equal(clientEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '262144');
      assert.equal(clientEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '262144');
      assert.equal(clientEnv.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK, '1');
      assert.equal(clientEnv.ANTHROPIC_CUSTOM_MODEL_OPTION, KIMI_UPSTREAM_MODEL);
    }
  );
});

test('Kimi gateway preserves the Anthropic wire protocol without leaking client credentials', async function () {
  await withIsolatedEnvironment(
    {
      ULTRATHINK_GATEWAY_KIMI_API_KEY: KIMI_API_KEY,
      ULTRATHINK_GATEWAY_MAIN_MODEL_ID: KIMI_MODEL_ALIAS,
      ULTRATHINK_GATEWAY_MAIN_PROVIDER: 'kimi',
    },
    async function verifyKimiProxy() {
      const requests = [];
      const rawSse = [
        ': kimi keepalive\r\n\r\n',
        'event: message_start\r\n',
        'data: {"type":"message_start","message":{"id":"msg_kimi_stream","type":"message","role":"assistant","model":"k3","content":[],"usage":{"input_tokens":9,"output_tokens":0}}}\r\n\r\n',
        'event: content_block_start\r\n',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":"fake-kimi-signature"}}\r\n\r\n',
        'event: content_block_delta\r\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"keep this byte-for-byte"}}\r\n\r\n',
        'event: content_block_delta\r\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"fake-signature-delta"}}\r\n\r\n',
        'event: message_stop\r\n',
        'data: {"type":"message_stop"}\r\n\r\n',
      ].join('');

      const upstream = http.createServer(async function fakeKimi(req, res) {
        const body = await readJsonBody(req);
        requests.push({
          body,
          headers: req.headers,
          method: req.method,
          url: req.url,
        });

        const parsedUrl = new URL(req.url, 'http://127.0.0.1');
        if (parsedUrl.pathname !== '/coding/v1/messages') {
          res.writeHead(404, jsonHeaders());
          res.end(JSON.stringify({ error: 'unsupported fake Kimi endpoint' }));
          return;
        }

        if (parsedUrl.searchParams.get('error') === 'rate-limit') {
          res.writeHead(429, jsonHeaders({ 'retry-after': '3' }));
          res.end(
            JSON.stringify({
              type: 'error',
              error: {
                type: 'rate_limit_error',
                message: 'fake Kimi rate limit',
              },
            })
          );
          return;
        }

        if (body.stream === true) {
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'x-fake-kimi-stream': 'true',
          });
          for (const chunk of [rawSse.slice(0, 37), rawSse.slice(37, 211), rawSse.slice(211)]) {
            res.write(chunk);
          }
          res.end();
          return;
        }

        res.writeHead(200, jsonHeaders());
        res.end(
          JSON.stringify({
            id: 'msg_kimi_json',
            type: 'message',
            role: 'assistant',
            model: KIMI_UPSTREAM_MODEL,
            content: [
              {
                type: 'thinking',
                thinking: 'fake internal reasoning',
                signature: 'fake-json-signature',
              },
              { type: 'text', text: 'KIMI_JSON_OK' },
            ],
            stop_reason: 'end_turn',
            usage: { input_tokens: 8, output_tokens: 5 },
          })
        );
      });
      upstream.listen(0, '127.0.0.1');
      await listen(upstream);
      const upstreamAddress = upstream.address();
      assert.equal(typeof upstreamAddress, 'object');

      const workflow = buildWorkflowGatewayConfig();
      workflow.config.port = 0;
      workflow.config.sharedSecret = GATEWAY_SECRET;
      workflow.config.requestTimeoutMs = 5_000;
      workflow.config.kimi.baseUrl = `http://127.0.0.1:${upstreamAddress.port}/coding`;
      const runtime = createGatewayServer(workflow.config);
      await listen(runtime.server);
      const gatewayAddress = runtime.server.address();
      assert.equal(typeof gatewayAddress, 'object');
      const gatewayBaseUrl = `http://127.0.0.1:${gatewayAddress.port}`;
      const gatewayHeaders = jsonHeaders({
        accept: 'application/json',
        authorization: `Bearer ${GATEWAY_SECRET}`,
        'anthropic-beta':
          'context-1m-2025-08-07,interleaved-thinking-2025-05-14',
        'anthropic-version': '2023-06-01',
        'user-agent': 'claude-code-test/9.9 (kimi-contract)',
        'x-api-key': 'test-inbound-client-credential',
      });

      try {
        const jsonResponse = await fetch(
          `${gatewayBaseUrl}/v1/messages?mode=json&duplicate=a&duplicate=b`,
          {
            method: 'POST',
            headers: gatewayHeaders,
            body: JSON.stringify({
              model: KIMI_MODEL_ALIAS,
              max_tokens: 128,
              thinking: { type: 'disabled' },
              output_config: { effort: 'low' },
              messages: [{ role: 'user', content: 'Use K3.' }],
            }),
          }
        );
        assert.equal(jsonResponse.status, 200);
        assert.deepEqual(await jsonResponse.json(), {
          id: 'msg_kimi_json',
          type: 'message',
          role: 'assistant',
          model: KIMI_UPSTREAM_MODEL,
          content: [
            {
              type: 'thinking',
              thinking: 'fake internal reasoning',
              signature: 'fake-json-signature',
            },
            { type: 'text', text: 'KIMI_JSON_OK' },
          ],
          stop_reason: 'end_turn',
          usage: { input_tokens: 8, output_tokens: 5 },
        });

        const jsonRequest = requests.at(-1);
        assert.equal(jsonRequest.method, 'POST');
        assert.equal(jsonRequest.url, '/coding/v1/messages?mode=json&duplicate=a&duplicate=b');
        assert.equal(jsonRequest.headers['x-api-key'], KIMI_API_KEY);
        assert.equal(jsonRequest.headers.authorization, undefined);
        assert.equal(jsonRequest.headers['anthropic-version'], '2023-06-01');
        assert.equal(
          jsonRequest.headers['anthropic-beta'],
          'context-1m-2025-08-07,interleaved-thinking-2025-05-14'
        );
        assert.equal(jsonRequest.headers['user-agent'], 'claude-code-test/9.9 (kimi-contract)');
        assert.equal(jsonRequest.body.model, KIMI_UPSTREAM_MODEL);
        assert.deepEqual(jsonRequest.body.thinking, { type: 'adaptive' });
        assert.deepEqual(jsonRequest.body.output_config, { effort: 'max' });

        const streamResponse = await fetch(`${gatewayBaseUrl}/v1/messages?mode=stream`, {
          method: 'POST',
          headers: gatewayHeaders,
          body: JSON.stringify({
            model: KIMI_MODEL_ALIAS,
            max_tokens: 128,
            stream: true,
            thinking: { type: 'adaptive', display: 'omitted' },
            output_config: { effort: 'low' },
            messages: [{ role: 'user', content: 'Stream K3.' }],
          }),
        });
        assert.equal(streamResponse.status, 200);
        assert.equal(
          streamResponse.headers.get('content-type'),
          'text/event-stream; charset=utf-8'
        );
        assert.equal(await streamResponse.text(), rawSse);
        const streamRequest = requests.at(-1);
        assert.equal(streamRequest.url, '/coding/v1/messages?mode=stream');
        assert.equal(streamRequest.headers['x-api-key'], KIMI_API_KEY);
        assert.equal(streamRequest.headers.authorization, undefined);
        assert.equal(streamRequest.headers['user-agent'], 'claude-code-test/9.9 (kimi-contract)');
        assert.deepEqual(streamRequest.body.thinking, {
          type: 'adaptive',
          display: 'omitted',
        });
        assert.deepEqual(streamRequest.body.output_config, { effort: 'max' });

        const upstreamCallsBeforeCount = requests.length;
        const countRequest = {
          model: KIMI_MODEL_ALIAS,
          system: 'Count locally.',
          messages: [{ role: 'user', content: 'Do not call Kimi count_tokens.' }],
        };
        const countResponse = await fetch(
          `${gatewayBaseUrl}/v1/messages/count_tokens?must=stay-local`,
          {
            method: 'POST',
            headers: gatewayHeaders,
            body: JSON.stringify(countRequest),
          }
        );
        assert.equal(countResponse.status, 200);
        const countPayload = await countResponse.json();
        const serializedCountInput = JSON.stringify({
          model: countRequest.model,
          system: countRequest.system,
          messages: countRequest.messages,
        });
        assert.equal(
          countPayload.input_tokens,
          Buffer.byteLength(serializedCountInput, 'utf8')
        );

        const unicodeCountRequest = {
          model: KIMI_MODEL_ALIAS,
          messages: [{ role: 'user', content: '代码审查 🚀 مرحبا' }],
        };
        const unicodeCountResponse = await fetch(
          `${gatewayBaseUrl}/v1/messages/count_tokens`,
          {
            method: 'POST',
            headers: gatewayHeaders,
            body: JSON.stringify(unicodeCountRequest),
          }
        );
        assert.equal(unicodeCountResponse.status, 200);
        const unicodeCountPayload = await unicodeCountResponse.json();
        const serializedUnicodeInput = JSON.stringify({
          model: unicodeCountRequest.model,
          messages: unicodeCountRequest.messages,
        });
        assert.equal(
          unicodeCountPayload.input_tokens,
          Buffer.byteLength(serializedUnicodeInput, 'utf8')
        );
        assert.equal(requests.length, upstreamCallsBeforeCount);

        const errorResponse = await fetch(
          `${gatewayBaseUrl}/v1/messages?error=rate-limit`,
          {
            method: 'POST',
            headers: gatewayHeaders,
            body: JSON.stringify({
              model: KIMI_MODEL_ALIAS,
              max_tokens: 32,
              messages: [{ role: 'user', content: 'Return a fake error.' }],
            }),
          }
        );
        assert.equal(errorResponse.status, 429);
        assert.equal(errorResponse.headers.get('retry-after'), '3');
        assert.deepEqual(await errorResponse.json(), {
          type: 'error',
          error: {
            type: 'rate_limit_error',
            message: 'fake Kimi rate limit',
          },
        });
      } finally {
        await runtime.close();
        await close(upstream);
      }
    }
  );
});

test('Kimi routes fail clearly when the gateway-side credential is missing', async function () {
  await withIsolatedEnvironment(
    {
      ULTRATHINK_GATEWAY_MAIN_MODEL_ID: KIMI_MODEL_ALIAS,
      ULTRATHINK_GATEWAY_MAIN_PROVIDER: 'kimi',
    },
    async function verifyMissingCredentialError() {
      const workflow = buildWorkflowGatewayConfig();
      assert.throws(
        function resolveKimiWithoutCredential() {
          resolveModelRoute(KIMI_MODEL_ALIAS, workflow.config);
        },
        function isActionableKimiError(error) {
          assert.equal(error.status, 500);
          assert.equal(error.type, 'api_error');
          assert.match(error.message, /ULTRATHINK_GATEWAY_KIMI_API_KEY|KIMI_API_KEY/u);
          assert.equal(error.message.includes(KIMI_API_KEY), false);
          return true;
        }
      );
    }
  );
});

test('shared daemon fails before listening when the Kimi credential is missing', async function () {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'claude-workflow-kimi-daemon-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const name of ISOLATED_ENV_NAMES) {
    delete env[name];
  }
  env.ULTRATHINK_GATEWAY_MAIN_MODEL_ID = KIMI_MODEL_ALIAS;
  env.ULTRATHINK_GATEWAY_MAIN_PROVIDER = 'kimi';

  try {
    const result = spawnSync(process.execPath, [DAEMON_PATH], {
      env,
      encoding: 'utf8',
      timeout: 5_000,
    });
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout || ''}${result.stderr || ''}`,
      /Kimi routing is configured.*(?:ULTRATHINK_GATEWAY_KIMI_API_KEY|KIMI_API_KEY)/u
    );
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});
