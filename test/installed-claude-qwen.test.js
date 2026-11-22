import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { createGatewayServer } from '../js/gateway/server.js';
import {
  QWEN_MAIN_MODEL_ID,
  buildWorkflowClientEnv,
  buildWorkflowGatewayConfig,
  buildWorkflowModelPicker,
} from '../js/gateway/workflow-config.js';
import {
  buildClaudeSettingsOverrideEnvironment,
  createPrivateClaudeSettingsOverride,
  prepareClaudeThirdPartyModelSupport,
} from '../js/utils/claude-config.js';
import { installedClaudePolicy } from './helpers/installed-cli-policy.js';

const CLAUDE_CLI = installedClaudePolicy();
const QWEN_API_KEY = 'sk-sp-test-installed-claude-qwen-key';
const WORKFLOW_PREFIXES = Object.freeze([
  'ANTHROPIC_',
  'BAILIAN_',
  'CLAUDE_CODE_',
  'CLAUDE_WORKFLOW_',
  'CODEX_',
  'DASHSCOPE_',
  'DEEPSEEK_',
  'GLM_',
  'KIMI_',
  'OPENAI_',
  'QWEN_',
  'ULTRATHINK_',
  'ZAI_',
]);

function listen(server) {
  if (server.listening) {
    return Promise.resolve(server.address());
  }
  return new Promise(function waitForServer(resolve, reject) {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise(function closeServer(resolve, reject) {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function sse(data) {
  return `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
}

function streamAnswer(response, id, reasoning, text) {
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
  response.end(
    [
      sse({ id, choices: [{ delta: { reasoning_content: reasoning }, finish_reason: null }] }),
      sse({ id, choices: [{ delta: { content: text }, finish_reason: null }] }),
      sse({ id, choices: [{ delta: {}, finish_reason: 'stop' }] }),
      sse({ id, choices: [], usage: { prompt_tokens: 25, completion_tokens: 8 } }),
      sse('[DONE]'),
    ].join('')
  );
}

function streamToolUse(response, filePath) {
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
  response.end(
    [
      sse({
        id: 'chat_qwen_installed_tool',
        choices: [{ delta: { reasoning_content: 'inspect fixture' }, finish_reason: null }],
      }),
      sse({
        id: 'chat_qwen_installed_tool',
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_installed_read',
                  type: 'function',
                  function: { name: 'Read', arguments: JSON.stringify({ file_path: filePath }) },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      sse({
        id: 'chat_qwen_installed_tool',
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      }),
      sse({
        id: 'chat_qwen_installed_tool',
        choices: [],
        usage: { prompt_tokens: 30, completion_tokens: 10 },
      }),
      sse('[DONE]'),
    ].join('')
  );
}

function isolatedEnvironment(home, extra = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (WORKFLOW_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      delete env[name];
    }
  }
  return { ...env, HOME: home, USERPROFILE: home, ...extra };
}

async function withWorkflowEnvironment(updates, callback) {
  const previous = { ...process.env };
  for (const name of Object.keys(process.env)) {
    if (WORKFLOW_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      delete process.env[name];
    }
  }
  Object.assign(process.env, updates);
  try {
    return await callback();
  } finally {
    for (const name of Object.keys(process.env)) {
      delete process.env[name];
    }
    Object.assign(process.env, previous);
  }
}

function runClaude(args, options) {
  return new Promise(function run(resolve, reject) {
    const child = spawn('claude', args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(function terminateTimedOutClaude() {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1_000).unref();
    }, 30_000);
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
      resolve({ signal, status, stderr, stdout, timedOut });
    });
  });
}

test(
  'installed Claude accepts Qwen 3.8 Max with truthful context and preserves a streamed tool loop',
  { skip: CLAUDE_CLI.skip },
  async function (t) {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'claude-workflow-clean-qwen-'));
    const home = path.join(root, 'home');
    const claudeConfig = path.join(home, 'claude-config');
    const cwd = path.join(root, 'repo');
    const fixturePath = path.join(cwd, 'qwen fixture.txt');
    await fsp.mkdir(home);
    await fsp.mkdir(path.join(cwd, '.git'), { recursive: true });
    await fsp.writeFile(fixturePath, 'QWEN_FIXTURE_FIRST\nmiddle\nQWEN_FIXTURE_LAST\n');
    t.after(async () => fsp.rm(root, { recursive: true, force: true }));

    const requests = [];
    const upstream = http.createServer(async function fakeQwen(request, response) {
      const body = await readJsonBody(request);
      requests.push({ body, headers: request.headers, url: request.url });
      if (request.url !== '/compatible-mode/v1/chat/completions') {
        response.writeHead(404).end();
        return;
      }
      const hasToolResult = body.messages.some((message) => message.role === 'tool');
      const transcript = JSON.stringify(body.messages);
      if (transcript.includes('QWEN_INSTALLED_TOOL') && !hasToolResult) {
        streamToolUse(response, fixturePath);
        return;
      }
      streamAnswer(
        response,
        hasToolResult ? 'chat_qwen_installed_tool_done' : 'chat_qwen_installed_direct',
        hasToolResult ? 'verify result' : 'answer directly',
        hasToolResult ? 'CLEAN_HOME_QWEN_TOOL_OK' : 'CLEAN_HOME_QWEN_DIRECT_OK'
      );
    });
    const upstreamAddress = await listen(upstream);
    t.after(async () => close(upstream));

    const workflow = await withWorkflowEnvironment(
      {
        ULTRATHINK_GATEWAY_MAIN_MODEL_ID: QWEN_MAIN_MODEL_ID,
        ULTRATHINK_GATEWAY_MAIN_PROVIDER: 'qwen',
        ULTRATHINK_GATEWAY_QWEN_API_KEY: QWEN_API_KEY,
      },
      async function buildWorkflow() {
        return buildWorkflowGatewayConfig();
      }
    );
    workflow.config.port = 0;
    workflow.config.qwen.baseUrl =
      `http://127.0.0.1:${upstreamAddress.port}/compatible-mode/v1`;
    const runtime = createGatewayServer(workflow.config);
    await listen(runtime.server);
    t.after(async () => runtime.close());
    const gatewayAddress = runtime.server.address();
    assert.equal(typeof gatewayAddress, 'object');

    const managedClientEnv = buildWorkflowClientEnv(
      workflow.config,
      `http://127.0.0.1:${gatewayAddress.port}`,
      workflow.subagentModelId,
      workflow.mainModelId
    );
    const env = isolatedEnvironment(home, {
      ...Object.fromEntries(
        Object.entries(managedClientEnv).filter(([, value]) => value !== null)
      ),
      CLAUDE_CONFIG_DIR: claudeConfig,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      NO_PROXY: '127.0.0.1',
      no_proxy: '127.0.0.1',
    });
    assert.equal(env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE, '1');
    assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '784800');
    assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '828400');
    assert.equal(env.CLAUDE_CODE_EFFORT_LEVEL, 'max');
    assert.equal(env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK, '1');
    assert.equal(env.ANTHROPIC_CUSTOM_MODEL_OPTION, QWEN_MAIN_MODEL_ID);
    assert.equal(env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME, 'Qwen 3.8 Max Main Route');
    assert.equal(
      env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION,
      'qwen:qwen3.8-max/xhigh through claude-workflow'
    );
    assert.equal(
      env.ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES,
      'effort,xhigh_effort,max_effort,thinking,adaptive_thinking,interleaved_thinking'
    );
    assert.equal(Object.values(env).includes(QWEN_API_KEY), false);
    const prepared = prepareClaudeThirdPartyModelSupport(env);
    assert.equal(prepared.changed, false);
    assert.equal(prepared.stateChanged, false);
    assert.equal(prepared.settingsChanged, false);
    assert.equal(prepared.backupPath, null);
    await assert.rejects(fsp.access(prepared.path));
    const settingsOverride = createPrivateClaudeSettingsOverride(
      buildClaudeSettingsOverrideEnvironment(env, managedClientEnv),
      buildWorkflowModelPicker(
        workflow.config,
        workflow.mainModelId,
        workflow.subagentModelId
      )
    );
    t.after(() => settingsOverride.cleanup());

    async function prompt(text) {
      return runClaude(
        [
          '--print',
          '--output-format',
          'json',
          '--model',
          QWEN_MAIN_MODEL_ID,
          '--effort',
          'max',
          '--settings',
          settingsOverride.path,
          '--dangerously-skip-permissions',
          text,
        ],
        { cwd, env }
      );
    }

    const direct = await prompt('Reply with exactly CLEAN_HOME_QWEN_DIRECT_OK.');
    assert.equal(direct.timedOut, false, direct.stderr || direct.stdout);
    assert.equal(direct.signal, null, direct.stderr || direct.stdout);
    assert.equal(direct.status, 0, direct.stderr || direct.stdout);
    assert.match(direct.stdout, /CLEAN_HOME_QWEN_DIRECT_OK/u);
    assert.equal(requests.length, 1, 'terminal-title traffic must not add a second model call');

    const tool = await prompt(
      'QWEN_INSTALLED_TOOL: use Read on the requested fixture, then reply exactly CLEAN_HOME_QWEN_TOOL_OK.'
    );
    assert.equal(tool.timedOut, false, tool.stderr || tool.stdout);
    assert.equal(tool.signal, null, tool.stderr || tool.stdout);
    assert.equal(tool.status, 0, tool.stderr || tool.stdout);
    assert.match(tool.stdout, /CLEAN_HOME_QWEN_TOOL_OK/u);
    assert.equal(requests.length, 3, 'one tool result requires exactly one continuation turn');

    for (const entry of requests) {
      assert.equal(entry.url, '/compatible-mode/v1/chat/completions');
      assert.equal(entry.headers.authorization, `Bearer ${QWEN_API_KEY}`);
      assert.equal(entry.body.model, 'qwen3.8-max');
      assert.equal(entry.body.reasoning_effort, 'xhigh');
      assert.equal(entry.body.enable_thinking, true);
      assert.equal(entry.body.preserve_thinking, true);
    }
    const toolStart = requests[1].body;
    assert.equal(toolStart.tool_stream, true);
    assert.equal(toolStart.parallel_tool_calls, true);
    assert.equal(toolStart.tools.some((candidate) => candidate.function?.name === 'Read'), true);
    const toolContinuation = requests[2].body;
    const assistant = toolContinuation.messages.find((message) => message.role === 'assistant');
    const result = toolContinuation.messages.find((message) => message.role === 'tool');
    assert.equal(assistant.reasoning_content, 'inspect fixture');
    assert.match(result.content, /QWEN_FIXTURE_FIRST/u);
    assert.match(result.content, /QWEN_FIXTURE_LAST/u);
  }
);
