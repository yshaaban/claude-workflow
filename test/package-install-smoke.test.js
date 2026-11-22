import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_NAME = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8')).name;
const PACKAGE_PATH_PARTS = PACKAGE_NAME.split('/');
const PACKAGE_METADATA = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
const WORKFLOW_ENV_PREFIXES = [
  'ANTHROPIC_',
  'BAILIAN_',
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
];

assert.equal(PACKAGE_NAME, '@onetool/claude-workflow');
assert.notEqual(PACKAGE_METADATA.private, true);
assert.equal(PACKAGE_METADATA.publishConfig?.access, 'public');
assert.equal(PACKAGE_METADATA.publishConfig?.registry, 'https://registry.npmjs.org/');
assert.equal(PACKAGE_METADATA.workspaces, undefined);
for (const lifecycle of [
  'build',
  'install',
  'postinstall',
  'preinstall',
  'prepack',
  'prepare',
]) {
  assert.equal(
    PACKAGE_METADATA.scripts?.[lifecycle],
    undefined,
    `${lifecycle} would make npm prepare GitHub installs in a temporary clone`
  );
}

function isolatedWorkflowEnvironment(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (WORKFLOW_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      delete env[key];
    }
  }
  return { ...env, ...overrides };
}

function run(command, args, options = {}) {
  const env = { ...(options.env || process.env) };
  // `npm publish --dry-run` exports its dry-run setting to lifecycle scripts.
  // Nested pack/install commands in this smoke test must still create and use
  // the local artifact they are validating.
  delete env.npm_config_dry_run;
  delete env.NPM_CONFIG_DRY_RUN;
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    env,
    encoding: 'utf8',
    timeout: options.timeout || 120_000,
  });
  if (options.expectedStatus === undefined) {
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-workflow-package-'));
try {
  const packResult = run('npm', [
    'pack',
    '--json',
    '--ignore-scripts',
    '--pack-destination',
    temporaryRoot,
  ]);
  const packOutput = JSON.parse(packResult.stdout);
  const packMetadata = Array.isArray(packOutput)
    ? packOutput[0]
    : packOutput[PACKAGE_NAME] || Object.values(packOutput)[0];
  assert.ok(packMetadata, 'npm pack did not return package metadata');
  const packedPaths = new Set(packMetadata.files.map(function filePath(file) {
    return file.path;
  }));
  for (const requiredPath of [
    '.env.example',
    'CHANGELOG.md',
    'SECURITY.md',
    'SUPPORT.md',
    'docs/LARGE_FILES_AND_DIFFS.md',
    'docs/UPSTREAM_COMPATIBILITY.md',
    'js/cli/claude-workflow-managed-state.js',
    'js/cli/claude-workflow-runtime-revision.js',
    'js/gateway/codex-capabilities.js',
    'js/gateway/codex-tool-catalog.js',
    'js/gateway/provider-profiles.js',
    'js/utils/runtime-identity.js',
    'scripts/claude-workflow-daemon.sh',
    'scripts/reconcile-installed-daemon.mjs',
    'scripts/validate-local-install.mjs',
  ]) {
    assert.equal(packedPaths.has(requiredPath), true, `tarball is missing ${requiredPath}`);
  }

  const consumer = path.join(temporaryRoot, 'consumer');
  const home = path.join(temporaryRoot, 'home');
  const state = path.join(temporaryRoot, 'state');
  await fs.mkdir(consumer);
  await fs.mkdir(home);
  await fs.writeFile(
    path.join(consumer, 'package.json'),
    '{"name":"claude-workflow-install-smoke","private":true}',
    'utf8'
  );
  const tarball = path.join(temporaryRoot, packMetadata.filename);
  run(
    'npm',
    [
      'install',
      '--prefer-offline',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      tarball,
    ],
    { cwd: consumer }
  );

  const gatewayBin = path.join(
    consumer,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'claude-workflow-gateway.cmd' : 'claude-workflow-gateway'
  );
  const statusResult = run(gatewayBin, ['status'], {
    cwd: consumer,
    env: {
      ...process.env,
      HOME: home,
      XDG_STATE_HOME: path.join(home, '.state'),
      CLAUDE_WORKFLOW_GATEWAY_STATE_DIR: state,
      ULTRATHINK_GATEWAY_DAEMON_PORT: '65534',
    },
    expectedStatus: 1,
    timeout: 5_000,
  });
  assert.equal(statusResult.status, 1, statusResult.stderr);
  assert.match(`${statusResult.stdout}\n${statusResult.stderr}`, /not running/u);

  const globalPrefix = path.join(temporaryRoot, 'global-prefix');
  const globalHome = path.join(temporaryRoot, 'global-home');
  const qwenHome = path.join(temporaryRoot, 'qwen-home');
  const globalState = path.join(temporaryRoot, 'global-state');
  await fs.mkdir(globalHome);
  await fs.mkdir(qwenHome);
  run(
    'npm',
    [
      'install',
      '--global',
      '--install-links',
      '--prefer-offline',
      '--no-audit',
      '--no-fund',
      '--prefix',
      globalPrefix,
      tarball,
    ],
    {
      env: isolatedWorkflowEnvironment({
        HOME: globalHome,
        USERPROFILE: globalHome,
        CLAUDE_WORKFLOW_GATEWAY_STATE_DIR: globalState,
      }),
    }
  );

  if (process.platform !== 'win32') {
    const globalPackage = path.join(
      globalPrefix,
      'lib',
      'node_modules',
      ...PACKAGE_PATH_PARTS
    );
    assert.equal(
      (await fs.lstat(globalPackage)).isSymbolicLink(),
      false,
      'documented global install must not depend on the source checkout'
    );
  }

  const globalBinDirectory =
    process.platform === 'win32' ? globalPrefix : path.join(globalPrefix, 'bin');
  const workflowBin = path.join(
    globalBinDirectory,
    process.platform === 'win32' ? 'claude-workflow.cmd' : 'claude-workflow'
  );
  const globalGatewayBin = path.join(
    globalBinDirectory,
    process.platform === 'win32'
      ? 'claude-workflow-gateway.cmd'
      : 'claude-workflow-gateway'
  );
  run(workflowBin, ['--help']);
  const versionResult = run(workflowBin, ['--version']);
  assert.equal(versionResult.stdout.trim(), packMetadata.version);
  run(workflowBin, ['setup', '--help']);
  run(workflowBin, ['config', '--help']);
  const qwenConfigResult = run(workflowBin, ['config', '--main', 'qwen'], {
    env: isolatedWorkflowEnvironment({ HOME: qwenHome, USERPROFILE: qwenHome }),
  });
  assert.match(qwenConfigResult.stdout, /ULTRATHINK_GATEWAY_QWEN_API_KEY/u);
  const qwenConfigPath = path.join(qwenHome, '.claude-workflow.env');
  const qwenConfig = await fs.readFile(qwenConfigPath, 'utf8');
  assert.match(qwenConfig, /ULTRATHINK_GATEWAY_MAIN_PROVIDER=qwen/u);
  assert.match(qwenConfig, /ULTRATHINK_GATEWAY_MAIN_MODEL_ID=qwen3\.8-max/u);
  assert.doesNotMatch(qwenConfig, /API_KEY=/u);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(qwenConfigPath)).mode & 0o777, 0o600);
  }

  if (process.platform !== 'win32') {
    const fakeBin = path.join(temporaryRoot, 'fake-native-bin');
    await fs.mkdir(fakeBin);
    await fs.writeFile(
      path.join(fakeBin, 'claude'),
      '#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo "2.1.330 (Claude Code)"; elif [ "$1" = "auth" ] && [ "$2" = "status" ] && [ "$3" = "--json" ]; then echo \'{"loggedIn":true}\'; else exit 2; fi\n',
      { mode: 0o755 }
    );
    await fs.writeFile(
      path.join(fakeBin, 'codex'),
      '#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo "codex-cli 0.171.0"; elif [ "$1" = "login" ] && [ "$2" = "status" ]; then echo "Logged in using ChatGPT"; else exit 2; fi\n',
      { mode: 0o755 }
    );
    const setupResult = run(workflowBin, ['setup'], {
      env: isolatedWorkflowEnvironment({
        HOME: globalHome,
        USERPROFILE: globalHome,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      }),
      timeout: 15_000,
    });
    assert.match(setupResult.stdout, /Ready\. Run `claude-workflow`/u);
    assert.equal(
      await fs.stat(path.join(globalHome, '.claude-workflow.env')).then(
        () => true,
        () => false
      ),
      false,
      'zero-config setup must not create a user configuration file'
    );
  }

  const globalStatusResult = run(globalGatewayBin, ['status'], {
    env: {
      ...process.env,
      HOME: globalHome,
      XDG_STATE_HOME: path.join(globalHome, '.state'),
      CLAUDE_WORKFLOW_GATEWAY_STATE_DIR: globalState,
      ULTRATHINK_GATEWAY_DAEMON_PORT: '65533',
    },
    expectedStatus: 1,
    timeout: 5_000,
  });
  assert.equal(globalStatusResult.status, 1, globalStatusResult.stderr);
  assert.match(`${globalStatusResult.stdout}\n${globalStatusResult.stderr}`, /not running/u);

  process.stdout.write('Packed and self-contained global install smoke tests passed.\n');
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
