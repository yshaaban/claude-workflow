import assert from 'node:assert/strict';
import test from 'node:test';
import { loadGatewayConfig } from '../js/gateway/config.js';
import { resolveModelRoute } from '../js/gateway/model-routing.js';
import { DEEPSEEK_FLASH_DEFAULTS } from '../js/gateway/provider-profiles.js';
import { translateAnthropicMessagesRequestWithOptions, translateOpenAiResponseToAnthropic } from '../js/gateway/anthropic-format.js';
import { buildWorkflowGatewayConfig, buildWorkflowClientEnv, buildWorkflowModelPicker } from '../js/gateway/workflow-config.js';
import { environmentWithoutGatewayCredentials } from '../js/utils/child-env.js';

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
}));
