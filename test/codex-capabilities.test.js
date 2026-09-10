import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  clearCodexCapabilityCacheForTests,
  resolveCodexCapabilities,
} from '../js/gateway/codex-capabilities.js';
import {
  buildWorkflowClientEnv,
  buildWorkflowGatewayConfig,
  buildWorkflowModelPicker,
  routeTargetSummary,
} from '../js/gateway/workflow-config.js';
import { loadGatewayConfig } from '../js/gateway/config.js';
import { resolveModelRoute } from '../js/gateway/model-routing.js';
import { createPrivateClaudeSettingsOverride } from '../js/utils/claude-config.js';

const MANAGED_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_WORKFLOW_DISPLAY_ROUTED_MODEL',
  'CLAUDE_WORKFLOW_MAIN_PROVIDER',
  'CLAUDE_WORKFLOW_SUBAGENT_MODEL_ID',
  'ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY',
  'ULTRATHINK_GATEWAY_ANTHROPIC_PASSTHROUGH_MODELS',
  'ULTRATHINK_GATEWAY_CODEX_COMMAND',
  'ULTRATHINK_GATEWAY_CODEX_CWD',
  'ULTRATHINK_GATEWAY_CODEX_CONTEXT',
  'ULTRATHINK_GATEWAY_CODEX_CONTEXT_PROFILE',
  'ULTRATHINK_GATEWAY_CODEX_CONTEXT_WINDOW',
  'ULTRATHINK_GATEWAY_CODEX_INPUT_MAX_TOKENS',
  'ULTRATHINK_GATEWAY_CODEX_MODEL',
  'ULTRATHINK_GATEWAY_CODEX_REASONING_EFFORT',
  'ULTRATHINK_GATEWAY_MAIN_MODEL_ID',
  'ULTRATHINK_GATEWAY_MAIN_PROVIDER',
  'ULTRATHINK_GATEWAY_MAIN_REASONING_EFFORT',
  'ULTRATHINK_GATEWAY_MAIN_UPSTREAM_MODEL',
  'ULTRATHINK_GATEWAY_ROUTE_MAP_JSON',
  'ULTRATHINK_GATEWAY_SHARED_SECRET',
  'ULTRATHINK_GATEWAY_SUBAGENT_MODEL_ID',
  'ULTRATHINK_GATEWAY_SUBAGENT_REASONING_EFFORT',
  'ULTRATHINK_GATEWAY_SUBAGENT_UPSTREAM_MODEL',
];

async function makeExecutable(file, contents) {
  await fs.writeFile(file, contents, { mode: 0o755 });
}

async function withEnvironment(values, callback) {
  const previous = Object.fromEntries(MANAGED_ENV.map((name) => [name, process.env[name]]));
  try {
    for (const name of MANAGED_ENV) {
      delete process.env[name];
    }
    Object.assign(process.env, values);
    clearCodexCapabilityCacheForTests();
    return await callback();
  } finally {
    for (const name of MANAGED_ENV) {
      if (previous[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previous[name];
      }
    }
    clearCodexCapabilityCacheForTests();
  }
}

test('Codex Astra fallback exposes the app-server window, not the API marketing window', () => {
  for (const [profile, raw, usable, compact] of [
    ['standard', 272_000, 258_400, 244_800],
    ['long', 872_000, 828_400, 784_800],
  ]) {
    const capability = resolveCodexCapabilities({
      command: '/definitely/missing/codex',
      model: 'gpt-6-astra',
      contextProfile: profile,
      reasoningEffort: 'ultra',
      env: {},
    });
    assert.equal(capability.source, 'known-model');
    assert.equal(capability.resolvedRawContextTokens, raw);
    assert.equal(capability.usableContextTokens, usable);
    assert.equal(capability.autoCompactTokens, compact);
    assert.equal(capability.effortSupported, true);
    assert.deepEqual(capability.reasoningEfforts, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    assert.deepEqual(capability.toolOutputTruncationPolicy, { mode: 'tokens', limit: 10_000 });
  }
});

test('Codex 5.6 long context resolves to the current app-server maximum', () => {
  const capability = resolveCodexCapabilities({
    command: '/definitely/missing/codex',
    model: 'gpt-5.6-terra',
    contextProfile: 'long',
    reasoningEffort: 'max',
    env: {},
  });

  assert.equal(capability.source, 'known-model');
  assert.equal(capability.requestedRawContextTokens, 872_000);
  assert.equal(capability.resolvedRawContextTokens, 872_000);
  assert.equal(capability.usableContextTokens, 828_400);
  assert.equal(capability.autoCompactTokens, 784_800);
  assert.equal(capability.inputBudgetTokens, 752_800);
  assert.deepEqual(capability.toolOutputTruncationPolicy, {
    mode: 'tokens',
    limit: 10_000,
  });
  assert.equal(capability.effortSupported, true);
});

test('Astra raw context requests are capped at the Codex maximum', () => {
  const capability = resolveCodexCapabilities({
    command: '/definitely/missing/codex',
    model: 'gpt-6-astra',
    requestedContextWindow: 1_050_000,
    reasoningEffort: 'max',
    env: {},
  });

  assert.equal(capability.requestedRawContextTokens, 1_050_000);
  assert.equal(capability.resolvedRawContextTokens, 872_000);
  assert.equal(capability.usableContextTokens, 828_400);
});

test('gpt-5.4 literal 1M fallback remains deterministic without a catalog', () => {
  const capability = resolveCodexCapabilities({
    command: '/definitely/missing/codex',
    model: 'gpt-5.4',
    contextProfile: 'long',
    reasoningEffort: 'xhigh',
    env: {},
  });

  assert.equal(capability.source, 'known-model');
  assert.equal(capability.resolvedRawContextTokens, 1_000_000);
  assert.deepEqual(capability.reasoningEfforts, ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(capability.toolOutputTruncationPolicy, {
    mode: 'tokens',
    limit: 10_000,
  });
});

test('unknown model fallback retains Codex conservative byte policy metadata', () => {
  const capability = resolveCodexCapabilities({
    command: '/definitely/missing/codex',
    model: 'future-unknown-model',
    env: {},
  });

  assert.equal(capability.source, 'conservative-fallback');
  assert.deepEqual(capability.toolOutputTruncationPolicy, {
    mode: 'bytes',
    limit: 10_000,
  });
});

test('Codex capabilities reject unsupported model and effort combinations', () => {
  const capability = resolveCodexCapabilities({
    command: '/definitely/missing/codex',
    model: 'gpt-5.6-luna',
    contextProfile: 'standard',
    reasoningEffort: 'ultra',
    env: {},
  });

  assert.equal(capability.effortSupported, false);
  assert.deepEqual(capability.reasoningEfforts, ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('capability discovery uses the installed bundled catalog without an online refresh', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-capabilities-bundled-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const command = path.join(directory, 'codex');
  const log = path.join(directory, 'args.log');
  await makeExecutable(
    command,
    `#!/usr/bin/env node\n` +
      `const fs = require('node:fs');\n` +
      `fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');\n` +
      `process.stdout.write(JSON.stringify({models:[{slug:'custom-bundled',context_window:400000,max_context_window:600000,effective_context_window_percent:90,supported_reasoning_levels:[{effort:'high'}],truncation_policy:{mode:'tokens',limit:7777}}]}, null, 2));\n`
  );

  clearCodexCapabilityCacheForTests();
  const capability = resolveCodexCapabilities({
    command,
    model: 'custom-bundled',
    contextProfile: 'long',
    reasoningEffort: 'high',
    env: process.env,
  });

  assert.equal(capability.source, 'codex-catalog');
  assert.equal(capability.resolvedRawContextTokens, 600_000);
  assert.deepEqual(capability.toolOutputTruncationPolicy, {
    mode: 'tokens',
    limit: 7_777,
  });
  assert.equal(await fs.readFile(log, 'utf8'), 'debug models --bundled\n');
});

test('capability discovery and its cache honor the configured Codex cwd', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-capabilities-cwd-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const firstDirectory = path.join(root, 'first');
  const secondDirectory = path.join(root, 'second');
  await fs.mkdir(firstDirectory);
  await fs.mkdir(secondDirectory);
  for (const [directory, model] of [
    [firstDirectory, 'cwd-first'],
    [secondDirectory, 'cwd-second'],
  ]) {
    await makeExecutable(
      path.join(directory, 'codex'),
      `#!/usr/bin/env node\n` +
        `process.stdout.write(JSON.stringify({models:[{slug:${JSON.stringify(model)},context_window:400000,max_context_window:400000,effective_context_window_percent:95,supported_reasoning_levels:[]}]}));\n`
    );
  }

  clearCodexCapabilityCacheForTests();
  const first = resolveCodexCapabilities({
    command: './codex',
    cwd: firstDirectory,
    model: 'cwd-first',
    env: process.env,
  });
  const second = resolveCodexCapabilities({
    command: './codex',
    cwd: secondDirectory,
    model: 'cwd-second',
    env: process.env,
  });
  assert.equal(first.source, 'codex-catalog');
  assert.equal(second.source, 'codex-catalog');
  assert.equal(first.model, 'cwd-first');
  assert.equal(second.model, 'cwd-second');
});

test('catalog discovery rejects trailing stdout instead of trusting a JSON prefix', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-capabilities-trailing-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const command = path.join(directory, 'codex');
  await makeExecutable(
    command,
    `#!/usr/bin/env node\n` +
      `process.stdout.write(JSON.stringify({models:[{slug:'tainted',context_window:999999,truncation_policy:{mode:'tokens',limit:999999}}]}) + '\\ntrailing diagnostic');\n`
  );

  clearCodexCapabilityCacheForTests();
  const capability = resolveCodexCapabilities({ command, model: 'tainted', env: process.env });
  assert.equal(capability.source, 'conservative-fallback');
  assert.deepEqual(capability.toolOutputTruncationPolicy, {
    mode: 'bytes',
    limit: 10_000,
  });
});

test('capability discovery refreshes online only for a model missing from the bundled catalog', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-capabilities-online-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const command = path.join(directory, 'codex');
  const log = path.join(directory, 'args.log');
  await makeExecutable(
    command,
    `#!/usr/bin/env node\n` +
      `const fs = require('node:fs');\n` +
      `const args = process.argv.slice(2);\n` +
      `fs.appendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n');\n` +
      `const models = args.includes('--bundled') ? [] : [{slug:'custom-online',context_window:500000,max_context_window:1000000,effective_context_window_percent:95,supported_reasoning_levels:[]}];\n` +
      `process.stdout.write(JSON.stringify({models}));\n`
  );

  clearCodexCapabilityCacheForTests();
  const capability = resolveCodexCapabilities({
    command,
    model: 'custom-online',
    contextProfile: 'long',
    env: process.env,
  });

  assert.equal(capability.source, 'codex-catalog');
  assert.equal(capability.resolvedRawContextTokens, 1_000_000);
  assert.deepEqual(capability.toolOutputTruncationPolicy, {
    mode: 'bytes',
    limit: 10_000,
  });
  assert.equal(
    await fs.readFile(log, 'utf8'),
    'debug models --bundled\ndebug models\n'
  );
});

test('transient catalog failures expire while successful discovery stays cached', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-capabilities-negative-cache-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const command = path.join(directory, 'codex');
  const log = path.join(directory, 'args.log');
  const ready = path.join(directory, 'ready');
  await makeExecutable(
    command,
    `#!/usr/bin/env node\n` +
      `const fs = require('node:fs');\n` +
      `fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');\n` +
      `if (!fs.existsSync(${JSON.stringify(ready)})) process.exit(1);\n` +
      `process.stdout.write(JSON.stringify({models:[{slug:'recovered-model',context_window:500000,max_context_window:700000,effective_context_window_percent:95,supported_reasoning_levels:[]}]}));\n`
  );

  const realDateNow = Date.now;
  let now = realDateNow();
  Date.now = () => now;
  clearCodexCapabilityCacheForTests();
  try {
    const failed = resolveCodexCapabilities({
      command,
      model: 'recovered-model',
      contextProfile: 'long',
      env: process.env,
    });
    assert.equal(failed.source, 'conservative-fallback');
    assert.equal(
      await fs.readFile(log, 'utf8'),
      'debug models --bundled\ndebug models\n'
    );

    await fs.writeFile(ready, 'ready\n');
    const negativelyCached = resolveCodexCapabilities({
      command,
      model: 'recovered-model',
      contextProfile: 'long',
      env: process.env,
    });
    assert.equal(negativelyCached.source, 'conservative-fallback');
    assert.equal(
      await fs.readFile(log, 'utf8'),
      'debug models --bundled\ndebug models\n'
    );

    now += 60_000;
    const recovered = resolveCodexCapabilities({
      command,
      model: 'recovered-model',
      contextProfile: 'long',
      env: process.env,
    });
    assert.equal(recovered.source, 'codex-catalog');
    assert.equal(recovered.resolvedRawContextTokens, 700_000);
    assert.equal(
      await fs.readFile(log, 'utf8'),
      'debug models --bundled\ndebug models\ndebug models --bundled\n'
    );

    now += 24 * 60 * 60_000;
    const successCached = resolveCodexCapabilities({
      command,
      model: 'recovered-model',
      contextProfile: 'long',
      env: process.env,
    });
    assert.equal(successCached.source, 'codex-catalog');
    assert.equal(
      await fs.readFile(log, 'utf8'),
      'debug models --bundled\ndebug models\ndebug models --bundled\n'
    );
  } finally {
    Date.now = realDateNow;
    clearCodexCapabilityCacheForTests();
  }
});

test('capability cache follows replacement of the resolved Codex executable', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-capabilities-identity-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const command = path.join(directory, 'codex');
  const log = path.join(directory, 'args.log');
  const executable = (model, padding) =>
    `#!/usr/bin/env node\n` +
    `const fs = require('node:fs');\n` +
    `fs.appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(model)} + ':' + process.argv.slice(2).join(' ') + '\\n');\n` +
    `process.stdout.write(JSON.stringify({models:[{slug:${JSON.stringify(model)},context_window:500000,max_context_window:500000,effective_context_window_percent:95,supported_reasoning_levels:[]}]}));\n` +
    `// ${padding}\n`;
  await makeExecutable(command, executable('before-replacement', 'short'));

  clearCodexCapabilityCacheForTests();
  const initial = resolveCodexCapabilities({
    command,
    model: 'missing-before-replacement',
    env: process.env,
  });
  assert.equal(initial.source, 'conservative-fallback');

  await makeExecutable(
    command,
    executable('after-replacement', 'padding-that-changes-the-executable-file-identity')
  );
  const replaced = resolveCodexCapabilities({
    command,
    model: 'after-replacement',
    env: process.env,
  });
  assert.equal(replaced.source, 'codex-catalog');
  assert.equal(replaced.resolvedRawContextTokens, 500_000);
  assert.equal(
    await fs.readFile(log, 'utf8'),
    'before-replacement:debug models --bundled\n' +
      'before-replacement:debug models\n' +
      'after-replacement:debug models --bundled\n'
  );
});

test('capability cache distinguishes the effective default Codex home', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-capabilities-home-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const command = path.join(directory, 'codex');
  const firstHome = path.join(directory, 'first-home');
  const secondHome = path.join(directory, 'second-home');
  await fs.mkdir(firstHome);
  await fs.mkdir(secondHome);
  await makeExecutable(
    command,
    `#!/usr/bin/env node\n` +
      `const context = process.env.HOME.endsWith('first-home') ? 400000 : 600000;\n` +
      `process.stdout.write(JSON.stringify({models:[{slug:'home-sensitive',context_window:context,max_context_window:context,effective_context_window_percent:95,supported_reasoning_levels:[]}]}));\n`
  );

  clearCodexCapabilityCacheForTests();
  const first = resolveCodexCapabilities({
    command,
    model: 'home-sensitive',
    env: { ...process.env, HOME: firstHome, CODEX_HOME: undefined },
  });
  const second = resolveCodexCapabilities({
    command,
    model: 'home-sensitive',
    env: { ...process.env, HOME: secondHome, CODEX_HOME: undefined },
  });
  assert.equal(first.source, 'codex-catalog');
  assert.equal(second.source, 'codex-catalog');
  assert.equal(first.resolvedRawContextTokens, 400_000);
  assert.equal(second.resolvedRawContextTokens, 600_000);
});

test('workflow long context gives Claude the truthful Codex usable and compact windows', async () => {
  await withEnvironment(
    {
      ULTRATHINK_GATEWAY_CODEX_COMMAND: '/definitely/missing/codex',
      ULTRATHINK_GATEWAY_CODEX_CONTEXT: 'long',
    },
    () => {
      const workflow = buildWorkflowGatewayConfig();
      const clientEnv = buildWorkflowClientEnv(
        workflow.config,
        'http://127.0.0.1:4319',
        workflow.subagentModelId,
        workflow.mainModelId
      );

      assert.equal(workflow.config.codex.dynamicToolsOnly, true);
      assert.equal(workflow.config.codex.inputMaxTokens, 0);
      assert.equal(workflow.config.codex.autoCompactTokenLimit, 0);
      assert.equal(clientEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '828400');
      assert.equal(clientEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '784800');
      assert.equal(clientEnv.CLAUDE_CODE_EFFORT_LEVEL, null);
      assert.equal(clientEnv.ANTHROPIC_CUSTOM_MODEL_OPTION, 'codex-astra');
      assert.equal(clientEnv.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME, 'Codex Astra');
      assert.equal(
        clientEnv.ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES,
        'effort,xhigh_effort,max_effort'
      );
      assert.equal(clientEnv.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME, null);
      assert.equal(clientEnv.ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION, null);
      assert.equal(clientEnv.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude-opus-5');
      assert.equal(clientEnv.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME, null);
      assert.equal(clientEnv.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, '1');
      assert.equal(clientEnv.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME, 'Codex Astra');
      assert.equal(
        clientEnv.ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION,
        'codex:gpt-6-astra/max through claude-workflow'
      );
      assert.equal(
        clientEnv.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES,
        'effort,xhigh_effort,max_effort'
      );
      assert.deepEqual(
        buildWorkflowModelPicker(
          workflow.config,
          workflow.mainModelId,
          workflow.subagentModelId
        ),
        {
          options: [
            {
              model: 'claude-fable-5-1',
              label: 'Fable 5.1',
              description: 'Anthropic claude-fable-5-1',
            },
            {
              model: 'codex-astra',
              label: 'Codex Astra',
              description: 'codex:gpt-6-astra/max through Claude Workflow',
            },
          ],
          replaceBuiltInOptions: true,
        }
      );
      assert.equal(clientEnv.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK, '1');
      assert.equal(workflow.subagentModelId.includes('[1m]'), false);
    }
  );
});

test('bare gateway stays standard while claude-workflow defaults to truthful long context', async () => {
  await withEnvironment(
    { ULTRATHINK_GATEWAY_CODEX_COMMAND: '/definitely/missing/codex' },
    () => {
      const bare = loadGatewayConfig();
      assert.equal(bare.codex.contextProfile, 'standard');
      assert.equal(bare.codex.capabilities.usableContextTokens, 258_400);
      assert.equal(bare.codex.capabilities.inputBudgetTokens, 194_400);
      const workflow = buildWorkflowGatewayConfig();
      assert.equal(workflow.config.codex.contextProfile, 'long');
      assert.equal(workflow.config.codex.capabilities.usableContextTokens, 828_400);
      assert.equal(workflow.config.codex.capabilities.autoCompactTokens, 784_800);
    }
  );
});

test('workflow rejects Claude-family, native-alias, and bracket-qualified custom IDs', async () => {
  for (const modelId of [
    'claude-codex-terra',
    'claude_codex',
    'claude.codex',
    'claude/codex',
    'anthropic-codex-terra',
    'anthropic_codex',
    'anthropic.codex',
    'anthropic/codex',
    'best',
    'opus',
    'opusplan',
    'inherit',
    'codex-terra[1m]',
  ]) {
    await withEnvironment(
      {
        ULTRATHINK_GATEWAY_CODEX_COMMAND: '/definitely/missing/codex',
        CLAUDE_WORKFLOW_SUBAGENT_MODEL_ID: modelId,
      },
      () => {
        assert.throws(
          () => buildWorkflowGatewayConfig(),
          /truthful custom model ID without a Claude\/Anthropic prefix, native Claude alias, or bracket context qualifier/u
        );
      }
    );
  }
});

test('private Claude settings preserve a validated exact model picker', async () => {
  const settings = createPrivateClaudeSettingsOverride(
    { ANTHROPIC_MODEL: 'k3' },
    {
      options: [
        { model: 'k3', label: ' Kimi K3 ', description: ' Kimi K3 main route ' },
        { model: 'codex-terra', label: 'Codex Terra' },
      ],
      replaceBuiltInOptions: true,
    }
  );
  try {
    const contents = JSON.parse(await fs.readFile(settings.path, 'utf8'));
    assert.deepEqual(contents, {
      env: { ANTHROPIC_MODEL: 'k3' },
      modelPicker: {
        options: [
          { model: 'k3', label: 'Kimi K3', description: 'Kimi K3 main route' },
          { model: 'codex-terra', label: 'Codex Terra' },
        ],
        replaceBuiltInOptions: true,
      },
    });
  } finally {
    settings.cleanup();
  }
  await assert.rejects(fs.access(settings.path));

  for (const invalidPicker of [
    { options: [] },
    { options: [{ model: '' }] },
    { options: [{ model: 'k3', label: '' }] },
    { options: [{ model: 'k3' }], replaceBuiltInOptions: 'yes' },
  ]) {
    assert.throws(
      () => createPrivateClaudeSettingsOverride({}, invalidPicker),
      /Claude settings modelPicker/u
    );
  }
});

test('workflow rejects Claude-family and native-alias IDs for non-Anthropic main models', async () => {
  for (const [provider, modelId] of [
    ['codex', 'claude-codex'],
    ['kimi', 'claude-k3'],
    ['qwen', 'claude-qwen3.8-max'],
    ['codex', 'sonnet'],
  ]) {
    await withEnvironment(
      {
        ULTRATHINK_GATEWAY_CODEX_COMMAND: '/definitely/missing/codex',
        ULTRATHINK_GATEWAY_MAIN_MODEL_ID: modelId,
        ULTRATHINK_GATEWAY_MAIN_PROVIDER: provider,
      },
      () => {
        assert.throws(
          () => buildWorkflowGatewayConfig(),
          (error) => {
            assert.match(error.message, /ULTRATHINK_GATEWAY_MAIN_MODEL_ID/u);
            assert.match(
              error.message,
              /truthful custom model ID without a Claude\/Anthropic prefix, native Claude alias, or bracket context qualifier/u
            );
            return true;
          }
        );
      }
    );
  }
});

test('workflow resolves display-id wildcard overrides and derives route-specific capabilities', async () => {
  await withEnvironment(
    {
      ULTRATHINK_GATEWAY_CODEX_COMMAND: '/definitely/missing/codex',
      ULTRATHINK_GATEWAY_ROUTE_MAP_JSON: JSON.stringify({
        'codex-*': {
          provider: 'codex',
          model: 'gpt-5.4',
          reasoningEffort: 'xhigh',
        },
      }),
    },
    () => {
      const workflow = buildWorkflowGatewayConfig();
      assert.equal(workflow.subagentModelId, 'codex-gpt-5.4');
      assert.equal(workflow.subagentRoute.upstreamModel, 'gpt-5.4');
      assert.equal(workflow.subagentRoute.reasoningEffort, 'xhigh');
      assert.equal(workflow.subagentCapabilities.model, 'gpt-5.4');
      assert.equal(workflow.subagentCapabilities.usableContextTokens, 950_000);

      const clientEnv = buildWorkflowClientEnv(
        workflow.config,
        'http://127.0.0.1:4319',
        workflow.subagentModelId,
        workflow.mainModelId
      );
      assert.equal(clientEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '950000');
      assert.equal(clientEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '900000');
      assert.equal(
        clientEnv.ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES,
        'effort,xhigh_effort'
      );
      assert.equal(
        clientEnv.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES,
        'effort,xhigh_effort'
      );
    }
  );
});

test('workflow resolves raw subagent and Anthropic main wildcards before defaults', async () => {
  await withEnvironment(
    {
      ULTRATHINK_GATEWAY_CODEX_COMMAND: '/definitely/missing/codex',
      ULTRATHINK_GATEWAY_MAIN_MODEL_ID: 'claude-opus-5',
      ULTRATHINK_GATEWAY_ROUTE_MAP_JSON: JSON.stringify({
        'claude-sonnet-*': {
          provider: 'codex',
          model: 'gpt-5.4',
          reasoningEffort: 'xhigh',
        },
        'claude-opus-5*': {
          provider: 'anthropic',
          model: 'claude-opus-5-20260828',
        },
      }),
    },
    () => {
      const workflow = buildWorkflowGatewayConfig();
      assert.equal(workflow.mainModelId, 'claude-opus-5');
      assert.equal(
        resolveModelRoute(workflow.mainModelId, workflow.config).upstreamModel,
        'claude-opus-5-20260828'
      );
      assert.equal(workflow.subagentModelId, 'codex-gpt-5.4');
      assert.equal(workflow.subagentRoute.upstreamModel, 'gpt-5.4');
      assert.equal(workflow.subagentCapabilities.usableContextTokens, 950_000);
    }
  );
});

test('workflow evaluates deceptive main wildcards and rejects their Claude identity', async () => {
  await withEnvironment(
    {
      ULTRATHINK_GATEWAY_CODEX_COMMAND: '/definitely/missing/codex',
      ULTRATHINK_GATEWAY_MAIN_MODEL_ID: 'claude-opus-5',
      ULTRATHINK_GATEWAY_ROUTE_MAP_JSON: JSON.stringify({
        'claude-opus-5*': {
          provider: 'codex',
          model: 'gpt-5.6-sol',
          reasoningEffort: 'max',
        },
      }),
    },
    () => {
      assert.throws(
        () => buildWorkflowGatewayConfig(),
        /ULTRATHINK_GATEWAY_MAIN_MODEL_ID must be a truthful custom model ID/u
      );
    }
  );
});

test('workflow returns a fully resolved effective subagent route for partial overrides', async () => {
  await withEnvironment(
    {
      ULTRATHINK_GATEWAY_CODEX_COMMAND: '/definitely/missing/codex',
      ULTRATHINK_GATEWAY_ROUTE_MAP_JSON: JSON.stringify({
        'codex-astra': { provider: 'codex' },
      }),
    },
    () => {
      const workflow = buildWorkflowGatewayConfig();
      assert.equal(workflow.subagentRoute.provider, 'codex');
      assert.equal(workflow.subagentRoute.upstreamModel, 'gpt-6-astra');
      assert.equal(workflow.subagentRoute.reasoningEffort, 'max');
      assert.equal(
        routeTargetSummary(workflow.subagentRoute),
        'codex:gpt-6-astra/max'
      );
    }
  );
});

test('workflow derives its automatic Claude-facing ID after exact route overrides', async () => {
  await withEnvironment(
    {
      ULTRATHINK_GATEWAY_CODEX_COMMAND: '/definitely/missing/codex',
      ULTRATHINK_GATEWAY_ROUTE_MAP_JSON: JSON.stringify({
        'codex-astra': {
          provider: 'codex',
          model: 'gpt-5.4',
          reasoningEffort: 'xhigh',
        },
      }),
    },
    () => {
      const workflow = buildWorkflowGatewayConfig();
      assert.equal(workflow.subagentModelId, 'codex-gpt-5.4');
      assert.equal(workflow.subagentRoute.upstreamModel, 'gpt-5.4');
      assert.equal(workflow.subagentRoute.reasoningEffort, 'xhigh');
    }
  );
});

test('workflow derives an automatic direct-Codex main ID after route overrides', async () => {
  await withEnvironment(
    {
      ULTRATHINK_GATEWAY_CODEX_COMMAND: '/definitely/missing/codex',
      ULTRATHINK_GATEWAY_MAIN_MODEL_ID: 'codex',
      ULTRATHINK_GATEWAY_MAIN_PROVIDER: 'codex',
      ULTRATHINK_GATEWAY_MAIN_UPSTREAM_MODEL: 'gpt-5.6-terra',
      ULTRATHINK_GATEWAY_ROUTE_MAP_JSON: JSON.stringify({
        'codex-terra': {
          provider: 'codex',
          model: 'gpt-5.6-sol',
          reasoningEffort: 'max',
        },
      }),
    },
    () => {
      const workflow = buildWorkflowGatewayConfig();
      assert.equal(workflow.mainModelId, 'codex-sol');
      const route = resolveModelRoute(workflow.mainModelId, workflow.config);
      assert.equal(route.upstreamModel, 'gpt-5.6-sol');
      assert.equal(route.reasoningEffort, 'max');
    }
  );
});

test('workflow rejects a conflicting alias for an automatically derived model ID', async () => {
  await withEnvironment(
    {
      ULTRATHINK_GATEWAY_CODEX_COMMAND: '/definitely/missing/codex',
      ULTRATHINK_GATEWAY_ROUTE_MAP_JSON: JSON.stringify({
        'codex-astra': {
          provider: 'codex',
          model: 'gpt-5.4',
          reasoningEffort: 'xhigh',
        },
        'codex-gpt-5.4': {
          provider: 'codex',
          model: 'gpt-5.6-sol',
          reasoningEffort: 'max',
        },
      }),
    },
    () => {
      assert.throws(
        () => buildWorkflowGatewayConfig(),
        /remove the conflicting route-map alias/u
      );
    }
  );
});

test('workflow re-derives an automatic ID when an override changes providers', async () => {
  await withEnvironment(
    {
      ULTRATHINK_GATEWAY_CODEX_COMMAND: '/definitely/missing/codex',
      ULTRATHINK_GATEWAY_ROUTE_MAP_JSON: JSON.stringify({
        'codex-astra': {
          provider: 'anthropic',
          model: 'claude-sonnet-5',
        },
      }),
    },
    () => {
      const workflow = buildWorkflowGatewayConfig();
      assert.equal(workflow.subagentModelId, 'claude-sonnet-5');
      assert.equal(workflow.subagentRoute.provider, 'anthropic');
      assert.equal(workflow.subagentRoute.upstreamModel, 'claude-sonnet-5');
    }
  );
});

test('workflow rejects an explicit durable Codex alias for a different model', async () => {
  await withEnvironment(
    {
      CLAUDE_WORKFLOW_SUBAGENT_MODEL_ID: 'codex-terra',
      ULTRATHINK_GATEWAY_CODEX_COMMAND: '/definitely/missing/codex',
      ULTRATHINK_GATEWAY_SUBAGENT_REASONING_EFFORT: 'xhigh',
      ULTRATHINK_GATEWAY_SUBAGENT_UPSTREAM_MODEL: 'gpt-5.4',
    },
    () => {
      assert.throws(
        () => buildWorkflowGatewayConfig(),
        /codex-terra does not describe the resolved Codex model gpt-5\.4/u
      );
    }
  );
});

test('workflow rejects unsupported effort on an effective custom Codex route', async () => {
  await withEnvironment(
    {
      ULTRATHINK_GATEWAY_CODEX_COMMAND: '/definitely/missing/codex',
      ULTRATHINK_GATEWAY_ROUTE_MAP_JSON: JSON.stringify({
        'codex-terra': {
          provider: 'codex',
          model: 'gpt-5.4',
          reasoningEffort: 'max',
        },
      }),
    },
    () => {
      assert.throws(
        () => buildWorkflowGatewayConfig(),
        /Codex route codex-terra uses gpt-5\.4 with unsupported reasoning effort max/u
      );
    }
  );
});
