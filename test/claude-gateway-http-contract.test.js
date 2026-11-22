import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';

import { loadGatewayConfig } from '../js/gateway/config.js';
import { translateAnthropicMessagesRequest } from '../js/gateway/anthropic-format.js';
import { createGatewayServer } from '../js/gateway/server.js';

const REQUEST_BODY_LIMIT_BYTES = 32 * 1024 * 1024;
const GATEWAY_SECRET = 'gateway-test-secret';
const UPSTREAM_SECRET = 'upstream-test-secret';
const TEST_MODEL = 'claude-contract-test';
const FABLE_MODEL = 'claude-fable-5-1';

test('Codex count_tokens estimates inline images as visual inputs, not base64 text', async (t) => {
  const gateway = await startGateway('http://127.0.0.1:1/', {
    anthropicPassthroughModels: [],
    codex: { enabled: true, model: 'gpt-6.2-sol' },
    routeMap: { [TEST_MODEL]: { provider: 'codex', model: 'gpt-6.2-sol' } },
  });
  t.after(() => gateway.runtime.close());
  const count = async (size) => {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a'.repeat(size) } };
    const response = await rawPost(`${gateway.url}/v1/messages/count_tokens`, gatewayHeaders(), JSON.stringify({
      model: TEST_MODEL, messages: [{ role: 'user', content: [image, {
        type: 'tool_result', tool_use_id: 'call-1', content: [image],
      }] }],
    }));
    assert.equal(response.status, 200);
    return JSON.parse(response.body).input_tokens;
  };
  const small = await count(16);
  assert.ok(small >= 2 * 1844 && small < 4000);
  assert.equal(await count(1024 * 1024), small);
});

test('managed workflows check delegated message and token-count routes after resolving aliases', async (t) => {
  const received = [];
  const upstream = http.createServer(async (req, res) => {
    received.push(JSON.parse((await readBody(req)).toString('utf8')).model);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'test', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    }));
  });
  const address = await listen(upstream);
  t.after(() => closeServer(upstream));
  const upstreamUrl = `http://127.0.0.1:${address.port}/`;
  const options = {
    anthropicPassthroughModels: [],
    codex: { enabled: true, model: 'gpt-6.2-astra', command: '/definitely/missing/codex' },
    openai: { apiKey: UPSTREAM_SECRET, baseUrl: upstreamUrl, reasoningEffort: 'low' },
    routeMap: {
      'main-openai': { provider: 'openai', model: 'gpt-6.2-sol' },
      'codex-runner-*': { provider: 'codex', model: 'gpt-6.2-sol-2026-11-22' },
      'astra-runner': { provider: 'openai', model: 'gpt-6.2-astra' },
    },
  };
  const managed = await startGateway(upstreamUrl, { ...options, workflowRunnerAstraFloor: true });
  const standalone = await startGateway(upstreamUrl, options);
  t.after(() => managed.runtime.close());
  t.after(() => standalone.runtime.close());
  const post = (gateway, path, model, extraHeaders = {}) => rawPost(
    `${gateway.url}/v1/messages${path}`, gatewayHeaders(extraHeaders),
    JSON.stringify({ model, max_tokens: 64, messages: [{ role: 'user', content: 'ping' }] })
  );
  for (const path of ['', '/count_tokens']) {
    for (const [model, header] of [
      ['main-openai', 'x-claude-code-agent-id'],
      ['codex-runner-deep', 'x-claude-code-parent-agent-id'],
    ]) {
      const blocked = await post(managed, path, model, { [header]: 'child' });
      assert.equal(blocked.status, 400, blocked.body);
      const error = JSON.parse(blocked.body).error;
      assert.equal(error.type, 'invalid_request_error');
      assert.match(error.message, /claude-workflow config --agents astra --effort low/);
    }
  }
  assert.deepEqual(received, []);
  const child = { 'x-claude-code-agent-id': 'child' };
  for (const [gateway, model, headers] of [
    [managed, 'main-openai', {}], [managed, 'astra-runner', child], [standalone, 'main-openai', child],
  ]) {
    for (const path of ['', '/count_tokens']) {
      const response = await post(gateway, path, model, headers);
      assert.equal(response.status, 200, response.body);
    }
  }
  assert.deepEqual(received, ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.2-sol']);
});

test('GPT-6.2 Chat routes omit sampling parameters and require Responses for tools', () => {
  const text = { messages: [{ role: 'user', content: 'test' }], max_tokens: 128, temperature: 1, top_p: 0.5 };
  for (const upstreamModel of ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.2-sol-2026-11-01']) {
    const route = { upstreamModel, provider: 'openai', reasoningEffort: 'max' };
    const translated = translateAnthropicMessagesRequest({ ...text, tool_choice: { type: 'none' } }, route);
    assert.equal(translated.model, upstreamModel);
    assert.equal(translated.reasoning_effort, 'max');
    assert.equal(translated.max_completion_tokens, 128);
    for (const field of ['temperature', 'top_p', 'tool_choice']) assert.ok(!(field in translated));
    for (const input of [
      { tools: [{ name: 'Read', input_schema: { type: 'object' } }] },
      { tool_choice: { type: 'tool', name: 'Read' } },
      { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] }] },
      { messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] }] },
    ]) assert.throws(() => translateAnthropicMessagesRequest({ ...text, ...input }, route), /require Responses/u);
    for (const reasoningEffort of ['none', 'minimal', 'ultra']) {
      assert.throws(() => translateAnthropicMessagesRequest(text, { ...route, reasoningEffort }), /effort must be/u);
    }
  }
  assert.equal(translateAnthropicMessagesRequest(text, { provider: 'openai', upstreamModel: 'other' }).temperature, 1);
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.closeAllConnections?.();
    server.close((error) => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function rawPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers,
      },
      (response) => {
        const chunks = [];
        let settled = false;
        const finish = (aborted) => {
          if (settled) {
            return;
          }
          settled = true;
          resolve({
            aborted,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: response.headers,
            status: response.statusCode,
          });
        };
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => finish(false));
        response.on('aborted', () => finish(true));
        response.on('error', () => finish(true));
      }
    );
    request.once('error', reject);
    request.end(body);
  });
}

function anthropicMessage(model = TEST_MODEL) {
  return {
    id: 'msg_contract_test',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

async function startGateway(upstreamBaseUrl, options = {}) {
  const defaults = loadGatewayConfig();
  const config = {
    ...defaults,
    host: '127.0.0.1',
    port: 0,
    traceDir: '',
    sharedSecret: GATEWAY_SECRET,
    requestTimeoutMs: 5_000,
    authFailureRateLimitWindowMs: 60_000,
    authFailureRateLimitMaxRequests: 10_000,
    maxConcurrentRequests: 64,
    exposedModels: [TEST_MODEL],
    routeMap: {},
    anthropicPassthroughModels: [TEST_MODEL],
    codex: {
      ...defaults.codex,
      enabled: false,
    },
    anthropic: {
      ...defaults.anthropic,
      apiKey: UPSTREAM_SECRET,
      apiKeySource: 'dedicated',
      baseUrl: upstreamBaseUrl,
    },
    ...options,
  };
  const runtime = createGatewayServer(config);
  if (!runtime.server.listening) {
    await once(runtime.server, 'listening');
  }
  const address = runtime.server.address();
  return {
    runtime,
    url: `http://127.0.0.1:${address.port}`,
  };
}

function gatewayHeaders(extra = {}) {
  return {
    authorization: `Bearer ${GATEWAY_SECRET}`,
    'content-type': 'application/json; charset=utf-8',
    ...extra,
  };
}

function jsonBodyWithExactBytes(byteLength) {
  const prefix = `{"model":"${TEST_MODEL}","stream":false,"padding":"`;
  const suffix = '"}';
  const fixedBytes = Buffer.byteLength(prefix) + Buffer.byteLength(suffix);
  assert.ok(byteLength >= fixedBytes);
  const body = `${prefix}${'x'.repeat(byteLength - fixedBytes)}${suffix}`;
  assert.equal(Buffer.byteLength(body), byteLength);
  return body;
}

test('Anthropic proxy forwards evolving identity headers without forwarding gateway credentials', async function (t) {
  let captured = null;
  const upstream = http.createServer(async function capture(request, response) {
    const body = await readBody(request);
    captured = {
      body: JSON.parse(body.toString('utf8')),
      headers: request.headers,
      url: request.url,
    };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(anthropicMessage()));
  });
  const upstreamAddress = await listen(upstream);
  t.after(() => closeServer(upstream));

  const gateway = await startGateway(
    `http://127.0.0.1:${upstreamAddress.port}/proxy/`
  );
  t.after(() => gateway.runtime.close());

  const response = await rawPost(
    `${gateway.url}/v1/messages?beta=true&future=1`,
    gatewayHeaders({
      'anthropic-api-key': 'must-not-leak',
      'anthropic-auth-token': 'must-not-leak',
      'anthropic-beta': 'future-beta',
      'anthropic-connection-scoped': 'must-not-forward',
      'anthropic-future-identity': 'future-value',
      'anthropic-version': 'future-version',
      'anthropic-workspace-id': 'workspace-123',
      connection: 'close, anthropic-connection-scoped',
      'user-agent': 'claude-contract-test/1.0',
      'x-api-key': GATEWAY_SECRET,
      'x-app': 'cli',
      'x-is-refusal-fallback': 'true',
      'x-cc-fallback-from-model': 'claude-fable-5-1',
      'x-cc-fallback-category': 'cyber',
      'x-cc-fallback-trigger': 'classifier',
      'x-cc-fallback-latched-by': 'claude-code',
      'x-cc-original-request-id': 'req_original',
      'x-cc-api-key': 'must-not-leak',
      'x-cc-future-unreviewed': 'must-not-forward',
      'x-claude-code-api-key': 'must-not-leak',
      'x-claude-code-agent-id': 'agent-123',
      'x-claude-code-auth': 'must-not-leak',
      'x-claude-code-authorization': 'must-not-leak',
      'x-claude-code-session-id': 'session-123',
      'x-stainless-api-key': 'must-not-leak',
      'x-stainless-retry-count': '7',
    }),
    JSON.stringify({
      model: TEST_MODEL,
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 16,
      stream: false,
      future_body_field: { enabled: true },
    })
  );

  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).content[0].text, 'ok');
  assert.ok(captured);
  assert.equal(captured.url, '/proxy/v1/messages?beta=true&future=1');
  assert.deepEqual(captured.body.future_body_field, { enabled: true });
  assert.equal(captured.headers['anthropic-beta'], 'future-beta');
  assert.equal(captured.headers['anthropic-future-identity'], 'future-value');
  assert.equal(captured.headers['anthropic-version'], 'future-version');
  assert.equal(captured.headers['anthropic-workspace-id'], 'workspace-123');
  assert.equal(captured.headers['x-claude-code-agent-id'], 'agent-123');
  assert.equal(captured.headers['x-claude-code-session-id'], 'session-123');
  assert.equal(captured.headers['x-stainless-retry-count'], '7');
  assert.equal(captured.headers['user-agent'], 'claude-contract-test/1.0');
  assert.equal(captured.headers['x-app'], 'cli');
  assert.equal(captured.headers['x-is-refusal-fallback'], 'true');
  assert.equal(captured.headers['x-cc-fallback-from-model'], 'claude-fable-5-1');
  assert.equal(captured.headers['x-cc-fallback-category'], 'cyber');
  assert.equal(captured.headers['x-cc-fallback-trigger'], 'classifier');
  assert.equal(captured.headers['x-cc-fallback-latched-by'], 'claude-code');
  assert.equal(captured.headers['x-cc-original-request-id'], 'req_original');
  assert.equal(captured.headers['x-cc-api-key'], undefined);
  assert.equal(captured.headers['x-cc-future-unreviewed'], undefined);
  assert.equal(captured.headers.authorization, undefined);
  assert.equal(captured.headers['x-api-key'], UPSTREAM_SECRET);
  assert.equal(captured.headers['anthropic-api-key'], undefined);
  assert.equal(captured.headers['anthropic-auth-token'], undefined);
  assert.equal(captured.headers['anthropic-connection-scoped'], undefined);
  assert.equal(captured.headers['x-claude-code-api-key'], undefined);
  assert.equal(captured.headers['x-claude-code-auth'], undefined);
  assert.equal(captured.headers['x-claude-code-authorization'], undefined);
  assert.equal(captured.headers['x-stainless-api-key'], undefined);
  assert.notEqual(captured.headers.connection, 'close');
  assert.equal(captured.headers['content-type'], 'application/json');
});

test('Fable 5.1 preserves prefix-bound history and per-turn fields through messages and token counting', async function (t) {
  const captured = [];
  const reply = {
    ...anthropicMessage(FABLE_MODEL),
    input_transformations: [{ type: 'thinking_blocks_dropped', count: 1 }],
  };
  const upstream = http.createServer(async function capture(request, response) {
    const body = JSON.parse((await readBody(request)).toString('utf8'));
    captured.push({ body, headers: request.headers, url: request.url });
    response.writeHead(200, {
      'content-type': 'application/json',
      'request-id': `req_fable_${captured.length}`,
    });
    response.end(JSON.stringify(request.url.includes('count_tokens') ? { input_tokens: 432 } : reply));
  });
  const upstreamAddress = await listen(upstream);
  t.after(() => closeServer(upstream));
  const gateway = await startGateway(`http://127.0.0.1:${upstreamAddress.port}/`, {
    exposedModels: [FABLE_MODEL],
    anthropicPassthroughModels: [`${FABLE_MODEL}*`],
  });
  t.after(() => gateway.runtime.close());

  // Fable 5.1 signatures bind the full earlier prefix, including system and
  // tools. The gateway must not strip, rebuild, summarize, or repair it.
  const prefix = {
    system: [{ type: 'text', text: 'Keep this system prefix.', cache_control: { type: 'ephemeral' } }],
    tools: [{
      name: 'Read',
      description: 'Read a file',
      strict: true,
      input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
      cache_control: { type: 'ephemeral' },
    }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Read the file.' }] },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: '', signature: 'opaque-prefix-bound-signature' },
        { type: 'redacted_thinking', data: 'opaque-redacted-block' },
        { type: 'tool_use', id: 'toolu_fable', name: 'Read', input: { path: 'file.txt' } },
      ] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fable', content: 'file contents' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'The file is loaded.' }] },
      { role: 'system', content: [], output_config: { effort: 'low' } },
      { role: 'user', content: [{ type: 'text', text: 'Summarize it.' }] },
      { role: 'system', clear_at: 'next_user_message', content: 'Keep this summary concise.' },
    ],
  };
  const body = {
    model: `${FABLE_MODEL}[1m]`,
    ...prefix,
    thinking: { type: 'adaptive', display: 'updates', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
    tool_choice: { type: 'auto' },
    output_config: { effort: 'xhigh' },
  };
  const beta = 'thinking-display-updates-2026-08-18,thinking-binding-controls-2026-08-01,mid-conversation-output-config-2026-07-01,mid-conversation-system-clear-at-2026-08-21';
  const requests = [
    { path: '/v1/messages?beta=true', body: { ...body, max_tokens: 128_000, stream: false }, reply },
    { path: '/v1/messages/count_tokens?beta=true', body, reply: { input_tokens: 432 } },
  ];
  for (const [index, entry] of requests.entries()) {
    const response = await rawPost(
      `${gateway.url}${entry.path}`,
      gatewayHeaders({ 'anthropic-beta': beta }),
      JSON.stringify(entry.body)
    );
    assert.equal(response.status, 200, response.body);
    assert.deepEqual(JSON.parse(response.body), entry.reply);
    assert.equal(response.headers['request-id'], `req_fable_${index + 1}`);
    assert.deepEqual(captured[index].body, { ...entry.body, model: FABLE_MODEL });
    assert.equal(captured[index].headers['anthropic-beta'], beta);
    assert.equal(captured[index].url, entry.path);
  }
  assert.equal(captured.length, requests.length, 'one upstream call per client request, with no inference to rewrite history or results');
});

test('Fable 5.1 streams progress, opaque signatures, and tool calls without rewriting SSE', async function (t) {
  let requests = 0;
  const events = [
    ['message_start', { type: 'message_start', message: { ...anthropicMessage(FABLE_MODEL), content: [], stop_reason: null } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Reading λ.txt.' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'opaque-prefix-bound-signature' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_fable', name: 'Read', input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_path":"λ.txt"}' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 1 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 12 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  const stream = events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  const upstream = http.createServer(async function respond(request, response) {
    await readBody(request);
    requests += 1;
    response.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_fable_stream' });
    const bytes = Buffer.from(stream);
    const split = bytes.indexOf(Buffer.from('λ')) + 1;
    response.write(bytes.subarray(0, split));
    setImmediate(() => response.end(bytes.subarray(split)));
  });
  const upstreamAddress = await listen(upstream);
  t.after(() => closeServer(upstream));
  const gateway = await startGateway(`http://127.0.0.1:${upstreamAddress.port}/`, {
    exposedModels: [FABLE_MODEL],
    anthropicPassthroughModels: [FABLE_MODEL],
  });
  t.after(() => gateway.runtime.close());
  const response = await rawPost(`${gateway.url}/v1/messages`, gatewayHeaders(), JSON.stringify({
    model: FABLE_MODEL,
    messages: [{ role: 'user', content: 'Read λ.txt.' }],
    thinking: { type: 'adaptive', display: 'updates' },
    stream: true,
    max_tokens: 128_000,
  }));
  assert.equal(response.status, 200);
  assert.equal(response.body, stream);
  assert.equal(response.headers['request-id'], 'req_fable_stream');
  assert.equal(requests, 1);
});

test('Fable 5.1 forced-tool errors and refusals stay upstream decisions without retry or fallback', async function (t) {
  const captured = [];
  const errorBody = { type: 'error', error: { type: 'invalid_request_error', message: 'Forced tool use is not supported by this model.' } };
  const refusalBody = {
    ...anthropicMessage(FABLE_MODEL),
    content: [{ type: 'text', text: 'I cannot help with this request.' }],
    stop_reason: 'refusal',
    stop_details: { type: 'refusal', category: 'general_harms', explanation: 'Synthetic refusal.' },
  };
  const upstream = http.createServer(async function respond(request, response) {
    const body = JSON.parse((await readBody(request)).toString('utf8'));
    captured.push(body);
    const forced = ['any', 'tool'].includes(body.tool_choice?.type);
    response.writeHead(forced ? 400 : 200, {
      'content-type': 'application/json',
      'request-id': 'req_fable_error',
      'retry-after': '9',
      'anthropic-ratelimit-requests-remaining': '7',
    });
    response.end(JSON.stringify(forced ? errorBody : refusalBody));
  });
  const upstreamAddress = await listen(upstream);
  t.after(() => closeServer(upstream));
  const gateway = await startGateway(`http://127.0.0.1:${upstreamAddress.port}/`, {
    exposedModels: [FABLE_MODEL],
    anthropicPassthroughModels: [FABLE_MODEL],
  });
  t.after(() => gateway.runtime.close());
  const choices = [{ type: 'any' }, { type: 'tool', name: 'Read' }];
  const endpoints = [
    { path: '/v1/messages', fields: { stream: false, max_tokens: 16 } },
    { path: '/v1/messages', fields: { stream: true, max_tokens: 16 } },
    { path: '/v1/messages/count_tokens', fields: {} },
  ];
  for (const toolChoice of choices) {
    for (const endpoint of endpoints) {
      const body = { model: FABLE_MODEL, messages: [{ role: 'user', content: 'Read the file.' }], tool_choice: toolChoice, ...endpoint.fields };
      const response = await rawPost(`${gateway.url}${endpoint.path}`, gatewayHeaders(), JSON.stringify(body));
      assert.equal(response.status, 400);
      assert.deepEqual(JSON.parse(response.body), errorBody);
      assert.match(response.headers['content-type'], /^application\/json/u);
      assert.equal(response.headers['request-id'], 'req_fable_error');
      assert.equal(response.headers['retry-after'], '9');
      assert.equal(response.headers['anthropic-ratelimit-requests-remaining'], '7');
      assert.deepEqual(captured.at(-1), body, 'forced tool use must not be silently weakened to auto');
    }
  }
  const response = await rawPost(`${gateway.url}/v1/messages`, gatewayHeaders(), JSON.stringify({
    model: FABLE_MODEL, messages: [{ role: 'user', content: 'Test refusal.' }], max_tokens: 16,
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), refusalBody);
  assert.equal(captured.length, choices.length * endpoints.length + 1);
});

test('credentialed upstream redirects fail closed without replaying the Kimi key', async function (t) {
  let redirectedRequest = null;
  const redirectTarget = http.createServer(async function captureRedirect(request, response) {
    await readBody(request);
    redirectedRequest = request.headers;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(anthropicMessage('k3')));
  });
  const redirectTargetAddress = await listen(redirectTarget);
  t.after(() => closeServer(redirectTarget));

  let sourceKey = null;
  const redirectSource = http.createServer(async function redirect(request, response) {
    await readBody(request);
    sourceKey = request.headers['x-api-key'];
    response.writeHead(307, {
      location: `http://127.0.0.1:${redirectTargetAddress.port}/credential-sink`,
    });
    response.end();
  });
  const redirectSourceAddress = await listen(redirectSource);
  t.after(() => closeServer(redirectSource));

  const kimiKey = 'test-kimi-redirect-key';
  const gateway = await startGateway('http://127.0.0.1:1/', {
    anthropicPassthroughModels: [],
    kimi: {
      apiKey: kimiKey,
      baseUrl: `http://127.0.0.1:${redirectSourceAddress.port}/`,
      contextTokens: 1_048_576,
      model: 'k3',
      reasoningEffort: 'max',
      version: '2023-06-01',
    },
    routeMap: {
      [TEST_MODEL]: { provider: 'kimi', model: 'k3', reasoningEffort: 'max' },
    },
  });
  t.after(() => gateway.runtime.close());

  const response = await rawPost(
    `${gateway.url}/v1/messages`,
    gatewayHeaders(),
    JSON.stringify({
      model: TEST_MODEL,
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 16,
      stream: false,
    })
  );
  assert.equal(response.status, 502);
  assert.equal(sourceKey, kimiKey);
  assert.equal(redirectedRequest, null);
  assert.deepEqual(JSON.parse(response.body), {
    type: 'error',
    error: {
      type: 'api_error',
      message: 'upstream redirects are disabled to protect credentials and request integrity',
    },
  });
});

test('shared-secret Anthropic routes reject a generic upstream credential', function () {
  const config = loadGatewayConfig();
  assert.throws(
    () =>
      createGatewayServer({
        ...config,
        host: '127.0.0.1',
        port: 0,
        sharedSecret: GATEWAY_SECRET,
        anthropicPassthroughModels: [TEST_MODEL],
        routeMap: {},
        anthropic: {
          ...config.anthropic,
          apiKey: 'generic-anthropic-key',
          apiKeySource: 'generic',
        },
      }),
    /requires ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY/u
  );
});

test('invalid credentials are rate-limited without throttling valid model requests', async function (t) {
  let upstreamRequests = 0;
  const upstream = http.createServer(async function respond(request, response) {
    await readBody(request);
    upstreamRequests += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(anthropicMessage()));
  });
  const upstreamAddress = await listen(upstream);
  t.after(() => closeServer(upstream));

  const gateway = await startGateway(`http://127.0.0.1:${upstreamAddress.port}/`, {
    authFailureRateLimitMaxRequests: 2,
  });
  t.after(() => gateway.runtime.close());
  const body = JSON.stringify({
    model: TEST_MODEL,
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 16,
  });

  const unrelated = await fetch(`${gateway.url}/v1evil`, {
    headers: { authorization: 'Bearer wrong-secret' },
  });
  assert.equal(unrelated.status, 404);

  const wrong = await rawPost(
    `${gateway.url}/V1/MESSAGES/`,
    gatewayHeaders({ authorization: 'Bearer wrong-secret' }),
    body
  );
  assert.equal(wrong.status, 401);

  const missing = await rawPost(
    `${gateway.url}/v1/messages`,
    { 'content-type': 'application/json' },
    body
  );
  assert.equal(missing.status, 401);

  const limited = await rawPost(
    `${gateway.url}/v1/messages`,
    gatewayHeaders({ authorization: 'Bearer another-wrong-secret' }),
    `{"model":"${TEST_MODEL}"`
  );
  assert.equal(limited.status, 429);
  assert.equal(Number(limited.headers['retry-after']) >= 1, true);
  assert.equal(JSON.parse(limited.body).error.type, 'rate_limit_error');
  assert.equal(upstreamRequests, 0);

  for (let index = 0; index < 4; index += 1) {
    const valid = await rawPost(`${gateway.url}/v1/messages`, gatewayHeaders(), body);
    assert.equal(valid.status, 200);
  }
  assert.equal(upstreamRequests, 4);
});

test('anonymous health polling stays unlimited while wrong health credentials are bounded', async function (t) {
  const gateway = await startGateway('http://127.0.0.1:1/', {
    host: '0.0.0.0',
    authFailureRateLimitMaxRequests: 1,
  });
  t.after(() => gateway.runtime.close());

  for (let index = 0; index < 4; index += 1) {
    const health = await fetch(`${gateway.url}/healthz`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);
  }

  const firstWrong = await fetch(`${gateway.url}/HEALTHZ/`, {
    headers: { authorization: 'Bearer wrong-secret' },
  });
  assert.equal(firstWrong.status, 200);
  assert.deepEqual(await firstWrong.json(), {
    ok: true,
    service: 'claude-workflow-gateway',
  });

  const limitedWrong = await fetch(`${gateway.url}/healthz`, {
    headers: { authorization: 'Bearer another-wrong-secret' },
  });
  assert.equal(limitedWrong.status, 429);
  assert.equal((await limitedWrong.json()).error.type, 'rate_limit_error');

  const valid = await fetch(`${gateway.url}/healthz`, {
    headers: gatewayHeaders(),
  });
  assert.equal(valid.status, 200);
  assert.equal((await valid.json()).runtime_pid, process.pid);
});

test('no-secret loopback routes do not acquire an authentication-failure quota', async function (t) {
  let upstreamRequests = 0;
  const upstream = http.createServer(async function respond(request, response) {
    await readBody(request);
    upstreamRequests += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(anthropicMessage()));
  });
  const upstreamAddress = await listen(upstream);
  t.after(() => closeServer(upstream));

  const gateway = await startGateway(`http://127.0.0.1:${upstreamAddress.port}/`, {
    sharedSecret: '',
    authFailureRateLimitMaxRequests: 1,
  });
  t.after(() => gateway.runtime.close());
  const body = JSON.stringify({
    model: TEST_MODEL,
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 16,
  });

  for (let index = 0; index < 3; index += 1) {
    const response = await rawPost(
      `${gateway.url}/v1/messages`,
      { 'content-type': 'application/json' },
      body
    );
    assert.equal(response.status, 200);
  }
  assert.equal(upstreamRequests, 3);
});

test('concurrent admission is held through the response and runs before JSON buffering', async function (t) {
  let releaseFirst;
  const firstRelease = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let markFirstReceived;
  const firstReceived = new Promise((resolve) => {
    markFirstReceived = resolve;
  });
  let upstreamRequests = 0;
  const upstream = http.createServer(async function respond(request, response) {
    const requestBody = JSON.parse((await readBody(request)).toString('utf8'));
    upstreamRequests += 1;
    if (upstreamRequests === 1) {
      assert.equal(requestBody.stream, true);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.flushHeaders();
      response.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      markFirstReceived();
      await firstRelease;
      response.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(anthropicMessage()));
  });
  const upstreamAddress = await listen(upstream);
  t.after(() => {
    releaseFirst();
    return closeServer(upstream);
  });

  const gateway = await startGateway(`http://127.0.0.1:${upstreamAddress.port}/`, {
    maxConcurrentRequests: 1,
  });
  t.after(() => gateway.runtime.close());
  const streamedBody = JSON.stringify({
    model: TEST_MODEL,
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 16,
    stream: true,
  });
  const body = JSON.stringify({
    model: TEST_MODEL,
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 16,
    stream: false,
  });

  const first = rawPost(`${gateway.url}/v1/messages`, gatewayHeaders(), streamedBody);
  await firstReceived;

  const limited = await rawPost(
    `${gateway.url}/v1/messages`,
    gatewayHeaders(),
    `{"model":"${TEST_MODEL}"`
  );
  assert.equal(limited.status, 429);
  assert.equal(JSON.parse(limited.body).error.type, 'rate_limit_error');
  assert.equal(upstreamRequests, 1);

  releaseFirst();
  assert.equal((await first).status, 200);

  const afterRelease = await rawPost(
    `${gateway.url}/v1/messages`,
    gatewayHeaders(),
    body
  );
  assert.equal(afterRelease.status, 200);
  assert.equal(upstreamRequests, 2);
});

test('health reports resolved Codex context capabilities and only active compact overrides', async function (t) {
  const gateway = await startGateway('http://127.0.0.1:1/');
  t.after(() => gateway.runtime.close());

  const capabilities = gateway.runtime.config.codex.capabilities;
  const initial = await fetch(`${gateway.url}/healthz`);
  assert.equal(initial.status, 200);
  const health = await initial.json();
  assert.equal(health.auth_failure_rate_limit_window_ms, 60_000);
  assert.equal(health.auth_failure_rate_limit_max_requests, 10_000);
  assert.equal(health.request_max_concurrent_requests, 64);
  assert.equal(health.request_active_operations, 0);
  assert.equal(health.codex_context_profile, capabilities.profile);
  assert.equal(health.codex_context_source, capabilities.source);
  assert.equal(
    health.codex_requested_raw_context_tokens,
    capabilities.requestedRawContextTokens
  );
  assert.equal(
    health.codex_resolved_raw_context_tokens,
    capabilities.resolvedRawContextTokens
  );
  assert.equal(health.codex_usable_context_tokens, capabilities.usableContextTokens);
  assert.equal(
    health.codex_native_auto_compact_tokens,
    capabilities.autoCompactTokens
  );
  assert.equal(health.codex_max_raw_context_tokens, capabilities.maxRawContextTokens);
  assert.equal(health.codex_auto_compact_token_limit_scope, null);

  gateway.runtime.config.codex.autoCompactTokenLimit = 123_456;
  gateway.runtime.config.codex.autoCompactTokenLimitScope = 'body_after_prefix';
  const overridden = await (await fetch(`${gateway.url}/healthz`)).json();
  assert.equal(overridden.codex_auto_compact_token_limit, 123_456);
  assert.equal(
    overridden.codex_auto_compact_token_limit_scope,
    'body_after_prefix'
  );
});

test('gateway accepts 32 MiB JSON and returns an Anthropic 413 above the limit', async function (t) {
  const upstreamBodies = [];
  const upstream = http.createServer(async function capture(request, response) {
    const body = await readBody(request);
    upstreamBodies.push(body.length);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(anthropicMessage()));
  });
  const upstreamAddress = await listen(upstream);
  t.after(() => closeServer(upstream));

  const gateway = await startGateway(`http://127.0.0.1:${upstreamAddress.port}/`);
  t.after(() => gateway.runtime.close());

  const acceptedBody = jsonBodyWithExactBytes(REQUEST_BODY_LIMIT_BYTES);
  const accepted = await fetch(`${gateway.url}/v1/messages`, {
    method: 'POST',
    headers: gatewayHeaders(),
    body: acceptedBody,
  });
  assert.equal(accepted.status, 200);
  assert.equal(upstreamBodies.length, 1);
  assert.equal(upstreamBodies[0], REQUEST_BODY_LIMIT_BYTES);

  const rejectedBody = jsonBodyWithExactBytes(REQUEST_BODY_LIMIT_BYTES + 1);
  const rejected = await fetch(`${gateway.url}/v1/messages`, {
    method: 'POST',
    headers: gatewayHeaders(),
    body: rejectedBody,
  });
  assert.equal(rejected.status, 413);
  assert.deepEqual(await rejected.json(), {
    type: 'error',
    error: {
      type: 'request_too_large',
      message: 'request body exceeds the 32 MiB limit',
    },
  });
  assert.equal(upstreamBodies.length, 1);

  const malformed = await fetch(`${gateway.url}/v1/messages`, {
    method: 'POST',
    headers: gatewayHeaders(),
    body: `{"model":"${TEST_MODEL}"`,
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.type, 'invalid_request_error');
});

test('proxied SSE keepalives stay between frames and never enter JSON errors', async function (t) {
  const upstream = http.createServer(async function respond(request, response) {
    const body = JSON.parse((await readBody(request)).toString('utf8'));
    if (body.metadata?.test_case === 'json-error') {
      response.writeHead(429, {
        'content-type': 'application/json',
        'retry-after': '3',
      });
      response.flushHeaders();
      setTimeout(function finishJsonError() {
        response.end(JSON.stringify({
          type: 'error',
          error: { type: 'rate_limit_error', message: 'slow down' },
        }));
      }, 70);
      return;
    }
    if (body.metadata?.test_case === 'truncated-json') {
      response.writeHead(502, { 'content-type': 'application/json' });
      response.write('{"type":"error","error":{"type":"api_error"');
      setTimeout(() => response.destroy(), 20);
      return;
    }

    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.flushHeaders();
    response.write('event: message_start\ndata: {"type":"message_');
    setTimeout(function finishSseFrame() {
      response.end('start"}\n\n');
    }, 70);
  });
  const upstreamAddress = await listen(upstream);
  t.after(() => closeServer(upstream));

  const gateway = await startGateway(`http://127.0.0.1:${upstreamAddress.port}/`, {
    sseKeepaliveIntervalMs: 15,
  });
  t.after(() => gateway.runtime.close());

  const streamed = await fetch(`${gateway.url}/v1/messages?beta=true`, {
    method: 'POST',
    headers: gatewayHeaders(),
    body: JSON.stringify({
      model: TEST_MODEL,
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 16,
      stream: true,
    }),
  });
  assert.equal(streamed.status, 200);
  assert.match(streamed.headers.get('content-type') || '', /^text\/event-stream/iu);
  const streamedText = await streamed.text();
  assert.ok((streamedText.match(/event: ping/gu) || []).length >= 2, streamedText);
  assert.match(
    streamedText,
    /event: message_start\ndata: \{"type":"message_start"\}\n\n/u
  );
  assert.doesNotMatch(streamedText, /message_\s*event: ping/u);

  const jsonError = await fetch(`${gateway.url}/v1/messages`, {
    method: 'POST',
    headers: gatewayHeaders(),
    body: JSON.stringify({
      model: TEST_MODEL,
      messages: [{ role: 'user', content: 'hello' }],
      metadata: { test_case: 'json-error' },
      max_tokens: 16,
      stream: true,
    }),
  });
  assert.equal(jsonError.status, 429);
  assert.equal(jsonError.headers.get('retry-after'), '3');
  assert.match(jsonError.headers.get('content-type') || '', /^application\/json/iu);
  const jsonErrorText = await jsonError.text();
  assert.doesNotMatch(jsonErrorText, /event: ping/u);
  assert.deepEqual(JSON.parse(jsonErrorText), {
    type: 'error',
    error: { type: 'rate_limit_error', message: 'slow down' },
  });

  const truncatedBody = JSON.stringify({
    model: TEST_MODEL,
    messages: [{ role: 'user', content: 'hello' }],
    metadata: { test_case: 'truncated-json' },
    max_tokens: 16,
    stream: true,
  });
  const truncated = await rawPost(
    `${gateway.url}/v1/messages`,
    {
      ...gatewayHeaders(),
      'content-length': Buffer.byteLength(truncatedBody),
    },
    truncatedBody
  );
  assert.equal(truncated.status, 502);
  assert.equal(truncated.aborted, true);
  assert.match(truncated.headers['content-type'] || '', /^application\/json/iu);
  assert.doesNotMatch(truncated.body, /event:\s*error|data:\s*\{/u);
});
