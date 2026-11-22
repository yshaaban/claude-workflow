import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_METADATA = JSON.parse(
  await fs.readFile(path.join(ROOT, 'package.json'), 'utf8')
);
const PACKAGE_PATH_PARTS = PACKAGE_METADATA.name.split('/');
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

function isolatedEnvironment(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (WORKFLOW_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      delete env[key];
    }
  }
  delete env.npm_config_dry_run;
  delete env.NPM_CONFIG_DRY_RUN;
  return { ...env, ...overrides };
}

function run(command, args, options = {}) {
  const env = { ...(options.env || process.env) };
  delete env.npm_config_dry_run;
  delete env.NPM_CONFIG_DRY_RUN;
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    env,
    encoding: 'utf8',
    timeout: options.timeout || 120_000,
  });
  if (options.expectedStatus === undefined) {
    assert.equal(
      result.status,
      0,
      `${command} ${args.join(' ')}\n${result.stdout || ''}\n${result.stderr || ''}`
    );
  } else {
    assert.equal(
      result.status,
      options.expectedStatus,
      `${command} ${args.join(' ')}\n${result.stdout || ''}\n${result.stderr || ''}`
    );
  }
  return result;
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

if (process.platform === 'win32') {
  process.stdout.write('GitHub global-install smoke test skipped on Windows.\n');
  process.exit(0);
}

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
    `${lifecycle} would trigger npm Git-package preparation`
  );
}

const temporaryRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), 'claude-workflow-github-install-')
);
const sourceArchiveDirectory = path.join(temporaryRoot, 'archive');
const gitRepository = path.join(temporaryRoot, 'git-repository');
const prefix = path.join(temporaryRoot, 'prefix');
const home = path.join(temporaryRoot, 'home');
const state = path.join(temporaryRoot, 'state');
const cache = path.join(temporaryRoot, 'npm-cache');
const fakeBin = path.join(temporaryRoot, 'fake-native-bin');
const daemonManager = path.join(ROOT, 'scripts', 'claude-workflow-daemon.sh');
const pidFile = path.join(state, 'claude-workflow-gateway.pid');
const port = await freePort();
let installedGateway = '';
let daemonEnvironment = null;

try {
  await Promise.all([
    fs.mkdir(sourceArchiveDirectory),
    fs.mkdir(gitRepository),
    fs.mkdir(prefix),
    fs.mkdir(home),
    fs.mkdir(cache),
    fs.mkdir(fakeBin),
  ]);

  const packed = run('npm', [
    'pack',
    '--json',
    '--ignore-scripts',
    '--pack-destination',
    sourceArchiveDirectory,
  ]);
  const packOutput = JSON.parse(packed.stdout);
  const packMetadata = Array.isArray(packOutput)
    ? packOutput[0]
    : packOutput[PACKAGE_METADATA.name] || Object.values(packOutput)[0];
  assert.ok(packMetadata, 'npm pack did not return package metadata');
  const archiveName = packMetadata.filename;
  run(
    'tar',
    [
      '-xzf',
      path.join(sourceArchiveDirectory, archiveName),
      '--strip-components=1',
      '-C',
      gitRepository,
    ],
    { cwd: temporaryRoot }
  );
  run('git', ['init', '--quiet'], { cwd: gitRepository });
  run('git', ['config', 'user.name', 'Claude Workflow Tests'], {
    cwd: gitRepository,
  });
  run('git', ['config', 'user.email', 'tests@invalid.example'], {
    cwd: gitRepository,
  });
  run('git', ['add', '--all'], { cwd: gitRepository });
  run('git', ['commit', '--quiet', '-m', 'package fixture'], {
    cwd: gitRepository,
  });

  daemonEnvironment = isolatedEnvironment({
    HOME: home,
    USERPROFILE: home,
    CLAUDE_WORKFLOW_GATEWAY_STATE_DIR: state,
    ULTRATHINK_GATEWAY_REQUEST_TIMEOUT_MS: '10000',
    ULTRATHINK_GATEWAY_DAEMON_PORT: String(port),
  });
  run('bash', [daemonManager, 'start'], {
    env: daemonEnvironment,
    timeout: 30_000,
  });
  const originalPid = Number((await fs.readFile(pidFile, 'utf8')).trim());
  assert.equal(processExists(originalPid), true);

  const shellRc = path.join(home, '.bashrc');
  const shellSentinel = '# user-owned shell content\n';
  await fs.writeFile(shellRc, shellSentinel, 'utf8');

  const installEnvironment = isolatedEnvironment({
    HOME: home,
    USERPROFILE: home,
    CLAUDE_WORKFLOW_GATEWAY_STATE_DIR: state,
    ULTRATHINK_GATEWAY_REQUEST_TIMEOUT_MS: '11000',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    npm_config_cache: cache,
    ULTRATHINK_GATEWAY_DAEMON_PORT: String(port),
  });
  run(
    'npm',
    [
      'install',
      '--global',
      '--allow-git=root',
      '--no-audit',
      '--no-fund',
      '--prefix',
      prefix,
      `git+${pathToFileURL(gitRepository).href}`,
    ],
    { env: installEnvironment, timeout: 180_000 }
  );

  const installedPackage = path.join(
    prefix,
    'lib',
    'node_modules',
    ...PACKAGE_PATH_PARTS
  );
  const installedStats = await fs.lstat(installedPackage);
  assert.equal(
    installedStats.isSymbolicLink(),
    false,
    'GitHub-style global install must not point into npm cache state'
  );
  assert.equal(
    JSON.parse(await fs.readFile(path.join(installedPackage, 'package.json'), 'utf8')).version,
    PACKAGE_METADATA.version
  );
  assert.equal(await fs.readFile(shellRc, 'utf8'), shellSentinel);
  assert.equal(Number((await fs.readFile(pidFile, 'utf8')).trim()), originalPid);
  assert.equal(processExists(originalPid), true, 'package installation must not stop the daemon');

  await fs.rm(gitRepository, { recursive: true, force: true });
  await fs.rm(cache, { recursive: true, force: true });

  const globalBin = path.join(prefix, 'bin');
  const installedWorkflow = path.join(globalBin, 'claude-workflow');
  installedGateway = path.join(globalBin, 'claude-workflow-gateway');
  assert.equal(fsSync.existsSync(installedWorkflow), true);
  assert.equal(fsSync.existsSync(installedGateway), true);
  assert.equal(run(installedWorkflow, ['--version']).stdout.trim(), PACKAGE_METADATA.version);

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

  const setupEnvironment = {
    ...installEnvironment,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
  };
  run(installedWorkflow, ['setup'], {
    cwd: temporaryRoot,
    env: setupEnvironment,
    timeout: 60_000,
  });
  const reconciledPid = Number((await fs.readFile(pidFile, 'utf8')).trim());
  assert.notEqual(reconciledPid, originalPid);
  assert.equal(processExists(reconciledPid), true);
  run(installedGateway, ['status'], {
    cwd: temporaryRoot,
    env: setupEnvironment,
    timeout: 30_000,
  });
  assert.equal(await fs.readFile(shellRc, 'utf8'), shellSentinel);

  process.stdout.write(
    'GitHub-style global install and explicit upgrade reconciliation passed.\n'
  );
} finally {
  if (installedGateway && daemonEnvironment) {
    spawnSync(installedGateway, ['stop'], {
      cwd: temporaryRoot,
      env: {
        ...daemonEnvironment,
        ULTRATHINK_GATEWAY_REQUEST_TIMEOUT_MS: '11000',
      },
      encoding: 'utf8',
      timeout: 30_000,
    });
  } else if (daemonEnvironment) {
    spawnSync('bash', [daemonManager, 'stop'], {
      cwd: ROOT,
      env: daemonEnvironment,
      encoding: 'utf8',
      timeout: 30_000,
    });
  }
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
