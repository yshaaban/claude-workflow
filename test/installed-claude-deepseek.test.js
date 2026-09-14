import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { loadGatewayConfig } from '../js/gateway/config.js';
import { installedCliPolicy } from './helpers/installed-cli-policy.js';

const CLI = fileURLToPath(new URL('../js/cli/claude-workflow.js', import.meta.url));
const LIVE = process.env.CLAUDE_WORKFLOW_LIVE_DEEPSEEK === '1';
const CLAUDE = installedCliPolicy({ command: 'claude', displayName: 'Claude Code' });
const profile = LIVE ? loadGatewayConfig().deepseek : { apiKey: 'test-deepseek-key' };
const PREFIX = /^(?:ANTHROPIC_|BAILIAN_|CLAUDE_|CODEX_|DASHSCOPE_|DEEPSEEK_|GLM_|KIMI_|OPENAI_|QWEN_|ULTRATHINK_|ZAI_)/u;

function streamReply(response, { text, tool }) {
  const frame = (value) => `data: ${JSON.stringify(value)}\n\n`;
  const chunk = (delta, finish_reason = null, usage) => ({
    id: 'deepseek-test', model: 'deepseek-flash',
    choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}),
  });
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end([
    frame(chunk({ reasoning_content: 'Preserved reasoning for this turn.' })),
    frame(chunk(tool ? { tool_calls: [{ index: 0, id: 'read_fixture', type: 'function',
      function: { name: 'Read', arguments: JSON.stringify({ file_path: tool }) } }] } : { content: text })),
    // DeepSeek puts usage on the finish chunk, not a separate usage-only frame.
    frame(chunk({}, tool ? 'tool_calls' : 'stop', { prompt_tokens: 30, completion_tokens: 12 })),
    'data: [DONE]\n\n',
  ].join(''));
}

function runWorkflow(args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, '--', ...args], {
      cwd, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1000).unref();
    }, LIVE ? 150_000 : 40_000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

test('DeepSeek V4.1 through installed Claude Workflow: stream, tool execution, and resumed thinking',
  { skip: CLAUDE.skip, timeout: LIVE ? 480_000 : 150_000 }, async (t) => {
    if (LIVE) assert.ok(profile.apiKey, 'A DeepSeek API key is required for the live test');
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'workflow-deepseek-'));
    t.after(() => fsp.rm(root, { recursive: true, force: true }));
    const cwd = path.join(root, 'repo');
    const home = path.join(root, 'home');
    const bin = path.join(root, 'bin');
    await Promise.all([fsp.mkdir(cwd), fsp.mkdir(home), fsp.mkdir(bin)]);
    await fsp.mkdir(path.join(cwd, '.git'));
    const fixture = path.join(cwd, 'deepseek fixture.txt');
    await fsp.writeFile(fixture, 'DEEPSEEK_FIXTURE_7239\nvalue=before\n');
    const image = path.join(cwd, 'red.png');
    await fsp.writeFile(image, Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC', 'base64'));
    // No Codex inference is in scope. Stub only the prerequisite check; Claude
    // and the complete Workflow launcher/gateway run as installed processes.
    await fsp.writeFile(path.join(bin, 'codex'),
      '#!/usr/bin/env node\n' +
      'if(process.argv.includes("--version")) console.log("codex-cli 0.153.4");\n' +
      'else if(process.argv[2]==="login" && process.argv[3]==="status") console.log("Logged in using ChatGPT");\n' +
      'else process.exit(1);\n', { mode: 0o700 });

    const requests = [];
    const replies = [];
    const upstream = http.createServer(async (req, res) => {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const raw = Buffer.concat(chunks);
        const body = JSON.parse(raw.toString());
        requests.push(body);
        assert.equal(req.url, '/chat/completions');
        assert.equal(req.headers.authorization, `Bearer ${profile.apiKey}`);
        assert.ok(requests.length <= 12, 'Live test request budget exceeded');
        if (LIVE) {
          // Fixed official destination; credentials and prompts never go to a
          // caller-configured host during this opt-in public-provider test.
          const response = await fetch('https://api.deepseek.com/chat/completions', {
            method: 'POST', headers: { 'content-type': 'application/json',
              authorization: `Bearer ${profile.apiKey}` }, body: raw,
            signal: AbortSignal.timeout(120_000),
          });
          replies.push(response.clone().text().then((text) => {
            const result = { reasoning: '', content: '', toolIds: [] };
            for (const line of text.split('\n')) {
              if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
              const delta = JSON.parse(line.slice(6)).choices?.[0]?.delta;
              result.reasoning += delta?.reasoning_content || '';
              result.content += delta?.content || '';
              for (const tool of delta?.tool_calls || []) if (tool.id) result.toolIds.push(tool.id);
            }
            return result;
          }));
          res.writeHead(response.status, {
            'content-type': response.headers.get('content-type') || 'application/json',
          });
          Readable.fromWeb(response.body).on('error', () => res.destroy()).pipe(res);
          return;
        }
        const transcript = JSON.stringify(body.messages);
        const hasResult = body.messages.some((message) => message.role === 'tool');
        const wantsTool = transcript.includes('DEEPSEEK_USE_READ');
        streamReply(res, wantsTool && !hasResult ? { tool: fixture } : {
          text: wantsTool ? 'DEEPSEEK_FIXTURE_7239' : 'DEEPSEEK_DIRECT_OK',
        });
      } catch (error) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
      }
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => {
      upstream.closeAllConnections();
      upstream.close(resolve);
    }));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !PREFIX.test(key)));
    Object.assign(env, {
      HOME: home, USERPROFILE: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8192',
      // A stale Claude setting must not lower DeepSeek's provider-side default.
      CLAUDE_CODE_EFFORT_LEVEL: 'low',
      ULTRATHINK_GATEWAY_MAIN_PROVIDER: 'deepseek',
      ULTRATHINK_GATEWAY_MAIN_MODEL_ID: 'deepseek-flash',
      ULTRATHINK_GATEWAY_MAIN_UPSTREAM_MODEL: 'deepseek-flash',
      ULTRATHINK_GATEWAY_DEEPSEEK_API_KEY: profile.apiKey,
      ULTRATHINK_GATEWAY_DEEPSEEK_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
      ULTRATHINK_GATEWAY_CODEX_COMMAND: path.join(bin, 'codex'),
      NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1',
    });
    const prompt = async (text, args = []) => {
      const result = await runWorkflow([text, '--print', '--output-format', 'json',
        '--max-turns', '6', '--tools', 'Read,Edit', ...args], cwd, env);
      assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
      const answer = JSON.parse(result.stdout.trim());
      assert.equal(answer.is_error, false, answer.result);
      return answer;
    };

    const direct = await prompt(LIVE
      ? 'Without tools, calculate the sum of the squares of the integers 1 through 19. Check your arithmetic, then reply DEEPSEEK_DIRECT_OK and the result.'
      : 'Do not use tools. Reply exactly DEEPSEEK_DIRECT_OK.');
    assert.match(direct.result, /DEEPSEEK_DIRECT_OK/u);
    assert.equal(requests.length, 1, 'No extra title or response-rewriting model call');
    const beforeResume = requests.length;
    const tool = await prompt(
      `DEEPSEEK_USE_READ: Read ${fixture} and report its first line. ` +
      (LIVE ? 'Also use Edit to change value=before to value=after. ' : '') +
      'Do not delegate or use agents.', ['--resume', direct.session_id]);
    assert.match(tool.result, /DEEPSEEK_FIXTURE_7239/u);
    assert.ok(requests.length >= beforeResume + 2, 'Read requires a model/tool continuation');
    if (!LIVE) assert.equal(requests.length, 3);
    const resumedAssistant = requests[beforeResume].messages.find((m) => m.role === 'assistant');
    if (LIVE) {
      // DeepSeek can legitimately emit no reasoning for a trivial prompt.
      // Compare what it actually returned instead of requiring invented text.
      assert.equal(resumedAssistant.reasoning_content || '', (await replies[0]).reasoning,
        'No-tool thinking survives a new gateway process unchanged');
    } else {
      assert.equal(resumedAssistant.reasoning_content, 'Preserved reasoning for this turn.');
    }
    const continuation = requests.find((body) => body.messages.some((m) => m.role === 'tool'));
    assert.ok(continuation, 'Claude must execute a real tool');
    if (LIVE) {
      const outputs = await Promise.all(replies);
      for (const message of continuation.messages.filter((m) => m.role === 'assistant')) {
        const output = outputs.find((candidate) => message.tool_calls?.length
          ? candidate.toolIds.includes(message.tool_calls[0].id)
          : candidate.content === message.content);
        assert.ok(output, 'Assistant history must come from an upstream response');
        assert.equal(message.reasoning_content || '', output.reasoning);
      }
    } else {
      assert.ok(continuation.messages.filter((m) => m.role === 'assistant')
        .every((m) => m.reasoning_content === 'Preserved reasoning for this turn.'));
    }
    assert.match(JSON.stringify(continuation.messages), /DEEPSEEK_FIXTURE_7239/u);
    for (const body of requests) {
      assert.equal(body.model, 'deepseek-flash');
      assert.equal(body.reasoning_effort, 'max');
      assert.equal(body.thinking.type, 'enabled');
      assert.equal(body.stream, true);
      assert.ok(body.max_tokens <= 393_216);
    }
    if (LIVE) {
      assert.match(await fsp.readFile(fixture, 'utf8'), /value=after/u);
      const vision = await prompt(`Use Read on ${image}. Report the dominant color. Do not delegate.`);
      assert.match(vision.result, /red/iu);
      assert.ok(requests.some((body) => body.messages.some((message) =>
        message.role === 'tool' && Array.isArray(message.content) &&
        message.content.some((block) => block.type === 'image_url'))), 'Image tool output reaches DeepSeek');
      await Promise.all(replies);
    }
    t.diagnostic(`${LIVE ? 'LIVE' : 'Controlled upstream'}: ${requests.length} requests; ${CLAUDE.version}`);
  });
