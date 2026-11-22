import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';

import { DEFAULT_CODEX_MODEL } from '../js/gateway/config.js';
import { CodexSessionManager } from '../js/gateway/codex-provider.js';
import { installedCodexPolicy } from './helpers/installed-cli-policy.js';

const execFileAsync = promisify(execFile);
const CODEX_COMMAND = process.env.ULTRATHINK_GATEWAY_CODEX_COMMAND || 'codex';
const MAX_COMMAND_OUTPUT_BYTES = 32 * 1024 * 1024;

const CODEX_PROBE = installedCodexPolicy({ command: CODEX_COMMAND });
const CODEX_SKIP = CODEX_PROBE.skip;

async function runCodex(args, environment) {
  try {
    return await execFileAsync(CODEX_COMMAND, args, {
      encoding: 'utf8',
      env: environment,
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      timeout: 30_000,
      windowsHide: true,
    });
  } catch (error) {
    const stderr = String(error?.stderr || '').trim();
    const detail = stderr ? `: ${stderr}` : '';
    error.message = `${CODEX_COMMAND} ${args.join(' ')} failed${detail}`;
    throw error;
  }
}

async function readJson(root, ...segments) {
  const source = await fs.readFile(path.join(root, ...segments), 'utf8');
  return JSON.parse(source);
}

async function readText(root, ...segments) {
  return fs.readFile(path.join(root, ...segments), 'utf8');
}

function assertRequired(schema, names, description) {
  const required = new Set(schema.required || []);
  for (const name of names) {
    assert.equal(required.has(name), true, `${description} must require ${name}`);
  }
}

function taggedVariant(union, tag) {
  return (union?.oneOf || []).find((candidate) => {
    const tagSchema = candidate?.properties?.type;
    return tagSchema?.const === tag || tagSchema?.enum?.includes(tag);
  });
}

function enumValues(schema) {
  const values = new Set();
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    if (!value || typeof value !== 'object') {
      return;
    }
    if (Array.isArray(value.enum)) {
      for (const item of value.enum) {
        if (typeof item === 'string') {
          values.add(item);
        }
      }
    }
    for (const child of Object.values(value)) {
      visit(child);
    }
  };
  visit(schema);
  return values;
}

function positiveInteger(value, description) {
  assert.equal(Number.isSafeInteger(value) && value > 0, true, `${description} must be positive`);
  return value;
}

function decodeRequestBody(chunks, encoding) {
  const compressed = Buffer.concat(chunks);
  switch (String(encoding || '').toLowerCase()) {
    case 'br':
      return brotliDecompressSync(compressed);
    case 'deflate':
      return inflateSync(compressed);
    case 'gzip':
      return gunzipSync(compressed);
    default:
      return compressed;
  }
}

function withTimeout(promise, timeoutMs, description) {
  let timeout = null;
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`timed out waiting for ${description}`)),
        timeoutMs
      );
      timeout.unref?.();
    }),
  ]).finally(() => clearTimeout(timeout));
}

function collectAdditionalToolSpecs(value, result = []) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectAdditionalToolSpecs(entry, result);
    }
    return result;
  }
  if (!value || typeof value !== 'object') {
    return result;
  }
  if (value.type === 'additional_tools' && Array.isArray(value.tools)) {
    result.push(...value.tools);
  }
  for (const child of Object.values(value)) {
    collectAdditionalToolSpecs(child, result);
  }
  return result;
}

function qualifiedToolNames(specs, namespace = '') {
  const result = [];
  for (const spec of specs || []) {
    if (!spec || typeof spec !== 'object') {
      continue;
    }
    const name = String(spec.name || '').trim();
    if (spec.type === 'namespace' && name && Array.isArray(spec.tools)) {
      const nestedNamespace = namespace ? `${namespace}.${name}` : name;
      result.push(...qualifiedToolNames(spec.tools, nestedNamespace));
      continue;
    }
    if (name) {
      result.push(namespace && !name.includes('.') ? `${namespace}.${name}` : name);
    }
  }
  return result;
}

function closeHttpServer(server) {
  if (!server?.listening) {
    return Promise.resolve();
  }
  server.closeAllConnections?.();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test(
  'installed Codex app-server schemas and model catalog satisfy the gateway contract',
  { skip: CODEX_SKIP },
  async function installedCodexContract(t) {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-installed-contract-'));
    t.after(async function cleanupInstalledCodexContract() {
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 3 });
    });
    await fs.chmod(tempRoot, 0o700);

    const codexStateDir = path.join(tempRoot, 'codex-state');
    const jsonDir = path.join(tempRoot, 'json-schema');
    const typescriptDir = path.join(tempRoot, 'typescript');
    await Promise.all(
      [codexStateDir, jsonDir, typescriptDir].map((directory) =>
        fs.mkdir(directory, { recursive: true, mode: 0o700 })
      )
    );

    const codexEnvironment = {
      ...process.env,
      CODEX_HOME: codexStateDir,
      NO_COLOR: '1',
    };
    await runCodex(
      ['app-server', 'generate-json-schema', '--experimental', '--out', jsonDir],
      codexEnvironment
    );
    await runCodex(
      ['app-server', 'generate-ts', '--experimental', '--out', typescriptDir],
      codexEnvironment
    );

    const initialize = await readJson(jsonDir, 'v1', 'InitializeParams.json');
    const initializeCapabilities = initialize.definitions?.InitializeCapabilities;
    assert.ok(initializeCapabilities, 'initialize must expose capability negotiation');
    assert.equal(
      initializeCapabilities.properties?.requestAttestation?.type,
      'boolean',
      'requestAttestation must remain an explicit boolean capability'
    );
    assert.equal(
      initializeCapabilities.properties?.requestAttestation?.default,
      false,
      'requestAttestation must remain opt-in so the gateway can disable attestation requests'
    );
    assert.equal(initializeCapabilities.properties?.experimentalApi?.type, 'boolean');

    const dynamicToolCall = await readJson(jsonDir, 'DynamicToolCallParams.json');
    assertRequired(
      dynamicToolCall,
      ['threadId', 'turnId', 'callId', 'tool', 'arguments'],
      'item/tool/call parameters'
    );
    assert.equal(dynamicToolCall.properties?.arguments, true);
    const dynamicToolResponse = await readJson(jsonDir, 'DynamicToolCallResponse.json');
    assertRequired(dynamicToolResponse, ['contentItems', 'success'], 'item/tool/call response');
    assert.ok(
      taggedVariant(
        dynamicToolResponse.definitions?.DynamicToolCallOutputContentItem,
        'inputText'
      ),
      'item/tool/call results must support inputText content'
    );

    const tokenUsage = await readJson(
      jsonDir,
      'v2',
      'ThreadTokenUsageUpdatedNotification.json'
    );
    assertRequired(tokenUsage, ['threadId', 'turnId', 'tokenUsage'], 'token usage notification');
    const cacheWriteTokens = tokenUsage.definitions?.TokenUsageBreakdown?.properties
      ?.cacheWriteInputTokens;
    assert.equal(cacheWriteTokens?.type, 'integer');
    assert.equal(cacheWriteTokens?.default, 0);

    const interrupt = await readJson(jsonDir, 'v2', 'TurnInterruptParams.json');
    assertRequired(interrupt, ['threadId', 'turnId'], 'turn/interrupt parameters');

    const itemStarted = await readJson(jsonDir, 'v2', 'ItemStartedNotification.json');
    const itemCompleted = await readJson(jsonDir, 'v2', 'ItemCompletedNotification.json');
    assert.ok(
      taggedVariant(itemStarted.definitions?.ThreadItem, 'contextCompaction'),
      'item/started must expose contextCompaction lifecycle items'
    );
    assert.ok(
      taggedVariant(itemCompleted.definitions?.ThreadItem, 'contextCompaction'),
      'item/completed must expose contextCompaction lifecycle items'
    );
    const agentMessage = taggedVariant(itemCompleted.definitions?.ThreadItem, 'agentMessage');
    assert.ok(agentMessage?.properties?.delivery, 'agent messages must expose delivery metadata');
    assert.equal(
      enumValues(itemCompleted.definitions?.AgentMessageDelivery).has('async'),
      true,
      'agent-message delivery must identify async messages'
    );

    const errorNotification = await readJson(jsonDir, 'v2', 'ErrorNotification.json');
    const turnCompleted = await readJson(jsonDir, 'v2', 'TurnCompletedNotification.json');
    for (const [description, schema] of [
      ['error notification', errorNotification],
      ['turn completion', turnCompleted],
    ]) {
      const typedErrors = enumValues(schema.definitions?.CodexErrorInfo);
      assert.equal(
        typedErrors.has('contextWindowExceeded'),
        true,
        `${description} must type context-window failures`
      );
      assert.equal(
        typedErrors.has('serverOverloaded'),
        true,
        `${description} must type overload failures`
      );
      assert.ok(
        schema.definitions?.TurnError?.properties?.codexErrorInfo,
        `${description} must carry codexErrorInfo on TurnError`
      );
    }

    const rerouted = await readJson(jsonDir, 'v2', 'ModelReroutedNotification.json');
    assertRequired(
      rerouted,
      ['threadId', 'turnId', 'fromModel', 'toModel', 'reason'],
      'model/rerouted notification'
    );

    const [
      clientRequestTs,
      serverRequestTs,
      serverNotificationTs,
      initializeCapabilitiesTs,
      dynamicToolCallTs,
      tokenUsageTs,
      errorInfoTs,
      threadItemTs,
      deliveryTs,
      reroutedTs,
    ] = await Promise.all([
      readText(typescriptDir, 'ClientRequest.ts'),
      readText(typescriptDir, 'ServerRequest.ts'),
      readText(typescriptDir, 'ServerNotification.ts'),
      readText(typescriptDir, 'InitializeCapabilities.ts'),
      readText(typescriptDir, 'v2', 'DynamicToolCallParams.ts'),
      readText(typescriptDir, 'v2', 'TokenUsageBreakdown.ts'),
      readText(typescriptDir, 'v2', 'CodexErrorInfo.ts'),
      readText(typescriptDir, 'v2', 'ThreadItem.ts'),
      readText(typescriptDir, 'v2', 'AgentMessageDelivery.ts'),
      readText(typescriptDir, 'v2', 'ModelReroutedNotification.ts'),
    ]);
    assert.match(clientRequestTs, /"method": "initialize"/u);
    assert.match(clientRequestTs, /"method": "turn\/interrupt"/u);
    assert.match(serverRequestTs, /"method": "item\/tool\/call"/u);
    assert.match(serverRequestTs, /"method": "attestation\/generate"/u);
    assert.match(serverNotificationTs, /"method": "model\/rerouted"/u);
    assert.match(initializeCapabilitiesTs, /requestAttestation:\s*boolean/u);
    assert.match(dynamicToolCallTs, /callId:\s*string/u);
    assert.match(tokenUsageTs, /cacheWriteInputTokens:\s*number/u);
    assert.match(errorInfoTs, /"contextWindowExceeded"/u);
    assert.match(errorInfoTs, /"serverOverloaded"/u);
    assert.match(threadItemTs, /"type": "contextCompaction"/u);
    assert.match(deliveryTs, /"async"/u);
    assert.match(reroutedTs, /toModel:\s*string/u);

    const { stdout: modelCatalogSource } = await runCodex(
      ['debug', 'models', '--bundled'],
      codexEnvironment
    );
    const modelCatalog = JSON.parse(modelCatalogSource);
    assert.equal(Array.isArray(modelCatalog.models), true, 'debug models must return a model list');
    const selectedModel = modelCatalog.models.find((model) => model.slug === DEFAULT_CODEX_MODEL);
    assert.ok(
      selectedModel,
      `${DEFAULT_CODEX_MODEL} must exist in the installed Codex bundled model catalog`
    );
    assert.equal(selectedModel.supported_in_api, true);
    assert.deepEqual(selectedModel.truncation_policy, {
      mode: 'tokens',
      limit: 10_000,
    });

    const rawDefaultWindow = positiveInteger(
      selectedModel.context_window,
      `${selectedModel.slug} default raw context window`
    );
    const rawMaximumWindow = positiveInteger(
      selectedModel.max_context_window ?? rawDefaultWindow,
      `${selectedModel.slug} maximum raw context window`
    );
    const effectivePercent = positiveInteger(
      selectedModel.effective_context_window_percent ?? 100,
      `${selectedModel.slug} effective-context percentage`
    );
    assert.ok(effectivePercent <= 100, 'effective-context percentage cannot exceed 100');
    assert.ok(rawDefaultWindow <= rawMaximumWindow, 'default context cannot exceed model maximum');

    const effectiveDefaultWindow = Math.floor((rawDefaultWindow * effectivePercent) / 100);
    const effectiveMaximumWindow = Math.floor((rawMaximumWindow * effectivePercent) / 100);
    assert.ok(effectiveDefaultWindow > 0 && effectiveDefaultWindow <= rawDefaultWindow);
    assert.ok(effectiveMaximumWindow >= effectiveDefaultWindow);
    assert.ok(effectiveMaximumWindow <= rawMaximumWindow);

    const supportedEfforts = new Set(
      (selectedModel.supported_reasoning_levels || []).map((level) => level.effort)
    );
    assert.equal(
      supportedEfforts.has(selectedModel.default_reasoning_level),
      true,
      'the selected model default effort must be advertised as supported'
    );
    assert.equal(
      supportedEfforts.has('max'),
      true,
      'the selected workflow model must support the configured max effort'
    );

    if (CODEX_PROBE.version) {
      t.diagnostic(`validated ${CODEX_PROBE.version} (${selectedModel.slug})`);
    }
  }
);

test('installed Codex releases interrupted threads across repeated cancellations on a warm connection',
  { skip: CODEX_SKIP, timeout: 25_000 }, async (t) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-installed-cancel-'));
    const stateDir = path.join(cwd, 'codex-state');
    const previousHome = process.env.CODEX_HOME;
    const previousKey = process.env.CODEX_CANCEL_PROBE_KEY;
    let onModelRequest;
    const server = createServer((request, response) => {
      const chunks = [];
      request.on('data', chunk => chunks.push(chunk));
      request.on('end', () => {
        if (request.method !== 'POST' || !request.url?.endsWith('/responses')) {
          response.writeHead(404); response.end(); return;
        }
        const body = decodeRequestBody(chunks, request.headers['content-encoding']).toString('utf8');
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(': held by local cancellation probe\n\n');
        onModelRequest?.(body);
      });
    });
    let manager;
    t.after(async () => {
      await manager?.close();
      await closeHttpServer(server);
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
      if (previousKey === undefined) delete process.env.CODEX_CANCEL_PROBE_KEY;
      else process.env.CODEX_CANCEL_PROBE_KEY = previousKey;
      await fs.rm(cwd, { recursive: true, force: true, maxRetries: 3 });
    });
    await fs.mkdir(stateDir, { mode: 0o700 });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    // No hosted credentials or inference. A zero unload delay allows the
    // released runtime's own loaded-thread inventory to verify reclamation.
    await fs.writeFile(path.join(stateDir, 'config.toml'), [
      'model_provider = "cancel_probe"', 'thread_unload_delay_secs = 0',
      '[model_providers.cancel_probe]', 'name = "Local cancellation probe"',
      `base_url = "http://127.0.0.1:${server.address().port}/v1"`,
      'wire_api = "responses"', 'supports_websockets = false', 'env_key = "CODEX_CANCEL_PROBE_KEY"',
    ].join('\n'), { mode: 0o600 });
    process.env.CODEX_HOME = stateDir;
    process.env.CODEX_CANCEL_PROBE_KEY = 'loopback-only';
    manager = new CodexSessionManager({
      requestTimeoutMs: 5_000, codex: {
        command: CODEX_COMMAND, cwd, idleTimeoutMs: 0, closeKillTimeoutMs: 300, maxSessions: 1,
      },
    });
    async function until(check, label) {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.fail(`timed out waiting for ${label}`);
    }
    let connection;
    for (let i = 0; i < 3; i++) {
      const abort = new AbortController();
      const prompt = `hold local turn ${i}`;
      const received = new Promise(resolve => {
        onModelRequest = payload => { if (payload.includes(prompt)) resolve(); };
      });
      const req = { get: name => name === 'x-claude-code-session-id' ? 'cancel-probe' : '', abortSignal: abort.signal };
      const rejected = assert.rejects(manager.processRequest(req, {
        model: 'cancel-probe', messages: [{ role: 'user', content: prompt }],
      }, { requestedModel: 'cancel-probe', upstreamModel: DEFAULT_CODEX_MODEL,
        approvalPolicy: 'never', sandbox: 'read-only' }), error => error.status === 499);
      // turn/start can acknowledge enqueueing before its core task is
      // interruptible. Observe this exact turn executing on the local provider.
      await withTimeout(received, 5_000, 'the local provider to receive this turn');
      const session = [...manager.sessions.values()][0];
      connection ??= session.connection;
      assert.equal(session.connection, connection);
      abort.abort();
      await rejected;
      assert.equal(manager.sessions.size, 1, 'a clean unsubscribe should keep the process warm');
      await until(async () => (await connection.request('thread/loaded/list', {})).data.length === 0,
        'the interrupted thread to leave the loaded inventory');
    }
  });

const isolatedCases = ['gpt-6.2-astra', 'gpt-6.2-sol'].flatMap((model) =>
  ['main', 'subagent'].map((threadKind) => ({ model, threadKind })));
for (const { model, threadKind } of isolatedCases) test(
  `installed Codex app-server exposes only Claude dynamic tools (${model}, ${threadKind})`,
  { skip: CODEX_SKIP },
  async function installedCodexDynamicToolIsolation(t) {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-installed-isolation-'));
    const codexStateDir = path.join(tempRoot, 'codex-state');
    const skillDir = path.join(codexStateDir, 'skills', 'should-not-leak');
    await fs.mkdir(skillDir, { recursive: true, mode: 0o700 });
    await fs.chmod(tempRoot, 0o700);

    const previousCodexHome = process.env.CODEX_HOME;
    const previousProbeKey = process.env.CODEX_ISOLATION_PROBE_KEY;
    let manager = null;
    let requestPromise = null;
    let server = null;
    t.after(async function cleanupInstalledIsolationContract() {
      await manager?.close().catch(() => {});
      if (requestPromise) {
        await withTimeout(requestPromise, 5_000, 'the terminated isolation request').catch(
          () => {}
        );
      }
      await closeHttpServer(server).catch(() => {});
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      if (previousProbeKey === undefined) {
        delete process.env.CODEX_ISOLATION_PROBE_KEY;
      } else {
        process.env.CODEX_ISOLATION_PROBE_KEY = previousProbeKey;
      }
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 3 });
    });

    let resolveCapturedRequest;
    let rejectCapturedRequest;
    const capturedRequestPromise = new Promise((resolve, reject) => {
      resolveCapturedRequest = resolve;
      rejectCapturedRequest = reject;
    });
    let captured = false;
    server = createServer((request, response) => {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('error', (error) => {
        if (!captured) {
          captured = true;
          rejectCapturedRequest(error);
        }
      });
      request.on('end', () => {
        try {
          const decoded = decodeRequestBody(chunks, request.headers['content-encoding']);
          const payload = JSON.parse(decoded.toString('utf8'));
          if (!captured) {
            captured = true;
            resolveCapturedRequest({ payload, request });
          }
        } catch (error) {
          if (!captured) {
            captured = true;
            rejectCapturedRequest(error);
          }
        }
        response.writeHead(400, {
          connection: 'close',
          'content-type': 'application/json',
        });
        response.end(
          JSON.stringify({
            error: {
              code: 'isolation_probe_complete',
              message: 'The local contract probe captured the request.',
              type: 'invalid_request_error',
            },
          })
        );
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');

    const { stdout: installedFeatures } = await runCodex(['features', 'list'], {
      ...process.env,
      CODEX_HOME: codexStateDir,
      NO_COLOR: '1',
    });
    const hasIndependentSleepFeature = /^sleep_tool\s/imu.test(installedFeatures);

    await fs.writeFile(
      path.join(codexStateDir, 'config.toml'),
      [
        'model_provider = "isolation_probe"',
        '',
        '[model_providers.isolation_probe]',
        'name = "Isolation Probe"',
        `base_url = "http://127.0.0.1:${address.port}/v1"`,
        'env_key = "CODEX_ISOLATION_PROBE_KEY"',
        'wire_api = "responses"',
        'supports_websockets = false',
        '',
        '[features.context_management]',
        'experimental_mode = true',
        '',
        '[features.current_time_reminder]',
        'enabled = true',
        'sleep_tool = true',
        '',
        ...(hasIndependentSleepFeature
          ? [
              '[features.sleep_tool]',
              'enabled = true',
              'mode = "always_on"',
              '',
            ]
          : []),
        '[mcp_servers."configured.server.with.dots"]',
        'command = "false"',
        '',
        '[plugins."configured-plugin@test"]',
        'enabled = true',
        '',
      ].join('\n'),
      { mode: 0o600 }
    );
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: should-not-leak',
        'description: Sentinel skill for the installed isolation contract.',
        '---',
        '',
        'CODEX_ISOLATION_SKILL_SENTINEL',
        '',
      ].join('\n'),
      { mode: 0o600 }
    );

    process.env.CODEX_HOME = codexStateDir;
    process.env.CODEX_ISOLATION_PROBE_KEY = 'local-contract-probe-key';

    manager = new CodexSessionManager({
      requestTimeoutMs: 15_000,
      codex: {
        approvalPolicy: 'never',
        closeKillTimeoutMs: 1_000,
        command: CODEX_COMMAND,
        cwd: tempRoot,
        dynamicToolsOnly: true,
        forkIdleTimeoutMs: 1_000,
        idleTimeoutMs: 0,
        maxSessions: 1,
        model,
        pendingToolTimeoutMs: 5_000,
        sandbox: 'workspace-write',
      },
    });
    try {
      const headers = {
        ...(threadKind === 'subagent'
          ? { 'x-claude-code-agent-id': 'installed-isolation-agent' }
          : {}),
        'x-claude-code-session-id': 'installed-isolation-session',
      };
      const request = {
        get(name) {
          return headers[String(name).toLowerCase()] || '';
        },
      };
      requestPromise = manager
        .processRequest(
          request,
          {
            messages: [{ role: 'user', content: [
              { type: 'text', text: 'BEFORE_INLINE_IMAGE' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png',
                data: 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAGUlEQVR4nO3BMQEAAADCoPVP7WENoAAAAG4MIAABt9NlCQAAAABJRU5ErkJggg==' } },
              { type: 'text', text: 'AFTER_INLINE_IMAGE' },
            ] }],
            model: 'claude-isolation-contract',
            tools: [
              {
                description: 'Read one bounded file range.',
                input_schema: {
                  properties: { file_path: { type: 'string' } },
                  required: ['file_path'],
                  type: 'object',
                },
                name: 'Read',
              },
              {
                name: 'AskUserQuestion',
                description: 'Ask the user a question through Claude Code.',
                input_schema: {
                  type: 'object',
                  properties: {
                    questions: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: { question: { type: 'string' } },
                        required: ['question'],
                      },
                    },
                  },
                  required: ['questions'],
                },
              },
            ],
          },
          {
            approvalPolicy: 'never',
            provider: 'codex',
            reasoningEffort: 'max',
            requestedModel: 'claude-isolation-contract',
            sandbox: 'workspace-write',
            upstreamModel: model,
            verbosity: 'low',
          }
        )
        .catch(() => null);

      const { payload, request: upstreamRequest } = await withTimeout(
        capturedRequestPromise,
        15_000,
        'the installed Codex inference request'
      );
      assert.equal(upstreamRequest.method, 'POST');
      assert.match(String(upstreamRequest.url || ''), /\/responses(?:\?|$)/u);
      assert.equal(payload.model, model);
      assert.equal(payload.tool_choice, 'auto');
      const user = payload.input.find((item) => item.role === 'user' &&
        item.content.some((part) => part.text?.includes('BEFORE_INLINE_IMAGE')));
      assert.ok(user);
      const before = user.content.findIndex((part) => part.text?.includes('BEFORE_INLINE_IMAGE'));
      const image = user.content.findIndex((part) => part.type === 'input_image');
      const after = user.content.findIndex((part) => part.text?.includes('AFTER_INLINE_IMAGE'));
      assert.ok(before < image && image < after, JSON.stringify(user.content.map(({type, text}) => ({type, text}))));
      assert.match(user.content[image].image_url, /^data:image\//u);

      const specs = [
        ...(Array.isArray(payload.tools) ? payload.tools : []),
        ...collectAdditionalToolSpecs(payload.input),
      ];
      const toolNames = [...new Set(qualifiedToolNames(specs))].sort();
      assert.deepEqual(toolNames, [
        'functions.ext_tool_001',
        'functions.ext_tool_002',
      ]);

      const serializedRequest = JSON.stringify(payload);
      assert.match(serializedRequest, /Ask the user a question through Claude Code\./u);
      assert.doesNotMatch(serializedRequest, /CODEX_ISOLATION_SKILL_SENTINEL/u);
      assert.doesNotMatch(serializedRequest, /configured\.server\.with\.dots/u);
      assert.doesNotMatch(serializedRequest, /configured-plugin@test/u);
      assert.equal(toolNames.some((name) => name.startsWith('clock.')), false);
      assert.equal(toolNames.some((name) => name.startsWith('collaboration.')), false);
      assert.equal(toolNames.some((name) => name.includes('spawn_agent')), false);
      assert.equal(toolNames.some((name) => name.includes('request_user_input')), false);

      if (CODEX_PROBE.version) {
        t.diagnostic(`validated dynamic isolation with ${CODEX_PROBE.version}`);
      }
    } finally {
      await manager.close().catch(() => {});
      if (requestPromise) {
        await withTimeout(requestPromise, 5_000, 'the terminated isolation request').catch(
          () => {}
        );
      }
      await closeHttpServer(server).catch(() => {});
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      if (previousProbeKey === undefined) {
        delete process.env.CODEX_ISOLATION_PROBE_KEY;
      } else {
        process.env.CODEX_ISOLATION_PROBE_KEY = previousProbeKey;
      }
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 3 });
    }
  }
);
