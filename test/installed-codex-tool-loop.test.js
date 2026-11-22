import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { installedClaudePolicy, installedCodexPolicy } from './helpers/installed-cli-policy.js';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../js/cli/claude-workflow.js', import.meta.url));
const mcp = fileURLToPath(new URL('./fixtures/workflow-mcp.cjs', import.meta.url));
const claude = installedClaudePolicy();
const codex = installedCodexPolicy();

function findTool(value, original) {
  if (!value || typeof value !== 'object') return undefined;
  if (value.description?.startsWith?.('Claude Code tool name: ' + original + '.')) return value.name;
  for (const child of Object.values(value)) {
    const found = findTool(child, original);
    if (found) return found;
  }
}

function responseFrame(type, fields) {
  return 'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...fields }) + '\n\n';
}

function respondAsCoordinator(res, body, delegate, file, expectedModel, nativeEffort) {
  assert.equal(body.model, expectedModel);
  if (nativeEffort) assert.equal(body.output_config?.effort, nativeEffort, 'agent effort must not change the coordinator effort');
  assert.equal(body.stream, true);
  const agentId = 'toolu_native_worker';
  if (delegate) {
    assert.ok(body.tools.some(tool => tool.name === 'Agent'));
  } else {
    const result = body.messages.flatMap(m => Array.isArray(m.content) ? m.content : [])
      .find(block => block.type === 'tool_result' && block.tool_use_id === agentId);
    assert.ok(result && !result.is_error, 'coordinator must receive the successful Agent result');
    assert.match(JSON.stringify(result.content), /TOOL_LOOP_OK/u);
  }
  const block = delegate
    ? { type: 'tool_use', id: agentId, name: 'Agent', input: {} }
    : { type: 'text', text: '' };
  const delta = delegate
    ? { type: 'input_json_delta', partial_json: JSON.stringify({
        subagent_type: 'fixture-worker', description: 'Edit and record a marker',
        prompt: 'Read and edit the marker in ' + file + ', then record completion using MCP.',
        run_in_background: false,
      }) }
    : { type: 'text_delta', text: 'COORDINATOR_AGENT_OK' };
  const usage = { input_tokens: 100, output_tokens: 0 };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(responseFrame('message_start', { message: {
    id: delegate ? 'msg_delegate' : 'msg_resume', type: 'message', role: 'assistant',
    model: body.model, content: [], stop_reason: null, stop_sequence: null, usage,
  } }) + responseFrame('content_block_start', { index: 0, content_block: block }) +
    responseFrame('content_block_delta', { index: 0, delta }) + responseFrame('content_block_stop', { index: 0 }) +
    responseFrame('message_delta', { delta: { stop_reason: delegate ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } }) +
    responseFrame('message_stop', {}));
}

for (const { tier, search = false, coordinator, runnerEffort } of [
  { tier: 'sol' }, { tier: 'astra' }, { tier: 'sol', search: true },
  { tier: 'astra', coordinator: 'claude-fable-5-2' },
  { tier: 'astra', coordinator: 'claude-opus-5-5', runnerEffort: 'low' },
  { tier: 'astra', coordinator: 'claude-opus-5-5', runnerEffort: 'medium' },
]) {
  const nativeEffort = runnerEffort ? 'high' : null;
  test((coordinator ? coordinator + ' delegates Agent via both installed CLIs:' : 'both installed CLIs execute') +
    ' Read, Edit and MCP via GPT-6.2 ' + tier + (runnerEffort ? '/' + runnerEffort : '') +
    (search ? ' with inherited deferred MCP settings' : ''),
    { skip: claude.skip || codex.skip, timeout: 45_000 }, async t => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-codex-tool-loop-'));
      t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }));
      const model = 'gpt-6.2-' + tier;
      const file = path.join(dir, 'large.txt');
      const marker = path.join(dir, 'mcp-calls');
      const fixtureHome = path.join(dir, 'profile');
      const codexDir = path.join(fixtureHome, '.codex');
      await fs.mkdir(codexDir, { recursive: true, mode: 0o700 });
      if (search) {
        const claudeDir = path.join(fixtureHome, '.claude');
        await fs.mkdir(claudeDir, { recursive: true });
        await fs.writeFile(path.join(claudeDir, 'settings.json'), JSON.stringify({
          env: { ENABLE_TOOL_SEARCH: 'true', MCP_CONNECTION_NONBLOCKING: '1' },
        }));
      }
      const original = Array.from({ length: 12_000 }, (_, i) => i === 11_989 ? 'TAIL_MARKER' : 'line ' + (i + 1)).join('\n') + '\n';
      await fs.writeFile(file, original);
      const toolSteps = [
        ['Read', { file_path: file, offset: 11980, limit: 20 }],
        ['Edit', { file_path: file, old_string: 'TAIL_MARKER', new_string: 'CHANGED_MARKER' }],
        ['mcp__workflowfixture__record', { value: 'once' }],
      ];
      const requests = [];
      const turnOrder = [];
      let fixtureError;
      const upstream = http.createServer(async (req, res) => {
        try {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const raw = Buffer.concat(chunks);
          const decode = { br: brotliDecompressSync, gzip: gunzipSync }[req.headers['content-encoding']];
          const body = JSON.parse(decode ? decode(raw) : raw);
          if (coordinator && /^\/v1\/messages(?:\?|$)/u.test(req.url)) {
            const delegate = turnOrder.length === 0;
            turnOrder.push(delegate ? 'Agent' : 'resume');
            respondAsCoordinator(res, body, delegate, file, coordinator, nativeEffort);
            return;
          }
          assert.match(req.url, /\/responses(?:\?|$)/u);
          const step = requests.length;
          requests.push(body);
          turnOrder.push(step < toolSteps.length ? toolSteps[step][0] : 'agent answer');
          assert.ok(step <= toolSteps.length);
          assert.equal(body.model, model);
          if (runnerEffort) assert.equal(body.reasoning?.effort, runnerEffort, 'wrong effort sent to Codex');
          if (!step) {
            // 0.171 can declare schemas in input's additional_tools items
            // instead of the top-level tools array. Both are model-visible.
            assert.ok(findTool(body, 'mcp__workflowfixture__record'), 'MCP schema must be registered before inference');
            assert.equal(findTool(body, 'DeferredToolPlaceholder'), undefined);
          }
          if (step) {
            const previous = requests[step - 1].input;
            assert.deepEqual(body.input.slice(0, previous.length), previous, 'replayed input prefix changed');
            const output = body.input.find(i => i.type === 'function_call_output' && i.call_id === 'call_' + (step - 1));
            assert.ok(output, 'missing Claude tool result');
            const prior = toolSteps[step - 1][0];
            if (prior === 'Read') assert.match(JSON.stringify(output.output), /TAIL_MARKER/u);
            if (prior === 'mcp__workflowfixture__record') assert.match(JSON.stringify(output.output), /MCP_EXECUTED/u);
          }
          let item;
          if (step < toolSteps.length) {
            const [originalName, args] = toolSteps[step];
            const name = findTool(body, originalName);
            assert.ok(name, 'missing Claude schema for ' + originalName);
            item = { type: 'function_call', call_id: 'call_' + step, namespace: 'functions', name, arguments: JSON.stringify(args) };
          } else {
            item = { id: 'msg_final', type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'TOOL_LOOP_OK' }] };
          }
          const id = 'resp_' + step;
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(responseFrame('response.created', { response: { id, status: 'in_progress' } }) +
            responseFrame('response.output_item.done', { output_index: 0, item }) +
            responseFrame('response.completed', { response: { id, status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 12, total_tokens: 112 } } }));
        } catch (error) {
          fixtureError ||= error;
          res.writeHead(400);
          res.end(JSON.stringify({ error: { message: error.message } }));
        }
      });
      await new Promise((resolve, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', resolve); });
      t.after(() => { upstream.closeAllConnections(); return new Promise(resolve => upstream.close(resolve)); });
      const base = 'http://127.0.0.1:' + upstream.address().port + '/v1';
      await fs.writeFile(path.join(codexDir, 'config.toml'), 'model_provider = "fixture"\n[model_providers.fixture]\nname = "Loopback"\nbase_url = ' + JSON.stringify(base) + '\nenv_key = "WORKFLOW_FIXTURE_KEY"\nwire_api = "responses"\nsupports_websockets = false\n');
      await fs.writeFile(path.join(codexDir, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'synthetic-loopback' }), { mode: 0o600 });
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
        !/^(?:ANTHROPIC_|CLAUDE_|CODEX_|ULTRATHINK_|OPENAI_|KIMI_|QWEN_|DEEPSEEK_|ZAI_|GLM_)/u.test(k)));
      Object.assign(env, { HOME: fixtureHome, USERPROFILE: fixtureHome, CODEX_HOME: codexDir,
        CLAUDE_CONFIG_DIR: path.join(fixtureHome, '.claude'), WORKFLOW_FIXTURE_KEY: 'local-only',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ENABLE_TOOL_SEARCH: String(search),
        MCP_CONNECTION_NONBLOCKING: '1',
        NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' });
      if (coordinator) {
        Object.assign(env, {
          ULTRATHINK_GATEWAY_ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + upstream.address().port,
          ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY: 'synthetic-upstream',
          ULTRATHINK_GATEWAY_SHARED_SECRET: 'synthetic-gateway',
          CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
        });
        if (runnerEffort) {
          // Persist the public profile, then launch a separate process with no
          // model or reasoning env overrides. Assert both on the provider wire.
          await run(process.execPath, [cli, 'config', '--main', 'opus', '--agents', 'astra',
            '--effort', runnerEffort, '--context', 'long'], { cwd: dir, env, timeout: 10_000 });
        }
      } else {
        Object.assign(env, { ULTRATHINK_GATEWAY_MAIN_PROVIDER: 'codex', ULTRATHINK_GATEWAY_CODEX_MODEL: model,
          ULTRATHINK_GATEWAY_ANTHROPIC_PASSTHROUGH_MODELS: 'none',
          ...(tier === 'sol' ? { ULTRATHINK_GATEWAY_SUBAGENT_UPSTREAM_MODEL: 'gpt-6.2-astra' } : {}) });
      }
      const mcpConfig = JSON.stringify({ mcpServers: { workflowfixture: { command: process.execPath, args: [mcp, marker] } } });
      let stdout;
      try {
        const command = run(process.execPath, [cli, '--', '--print', 'Read and edit the marker in ' + file + ' and record completion.',
          '--strict-mcp-config', '--mcp-config', mcpConfig, '--output-format', 'json', '--tools', coordinator ? 'Agent,Read,Edit' : search ? 'Read,Edit,ToolSearch' : 'Read,Edit',
          ...(nativeEffort ? ['--effort', nativeEffort] : []),
          ...(coordinator ? ['--agents', JSON.stringify({ 'fixture-worker': {
            description: 'Update the specified file.', prompt: 'Use Read, Edit, and the provided MCP tool.',
          } })] : []),
          '--max-turns', '6'], { cwd: dir, env, timeout: 35_000, maxBuffer: 1024 * 1024 });
        command.child.stdin.end();
        ({ stdout } = await command);
      } catch (error) { throw fixtureError || error; }
      if (fixtureError) throw fixtureError;
      const result = JSON.parse(stdout.trim());
      assert.equal(result.is_error, false);
      assert.equal(result.result, coordinator ? 'COORDINATOR_AGENT_OK' : 'TOOL_LOOP_OK');
      assert.equal(requests.length, toolSteps.length + 1);
      if (coordinator) {
        assert.deepEqual(turnOrder, ['Agent', 'Read', 'Edit', 'mcp__workflowfixture__record', 'agent answer', 'resume']);
      }
      assert.equal(await fs.readFile(file, 'utf8'), original.replace('TAIL_MARKER', 'CHANGED_MARKER'));
      assert.equal(await fs.readFile(marker, 'utf8'), 'once\n');
    });
}
