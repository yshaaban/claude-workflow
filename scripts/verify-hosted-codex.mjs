// Opt-in: two real model turns per tier using the caller's existing Codex login.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../js/cli/claude-workflow.js', import.meta.url));
const models = ['gpt-6.2-sol', 'gpt-6.2-astra'];

// Failure output can contain endpoint URLs, key hints, or full request text.
// Report only categorical findings; never print raw subprocess output or traces.
function failureReason(text, timedOut) {
  if (/error_max_turns/iu.test(text)) return 'Claude reached the turn limit';
  if (/is not logged in|not authenticated|unauthorized|\b401\b/iu.test(text)) return 'authentication rejected';
  if (/not available|not supported|not found|do not have access|not authorized|forbidden|\b403\b/iu.test(text)) {
    return 'model, permission or configuration unavailable';
  }
  if (/rate limit|quota|usage limit|\b429\b/iu.test(text)) return 'provider rate or usage limit';
  if (/stream disconnected|error sending request|network|connect error|connection reset/iu.test(text)) return 'provider connection failed';
  if (/server_error|internal server error|\b50[0234]\b/iu.test(text)) return 'server error';
  return timedOut ? 'timed out' : 'turn did not complete';
}

async function verify(model) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-workflow-live-'));
  try {
    const home = path.join(temporary, 'home');
    const cwd = path.join(temporary, 'workspace');
    const trace = path.join(temporary, 'trace');
    await Promise.all([home, cwd, trace].map(dir => fs.mkdir(dir, { mode: 0o700 })));
    const nonce = randomUUID();
    const file = path.join(await fs.realpath(cwd), 'nonce.txt');
    await fs.writeFile(file, nonce + '\n', { mode: 0o600 });
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      /^(PATH|PATHEXT|SystemRoot|ComSpec|LANG|LC_ALL|TMPDIR|TEMP|TMP|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR)$/iu.test(key)));
    Object.assign(env, {
      HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      // Use the native credential store. Do not copy, print or modify credentials.
      CODEX_HOME: path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex')),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_MAX_RETRIES: '0',
      ENABLE_TOOL_SEARCH: 'false', NO_PROXY: [env.NO_PROXY, env.no_proxy, '127.0.0.1', 'localhost'].filter(Boolean).join(','),
      ULTRATHINK_GATEWAY_MAIN_PROVIDER: 'codex', ULTRATHINK_GATEWAY_CODEX_MODEL: model,
      ULTRATHINK_GATEWAY_SUBAGENT_UPSTREAM_MODEL: 'gpt-6.2-astra',
      ULTRATHINK_GATEWAY_CODEX_REASONING_EFFORT: 'low', ULTRATHINK_GATEWAY_SUBAGENT_REASONING_EFFORT: 'low',
      ULTRATHINK_GATEWAY_ANTHROPIC_PASSTHROUGH_MODELS: 'none', ULTRATHINK_GATEWAY_TRACE_DIR: trace,
      ULTRATHINK_GATEWAY_REQUEST_TIMEOUT_MS: '60000',
    });
    env.no_proxy = env.NO_PROXY;
    let result;
    let failure;
    let readSucceeded = false;
    try {
      const { stdout } = await run(process.execPath, [cli, '--no-yolo', '--',
        '--restricted', '--print', '--verbose', '--output-format', 'stream-json', '--no-session-persistence',
        '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', 'Read',
        '--allowedTools', 'Read', '--disable-slash-commands', '--max-turns', '3',
        '--system-prompt', 'Use the Read tool exactly once, with the full path in the prompt. Then output only the UUID it returned, without a line number, markdown or explanation.',
        'Read this file: ' + file + '\nWhat UUID does it contain?',
      ], { cwd, env, timeout: 90_000, maxBuffer: 1_048_576 });
      const stream = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      result = stream.findLast(entry => entry.type === 'result');
      readSucceeded = stream.some(entry => entry.type === 'user' && entry.message?.content?.some?.(
        block => block.type === 'tool_result' && !block.is_error && JSON.stringify(block.content).includes(nonce)));
    } catch (error) {
      failure = error;
    }
    const events = (await fs.readFile(path.join(trace, 'gateway-trace.jsonl'), 'utf8').catch(() => ''))
      .split('\n').filter(Boolean).map(line => JSON.parse(line));
    const thread = events.find(e => e.event === 'codex.thread.started');
    const calls = events.filter(e => e.event === 'codex.tool_call.pending');
    const continued = events.some(e => e.event === 'codex.tool_result.continued' && e.tool_name === 'Read');
    const matched = !result?.is_error && result?.result?.trim() === nonce;
    if (!failure && matched && readSucceeded && thread?.actual_model === model && calls.length &&
      calls.every(e => e.tool_name === 'Read') && continued &&
      !events.some(e => e.event === 'codex.model.rerouted')) {
      console.log('PASS ' + model + ': hosted model returned the nonce using Claude Read');
      return true;
    }
    const reason = failureReason([failure?.stdout, failure?.stderr, result?.result, result?.subtype,
      ...events.map(e => e.error_message)].filter(Boolean).join('\n'), failure?.killed);
    console.error('FAIL ' + model + ': ' + reason + ' (expected thread: ' +
      (thread?.actual_model === model) + ', Read calls: ' + calls.filter(e => e.tool_name === 'Read').length +
      ', Read returned nonce: ' + readSucceeded + ', result continued: ' + continued + ', nonce matched: ' + matched + ')');
    return false;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 3 });
  }
}

if (process.argv.length !== 3 || process.argv[2] !== '--run') {
  console.error('Usage: node scripts/verify-hosted-codex.mjs --run (uses real Codex authentication and usage)');
  process.exitCode = 2;
} else {
  const results = await Promise.all(models.map(verify));
  if (!results.every(Boolean)) process.exitCode = 1;
}
