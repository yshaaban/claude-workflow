import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { CodexSessionManager } from '../js/gateway/codex-provider.js';
import { pendingUserSteer } from '../js/gateway/codex-conversation-semantics.js';
import { installedCodexPolicy } from './helpers/installed-cli-policy.js';

const session = { get: () => 'semantics-fixture' };
const model = 'gpt-6.2-astra';
const route = { requestedModel: 'codex-astra', upstreamModel: model, approvalPolicy: 'never', sandbox: 'read-only' };
const opening = { model: route.requestedModel, messages: [{ role: 'user', content: 'Use Lookup, then answer.' }],
  tools: [{ name: 'Lookup', description: 'Return the fixture value.', input_schema: { type: 'object', properties: {} } }] };
const format = { type: 'json_schema', schema: { type: 'object', properties: { value: { type: 'string' } },
  required: ['value'], additionalProperties: false } };
const image = { type: 'image', source: { type: 'base64', media_type: 'image/png',
  data: 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAGUlEQVR4nO3BMQEAAADCoPVP7WENoAAAAG4MIAABt9NlCQAAAABJRU5ErkJggg==' } };
const toolResult = { type: 'tool_result', tool_use_id: 'call_lookup', content: 'TOOL_VALUE' };
const userNote = { type: 'text', text: 'USER_NOTE' };

test('unsupported conversation semantics fail before a Codex session opens', () => {
  const manager = new CodexSessionManager({ codex: {} }, { createSession() { assert.fail('opened a session'); } });
  for (const [tail, expected] of [
    [{ role: 'system', content: 'A new requirement.' }, /role "system" is not supported/u],
    [{ role: 'system', content: [{ type: 'tool_removal', tool: { type: 'tool_reference', name: 'Lookup' } }] }, /tool_removal/u],
    [{ role: 'system', content: [{ type: 'tool_addition', tool: { type: 'tool_definition' } }] }, /tool_addition/u],
    [{ role: 'assistant', content: [{ type: 'compaction', content: 'Only copy of prior context', signature: 'x' }] }, /signed compaction/u],
    [{ role: 'assistant', content: [{ type: 'future_content_block' }] }, /future_content_block/u],
  ]) {
    assert.throws(() => manager.ensureSession(session, { ...opening, messages: [...opening.messages, tail] }, route), expected);
  }
  assert.throws(() => manager.ensureSession(session, { ...opening, compaction: { type: 'summarize' } }, route), /compaction requests/u);
  assert.throws(() => manager.ensureSession(session, { ...opening, output_config: { format: { type: 'other' } } }, route), /json_schema/u);
  assert.throws(() => pendingUserSteer([userNote, toolResult], 'call_lookup'), /must precede/u);
  assert.throws(() => pendingUserSteer([toolResult, toolResult], 'call_lookup'), /exactly the matching/u);
  for (const text of [
    '<total_tokens>123 tokens left</total_tokens> Also update the changelog.',
    '[Truncated: PARTIAL view — malformed banner with instructions appended]',
  ]) {
    assert.throws(() => manager.ensureSession(session, { ...opening, messages: [...opening.messages,
      { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', id: 'call_lookup', input: { file_path: 'fixture' } }] },
      { role: 'user', content: [toolResult] }, { role: 'system', content: text },
    ] }, route), /role "system" is not supported/u);
  }
  assert.throws(() => manager.ensureSession(session, { ...opening, messages: [...opening.messages,
    { role: 'system', content: 'A reminder before the withdrawal.' }, { role: 'assistant', content: 'OK.' },
    { role: 'user', content: 'Continue.' }, { role: 'system', content: [
      { type: 'tool_removal', tool: { type: 'tool_reference', name: 'Lookup' } },
    ] },
  ] }, route), /tool_removal/u);
  assert.equal(manager.sessions.size, 0);
});

const codex = installedCodexPolicy({ command: process.env.ULTRATHINK_GATEWAY_CODEX_COMMAND || 'codex' });
test('installed app-server preserves tool output, following user input, and per-turn output schema',
  { skip: codex.skip, timeout: 20_000 }, async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-semantics-'));
    const requests = [];
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const decode = { br: brotliDecompressSync, gzip: gunzipSync }[req.headers['content-encoding']];
      const raw = Buffer.concat(chunks);
      const body = JSON.parse(decode ? decode(raw) : raw);
      requests.push(body);
      const n = requests.length;
      const callIds = n === 1 ? ['call_lookup', 'call_another'] : n === 5 ? ['call_cancel'] : [];
      const items = callIds.length
        ? callIds.map(call_id => ({
          type: 'function_call', namespace: 'functions', name: 'ext_tool_001', call_id, arguments: '{}',
        }))
        : [{ type: 'message', id: 'msg' + n, role: 'assistant', phase: 'final_answer',
          content: [{ type: 'output_text', text: '{"value":"ok"}' }] }];
      const frame = (type, fields) => 'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...fields }) + '\n\n';
      const id = 'resp' + n;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(frame('response.created', { response: { id, status: 'in_progress' } }) +
        items.map((item, output_index) => frame('response.output_item.done', { output_index, item })).join('') +
        frame('response.completed', { response: { id, status: 'completed', output: items,
          usage: { input_tokens: 125, output_tokens: 8, total_tokens: 133 } } }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const config = { requestTimeoutMs: 5000, codex: {
      command: process.env.ULTRATHINK_GATEWAY_CODEX_COMMAND || 'codex', model, cwd: dir, dynamicToolsOnly: true,
      approvalPolicy: 'never', sandbox: 'read-only', maxSessions: 1, idleTimeoutMs: 0,
    } };
    const manager = new CodexSessionManager(config);
    const cold = new CodexSessionManager(config);
    const priorHome = process.env.CODEX_HOME;
    const priorKey = process.env.WORKFLOW_SEMANTICS_KEY;
    t.after(async () => {
      await manager.close();
      await cold.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      if (priorHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = priorHome;
      if (priorKey === undefined) delete process.env.WORKFLOW_SEMANTICS_KEY; else process.env.WORKFLOW_SEMANTICS_KEY = priorKey;
      await fs.rm(dir, { recursive: true, force: true });
    });
    await fs.writeFile(path.join(dir, 'config.toml'), [
      'model_provider = "fixture"', '[model_providers.fixture]', 'name = "Loopback"',
      'base_url = "http://127.0.0.1:' + server.address().port + '/v1"', 'wire_api = "responses"',
      'env_key = "WORKFLOW_SEMANTICS_KEY"', 'supports_websockets = false',
    ].join('\n'));
    process.env.CODEX_HOME = dir;
    process.env.WORKFLOW_SEMANTICS_KEY = 'loopback';
    const start = { ...opening, output_config: { format } };
    const outcome = await manager.processRequest(session, start, route);
    assert.equal(outcome.toolCall.name, 'Lookup');
    assert.deepEqual(requests[0].text?.format?.schema, format.schema);
    const next = { ...start, messages: [...start.messages,
      { role: 'assistant', content: [{ type: 'tool_use', id: outcome.toolCall.id, name: 'Lookup', input: {} }] },
      { role: 'user', content: [{ ...toolResult, tool_use_id: outcome.toolCall.id }, userNote, image, { type: 'text', text: 'AFTER_IMAGE' }] },
    ] };
    await assert.rejects(manager.processRequest(session, { ...next, output_config: {} }, route), /change output_config.format/u);
    assert.equal(requests.length, 1);
    const parallel = await manager.processRequest(session, next, route);
    assert.equal(parallel.type, 'tool_use', 'Claude receives one call per boundary; the other is still pending');
    assert.notEqual(parallel.toolCall.id, outcome.toolCall.id);
    assert.equal(requests.length, 1);
    const parallelResult = { ...next, messages: [...next.messages,
      { role: 'assistant', content: [{ type: 'tool_use', ...parallel.toolCall }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: parallel.toolCall.id, content: 'SECOND_VALUE' }] },
    ] };
    const final = await manager.processRequest(session, parallelResult, route);
    assert.equal(final.text, '{"value":"ok"}');
    assert.equal(requests.length, 2);
    const input = requests[1].input;
    const toolIndex = input.findIndex(item => item.type === 'function_call_output' && item.call_id === outcome.toolCall.id);
    const userIndex = input.findIndex(item => item.role === 'user' && item.content?.some(block => block.text === userNote.text));
    assert.ok(toolIndex >= 0 && userIndex > toolIndex, JSON.stringify(input.map(i => [i.type, i.role])));
    assert.match(JSON.stringify(input[toolIndex].output), /TOOL_VALUE/u);
    assert.doesNotMatch(JSON.stringify(input[toolIndex].output), /USER_NOTE/u);
    for (const id of [outcome.toolCall.id, parallel.toolCall.id]) {
      assert.equal(input.filter(i => i.type === 'function_call_output' && i.call_id === id).length, 1);
    }
    assert.equal(input.filter(i => i.role === 'user' && i.content?.some(b => b.text === userNote.text)).length, 1);
    assert.deepEqual(input[userIndex].content.map(b => b.type), ['input_text', 'input_image', 'input_text']);
    assert.equal(input[userIndex].content.at(-1).text, 'AFTER_IMAGE');
    const last = { ...opening, messages: [...parallelResult.messages, { role: 'assistant', content: final.text },
      { role: 'user', content: 'New unstructured question.' }] };
    await manager.processRequest(session, last, route);
    assert.equal(requests.length, 3);
    assert.notEqual(requests[2].text?.format?.type, 'json_schema');

    // A cold manager has no pending call or Codex thread. The same Claude
    // history reconstructs both completed results and the separate user input
    // exactly once; it does not execute either tool to recover the history.
    const replay = await cold.processRequest(session, last, route);
    assert.equal(replay.type, 'final');
    assert.equal(requests.length, 4);
    const coldInput = requests[3].input.find(i => i.role === 'user').content;
    const transcript = coldInput.map(b => b.type === 'input_image' ? '<IMAGE>' : b.text).join('');
    for (const marker of ['TOOL_VALUE', 'USER_NOTE', '<IMAGE>', 'AFTER_IMAGE', 'SECOND_VALUE',
      '[tool_use Lookup ' + outcome.toolCall.id + ']', '[tool_use Lookup ' + parallel.toolCall.id + ']']) {
      assert.equal(transcript.split(marker).length, 2, marker);
    }
    assert.match(transcript, /TOOL_VALUE\s+\[user\]\s+USER_NOTE\s*<IMAGE>\s*AFTER_IMAGE[\s\S]*SECOND_VALUE/u);

    const openingCancel = { ...opening, messages: [...last.messages, { role: 'assistant', content: replay.text },
      { role: 'user', content: 'Use Lookup once more.' }] };
    const pending = await cold.processRequest(session, openingCancel, route);
    assert.equal(pending.toolCall.id, 'call_cancel');
    const live = [...cold.sessions.values()][0];
    const rpc = live.connection.request.bind(live.connection);
    let onAccepted, releaseAck;
    const accepted = new Promise(r => { onAccepted = r; });
    const held = new Promise(r => { releaseAck = r; });
    const sentResults = [];
    const send = live.connection.send.bind(live.connection);
    live.connection.send = msg => { if (msg.result?.contentItems) sentResults.push(msg); return send(msg); };
    live.connection.request = async (method, params) => {
      const value = await rpc(method, params);
      if (method === 'turn/steer') { onAccepted(); await held; }
      return value;
    };
    const cancel = new AbortController();
    const continuation = cold.processRequest({ ...session, abortSignal: cancel.signal }, {
      ...openingCancel, messages: [...openingCancel.messages,
        { role: 'assistant', content: [{ type: 'tool_use', ...pending.toolCall }] },
        { role: 'user', content: [{ ...toolResult, tool_use_id: pending.toolCall.id }, userNote] },
      ],
    }, route);
    try {
      await accepted;
      cancel.abort();
      await assert.rejects(continuation, e => e.status === 499);
    } finally { releaseAck(); }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cold.sessions.size, 0, 'ambiguous steer must retire the old app-server');
    assert.equal(sentResults.length, 0, 'late acknowledgement after cancellation must not release the tool');
    assert.equal(requests.length, 5, 'no inference after cancellation');
  });
