import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { loadGatewayConfig } from '../js/gateway/config.js';
import { resolveModelRoute } from '../js/gateway/model-routing.js';
import { DEEPSEEK_FLASH_DEFAULTS } from '../js/gateway/provider-profiles.js';
import { translateAnthropicMessagesRequestWithOptions, translateOpenAiResponseToAnthropic } from '../js/gateway/anthropic-format.js';
import { buildWorkflowGatewayConfig, buildWorkflowClientEnv, buildWorkflowModelPicker } from '../js/gateway/workflow-config.js';
import { environmentWithoutGatewayCredentials } from '../js/utils/child-env.js';
import { createGatewayServer } from '../js/gateway/server.js';

function isolated(updates, callback) {
  const original = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) {
      if (/^(?:ANTHROPIC_|CLAUDE_|CODEX_|DEEPSEEK_|ULTRATHINK_)/u.test(key)) delete process.env[key];
    }
    Object.assign(process.env, updates);
    return callback();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, original);
  }
}

const env = { DEEPSEEK_API_KEY: 'test-only-deepseek', ULTRATHINK_GATEWAY_MAIN_PROVIDER: 'deepseek' };
const request = {
  model: 'deepseek-flash', max_tokens: 500_000,
  messages: [{ role: 'user', content: 'Hello' }],
  tools: [{ name: 'Read', input_schema: { type: 'object', properties: {} } }],
};

test('DeepSeek V4.1 has truthful identity, bounded context, protected client credentials, and no session effort override', () => isolated(env, () => {
  const workflow = buildWorkflowGatewayConfig();
  const route = resolveModelRoute(workflow.mainModelId, workflow.config);
  assert.equal(workflow.mainModelId, 'deepseek-flash');
  assert.equal(route.upstreamModel, DEEPSEEK_FLASH_DEFAULTS.model);
  assert.equal(route.contextTokens, 1_000_000);
  assert.equal(route.maxOutputTokens, 393_216);
  assert.equal(route.reasoningEffort, 'max');
  assert.equal(route.emitReasoningContent, true);
  assert.ok(workflow.config.sharedSecret);
  const client = buildWorkflowClientEnv(workflow.config, 'http://127.0.0.1:1', workflow.subagentModelId, workflow.mainModelId);
  assert.equal(client.CLAUDE_CODE_EFFORT_LEVEL, null);
  assert.equal(client.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '828400');
  assert.equal(client.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '784800');
  assert.equal(client.CLAUDE_CODE_DISABLE_TERMINAL_TITLE, '1');
  assert.match(client.ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES, /interleaved_thinking/u);
  assert.equal(buildWorkflowModelPicker(workflow.config, workflow.mainModelId, workflow.subagentModelId).options[0].label, 'DeepSeek V4.1 Flash');
  assert.equal(environmentWithoutGatewayCredentials({ DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY }).DEEPSEEK_API_KEY, undefined);
}));

test('DeepSeek caps input/output configuration and preserves explicit older Pro routing', () => isolated({ ...env,
  ULTRATHINK_GATEWAY_DEEPSEEK_CONTEXT_TOKENS: '2000000',
  ULTRATHINK_GATEWAY_DEEPSEEK_MAX_OUTPUT_TOKENS: '900000',
}, () => {
  const config = loadGatewayConfig();
  assert.equal(config.deepseek.contextTokens, 1_000_000);
  assert.equal(config.deepseek.maxOutputTokens, 393_216);
  config.routeMap = { pro: { provider: 'deepseek', model: 'deepseek-v4-pro' } };
  assert.equal(resolveModelRoute('pro', config).upstreamModel, 'deepseek-v4-pro');
}));

test('DeepSeek honors a smaller configured context across Claude and the gateway', () => isolated({ ...env,
  ULTRATHINK_GATEWAY_DEEPSEEK_CONTEXT_TOKENS: '262144',
}, () => {
  const { config, mainModelId, subagentModelId } = buildWorkflowGatewayConfig();
  const client = buildWorkflowClientEnv(config, 'http://127.0.0.1:1', subagentModelId, mainModelId);
  assert.equal(client.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '262144');
  assert.equal(client.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '262144');
}));

test('DeepSeek context/output limits handle blank, invalid, fractional and nonpositive settings', () => {
  for (const [input, expected] of [['', null], ['not-a-number', null], ['Infinity', null], ['0', 1], ['-1', 1], ['8192.9', 8192]]) {
    isolated({ ...env, ULTRATHINK_GATEWAY_DEEPSEEK_CONTEXT_TOKENS: input,
      ULTRATHINK_GATEWAY_DEEPSEEK_MAX_OUTPUT_TOKENS: input }, () => {
      const config = loadGatewayConfig();
      assert.equal(config.deepseek.contextTokens, expected ?? DEEPSEEK_FLASH_DEFAULTS.contextTokens);
      assert.equal(config.deepseek.maxOutputTokens, expected ?? DEEPSEEK_FLASH_DEFAULTS.maxOutputTokens);
    });
  }
});

test('DeepSeek translates images and tool choices without losing caller intent', () => isolated(env, () => {
  const workflow = buildWorkflowGatewayConfig();
  const route = resolveModelRoute(workflow.mainModelId, workflow.config);
  for (const type of ['auto', 'none']) {
    const result = translateAnthropicMessagesRequestWithOptions({ ...request, tool_choice: { type } }, route);
    assert.equal(result.tool_choice, type);
    assert.equal(result.max_tokens, 393_216);
  }
  for (const choice of [{ type: 'any' }, { type: 'tool', name: 'Read' }]) {
    assert.throws(() => translateAnthropicMessagesRequestWithOptions({ ...request, tool_choice: choice }, route), /DeepSeek.*auto or none/u);
  }
  const result = translateAnthropicMessagesRequestWithOptions({ ...request, messages: [{ role: 'user', content: [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'test' } },
    { type: 'image', source: { type: 'url', url: 'https://example.com/image.png' } },
  ] }] }, route);
  assert.equal(result.messages[0].content[0].image_url.url, 'data:image/png;base64,test');
  assert.equal(result.messages[0].content[1].image_url.url, 'https://example.com/image.png');
  const imageToolRequest = { ...request, messages: [{ role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'read_image', content: [
      { type: 'text', text: 'Read image' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'test' } },
    ] },
  ] }] };
  const imageTool = translateAnthropicMessagesRequestWithOptions(imageToolRequest, route);
  assert.equal(imageTool.messages[0].role, 'tool');
  assert.equal(imageTool.messages[0].content[1].image_url.url, 'data:image/png;base64,test');
  assert.throws(() => translateAnthropicMessagesRequestWithOptions(imageToolRequest,
    { ...route, supportsToolResultImages: false }), /unsupported tool_result/u);
  const disabled = { ...route, thinking: { type: 'disabled' }, toolChoicePolicy: '' };
  const withoutThinking = translateAnthropicMessagesRequestWithOptions({ ...request, tool_choice: { type: 'any' } }, disabled);
  assert.equal(withoutThinking.tool_choice, 'required');
  assert.equal(withoutThinking.reasoning_effort, undefined);
}));

test('DeepSeek non-stream thinking survives a completed no-tool turn without a cache', () => isolated(env, () => {
  const workflow = buildWorkflowGatewayConfig();
  const route = resolveModelRoute(workflow.mainModelId, workflow.config);
  const options = { preserveAssistantThinking: true, emitReasoningContent: true, strictThinkingReplay: true, providerLabel: 'DeepSeek' };
  const answer = translateOpenAiResponseToAnthropic({ choices: [{ message: {
    content: 'done', reasoning_content: 'unchanged reasoning' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 25, completion_tokens: 10 },
  }, 'deepseek-flash', 'test', options);
  const continued = translateAnthropicMessagesRequestWithOptions({ ...request, messages: [
    request.messages[0], { role: 'assistant', content: answer.content }, { role: 'user', content: 'continue' },
  ] }, route, options);
  assert.equal(continued.messages[1].reasoning_content, 'unchanged reasoning');
  assert.throws(() => translateAnthropicMessagesRequestWithOptions({ ...request, messages: [
    { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'opaque' }] },
  ] }, route, options), /DeepSeek cannot replay redacted_thinking/u);
  assert.throws(() => translateAnthropicMessagesRequestWithOptions({ ...request, messages: [
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'one' }, { type: 'thinking', thinking: 'two' }] },
  ] }, route, options), /DeepSeek.*multiple thinking blocks/u);
}));

test('DeepSeek defaults missing thinking/effort, normalizes API aliases, and rejects invalid settings', () => isolated(env, () => {
  const config = loadGatewayConfig();
  config.routeMap = { 'deepseek-flash': { provider: 'deepseek', model: 'deepseek-flash' } };
  delete config.deepseek.thinking;
  delete config.deepseek.reasoningEffort;
  let route = resolveModelRoute('deepseek-flash', config);
  assert.deepEqual(route.thinking, { type: 'enabled' });
  assert.equal(route.reasoningEffort, 'max');
  const levels = { '': 'max', ' MAX ': 'max', minimal: 'low', low: 'low', medium: 'high', high: 'high', xhigh: 'high', ultra: 'max', none: 'none' };
  for (const [input, expected] of Object.entries(levels)) {
    config.deepseek.reasoningEffort = input;
    route = resolveModelRoute('deepseek-flash', config);
    const body = translateAnthropicMessagesRequestWithOptions(request, route);
    assert.equal(route.reasoningEffort, expected, input);
    assert.equal(body.thinking.type, expected === 'none' ? 'disabled' : 'enabled', input);
    assert.equal(body.reasoning_effort, expected === 'none' ? undefined : expected, input);
    assert.equal(route.toolChoicePolicy, expected === 'none' ? '' : 'auto-none');
  }
  config.deepseek.reasoningEffort = 'maximum';
  assert.throws(() => resolveModelRoute('deepseek-flash', config), /DeepSeek.*reasoning effort/u);
  config.deepseek.reasoningEffort = 'max';
  config.deepseek.thinking = { type: 'adaptive' };
  assert.throws(() => resolveModelRoute('deepseek-flash', config), /DeepSeek.*thinking.*enabled or disabled/u);
}));

test('DeepSeek effort precedence, explicit OFF, and Claude session effort stay independent', () => isolated({
  ...env, ULTRATHINK_DEEPSEEK_REASONING_EFFORT: 'low',
  ULTRATHINK_GATEWAY_DEEPSEEK_REASONING_EFFORT: 'high',
  ULTRATHINK_GATEWAY_MAIN_REASONING_EFFORT: 'max',
  CLAUDE_CODE_EFFORT_LEVEL: 'low',
}, () => {
  let workflow = buildWorkflowGatewayConfig();
  assert.equal(workflow.config.deepseek.reasoningEffort, 'high');
  assert.equal(resolveModelRoute(workflow.mainModelId, workflow.config).reasoningEffort, 'max');
  assert.equal(buildWorkflowClientEnv(workflow.config, 'http://127.0.0.1:1', workflow.subagentModelId, workflow.mainModelId).CLAUDE_CODE_EFFORT_LEVEL, null);
  workflow.config.routeMap.custom = { provider: 'deepseek', model: 'deepseek-flash', reasoning_effort: 'low' };
  assert.equal(resolveModelRoute('custom', workflow.config).reasoningEffort, 'low');
  process.env.ULTRATHINK_THINKING_LEVEL = 'OFF';
  workflow = buildWorkflowGatewayConfig();
  const body = translateAnthropicMessagesRequestWithOptions(request, resolveModelRoute(workflow.mainModelId, workflow.config));
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.reasoning_effort, undefined);
  workflow.config.routeMap.custom = { provider: 'deepseek', model: 'deepseek-flash',
    thinking: { type: 'enabled' }, reasoningEffort: 'max' };
  assert.equal(resolveModelRoute('custom', workflow.config).thinking.type, 'enabled',
    'an explicit route-map thinking setting overrides the provider profile');
}));

const frame = (delta = {}, finish = null) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`;
const toolDelta = { tool_calls: [{ index: 0, id: 'call_partial', type: 'function', function: { name: 'Read', arguments: '{"path":' } }] };

async function httpFixture(t, reply) {
  const captured = [];
  const upstream = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    captured.push(JSON.parse(body));
    await reply(res);
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => new Promise((resolve) => { upstream.closeAllConnections(); upstream.close(resolve); }));
  const config = isolated(env, () => buildWorkflowGatewayConfig().config);
  config.port = 0;
  config.host = '127.0.0.1';
  config.deepseek.baseUrl = `http://127.0.0.1:${upstream.address().port}`;
  const runtime = createGatewayServer(config);
  if (!runtime.server.listening) await once(runtime.server, 'listening');
  t.after(() => runtime.close());
  return {
    captured,
    async send(stream = true) {
      return fetch(`http://127.0.0.1:${runtime.server.address().port}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.sharedSecret}` },
        body: JSON.stringify({ ...request, stream }), signal: AbortSignal.timeout(10_000),
      });
    },
  };
}

test('DeepSeek streaming fails closed on incomplete or unsuccessful upstream responses', async (t) => {
  const cases = {
    'empty stream': '',
    'clean EOF with buffered tool': frame(toolDelta),
    'DONE without finish': frame(toolDelta) + 'data: [DONE]\n\n',
    'finish without DONE': frame({ content: 'partial' }, 'stop'),
    'malformed JSON': 'data: {broken}\n\n' + frame({}, 'stop') + 'data: [DONE]\n\n',
    'truncated frame': 'data: {"choices":',
    'provider error frame': 'data: {"error":{"message":"provider failure"}}\n\n' + frame({}, 'stop') + 'data: [DONE]\n\n',
    'resource interruption': frame(toolDelta) + frame({}, 'insufficient_system_resource') + 'data: [DONE]\n\n',
    'aborted generation': frame(toolDelta) + frame({}, 'aborted') + 'data: [DONE]\n\n',
    'unknown finish': frame({}, 'new_failure') + 'data: [DONE]\n\n',
    'invalid tool arguments': frame(toolDelta, 'tool_calls') + 'data: [DONE]\n\n',
    'length with incomplete tool': frame(toolDelta, 'length') + 'data: [DONE]\n\n',
    'tool finish without tools': frame({}, 'tool_calls') + 'data: [DONE]\n\n',
    'array tool arguments': frame({ tool_calls: [{ ...toolDelta.tool_calls[0], function: { name: 'Read', arguments: '[]' } }] }, 'tool_calls') + 'data: [DONE]\n\n',
    'invalid second tool must withhold the first': frame({ tool_calls: [
      { ...toolDelta.tool_calls[0], function: { name: 'Read', arguments: '{}' } },
      { ...toolDelta.tool_calls[0], index: 1, id: 'call_invalid' },
    ] }, 'tool_calls') + 'data: [DONE]\n\n',
  };
  for (const [name, data] of Object.entries(cases)) {
    await t.test(name, async (t) => {
      const fixture = await httpFixture(t, (res) => { res.setHeader('content-type', 'text/event-stream'); res.end(data); });
      const response = await fixture.send();
      const text = await response.text();
      assert.match(text, /"type":"(?:error|api_error)"/u, text);
      assert.doesNotMatch(text, /event: message_stop|"type":"tool_use"/u);
      assert.equal(fixture.captured.length, 1, 'the gateway must not retry inference');
    });
  }
});

test('DeepSeek JSON validates complete tool batches before exposing them', async (t) => {
  const valid = { id: 'call_valid', type: 'function', function: { name: 'Read', arguments: '{}' } };
  for (const [name, finish, tools, expected] of [
    ['valid tools', 'tool_calls', [valid], 200],
    ['missing tools', 'tool_calls', [], 502],
    ['truncated tools', 'length', [valid], 502],
    ['missing name', 'tool_calls', [{ ...valid, function: { arguments: '{}' } }], 502],
    ['malformed arguments', 'tool_calls', [valid, { ...valid, function: { name: 'Read', arguments: '{' } }], 502],
    ['invalid tool list', 'tool_calls', {}, 502],
  ]) {
    await t.test(name, async (t) => {
      const fixture = await httpFixture(t, (res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: tools }, finish_reason: finish }] }));
      });
      const response = await fixture.send(false);
      assert.equal(response.status, expected);
      if (expected === 502) assert.doesNotMatch(await response.text(), /"type":"tool_use"/u);
    });
  }
});

test('DeepSeek accepts fragmented UTF-8/CRLF SSE, multiline data, usage, tools and length stops', async (t) => {
  for (const finish of ['stop', 'length', 'tool_calls']) {
    await t.test(finish, async (t) => {
      const tool = { tool_calls: [{ ...toolDelta.tool_calls[0], function: { name: 'Read', arguments: '{"path":"a"}' } }] };
      const content = finish === 'tool_calls' ? tool : { reasoning_content: 'فكرة', content: '你好' };
      const data = ': ping\r\n\r\n' + frame(content).replaceAll('data: ', 'data:').replaceAll('\n', '\r\n')
        + frame({}, finish) + 'data: {"choices": [],\ndata: "usage":{"prompt_tokens":7,"completion_tokens":9}}\n\n'
        + 'data: [DONE]\n\n';
      const fixture = await httpFixture(t, async (res) => {
        res.setHeader('content-type', 'text/event-stream');
        for (const byte of Buffer.from(data)) {
          res.write(Buffer.from([byte]));
          await new Promise((resolve) => setImmediate(resolve));
        }
        res.end();
      });
      const response = await fixture.send();
      const text = await response.text();
      assert.equal(response.status, 200);
      assert.doesNotMatch(text, /event: error/u);
      assert.match(text, /event: message_stop/u);
      assert.match(text, /"input_tokens":7,"output_tokens":9/u);
      assert.match(text, new RegExp(`"stop_reason":"${{ stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use' }[finish]}"`, 'u'));
      if (finish !== 'tool_calls') { assert.match(text, /فكرة/u); assert.match(text, /你好/u); }
      assert.equal(fixture.captured[0].reasoning_effort, 'max');
      assert.deepEqual(fixture.captured[0].thinking, { type: 'enabled' });
    });
  }
});

test('DeepSeek JSON reports unsuccessful or missing finish reasons as upstream failures', async (t) => {
  for (const finish of ['insufficient_system_resource', 'aborted', 'new_failure', null, 'stop', 'length']) {
    await t.test(String(finish), async (t) => {
      const fixture = await httpFixture(t, (res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: 'answer' }, finish_reason: finish }] }));
      });
      const response = await fixture.send(false);
      assert.equal(response.status, ['stop', 'length'].includes(finish) ? 200 : 502);
      assert.equal(fixture.captured.length, 1);
    });
  }
});

test('DeepSeek preserves upstream HTTP failures without extra inference requests', async (t) => {
  for (const status of [401, 429, 503]) {
    await t.test(String(status), async (t) => {
      const fixture = await httpFixture(t, (res) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'api_error', message: 'Synthetic upstream error' } }));
      });
      for (const stream of [false, true]) {
        const response = await fixture.send(stream);
        assert.equal(response.status, status);
        assert.equal((await response.json()).error.message, 'Synthetic upstream error');
      }
      assert.equal(fixture.captured.length, 2, 'one upstream call per client request');
    });
  }
});
