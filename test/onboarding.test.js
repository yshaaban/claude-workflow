import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  findExecutable,
  isWindowsMountedPath,
  rewriteConfigurationText,
  runDoctorCommand,
  runSetupCommand,
  validateSharedSetup,
  writeUserConfiguration,
} from '../js/cli/onboarding.js';
import {
  CLAUDE_WORKFLOW_MANAGED_SETTINGS_ENV_NAMES,
  prepareClaudeThirdPartyModelSupport,
} from '../js/utils/claude-config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'js', 'cli', 'claude-workflow.js');
const WORKFLOW_ENV_PREFIXES = [
  'ANTHROPIC_',
  'BAILIAN_',
  'CLAUDE_CODE_',
  'CLAUDE_WORKFLOW_',
  'CODEX_',
  'DEEPSEEK_',
  'DASHSCOPE_',
  'GLM_',
  'KIMI_',
  'QWEN_',
  'ULTRATHINK_',
  'ZAI_',
];

async function temporaryDirectory(t, prefix) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async function removeDirectory() {
    await fsp.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function isolatedEnvironment(home, extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (WORKFLOW_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      delete env[key];
    }
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    ...extra,
  };
}

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: options.cwd || ROOT,
    env: options.env || process.env,
    encoding: 'utf8',
    timeout: options.timeout || 15_000,
  });
}

function runCliAsync(args, options = {}) {
  return new Promise(function run(resolve, reject) {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: options.cwd || ROOT,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stderr, stdout }));
  });
}

async function installFakeNativeTools(root) {
  const bin = path.join(root, 'fake bin');
  await fsp.mkdir(bin);
  const claude = path.join(bin, 'claude');
  const codex = path.join(bin, 'codex');
  await fsp.writeFile(
    claude,
    [
      '#!/usr/bin/env bash',
      'if [ -n "${FAKE_NATIVE_ENV_FILE:-}" ]; then printf \'claude:%s|%s|%s|%s|%s|%s|%s\\n\' "$*" "${ULTRATHINK_GATEWAY_KIMI_API_KEY+x}" "${KIMI_API_KEY+x}" "${ULTRATHINK_GATEWAY_QWEN_API_KEY+x}" "${QWEN_API_KEY+x}" "${BAILIAN_TOKEN_PLAN_API_KEY+x}" "${DASHSCOPE_API_KEY+x}" >> "$FAKE_NATIVE_ENV_FILE"; fi',
      'if [ "${1:-}" = "--version" ]; then echo "${FAKE_CLAUDE_VERSION:-2.1.261} (Claude Code)"; exit 0; fi',
      'if [ "${1:-}" = "auth" ] && [ "${2:-}" = "status" ] && [ "${3:-}" = "--json" ]; then if [ "${FAKE_CLAUDE_LOGGED_OUT:-}" = "1" ]; then echo \'{"loggedIn":false}\'; exit 1; fi; echo \'{"loggedIn":true}\'; exit 0; fi',
      'if [ -n "${FAKE_CLAUDE_SETTINGS_CAPTURE_FILE:-}" ]; then _cw_args=("$@"); for ((_cw_i=0; _cw_i<${#_cw_args[@]}; _cw_i++)); do if [ "${_cw_args[$_cw_i]}" = "--settings" ]; then _cw_i=$((_cw_i + 1)); cp "${_cw_args[$_cw_i]}" "$FAKE_CLAUDE_SETTINGS_CAPTURE_FILE"; break; fi; done; fi',
      'if [ -n "${FAKE_CLAUDE_ARGS_FILE:-}" ]; then printf \'%s\\n\' "$@" > "$FAKE_CLAUDE_ARGS_FILE"; if [ -z "${FAKE_CLAUDE_ENV_FILE:-}" ]; then exit 0; fi; fi',
      'if [ -n "${FAKE_CLAUDE_ENV_FILE:-}" ]; then printf \'%s\\n\' "${ULTRATHINK_GATEWAY_KIMI_API_KEY-unset}" "${KIMI_API_KEY-unset}" "${ANTHROPIC_MODEL-unset}" "${CLAUDE_CODE_EFFORT_LEVEL-unset}" "${CLAUDE_CODE_AUTO_COMPACT_WINDOW-unset}" "${CLAUDE_CODE_MAX_CONTEXT_TOKENS-unset}" "${CLAUDE_WORKFLOW_GATEWAY_MANAGED_AUTH_TOKEN-unset}" "${ANTHROPIC_AUTH_TOKEN-unset}" "${ANTHROPIC_API_KEY-unset}" "${ULTRATHINK_GATEWAY_QWEN_API_KEY-unset}" "${QWEN_API_KEY-unset}" "${BAILIAN_TOKEN_PLAN_API_KEY-unset}" "${DASHSCOPE_API_KEY-unset}" "${CLAUDE_CODE_DISABLE_TERMINAL_TITLE-unset}" "${ANTHROPIC_CUSTOM_MODEL_OPTION-unset}" "${ANTHROPIC_CUSTOM_MODEL_OPTION_NAME-unset}" "${ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION-unset}" "${CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK-unset}" > "$FAKE_CLAUDE_ENV_FILE"; exit 0; fi',
      'exit 2',
      '',
    ].join('\n'),
    { mode: 0o755 }
  );
  await fsp.writeFile(
    codex,
    [
      '#!/usr/bin/env bash',
      'if [ -n "${FAKE_NATIVE_ENV_FILE:-}" ]; then printf \'codex:%s|%s|%s|%s|%s|%s|%s\\n\' "$*" "${ULTRATHINK_GATEWAY_KIMI_API_KEY+x}" "${KIMI_API_KEY+x}" "${ULTRATHINK_GATEWAY_QWEN_API_KEY+x}" "${QWEN_API_KEY+x}" "${BAILIAN_TOKEN_PLAN_API_KEY+x}" "${DASHSCOPE_API_KEY+x}" >> "$FAKE_NATIVE_ENV_FILE"; fi',
      'if [ "${1:-}" = "--version" ]; then echo "codex-cli ${FAKE_CODEX_VERSION:-0.153.4}"; exit 0; fi',
      'if [ "${1:-}" = "login" ] && [ "${2:-}" = "status" ]; then',
      '  if [ "${FAKE_CODEX_LOGGED_OUT:-}" = "1" ]; then echo "Not logged in"; exit 1; fi',
      '  echo "Logged in using ChatGPT"; exit 0',
      'fi',
      'exit 2',
      '',
    ].join('\n'),
    { mode: 0o755 }
  );
  return bin;
}

test('DeepSeek preset selects V4.1 Flash, keeps agent defaults, and needs no Claude login', async (t) => {
  const root = await temporaryDirectory(t, 'workflow-deepseek-config-');
  const home = path.join(root, 'home');
  await fsp.mkdir(home);
  const bin = await installFakeNativeTools(root);
  const env = isolatedEnvironment(home, { PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    FAKE_CLAUDE_LOGGED_OUT: '1', DEEPSEEK_API_KEY: 'test-only-deepseek' });
  for (const main of ['deepseek', 'deepseek-flash', 'deepseek-v4.1-flash']) {
    const result = runCli(['config', '--main', main], { env });
    assert.equal(result.status, 0, result.stderr);
    const saved = await fsp.readFile(path.join(home, '.claude-workflow.env'), 'utf8');
    assert.match(saved, /^ULTRATHINK_GATEWAY_MAIN_PROVIDER=deepseek$/mu);
    assert.match(saved, /^ULTRATHINK_GATEWAY_MAIN_UPSTREAM_MODEL=deepseek-flash$/mu);
    assert.match(saved, /^ULTRATHINK_GATEWAY_MAIN_REASONING_EFFORT=max$/mu);
    assert.doesNotMatch(saved, /test-only-deepseek/u);
  }
  const doctor = runCli(['doctor', '--json'], { env });
  assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
  assert.match(doctor.stdout, /deepseek-flash/u);
});

test('configuration rewriting preserves unmanaged content and line endings', function () {
  const original = [
    '# personal note',
    'UNMANAGED=value',
    'export ULTRATHINK_GATEWAY_CODEX_MODEL=old-model',
    'ULTRATHINK_GATEWAY_CODEX_MODEL=duplicate',
    'CLAUDE_WORKFLOW_SKIP_PERMISSIONS=true',
    '',
  ].join('\r\n');
  const rewritten = rewriteConfigurationText(
    original,
    { ULTRATHINK_GATEWAY_CODEX_MODEL: 'gpt-5.6-sol' },
    ['CLAUDE_WORKFLOW_SKIP_PERMISSIONS']
  );

  assert.equal(
    rewritten,
    [
      '# personal note',
      'UNMANAGED=value',
      'ULTRATHINK_GATEWAY_CODEX_MODEL=gpt-5.6-sol',
      '',
    ].join('\r\n')
  );
});

test(
  'configuration writes are atomic, private, idempotent, and Unicode-path safe',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude workflow إعداد ');
    const target = path.join(root, 'home with spaces', '.claude-workflow.env');
    await fsp.mkdir(path.dirname(target));
    await fsp.writeFile(target, '# keep me\nUNMANAGED=yes\n', { mode: 0o644 });
    await fsp.chmod(target, 0o644);

    const first = writeUserConfiguration(target, {
      ULTRATHINK_GATEWAY_SUBAGENT_UPSTREAM_MODEL: 'gpt-5.6-terra',
      CLAUDE_WORKFLOW_SKIP_PERMISSIONS: 'false',
    });
    assert.equal(first.changed, true);
    assert.equal((await fsp.stat(target)).mode & 0o777, 0o600);
    assert.match(await fsp.readFile(target, 'utf8'), /^# keep me\nUNMANAGED=yes\n/u);

    const second = writeUserConfiguration(target, {
      ULTRATHINK_GATEWAY_SUBAGENT_UPSTREAM_MODEL: 'gpt-5.6-terra',
      CLAUDE_WORKFLOW_SKIP_PERMISSIONS: 'false',
    });
    assert.equal(second.changed, false);
    assert.deepEqual((await fsp.readdir(path.dirname(target))).sort(), ['.claude-workflow.env']);
  }
);

test(
  'configuration writer accepts safe passthrough lists and rejects malformed entries',
  { skip: process.platform === 'win32' },
  async function (t) {
    const directory = await temporaryDirectory(t, 'claude-workflow-passthrough-config-');
    const target = path.join(directory, 'config.env');
    const key = 'ULTRATHINK_GATEWAY_ANTHROPIC_PASSTHROUGH_MODELS';
    const models = 'claude-fable-5-1*,claude-opus-5,claude-opus-5[1m],claude-opus-4-8,claude-opus-4-8[1m]';
    writeUserConfiguration(target, { [key]: models });
    const before = await fsp.readFile(target, 'utf8');
    assert.equal(before, `${key}=${models}\n`);
    for (const invalid of ['', 'claude-opus-5,', ',claude-opus-5', 'claude-opus-5,,claude-opus-4-8', 'claude-*-5', '*', 'claude-opus-5;echo', 'claude-opus-5\nOTHER=value']) {
      assert.throws(() => writeUserConfiguration(target, { [key]: invalid }), /invalid value/u);
      assert.equal(await fsp.readFile(target, 'utf8'), before);
    }
  }
);

test(
  'configuration writer refuses symlink targets',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-config-symlink-');
    const real = path.join(root, 'real.env');
    const link = path.join(root, 'linked.env');
    await fsp.writeFile(real, 'UNMANAGED=safe\n');
    await fsp.symlink(real, link);
    assert.throws(
      () => writeUserConfiguration(link, { CLAUDE_WORKFLOW_SKIP_PERMISSIONS: 'true' }),
      /regular file, not a symlink/u
    );
    assert.equal(await fsp.readFile(real, 'utf8'), 'UNMANAGED=safe\n');
  }
);

test(
  'Claude third-party-model preparation is a state-preserving compatibility no-op',
  { skip: process.platform === 'win32' },
  async function (t) {
    const home = await temporaryDirectory(t, 'claude-workflow-claude-state-');
    const target = path.join(home, '.claude.json');
    const original = '{\n  "theme": "dark"\n}\n';
    await fsp.writeFile(target, original, { mode: 0o644 });
    await fsp.chmod(target, 0o644);
    const settingsPath = path.join(home, '.claude', 'settings.json');
    await fsp.mkdir(path.dirname(settingsPath), { recursive: true });
    const originalSettings = `${JSON.stringify(
      {
        env: {
          ...Object.fromEntries(
            CLAUDE_WORKFLOW_MANAGED_SETTINGS_ENV_NAMES.map((name, index) => [
              name,
              `stale-routing-value-${index}`,
            ])
          ),
          CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
          UNRELATED_SETTING: 'preserved',
        },
        permissions: { allow: ['Read'] },
      },
      null,
      2
    )}\n`;
    await fsp.writeFile(settingsPath, originalSettings, { mode: 0o644 });
    await fsp.chmod(settingsPath, 0o644);
    const env = isolatedEnvironment(home);

    const prepared = prepareClaudeThirdPartyModelSupport(env);
    assert.equal(prepared.changed, false);
    assert.equal(prepared.stateChanged, false);
    assert.equal(prepared.settingsChanged, false);
    assert.equal(prepared.backupPath, null);
    assert.equal(prepared.settingsBackupPath, null);
    assert.equal(await fsp.readFile(target, 'utf8'), original);
    assert.equal(await fsp.readFile(settingsPath, 'utf8'), originalSettings);
    assert.equal((await fsp.stat(target)).mode & 0o777, 0o644);
    assert.equal((await fsp.stat(settingsPath)).mode & 0o777, 0o644);
    await assert.rejects(fsp.access(`${target}.claude-workflow.bak`));

    const repeated = prepareClaudeThirdPartyModelSupport(env);
    assert.equal(repeated.changed, false);
    assert.equal(repeated.backupPath, null);
    assert.equal(repeated.settingsBackupPath, null);
    assert.equal(await fsp.readFile(target, 'utf8'), original);
    await assert.rejects(fsp.access(`${settingsPath}.claude-workflow.bak`));
  }
);

test(
  'Claude third-party-model preparation does not inspect or mutate a symlinked state file',
  { skip: process.platform === 'win32' },
  async function (t) {
    const home = await temporaryDirectory(t, 'claude-workflow-claude-state-link-');
    const real = path.join(home, 'real.json');
    const target = path.join(home, '.claude.json');
    await fsp.writeFile(real, '{"preserved":true}\n');
    await fsp.symlink(real, target);
    const prepared = prepareClaudeThirdPartyModelSupport(isolatedEnvironment(home));
    assert.equal(prepared.changed, false);
    assert.equal(prepared.stateChanged, false);
    assert.equal(prepared.backupPath, null);
    assert.equal((await fsp.lstat(target)).isSymbolicLink(), true);
    assert.equal(await fsp.readFile(real, 'utf8'), '{"preserved":true}\n');
  }
);

test(
  'non-Anthropic launches ignore malformed and symlinked persistent user settings',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-settings-launch-');
    const bin = await installFakeNativeTools(root);

    for (const kind of ['malformed', 'symlink']) {
      const home = path.join(root, `${kind}-home`);
      const settingsDirectory = path.join(home, '.claude');
      const settingsPath = path.join(settingsDirectory, 'settings.json');
      const argsFile = path.join(root, `${kind}-args.txt`);
      await fsp.mkdir(settingsDirectory, { recursive: true });
      await fsp.writeFile(
        path.join(home, '.claude.json'),
        '{"hasCompletedOnboarding":true,"penguinModeOrgEnabled":true}\n'
      );
      if (kind === 'malformed') {
        await fsp.writeFile(settingsPath, '{not-json\n');
      } else {
        const realSettings = path.join(root, 'real-settings.json');
        await fsp.writeFile(realSettings, '{}\n');
        await fsp.symlink(realSettings, settingsPath);
      }

      const result = runCli(['Reply with exactly OK.'], {
        env: isolatedEnvironment(home, {
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          FAKE_CLAUDE_ARGS_FILE: argsFile,
          ULTRATHINK_GATEWAY_MAIN_MODEL_ID: 'codex',
          ULTRATHINK_GATEWAY_MAIN_PROVIDER: 'codex',
        }),
      });
      assert.equal(result.status, 0, `${kind}: ${result.stderr}`);
      const claudeArgs = (await fsp.readFile(argsFile, 'utf8')).trim().split('\n');
      assert.ok(claudeArgs.includes('--settings'));
      assert.ok(claudeArgs.includes('codex-astra'));
    }
  }
);

test(
  'Claude third-party-model preparation leaves settings untouched and creates no state',
  { skip: process.platform === 'win32' },
  async function (t) {
    const home = await temporaryDirectory(t, 'claude-workflow-claude-settings-link-');
    const settingsDirectory = path.join(home, '.claude');
    const real = path.join(home, 'real-settings.json');
    const settingsPath = path.join(settingsDirectory, 'settings.json');
    await fsp.mkdir(settingsDirectory);
    await fsp.writeFile(real, '{"env":{"ANTHROPIC_MODEL":"stale"}}\n');
    await fsp.symlink(real, settingsPath);
    const prepared = prepareClaudeThirdPartyModelSupport(isolatedEnvironment(home));
    assert.equal(prepared.changed, false);
    assert.equal(prepared.stateChanged, false);
    assert.equal(prepared.settingsChanged, false);
    assert.equal(fs.existsSync(path.join(home, '.claude.json')), false);
    assert.equal(
      await fsp.readFile(real, 'utf8'),
      '{"env":{"ANTHROPIC_MODEL":"stale"}}\n'
    );
  }
);

test('WSL path detection distinguishes mounted Windows paths', function () {
  assert.equal(isWindowsMountedPath('/mnt/c/Users/example/node'), true);
  assert.equal(isWindowsMountedPath('/MNT/D/tools/codex.EXE'), true);
  assert.equal(isWindowsMountedPath('/home/example/.local/bin/codex'), false);
  assert.equal(isWindowsMountedPath('/mnt/wsl/shared/codex'), false);
});

test(
  'WSL path detection recognizes custom DrvFS mounts',
  { skip: process.platform !== 'linux' },
  function () {
    const mountInfo =
      '36 25 0:32 / /work/windows rw,relatime - drvfs C:\\\\ rw,uid=1000,gid=1000\n';
    assert.equal(
      isWindowsMountedPath('/work/windows/projects/ultrathink', mountInfo),
      true
    );
    assert.equal(isWindowsMountedPath('/home/example/ultrathink', mountInfo), false);
  }
);

test(
  'setup validates fake native tools without creating configuration',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-setup-');
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    const bin = await installFakeNativeTools(root);
    const env = isolatedEnvironment(home, { PATH: `${bin}${path.delimiter}${process.env.PATH}` });

    const result = runCli(['setup'], { env });
    assert.equal(
      result.status,
      0,
      result.stderr || result.stdout || result.error?.message || `signal ${result.signal || 'none'}`
    );
    assert.match(result.stdout, /Claude Workflow setup/u);
    assert.match(result.stdout, /Claude Code .*authenticated/u);
    assert.match(result.stdout, /Codex CLI .*authenticated/u);
    assert.match(result.stdout, /Ready\. Run `claude-workflow`/u);
    assert.equal(fs.existsSync(path.join(home, '.claude-workflow.env')), false);

    const help = runCli(['setup', '--help'], { env });
    assert.equal(help.status, 0, help.stderr);
    assert.match(
      help.stdout,
      /--prepare-claude\s+Compatibility no-op for Claude state; custom models use documented per-session settings/u
    );
    assert.doesNotMatch(help.stdout, /Back up.*third-party-model support/u);
  }
);

test(
  'setup performs bounded upgrade maintenance without starting the shared daemon',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-setup-maintenance-');
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    const bin = await installFakeNativeTools(root);
    const env = isolatedEnvironment(home, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      CLAUDE_WORKFLOW_GATEWAY_MANAGED_AUTH_TOKEN: 'managed-auth',
      ANTHROPIC_API_KEY: 'managed-auth',
    });
    const actions = [];

    runSetupCommand([], {
      env,
      stdout: { write() { return true; } },
      runGatewayAction(action, actionOptions) {
        actions.push({ action, options: actionOptions });
      },
    });

    assert.deepEqual(
      actions.map(({ action }) => action),
      ['migrate-shell-upgrade', 'reconcile']
    );
    assert.equal(actions[0].options.quiet, true);
    assert.equal(actions[0].options.env, env);
    assert.equal(actions[1].options.quiet, true);
    assert.equal(actions[1].options.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(
      actions.some(({ action }) => action === 'start'),
      false,
      'ordinary setup must not start a stopped shared daemon'
    );
  }
);

test(
  'JSON setup diagnostics remain read-only',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-setup-json-');
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    const bin = await installFakeNativeTools(root);
    const actions = [];

    runSetupCommand(['--json'], {
      env: isolatedEnvironment(home, {
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      }),
      stdout: { write() { return true; } },
      runGatewayAction(action) {
        actions.push(action);
      },
    });

    assert.deepEqual(actions, []);
  }
);

test(
  'fresh per-session setup remains available without Bash',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-setup-no-bash-');
    const home = path.join(root, 'home');
    const bin = path.join(root, 'bin');
    await fsp.mkdir(home);
    await fsp.mkdir(bin);
    await fsp.symlink(process.execPath, path.join(bin, 'claude'));
    await fsp.symlink(process.execPath, path.join(bin, 'codex'));
    const actions = [];

    runSetupCommand([], {
      env: isolatedEnvironment(home, { PATH: bin }),
      stdout: { write() { return true; } },
      run(command, args) {
        if (path.basename(command) === 'claude' && args[0] === '--version') {
          return { status: 0, stdout: '2.1.261 (Claude Code)\n', stderr: '' };
        }
        if (path.basename(command) === 'claude' && args[0] === 'auth') {
          return { status: 0, stdout: '{"loggedIn":true}\n', stderr: '' };
        }
        if (path.basename(command) === 'codex' && args[0] === '--version') {
          return { status: 0, stdout: 'codex-cli 0.153.4\n', stderr: '' };
        }
        if (path.basename(command) === 'codex' && args[0] === 'login') {
          return { status: 0, stdout: 'Logged in using ChatGPT\n', stderr: '' };
        }
        return { status: 1, stdout: '', stderr: 'unexpected command' };
      },
      runGatewayAction(action) {
        actions.push(action);
      },
    });

    assert.deepEqual(actions, []);
  }
);

test(
  'setup stops before reconciliation when shell migration fails',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-setup-migration-failure-');
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    const bin = await installFakeNativeTools(root);
    const actions = [];

    assert.throws(
      () =>
        runSetupCommand([], {
          env: isolatedEnvironment(home, {
            PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          }),
          stdout: { write() { return true; } },
          runGatewayAction(action) {
            actions.push(action);
            throw new Error('migration failed');
          },
        }),
      /migration failed/u
    );
    assert.deepEqual(actions, ['migrate-shell-upgrade']);
  }
);

test(
  'setup surfaces reconciliation failures',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-setup-reconcile-failure-');
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    const bin = await installFakeNativeTools(root);
    const actions = [];

    assert.throws(
      () =>
        runSetupCommand([], {
          env: isolatedEnvironment(home, {
            PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          }),
          stdout: { write() { return true; } },
          runGatewayAction(action) {
            actions.push(action);
            if (action === 'reconcile') {
              throw new Error('reconciliation failed');
            }
          },
        }),
      /reconciliation failed/u
    );
    assert.deepEqual(actions, ['migrate-shell-upgrade', 'reconcile']);
  }
);

test(
  'shared setup rejects cwd-dependent Codex resolution without creating state',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-shared-relative-path-');
    const home = path.join(root, 'home');
    const caller = path.join(root, 'repo');
    const callerBin = path.join(caller, 'relative-bin');
    const stateDirectory = path.join(root, 'state');
    const absoluteBin = await installFakeNativeTools(root);
    await fsp.mkdir(home);
    await fsp.mkdir(callerBin, { recursive: true });
    await fsp.writeFile(
      path.join(callerBin, 'codex'),
      '#!/usr/bin/env bash\nexit 1\n',
      { mode: 0o755 }
    );
    const env = isolatedEnvironment(home, {
      CLAUDE_WORKFLOW_GATEWAY_STATE_DIR: stateDirectory,
      PATH: [
        './relative-bin',
        absoluteBin,
        process.env.PATH || '',
      ].join(path.delimiter),
    });

    assert.equal(
      findExecutable('codex', env, caller),
      path.join(callerBin, 'codex')
    );
    assert.throws(
      () => validateSharedSetup(env, caller),
      /set ULTRATHINK_GATEWAY_CODEX_COMMAND to an absolute executable path/u
    );
    const commands = [];
    const actions = [];
    assert.throws(
      () =>
        runSetupCommand(['--shared'], {
          cwd: caller,
          env,
          stdout: { write() { return true; } },
          run(command) {
            commands.push(command);
            return { status: 1, stdout: '', stderr: 'must not run' };
          },
          runGatewayAction(action) {
            actions.push(action);
          },
        }),
      /set ULTRATHINK_GATEWAY_CODEX_COMMAND to an absolute executable path/u
    );
    assert.deepEqual(commands, []);
    assert.deepEqual(actions, []);
    assert.equal(fs.existsSync(stateDirectory), false);
  }
);

test(
  'shared setup accepts harmless relative PATH entries before an absolute Codex path',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-shared-stable-path-');
    const home = path.join(root, 'home');
    const caller = path.join(root, 'repo');
    const stateDirectory = path.join(root, 'state');
    const absoluteBin = await installFakeNativeTools(root);
    await fsp.mkdir(home);
    await fsp.mkdir(caller);
    const env = isolatedEnvironment(home, {
      CLAUDE_WORKFLOW_GATEWAY_STATE_DIR: stateDirectory,
      PATH: [
        './missing-bin',
        absoluteBin,
        process.env.PATH || '',
      ].join(path.delimiter),
    });

    assert.doesNotThrow(() => validateSharedSetup(env, caller));
    assert.equal(fs.existsSync(stateDirectory), false);
  }
);

test(
  'shared setup schedules migration without requiring Bash or zsh as the active shell',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-shared-shell-');
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    const bin = await installFakeNativeTools(root);
    const env = isolatedEnvironment(home, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      SHELL: '/usr/bin/fish',
    });
    const actions = [];

    runSetupCommand(['--shared'], {
      env,
      stdout: { write() { return true; } },
      runGatewayAction(action) {
        actions.push(action);
      },
    });
    assert.deepEqual(actions, ['migrate-shell', 'start']);
  }
);

test(
  'shared setup delegates shell-rc resolution to migration before daemon start',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-shared-symlink-');
    const home = path.join(root, 'home');
    const blockingFile = path.join(root, 'not-a-directory');
    await fsp.mkdir(home);
    await fsp.writeFile(blockingFile, 'block');
    await fsp.symlink(path.join(blockingFile, '.bashrc'), path.join(home, '.bashrc'));
    const bin = await installFakeNativeTools(root);
    const env = isolatedEnvironment(home, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      SHELL: '/bin/bash',
    });
    const actions = [];

    runSetupCommand(['--shared'], {
      env,
      stdout: { write() { return true; } },
      runGatewayAction(action) {
        actions.push(action);
      },
    });
    assert.deepEqual(actions, ['migrate-shell', 'start']);
    assert.equal((await fsp.lstat(path.join(home, '.bashrc'))).isSymbolicLink(), true);
  }
);

test(
  'shared setup leaves repository Claude routing settings untouched',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-shared-routing-conflict-');
    const home = path.join(root, 'home');
    const project = path.join(root, 'repo');
    const nested = path.join(project, 'packages', 'app');
    const settingsPath = path.join(project, '.claude', 'settings.local.json');
    await fsp.mkdir(home);
    await fsp.mkdir(path.join(project, '.git'), { recursive: true });
    await fsp.mkdir(path.dirname(settingsPath));
    await fsp.mkdir(nested, { recursive: true });
    const settingsText = '{"env":{"ANTHROPIC_BASE_URL":"https://custom.invalid","ANTHROPIC_MODEL":"custom"}}\n';
    await fsp.writeFile(settingsPath, settingsText);
    const bin = await installFakeNativeTools(root);
    const env = isolatedEnvironment(home, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      SHELL: '/bin/bash',
    });
    const actions = [];

    runSetupCommand(['--shared'], {
      cwd: nested,
      env,
      stdout: { write() { return true; } },
      runGatewayAction(action) {
        actions.push(action);
      },
    });
    assert.deepEqual(actions, ['migrate-shell', 'start']);
    assert.equal(await fsp.readFile(settingsPath, 'utf8'), settingsText);
  }
);

test(
  'shared setup rejects repository environment loading',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-shared-project-env-');
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    const bin = await installFakeNativeTools(root);
    const actions = [];
    assert.throws(
      () =>
        runSetupCommand(['--shared'], {
          env: isolatedEnvironment(home, {
            CLAUDE_WORKFLOW_LOAD_PROJECT_ENV: 'true',
            PATH: `${bin}${path.delimiter}${process.env.PATH}`,
            SHELL: '/bin/bash',
          }),
          stdout: { write() { return true; } },
          runGatewayAction(action) {
            actions.push(action);
          },
        }),
      /shared mode cannot load a repository \.env/u
    );
    assert.deepEqual(actions, []);
  }
);

test(
  'shared setup rejects env and trace paths outside managed state',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-shared-owned-paths-');
    const home = path.join(root, 'home');
    const stateDirectory = path.join(root, 'state');
    await fsp.mkdir(home);
    const bin = await installFakeNativeTools(root);
    const baseEnv = isolatedEnvironment(home, {
      CLAUDE_WORKFLOW_GATEWAY_STATE_DIR: stateDirectory,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      SHELL: '/bin/bash',
    });
    assert.throws(
      () =>
        validateSharedSetup({
          ...baseEnv,
          CLAUDE_WORKFLOW_GATEWAY_ENV_FILE: path.join(root, 'external.env'),
        }),
      /must be exactly/u
    );
    assert.throws(
      () =>
        validateSharedSetup({
          ...baseEnv,
          ULTRATHINK_GATEWAY_TRACE_DIR: path.join(root, 'external-trace'),
        }),
      /shared-daemon ULTRATHINK_GATEWAY_TRACE_DIR/u
    );
  }
);

test(
  'shared setup validates trace paths against selected legacy state',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-shared-legacy-state-');
    const home = path.join(root, 'home');
    const legacyState = path.join(home, '.cache', 'ultrathink');
    await fsp.mkdir(legacyState, { recursive: true });
    await fsp.writeFile(
      path.join(legacyState, 'claude-workflow-gateway.env'),
      "export ANTHROPIC_BASE_URL='http://127.0.0.1:4318'\n"
    );
    const bin = await installFakeNativeTools(root);
    const env = isolatedEnvironment(home, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      SHELL: '/bin/bash',
      ULTRATHINK_GATEWAY_TRACE_DIR: path.join(legacyState, 'gateway-trace'),
    });
    assert.doesNotThrow(() => validateSharedSetup(env));
  }
);

test(
  'Linux setup rejects WSL home paths on mounted Windows storage',
  { skip: process.platform !== 'linux' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-wsl-platform-');
    const bin = await installFakeNativeTools(root);
    const env = isolatedEnvironment('/mnt/c/Users/example', {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      SHELL: '/bin/bash',
      WSL_DISTRO_NAME: 'Ubuntu',
    });

    const result = runCli(['setup'], { env });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /\[error\] Platform WSL/u);
    assert.match(result.stdout, /Home directory, Gateway state resolves to Windows or \/mnt storage/u);
  }
);

test(
  'Linux setup rejects WSL working directories on mounted Windows storage',
  { skip: process.platform !== 'linux' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-wsl-cwd-');
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    const bin = await installFakeNativeTools(root);
    const env = isolatedEnvironment(home, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      SHELL: '/bin/bash',
      WSL_DISTRO_NAME: 'Ubuntu',
    });
    let output = '';

    assert.throws(
      () =>
        runSetupCommand([], {
          cwd: '/mnt/c/Users/example/repository',
          env,
          stdout: {
            write(chunk) {
              output += String(chunk);
              return true;
            },
          },
        }),
      /setup checks failed/u
    );
    assert.match(output, /\[error\] Platform WSL/u);
    assert.match(output, /Working directory.*resolves to Windows or \/mnt storage/u);
  }
);

test(
  'Linux setup resolves WSL state paths through intermediate symlinks',
  { skip: process.platform !== 'linux' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-wsl-state-link-');
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    await fsp.symlink('/mnt/c/Users/example/workflow-state', path.join(home, 'state-link'));
    const bin = await installFakeNativeTools(root);
    const env = isolatedEnvironment(home, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      SHELL: '/bin/bash',
      WSL_DISTRO_NAME: 'Ubuntu',
      CLAUDE_WORKFLOW_GATEWAY_STATE_DIR: path.join(home, 'state-link', 'gateway'),
    });

    const result = runCli(['setup'], { env });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /\[error\] Platform WSL/u);
    assert.match(result.stdout, /Gateway state resolves to Windows or \/mnt storage/u);
  }
);

test(
  'setup fails promptly with actionable logged-out guidance',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-setup-logged-out-');
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    const bin = await installFakeNativeTools(root);
    const env = isolatedEnvironment(home, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      FAKE_CODEX_LOGGED_OUT: '1',
    });

    const result = runCli(['setup'], { env, timeout: 5_000 });
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}\n${result.stderr}`, /Run `codex login`/u);
    assert.equal(fs.existsSync(path.join(home, '.claude-workflow.env')), false);
  }
);

test(
  'Kimi setup does not require an Anthropic login',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-setup-kimi-auth-');
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    const bin = await installFakeNativeTools(root);
    const env = isolatedEnvironment(home, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      FAKE_CLAUDE_LOGGED_OUT: '1',
      ULTRATHINK_GATEWAY_KIMI_API_KEY: 'test-kimi-setup-key',
      ULTRATHINK_GATEWAY_MAIN_MODEL_ID: 'k3',
      ULTRATHINK_GATEWAY_MAIN_PROVIDER: 'kimi',
    });

    const withoutPreparation = runCli(['setup'], { env, timeout: 5_000 });
    assert.equal(withoutPreparation.status, 0, withoutPreparation.stderr);
    assert.match(
      `${withoutPreparation.stdout}\n${withoutPreparation.stderr}`,
      /custom model routing uses documented session settings/u
    );
    assert.equal(fs.existsSync(path.join(home, '.claude.json')), false);

    const result = runCli(['setup', '--prepare-claude'], { env, timeout: 5_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /provider authentication via gateway/u);
    assert.match(result.stdout, /No Claude state changes are required/u);
    assert.match(result.stdout, /documented per-session settings/u);
    assert.equal(fs.existsSync(path.join(home, '.claude.json')), false);
  }
);

test(
  'direct Codex setup does not require an Anthropic login',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-setup-codex-main-');
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    const bin = await installFakeNativeTools(root);
    const env = isolatedEnvironment(home, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      FAKE_CLAUDE_LOGGED_OUT: '1',
      ULTRATHINK_GATEWAY_MAIN_MODEL_ID: 'codex',
      ULTRATHINK_GATEWAY_MAIN_PROVIDER: 'codex',
    });

    const withoutPreparation = runCli(['setup'], { env, timeout: 5_000 });
    assert.equal(withoutPreparation.status, 0, withoutPreparation.stderr);
    assert.match(
      `${withoutPreparation.stdout}\n${withoutPreparation.stderr}`,
      /custom model routing uses documented session settings/u
    );
    assert.equal(fs.existsSync(path.join(home, '.claude.json')), false);

    const result = runCli(['setup', '--prepare-claude'], { env, timeout: 5_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /provider authentication via gateway/u);
    assert.match(result.stdout, /No Claude state changes are required/u);
    assert.equal(fs.existsSync(path.join(home, '.claude.json')), false);
  }
);

test(
  'setup rejects unsupported Claude Code versions before authentication',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-setup-old-claude-');
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    const bin = await installFakeNativeTools(root);
    const env = isolatedEnvironment(home, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      FAKE_CLAUDE_VERSION: '2.1.260',
    });

    const result = runCli(['setup'], { env });
    assert.equal(result.status, 1);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /requires Claude Code 2\.1\.261 or newer/u
    );
  }
);

test(
  'setup rejects unsupported Codex versions before authentication',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-setup-old-codex-');
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    const bin = await installFakeNativeTools(root);
    const env = isolatedEnvironment(home, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      FAKE_CODEX_VERSION: '0.153.3',
    });

    const result = runCli(['setup'], { env });
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}\n${result.stderr}`, /requires Codex CLI 0\.153\.4 or newer/u);
  }
);

test(
  'shared setup migrates historical shell routing before starting the daemon',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-shared-setup-');
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    const bin = await installFakeNativeTools(root);
    const env = isolatedEnvironment(home, { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
    const actions = [];
    let output = '';

    runSetupCommand(['--shared'], {
      env,
      stdout: {
        write(chunk) {
          output += String(chunk);
          return true;
        },
      },
      runGatewayAction(action, actionOptions) {
        actions.push({ action, env: actionOptions.env });
      },
    });

    assert.deepEqual(actions.map(({ action }) => action), ['migrate-shell', 'start']);
    assert.deepEqual(actions[1].env, env);
    assert.match(output, /cleanup-only mode/u);
    assert.match(output, /Source the migrated rc or open a new shell/u);
  }
);

test(
  'shared setup migrates inherited routing and starts the daemon from a clean environment',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-inherited-routing-');
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    const bin = await installFakeNativeTools(root);
    const managedBaseUrl = 'http://127.0.0.1:4318';
    const env = isolatedEnvironment(home, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      CLAUDE_WORKFLOW_GATEWAY_MANAGED_ENV_NAMES:
        'ANTHROPIC_BASE_URL CLAUDE_CODE_SUBAGENT_MODEL',
      CLAUDE_WORKFLOW_GATEWAY_MANAGED_ENV_SET_NAMES:
        'ANTHROPIC_BASE_URL CLAUDE_CODE_SUBAGENT_MODEL',
      CLAUDE_WORKFLOW_GATEWAY_MANAGED_VALUE_ANTHROPIC_BASE_URL: managedBaseUrl,
      CLAUDE_WORKFLOW_GATEWAY_MANAGED_VALUE_CLAUDE_CODE_SUBAGENT_MODEL: 'codex-terra',
      CLAUDE_WORKFLOW_GATEWAY_MANAGED_AUTH_TOKEN: 'managed-auth',
      ANTHROPIC_BASE_URL: managedBaseUrl,
      CLAUDE_CODE_SUBAGENT_MODEL: 'codex-terra',
      ANTHROPIC_API_KEY: 'managed-auth',
      KIMI_API_KEY: 'preserved-gateway-credential',
    });
    const actions = [];
    let output = '';

    runSetupCommand(['--shared'], {
      env,
      stdout: {
        write(chunk) {
          output += String(chunk);
          return true;
        },
      },
      runGatewayAction(action, actionOptions) {
        actions.push({ action, env: actionOptions.env });
      },
    });

    assert.deepEqual(actions.map(({ action }) => action), ['migrate-shell', 'start']);
    assert.equal(actions[0].env, env);
    assert.equal(actions[1].env.ANTHROPIC_BASE_URL, undefined);
    assert.equal(actions[1].env.CLAUDE_CODE_SUBAGENT_MODEL, undefined);
    assert.equal(actions[1].env.CLAUDE_WORKFLOW_GATEWAY_MANAGED_AUTH_TOKEN, undefined);
    assert.equal(actions[1].env.ANTHROPIC_API_KEY, undefined);
    assert.equal(actions[1].env.KIMI_API_KEY, 'preserved-gateway-credential');
    assert.match(output, /will be migrated/u);
  }
);

test(
  'doctor rejects inherited workflow routing with parent-shell migration guidance',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-doctor-routing-');
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    const bin = await installFakeNativeTools(root);
    const env = isolatedEnvironment(home, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4318',
      CLAUDE_CODE_SUBAGENT_MODEL: 'codex-terra',
    });
    let output = '';

    assert.throws(
      () =>
        runDoctorCommand([], {
          env,
          stdout: {
            write(chunk) {
              output += String(chunk);
              return true;
            },
          },
        }),
      /diagnostics failed/u
    );
    assert.match(output, /Inherited workflow-managed Claude routing/u);
    assert.match(output, /cannot change its parent shell/u);
    assert.match(output, /claude-workflow-gateway migrate-shell/u);
    assert.match(output, /open a new shell/u);
  }
);

test(
  'fresh defaults use Fable 5.1 and Astra/max while tier aliases retain their released generations',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-config-astra-');
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    const env = isolatedEnvironment(home, {
      ULTRATHINK_GATEWAY_CODEX_COMMAND: '/definitely/missing/codex',
    });

    const initial = runCli(['config', '--json'], { env });
    assert.equal(initial.status, 0, initial.stderr);
    const defaults = JSON.parse(initial.stdout);
    assert.equal(defaults.main.model, 'claude-fable-5-1');
    assert.equal(defaults.main.name, 'Fable 5.1');
    assert.equal(defaults.agents.model, 'gpt-6-astra');
    assert.equal(defaults.agents.displayModel, 'codex-astra');
    assert.equal(defaults.agents.name, 'Astra');
    assert.equal(defaults.agents.effort, 'max');
    assert.equal(defaults.agents.context, 'long');
    assert.equal(defaults.agents.contextTokens, 828_400);

    // Repeated transitions ensure aliases are not synthesized from the
    // previously selected generation, including an explicit future ID.
    for (const [alias, expected] of [
      ['terra', 'gpt-5.6-terra'],
      ['astra', 'gpt-6-astra'],
      ['sol', 'gpt-5.6-sol'],
      ['luna', 'gpt-5.6-luna'],
      ['gpt-9-custom', 'gpt-9-custom'],
      ['ASTRA', 'gpt-6-astra'],
      ['terra', 'gpt-5.6-terra'],
    ]) {
      const update = runCli(['config', '--agents', alias, '--effort', 'high'], { env });
      assert.equal(update.status, 0, update.stderr);
      const show = runCli(['config', '--json'], { env });
      assert.equal(show.status, 0, show.stderr);
      assert.equal(JSON.parse(show.stdout).agents.model, expected);
    }

    const reset = runCli(['config', '--reset'], { env });
    assert.equal(reset.status, 0, reset.stderr);
    const restored = runCli(['config', '--json'], { env });
    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(JSON.parse(restored.stdout).agents.model, 'gpt-6-astra');
  }
);

test(
  'one profile command repairs legacy Fable and Terra pins with native fallback routing',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-config-fable-migration-');
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    const configPath = path.join(home, '.claude-workflow.env');
    const legacy = [
      '# keep this user note',
      'ULTRATHINK_GATEWAY_MAIN_MODEL_ID=claude-fable-5',
      'ULTRATHINK_GATEWAY_MAIN_PROVIDER=anthropic',
      'ULTRATHINK_GATEWAY_MAIN_UPSTREAM_MODEL=claude-fable-5',
      'ULTRATHINK_GATEWAY_ANTHROPIC_PASSTHROUGH_MODELS=claude-fable-5*',
      'ULTRATHINK_GATEWAY_CODEX_MODEL=gpt-5.6-terra',
      'ULTRATHINK_GATEWAY_SUBAGENT_UPSTREAM_MODEL=gpt-5.6-terra',
      'ULTRATHINK_GATEWAY_SUBAGENT_REASONING_EFFORT=max',
      'CLAUDE_WORKFLOW_SUBAGENT_MODEL_ID=codex-terra',
      '',
    ].join('\n');
    await fsp.writeFile(configPath, legacy, { mode: 0o600 });
    const env = isolatedEnvironment(home, {
      ULTRATHINK_GATEWAY_CODEX_COMMAND: '/definitely/missing/codex',
    });
    const args = ['config', '--main', 'fable', '--agents', 'astra', '--effort', 'max', '--context', 'long'];
    const update = runCli(args, { env });
    assert.equal(update.status, 0, update.stderr);
    const content = await fsp.readFile(configPath, 'utf8');
    assert.match(content, /^# keep this user note\n/u);
    assert.match(content, /^ULTRATHINK_GATEWAY_ANTHROPIC_PASSTHROUGH_MODELS=claude-fable-5-1\*,claude-opus-5,claude-opus-5\[1m\],claude-opus-4-8,claude-opus-4-8\[1m\]$/mu);
    const show = runCli(['config', '--json'], { env });
    assert.equal(show.status, 0, show.stderr);
    const effective = JSON.parse(show.stdout);
    assert.equal(effective.main.model, 'claude-fable-5-1');
    assert.equal(effective.agents.model, 'gpt-6-astra');
    assert.equal(effective.agents.displayModel, 'codex-astra');
    assert.equal(effective.agents.effort, 'max');

    for (const commandArgs of [args, ['config', '--main', 'fable']]) {
      await fsp.writeFile(configPath, legacy, { mode: 0o600 });
      const conflict = runCli(commandArgs, {
        env: {
          ...env,
          ULTRATHINK_GATEWAY_ROUTE_MAP_JSON: JSON.stringify({
            'claude-opus-5': { provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'max' },
          }),
        },
      });
      assert.equal(conflict.status, 1);
      assert.match(conflict.stderr, /Native fallback.*requires claude-opus-5.*Anthropic/u);
      assert.equal(await fsp.readFile(configPath, 'utf8'), legacy);
    }
  }
);

test(
  'combined third-party and agent configuration remains available before storing provider keys',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-config-keyless-main-');
    for (const [preset, model] of [['kimi', 'k3'], ['qwen', 'qwen3.8-max']]) {
      const home = path.join(root, preset);
      await fsp.mkdir(home);
      const configPath = path.join(home, '.claude-workflow.env');
      await fsp.writeFile(configPath, [
        'ULTRATHINK_GATEWAY_MAIN_MODEL_ID=claude-fable-5',
        'ULTRATHINK_GATEWAY_MAIN_PROVIDER=anthropic',
        'ULTRATHINK_GATEWAY_ANTHROPIC_PASSTHROUGH_MODELS=claude-fable-5*',
        '',
      ].join('\n'), { mode: 0o600 });
      const update = runCli(['config', '--main', preset, '--agents', 'astra', '--effort', 'MAX'], {
        env: isolatedEnvironment(home, {
          ULTRATHINK_GATEWAY_CODEX_COMMAND: '/definitely/missing/codex',
        }),
      });
      assert.equal(update.status, 0, update.stderr);
      assert.match(update.stdout, /API_KEY/u);
      const content = await fsp.readFile(configPath, 'utf8');
      assert.ok(content.includes(`ULTRATHINK_GATEWAY_MAIN_MODEL_ID=${model}\n`));
      assert.ok(content.includes(`ULTRATHINK_GATEWAY_MAIN_PROVIDER=${preset}\n`));
      assert.match(content, /^ULTRATHINK_GATEWAY_ANTHROPIC_PASSTHROUGH_MODELS=none$/mu);
      assert.match(content, /^ULTRATHINK_GATEWAY_SUBAGENT_UPSTREAM_MODEL=gpt-6-astra$/mu);
      assert.match(content, /^ULTRATHINK_GATEWAY_SUBAGENT_REASONING_EFFORT=max$/mu);
      assert.doesNotMatch(content, /API_KEY=/u);
    }
  }
);

test(
  'config supports short names, reports effective values, and resets managed settings',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-config-command-');
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    const env = isolatedEnvironment(home);

    const update = runCli(
      ['config', '--main', 'fable', '--agents', 'sol', '--effort', 'high', '--permissions', 'prompt'],
      { env }
    );
    assert.equal(update.status, 0, update.stderr);
    const configPath = path.join(home, '.claude-workflow.env');
    const content = await fsp.readFile(configPath, 'utf8');
    assert.match(content, /^ULTRATHINK_GATEWAY_MAIN_MODEL_ID=claude-fable-5-1$/mu);
    assert.match(content, /ULTRATHINK_GATEWAY_SUBAGENT_UPSTREAM_MODEL=gpt-5\.6-sol/u);
    assert.match(content, /ULTRATHINK_GATEWAY_SUBAGENT_REASONING_EFFORT=high/u);
    assert.match(content, /CLAUDE_WORKFLOW_SKIP_PERMISSIONS=false/u);
    assert.equal((await fsp.stat(configPath)).mode & 0o777, 0o600);

    const show = runCli(['config'], { env });
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, /Main\s+Fable 5\.1 -> anthropic \(claude-fable-5-1\)/u);
    assert.match(show.stdout, /Agents\s+Sol -> codex \(gpt-5\.6-sol\)/u);
    assert.match(show.stdout, /Reasoning\s+high/u);
    assert.match(show.stdout, /Permissions\s+prompt/u);

    const opus = runCli(['config', '--main', 'opus'], { env });
    assert.equal(opus.status, 0, opus.stderr);
    assert.match(
      await fsp.readFile(configPath, 'utf8'),
      /ULTRATHINK_GATEWAY_MAIN_MODEL_ID=claude-opus-5/u
    );
    const opusShow = runCli(['config'], { env });
    assert.equal(opusShow.status, 0, opusShow.stderr);
    assert.match(opusShow.stdout, /Main\s+Opus 5 -> anthropic \(claude-opus-5\)/u);

    const reset = runCli(['config', '--reset'], { env });
    assert.equal(reset.status, 0, reset.stderr);
    assert.equal(await fsp.readFile(configPath, 'utf8'), '');
  }
);

test(
  'config selects Kimi K3/max without a synthetic model qualifier or stored credential',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-config-kimi-');
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    const env = isolatedEnvironment(home);

    const update = runCli(['config', '--main', 'kimi'], { env });
    assert.equal(update.status, 0, update.stderr);
    assert.match(update.stdout, /ULTRATHINK_GATEWAY_KIMI_API_KEY/u);
    assert.doesNotMatch(update.stdout, /setup --prepare-claude/u);

    const configPath = path.join(home, '.claude-workflow.env');
    const content = await fsp.readFile(configPath, 'utf8');
    assert.match(content, /ULTRATHINK_GATEWAY_MAIN_PROVIDER=kimi/u);
    assert.match(content, /^ULTRATHINK_GATEWAY_MAIN_MODEL_ID=k3$/mu);
    assert.match(content, /ULTRATHINK_GATEWAY_MAIN_UPSTREAM_MODEL=k3/u);
    assert.match(content, /ULTRATHINK_GATEWAY_MAIN_REASONING_EFFORT=max/u);
    assert.match(content, /ULTRATHINK_GATEWAY_KIMI_CONTEXT_TOKENS=1048576/u);
    assert.doesNotMatch(content, /KIMI_API_KEY=/u);

    const moderate = runCli(['config', '--main', 'k3'], { env });
    assert.equal(moderate.status, 0, moderate.stderr);
    const moderateContent = await fsp.readFile(configPath, 'utf8');
    assert.match(moderateContent, /ULTRATHINK_GATEWAY_MAIN_MODEL_ID=k3$/mu);
    assert.match(moderateContent, /ULTRATHINK_GATEWAY_KIMI_CONTEXT_TOKENS=262144/u);

    const oneMillion = runCli(['config', '--main', 'kimi'], { env });
    assert.equal(oneMillion.status, 0, oneMillion.stderr);
    const oneMillionContent = await fsp.readFile(configPath, 'utf8');
    assert.match(oneMillionContent, /^ULTRATHINK_GATEWAY_MAIN_MODEL_ID=k3$/mu);
    assert.match(oneMillionContent, /ULTRATHINK_GATEWAY_KIMI_CONTEXT_TOKENS=1048576/u);

    const fakeKey = 'test-kimi-config-key';
    await fsp.appendFile(
      configPath,
      `ULTRATHINK_GATEWAY_KIMI_API_KEY=${fakeKey}\n`,
      'utf8'
    );
    const show = runCli(['config'], {
      env: { ...env, ULTRATHINK_GATEWAY_KIMI_API_KEY: fakeKey },
    });
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, /Main\s+Kimi K3 -> kimi \(k3\)/u);

    const reset = runCli(['config', '--reset'], { env });
    assert.equal(reset.status, 0, reset.stderr);
    assert.equal(
      (await fsp.readFile(configPath, 'utf8')).trim(),
      `ULTRATHINK_GATEWAY_KIMI_API_KEY=${fakeKey}`
    );
  }
);

test(
  'config rejects unsupported model and effort combinations before writing',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-config-effort-');
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    const env = isolatedEnvironment(home);
    const configPath = path.join(home, '.claude-workflow.env');

    for (const args of [
      ['config', '--agents', 'luna', '--effort', 'ultra'],
      ['config', '--agents', 'terra', '--effort', 'minimal'],
    ]) {
      const result = runCli(args, { env });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /does not support Codex reasoning effort/u);
      assert.equal(fs.existsSync(configPath), false);
    }

    const supported = runCli(['config', '--agents', 'luna', '--effort', 'max'], { env });
    assert.equal(supported.status, 0, supported.stderr);
    assert.match(
      await fsp.readFile(configPath, 'utf8'),
      /ULTRATHINK_GATEWAY_SUBAGENT_REASONING_EFFORT=max/u
    );

    const beforeModelOnlyChange = await fsp.readFile(configPath, 'utf8');
    const incompatibleModelOnly = runCli(
      ['config', '--agents', 'gpt-5.4'],
      { env }
    );
    assert.equal(incompatibleModelOnly.status, 1);
    assert.match(
      incompatibleModelOnly.stderr,
      /gpt-5\.4 does not support Codex reasoning effort max/u
    );
    assert.equal(await fsp.readFile(configPath, 'utf8'), beforeModelOnlyChange);
  }
);

test(
  'config reports the final overridden subagent route and its own context contract',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-config-effective-route-');
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    const env = isolatedEnvironment(home, {
      ULTRATHINK_GATEWAY_CODEX_COMMAND: '/definitely/missing/codex',
      ULTRATHINK_GATEWAY_ROUTE_MAP_JSON: JSON.stringify({
        'codex-astra': {
          provider: 'codex',
          model: 'gpt-5.4',
          reasoningEffort: 'xhigh',
        },
      }),
    });

    const result = runCli(['config', '--json'], { env });
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.agents.displayModel, 'codex-gpt-5.4');
    assert.equal(summary.agents.model, 'gpt-5.4');
    assert.equal(summary.agents.effort, 'xhigh');
    assert.equal(summary.agents.context, 'long');
    assert.equal(summary.agents.contextTokens, 950_000);
  }
);

test(
  'agent config blank-shadows a stale legacy Claude-facing alias',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-config-legacy-alias-');
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    await fsp.writeFile(
      path.join(home, '.ultrathink.env'),
      [
        'CLAUDE_WORKFLOW_SUBAGENT_MODEL_ID=codex-terra',
        'ULTRATHINK_GATEWAY_CODEX_MODEL=gpt-5.6-terra',
        'ULTRATHINK_GATEWAY_SUBAGENT_UPSTREAM_MODEL=gpt-5.6-terra',
        'ULTRATHINK_GATEWAY_SUBAGENT_REASONING_EFFORT=max',
        '',
      ].join('\n'),
      { mode: 0o600 }
    );
    await fsp.writeFile(
      path.join(home, '.claude-workflow.env'),
      [
        'ULTRATHINK_GATEWAY_CODEX_MODEL=gpt-5.4',
        'ULTRATHINK_GATEWAY_SUBAGENT_UPSTREAM_MODEL=gpt-5.4',
        'ULTRATHINK_GATEWAY_SUBAGENT_REASONING_EFFORT=max',
        '',
      ].join('\n'),
      { mode: 0o600 }
    );
    const env = isolatedEnvironment(home, {
      ULTRATHINK_GATEWAY_CODEX_COMMAND: '/definitely/missing/codex',
    });

    const update = runCli(
      ['config', '--agents', 'gpt-5.4', '--effort', 'xhigh'],
      { env }
    );
    assert.equal(update.status, 0, update.stderr);
    const primary = await fsp.readFile(path.join(home, '.claude-workflow.env'), 'utf8');
    assert.match(primary, /^CLAUDE_WORKFLOW_SUBAGENT_MODEL_ID=$/mu);
    assert.match(primary, /^ULTRATHINK_GATEWAY_SUBAGENT_REASONING_EFFORT=xhigh$/mu);

    const show = runCli(['config', '--json'], { env });
    assert.equal(show.status, 0, show.stderr);
    assert.equal(JSON.parse(show.stdout).agents.displayModel, 'codex-gpt-5.4');
  }
);

test(
  'agent config repairs a stale direct-Codex main ID before validating the new fixed point',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-config-stale-codex-main-');
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    await fsp.writeFile(
      path.join(home, '.claude-workflow.env'),
      [
        'ULTRATHINK_GATEWAY_MAIN_PROVIDER=codex',
        'ULTRATHINK_GATEWAY_MAIN_MODEL_ID=codex-terra',
        'ULTRATHINK_GATEWAY_MAIN_UPSTREAM_MODEL=gpt-5.4',
        'ULTRATHINK_GATEWAY_MAIN_REASONING_EFFORT=max',
        'ULTRATHINK_GATEWAY_ANTHROPIC_PASSTHROUGH_MODELS=none',
        'ULTRATHINK_GATEWAY_CODEX_MODEL=gpt-5.4',
        'ULTRATHINK_GATEWAY_SUBAGENT_UPSTREAM_MODEL=gpt-5.4',
        'ULTRATHINK_GATEWAY_SUBAGENT_REASONING_EFFORT=max',
        'CLAUDE_WORKFLOW_SUBAGENT_MODEL_ID=codex-terra',
        '',
      ].join('\n'),
      { mode: 0o600 }
    );
    const env = isolatedEnvironment(home, {
      ULTRATHINK_GATEWAY_CODEX_COMMAND: '/definitely/missing/codex',
    });

    const update = runCli(
      ['config', '--agents', 'gpt-5.4', '--effort', 'xhigh'],
      { env }
    );
    assert.equal(update.status, 0, update.stderr);
    const primary = await fsp.readFile(path.join(home, '.claude-workflow.env'), 'utf8');
    assert.match(primary, /^ULTRATHINK_GATEWAY_MAIN_MODEL_ID=codex$/mu);
    assert.match(primary, /^CLAUDE_WORKFLOW_SUBAGENT_MODEL_ID=$/mu);

    const show = runCli(['config', '--json'], { env });
    assert.equal(show.status, 0, show.stderr);
    const summary = JSON.parse(show.stdout);
    assert.equal(summary.main.model, 'codex-gpt-5.4');
    assert.equal(summary.main.target, 'codex:gpt-5.4/xhigh');
    assert.equal(summary.agents.displayModel, 'codex-gpt-5.4');
  }
);

test(
  'effort-only config persists every identity repair used by its mutation preview',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-config-stale-effort-');
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    await fsp.writeFile(
      path.join(home, '.ultrathink.env'),
      ['CLAUDE_WORKFLOW_SUBAGENT_MODEL_ID=codex-terra', ''].join('\n'),
      { mode: 0o600 }
    );
    await fsp.writeFile(
      path.join(home, '.claude-workflow.env'),
      [
        'ULTRATHINK_GATEWAY_CODEX_MODEL=gpt-5.4',
        'ULTRATHINK_GATEWAY_SUBAGENT_UPSTREAM_MODEL=gpt-5.4',
        'ULTRATHINK_GATEWAY_SUBAGENT_REASONING_EFFORT=max',
        '',
      ].join('\n'),
      { mode: 0o600 }
    );
    const env = isolatedEnvironment(home, {
      ULTRATHINK_GATEWAY_CODEX_COMMAND: '/definitely/missing/codex',
    });

    const update = runCli(['config', '--effort', 'xhigh'], { env });
    assert.equal(update.status, 0, update.stderr);
    const primary = await fsp.readFile(path.join(home, '.claude-workflow.env'), 'utf8');
    assert.match(primary, /^CLAUDE_WORKFLOW_SUBAGENT_MODEL_ID=$/mu);

    const show = runCli(['config', '--json'], { env });
    assert.equal(show.status, 0, show.stderr);
    const summary = JSON.parse(show.stdout);
    assert.equal(summary.agents.displayModel, 'codex-gpt-5.4');
    assert.equal(summary.agents.effort, 'xhigh');
  }
);

test(
  'config selects a direct Codex main route and clears it when returning to Fable',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-config-codex-main-');
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    const env = isolatedEnvironment(home);

    const update = runCli(['config', '--main', 'codex'], { env });
    assert.equal(update.status, 0, update.stderr);
    assert.doesNotMatch(update.stdout, /setup --prepare-claude/u);

    const retune = runCli(['config', '--agents', 'sol', '--effort', 'ultra'], { env });
    assert.equal(retune.status, 0, retune.stderr);

    const configPath = path.join(home, '.claude-workflow.env');
    const content = await fsp.readFile(configPath, 'utf8');
    assert.match(content, /ULTRATHINK_GATEWAY_MAIN_MODEL_ID=codex/u);
    assert.match(content, /ULTRATHINK_GATEWAY_MAIN_PROVIDER=codex/u);
    assert.match(content, /ULTRATHINK_GATEWAY_MAIN_UPSTREAM_MODEL=gpt-5\.6-sol/u);
    assert.match(content, /ULTRATHINK_GATEWAY_MAIN_REASONING_EFFORT=ultra/u);
    assert.match(content, /ULTRATHINK_GATEWAY_SUBAGENT_UPSTREAM_MODEL=gpt-5\.6-sol/u);
    assert.match(content, /ULTRATHINK_GATEWAY_SUBAGENT_REASONING_EFFORT=ultra/u);

    const show = runCli(['config'], { env });
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, /Main\s+codex-sol -> codex \(codex-sol\)/u);
    const json = runCli(['config', '--json'], { env });
    assert.equal(json.status, 0, json.stderr);
    assert.equal(JSON.parse(json.stdout).main.target, 'codex:gpt-5.6-sol/ultra');

    const resetMain = runCli(['config', '--main', 'fable'], { env });
    assert.equal(resetMain.status, 0, resetMain.stderr);
    const resetContent = await fsp.readFile(configPath, 'utf8');
    assert.match(resetContent, /ULTRATHINK_GATEWAY_MAIN_PROVIDER=anthropic/u);
    assert.match(resetContent, /^ULTRATHINK_GATEWAY_MAIN_UPSTREAM_MODEL=claude-fable-5-1$/mu);
    assert.doesNotMatch(resetContent, /ULTRATHINK_GATEWAY_MAIN_REASONING_EFFORT=/u);
  }
);

test(
  'config selects Qwen 3.8 Max/xhigh with a plain wire id and no stored credential',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-config-qwen-');
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    await fsp.writeFile(
      path.join(home, '.ultrathink.env'),
      [
        'ULTRATHINK_GATEWAY_MAIN_PROVIDER=anthropic',
        'ULTRATHINK_GATEWAY_MAIN_MODEL_ID=claude-fable-5[1m]',
        'ULTRATHINK_GATEWAY_MAIN_UPSTREAM_MODEL=claude-fable-5',
        'ULTRATHINK_GATEWAY_MAIN_REASONING_EFFORT=low',
        'ULTRATHINK_GATEWAY_ANTHROPIC_PASSTHROUGH_MODELS=claude-fable-5*',
        'ULTRATHINK_GATEWAY_QWEN_CONTEXT_TOKENS=4096',
        'ULTRATHINK_GATEWAY_QWEN_MAX_OUTPUT_TOKENS=1024',
        'ULTRATHINK_GATEWAY_QWEN_MODEL=stale-qwen-model',
        'ULTRATHINK_GATEWAY_QWEN_REASONING_EFFORT=low',
        '',
      ].join('\n'),
      { mode: 0o600 }
    );
    const env = isolatedEnvironment(home);

    const update = runCli(['config', '--main', 'qwen'], { env });
    assert.equal(update.status, 0, update.stderr);
    assert.match(update.stdout, /ULTRATHINK_GATEWAY_QWEN_API_KEY/u);
    assert.doesNotMatch(update.stdout, /setup --prepare-claude/u);

    const configPath = path.join(home, '.claude-workflow.env');
    await fsp.appendFile(
      configPath,
      'ULTRATHINK_GATEWAY_ANTHROPIC_PASSTHROUGH_MODELS=claude-fable-5*\n',
      'utf8'
    );
    const ignoredAmbient = runCli(['config', '--main', 'qwen'], {
      env: { ...env, DASHSCOPE_API_KEY: 'sk-test-payg-key' },
    });
    assert.equal(ignoredAmbient.status, 0, ignoredAmbient.stderr);
    assert.match(ignoredAmbient.stdout, /ULTRATHINK_GATEWAY_QWEN_API_KEY/u);

    const content = await fsp.readFile(configPath, 'utf8');
    assert.match(content, /ULTRATHINK_GATEWAY_MAIN_PROVIDER=qwen/u);
    assert.match(content, /^ULTRATHINK_GATEWAY_MAIN_MODEL_ID=qwen3\.8-max$/mu);
    assert.match(content, /^ULTRATHINK_GATEWAY_MAIN_UPSTREAM_MODEL=qwen3\.8-max$/mu);
    assert.match(content, /^ULTRATHINK_GATEWAY_MAIN_REASONING_EFFORT=xhigh$/mu);
    assert.match(content, /^ULTRATHINK_GATEWAY_QWEN_CONTEXT_TOKENS=983616$/mu);
    assert.match(content, /^ULTRATHINK_GATEWAY_QWEN_MAX_OUTPUT_TOKENS=131072$/mu);
    assert.match(content, /^ULTRATHINK_GATEWAY_QWEN_MODEL=qwen3\.8-max$/mu);
    assert.match(content, /^ULTRATHINK_GATEWAY_QWEN_REASONING_EFFORT=xhigh$/mu);
    assert.match(content, /^ULTRATHINK_GATEWAY_ANTHROPIC_PASSTHROUGH_MODELS=none$/mu);
    assert.doesNotMatch(
      content,
      /^ULTRATHINK_GATEWAY_ANTHROPIC_PASSTHROUGH_MODELS=claude-fable-5\*$/mu
    );
    assert.doesNotMatch(content, /(?:QWEN|BAILIAN|DASHSCOPE).*API_KEY=/u);

    const fakeKey = 'sk-sp-test-qwen-config-key';
    await fsp.appendFile(
      configPath,
      `ULTRATHINK_GATEWAY_QWEN_API_KEY=${fakeKey}\n`,
      'utf8'
    );
    const insecure = runCli(['config', '--main', 'qwen'], {
      env: {
        ...env,
        ULTRATHINK_GATEWAY_QWEN_API_KEY: fakeKey,
        QWEN_BASE_URL: 'http://api.example.com/compatible-mode/v1',
      },
    });
    assert.equal(insecure.status, 0, insecure.stderr);
    assert.match(insecure.stdout, /use an HTTPS Qwen base URL/u);
    assert.doesNotMatch(insecure.stdout, /add ULTRATHINK_GATEWAY_QWEN_API_KEY/u);

    const show = runCli(['config'], {
      env: { ...env, ULTRATHINK_GATEWAY_QWEN_API_KEY: fakeKey },
    });
    assert.equal(show.status, 0, show.stderr);
    assert.match(
      show.stdout,
      /Main\s+Qwen 3\.8 Max -> qwen \(qwen3\.8-max\)/u
    );
    const json = runCli(['config', '--json'], {
      env: { ...env, ULTRATHINK_GATEWAY_QWEN_API_KEY: fakeKey },
    });
    assert.equal(json.status, 0, json.stderr);
    assert.equal(JSON.parse(json.stdout).main.target, 'qwen:qwen3.8-max/xhigh');

    const reset = runCli(['config', '--reset'], { env });
    assert.equal(reset.status, 0, reset.stderr);
    assert.equal(
      (await fsp.readFile(configPath, 'utf8')).trim(),
      `ULTRATHINK_GATEWAY_QWEN_API_KEY=${fakeKey}`
    );
  }
);

test(
  'concurrent config commands merge independent updates without leftover locks',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-config-concurrency-');
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    const env = isolatedEnvironment(home);
    const commands = [];
    for (let index = 0; index < 8; index += 1) {
      commands.push(runCliAsync(['config', '--agents', 'Vendor/CaseSensitive-ID'], { env }));
      commands.push(runCliAsync(['config', '--permissions', 'prompt'], { env }));
    }

    const results = await Promise.all(commands);
    for (const result of results) {
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    }

    const content = await fsp.readFile(path.join(home, '.claude-workflow.env'), 'utf8');
    assert.match(content, /ULTRATHINK_GATEWAY_CODEX_MODEL=Vendor\/CaseSensitive-ID/u);
    assert.match(content, /CLAUDE_WORKFLOW_SKIP_PERMISSIONS=false/u);
    assert.deepEqual((await fsp.readdir(home)).sort(), ['.claude-workflow.env']);
  }
);

test(
  'run dispatches a prompt that begins with a reserved command name',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-run-command-');
    const home = path.join(root, 'home');
    const argsFile = path.join(root, 'claude args.txt');
    await fsp.mkdir(home);
    const bin = await installFakeNativeTools(root);
    const env = isolatedEnvironment(home, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      FAKE_CLAUDE_ARGS_FILE: argsFile,
    });

    const result = runCli(['run', 'setup', 'the', 'repository'], { env });
    assert.equal(result.status, 0, result.stderr);
    const claudeArgs = (await fsp.readFile(argsFile, 'utf8')).trim().split('\n');
    assert.ok(claudeArgs.includes('-p'));
    assert.equal(claudeArgs.at(-1), 'setup the repository');
  }
);

test(
  'launcher rejects a caller-supplied Claude settings override',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-settings-override-');
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    const bin = await installFakeNativeTools(root);
    const result = runCli(['--', '--settings', path.join(root, 'unsafe.json')], {
      env: isolatedEnvironment(home, {
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      }),
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /reserved by claude-workflow/u);
  }
);

test('native Claude effort flags stay independent of the configured Codex effort',
  { skip: process.platform === 'win32' }, async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-native-effort-');
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    const bin = await installFakeNativeTools(root);
    const argsFile = path.join(root, 'claude args.txt');
    const settingsFile = path.join(root, 'private settings.json');
    const envFile = path.join(root, 'claude env.txt');
    const env = isolatedEnvironment(home, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      FAKE_CLAUDE_ARGS_FILE: argsFile,
      FAKE_CLAUDE_SETTINGS_CAPTURE_FILE: settingsFile,
      FAKE_CLAUDE_ENV_FILE: envFile,
      CLAUDE_CODE_EFFORT_LEVEL: 'max',
    });
    for (const main of ['fable', 'opus', 'codex']) {
      const configured = runCli(['config', '--main', main, '--agents', 'astra', '--effort', 'max'], { env });
      assert.equal(configured.status, 0, configured.stderr);
      for (const options of [['--effort', 'xhigh'], ['--effort=high']]) {
        const result = runCli(['--', ...options], { env });
        assert.equal(result.status, 0, result.stderr);
        const args = (await fsp.readFile(argsFile, 'utf8')).trim().split('\n');
        assert.deepEqual(args.slice(-options.length), options);
        const settings = JSON.parse(await fsp.readFile(settingsFile, 'utf8'));
        assert.equal(settings.env.CLAUDE_CODE_EFFORT_LEVEL, '');
        assert.equal((await fsp.readFile(envFile, 'utf8')).split('\n')[3], 'unset');
      }
      const summary = runCli(['config', '--json'], { env });
      assert.equal(summary.status, 0, summary.stderr);
      assert.equal(JSON.parse(summary.stdout).agents.effort, 'max');
    }
  });

test('provider-required client effort cannot be replaced by a native effort flag',
  { skip: process.platform === 'win32' }, async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-provider-effort-');
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    const bin = await installFakeNativeTools(root);
    const argsFile = path.join(root, 'must-not-launch.txt');
    const env = isolatedEnvironment(home, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      FAKE_CLAUDE_ARGS_FILE: argsFile,
      KIMI_API_KEY: 'test-kimi-effort-key',
      QWEN_API_KEY: 'sk-sp-test-qwen-effort-key',
    });
    for (const main of ['kimi', 'qwen']) {
      const configured = runCli(['config', '--main', main], { env });
      assert.equal(configured.status, 0, configured.stderr);
      for (const options of [['--effort', 'high'], ['--effort=xhigh']]) {
        const result = runCli(['--', ...options], { env });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /--effort is managed.*provider preset/u);
      }
    }
    await assert.rejects(fsp.access(argsFile));
  });

test('launcher rejects background Claude lifecycle flags before dispatch', function () {
  for (const args of [
    ['--', '--background'],
    ['--', '--bg'],
    ['--', '--background=true'],
    ['run', '--', '--background'],
    ['run', '--', '--bg'],
  ]) {
    const result = runCli(args, {
      env: isolatedEnvironment(os.tmpdir(), { PATH: '/usr/bin:/bin' }),
    });
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /is not supported because claude-workflow owns a per-session gateway/u
    );
    assert.match(result.stderr, /explicit durable gateway integration/u);
    assert.doesNotMatch(result.stderr, /claude CLI not found/u);
  }
});

test(
  'Kimi credentials stay gateway-only while Claude receives a native truthful profile',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-kimi-child-env-');
    const home = path.join(root, 'home');
    const envFile = path.join(root, 'claude env.txt');
    const nativeEnvFile = path.join(root, 'native child env.txt');
    const argsFile = path.join(root, 'claude args.txt');
    const settingsCapture = path.join(root, 'private settings.json');
    const project = path.join(root, 'repo');
    await fsp.mkdir(home);
    await fsp.mkdir(path.join(project, '.claude'), { recursive: true });
    const persistentSettings = '{"env":{"ANTHROPIC_BASE_URL":"https://stale.invalid","ANTHROPIC_MODEL":"stale","CLAUDE_CODE_EFFORT_LEVEL":"low"}}\n';
    await fsp.writeFile(path.join(project, '.claude', 'settings.json'), persistentSettings);
    const bin = await installFakeNativeTools(root);
    const fakeKey = 'test-kimi-child-secret';
    const env = isolatedEnvironment(home, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      FAKE_CLAUDE_ENV_FILE: envFile,
      FAKE_CLAUDE_ARGS_FILE: argsFile,
      FAKE_CLAUDE_SETTINGS_CAPTURE_FILE: settingsCapture,
      FAKE_NATIVE_ENV_FILE: nativeEnvFile,
      ULTRATHINK_GATEWAY_MAIN_PROVIDER: 'kimi',
      ULTRATHINK_GATEWAY_MAIN_MODEL_ID: 'k3',
      ULTRATHINK_GATEWAY_KIMI_API_KEY: fakeKey,
      KIMI_API_KEY: 'test-kimi-ambient-secret',
    });
    const prepared = prepareClaudeThirdPartyModelSupport(env);
    assert.equal(prepared.changed, false);
    assert.equal(prepared.stateChanged, false);
    assert.equal(fs.existsSync(path.join(home, '.claude.json')), false);

    const result = runCli(['Reply with exactly OK.'], { cwd: project, env });
    assert.equal(result.status, 0, result.stderr);
    const values = (await fsp.readFile(envFile, 'utf8')).trim().split('\n');
    assert.deepEqual(values.slice(0, 6), [
      'unset',
      'unset',
      'k3',
      'max',
      '784800',
      '828400',
    ]);
    assert.notEqual(values[6], 'unset');
    assert.equal(values[7], values[6]);
    assert.equal(values[8], values[6]);
    assert.equal(values[13], '1');
    assert.deepEqual(values.slice(14, 18), [
      'k3',
      'Kimi K3 Main Route',
      'kimi:k3/max through claude-workflow',
      '1',
    ]);
    assert.equal(`${result.stdout}\n${result.stderr}`.includes(fakeKey), false);
    const args = (await fsp.readFile(argsFile, 'utf8')).trim().split('\n');
    assert.ok(args.includes('--settings'));
    assert.deepEqual(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2), [
      '--effort',
      'max',
    ]);
    const privateSettings = JSON.parse(await fsp.readFile(settingsCapture, 'utf8'));
    assert.deepEqual(privateSettings.modelPicker, {
      options: [
        {
          model: 'k3',
          label: 'Kimi K3',
          description: 'kimi:k3/max through Claude Workflow',
        },
        {
          model: 'codex-astra',
          label: 'Codex Astra',
          description: 'codex:gpt-6-astra/max through Claude Workflow',
        },
      ],
      replaceBuiltInOptions: true,
    });
    assert.equal(privateSettings.env.ANTHROPIC_MODEL, 'k3');
    assert.equal(privateSettings.env.CLAUDE_CODE_EFFORT_LEVEL, 'max');
    assert.equal(privateSettings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '784800');
    assert.equal(privateSettings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '828400');
    assert.equal(privateSettings.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK, '1');
    assert.equal(privateSettings.env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE, '1');
    assert.equal(privateSettings.env.ANTHROPIC_CUSTOM_MODEL_OPTION, 'k3');
    assert.equal(privateSettings.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME, 'Kimi K3 Main Route');
    assert.equal(
      privateSettings.env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION,
      'kimi:k3/max through claude-workflow'
    );
    assert.equal(
      privateSettings.env.ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES,
      'effort,xhigh_effort,max_effort,thinking,adaptive_thinking,interleaved_thinking'
    );
    assert.equal(privateSettings.env.CLAUDE_CODE_SUBAGENT_MODEL, 'codex-astra');
    assert.equal(privateSettings.env.ULTRATHINK_GATEWAY_KIMI_API_KEY, '');
    assert.equal(privateSettings.env.KIMI_API_KEY, '');
    for (const name of [
      'ANTHROPIC_BETAS',
      'ANTHROPIC_CUSTOM_HEADERS',
      'CLAUDE_CODE_DISABLE_1M_CONTEXT',
      'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
      'CLAUDE_CODE_DISABLE_THINKING',
      'CLAUDE_CODE_USE_MANTLE',
    ]) {
      assert.equal(privateSettings.env[name], '');
    }
    assert.equal(privateSettings.env.ANTHROPIC_AUTH_TOKEN, values[6]);
    assert.equal(privateSettings.env.ANTHROPIC_API_KEY, values[6]);
    assert.equal(
      await fsp.readFile(path.join(project, '.claude', 'settings.json'), 'utf8'),
      persistentSettings
    );

    const doctor = runCli(['doctor'], { env });
    assert.equal(doctor.status, 0, doctor.stderr);
    const nativeChildRecords = (await fsp.readFile(nativeEnvFile, 'utf8'))
      .trim()
      .split('\n');
    assert.equal(nativeChildRecords.some((record) => record.startsWith('claude:')), true);
    assert.equal(nativeChildRecords.some((record) => record.startsWith('codex:')), true);
    for (const record of nativeChildRecords) {
      assert.match(record, /\|{6}$/u);
    }
  }
);

test(
  'Qwen credentials stay gateway-only while Claude receives a native truthful profile',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-qwen-child-env-');
    const home = path.join(root, 'home');
    const envFile = path.join(root, 'claude env.txt');
    const nativeEnvFile = path.join(root, 'native child env.txt');
    const argsFile = path.join(root, 'claude args.txt');
    const settingsCapture = path.join(root, 'private settings.json');
    await fsp.mkdir(home);
    const bin = await installFakeNativeTools(root);
    const fakeKey = 'sk-sp-test-qwen-child-secret';
    const env = isolatedEnvironment(home, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      FAKE_CLAUDE_ENV_FILE: envFile,
      FAKE_CLAUDE_ARGS_FILE: argsFile,
      FAKE_CLAUDE_SETTINGS_CAPTURE_FILE: settingsCapture,
      FAKE_NATIVE_ENV_FILE: nativeEnvFile,
      ULTRATHINK_GATEWAY_MAIN_PROVIDER: 'qwen',
      ULTRATHINK_GATEWAY_MAIN_MODEL_ID: 'qwen3.8-max',
      ULTRATHINK_GATEWAY_QWEN_API_KEY: fakeKey,
      QWEN_API_KEY: 'sk-sp-test-qwen-ambient-secret',
      BAILIAN_TOKEN_PLAN_API_KEY: 'sk-sp-test-bailian-ambient-secret',
      DASHSCOPE_API_KEY: 'sk-test-dashscope-ambient-secret',
    });
    const prepared = prepareClaudeThirdPartyModelSupport(env);
    assert.equal(prepared.changed, false);
    assert.equal(prepared.stateChanged, false);
    assert.equal(fs.existsSync(path.join(home, '.claude.json')), false);

    const result = runCli(['Reply with exactly OK.'], { env });
    assert.equal(result.status, 0, result.stderr);
    const values = (await fsp.readFile(envFile, 'utf8')).trim().split('\n');
    assert.deepEqual(values.slice(2, 6), [
      'qwen3.8-max',
      'max',
      '784800',
      '828400',
    ]);
    assert.notEqual(values[6], 'unset');
    assert.equal(values[7], values[6]);
    assert.equal(values[8], values[6]);
    assert.deepEqual(values.slice(9, 13), ['unset', 'unset', 'unset', 'unset']);
    assert.equal(values[13], '1');
    assert.deepEqual(values.slice(14, 18), [
      'qwen3.8-max',
      'Qwen 3.8 Max Main Route',
      'qwen:qwen3.8-max/xhigh through claude-workflow',
      '1',
    ]);
    assert.equal(`${result.stdout}\n${result.stderr}`.includes(fakeKey), false);

    const args = (await fsp.readFile(argsFile, 'utf8')).trim().split('\n');
    assert.deepEqual(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2), [
      '--effort',
      'max',
    ]);
    const privateSettings = JSON.parse(await fsp.readFile(settingsCapture, 'utf8'));
    assert.deepEqual(privateSettings.modelPicker, {
      options: [
        {
          model: 'qwen3.8-max',
          label: 'Qwen 3.8 Max',
          description: 'qwen:qwen3.8-max/xhigh through Claude Workflow',
        },
        {
          model: 'codex-astra',
          label: 'Codex Astra',
          description: 'codex:gpt-6-astra/max through Claude Workflow',
        },
      ],
      replaceBuiltInOptions: true,
    });
    assert.equal(privateSettings.env.ANTHROPIC_MODEL, 'qwen3.8-max');
    assert.equal(privateSettings.env.CLAUDE_CODE_EFFORT_LEVEL, 'max');
    assert.equal(privateSettings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '784800');
    assert.equal(privateSettings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '828400');
    assert.equal(privateSettings.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK, '1');
    assert.equal(privateSettings.env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE, '1');
    assert.equal(privateSettings.env.ANTHROPIC_CUSTOM_MODEL_OPTION, 'qwen3.8-max');
    assert.equal(
      privateSettings.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME,
      'Qwen 3.8 Max Main Route'
    );
    assert.equal(
      privateSettings.env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION,
      'qwen:qwen3.8-max/xhigh through claude-workflow'
    );
    assert.equal(
      privateSettings.env.ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES,
      'effort,xhigh_effort,max_effort,thinking,adaptive_thinking,interleaved_thinking'
    );
    for (const name of [
      'ULTRATHINK_GATEWAY_QWEN_API_KEY',
      'QWEN_API_KEY',
      'BAILIAN_TOKEN_PLAN_API_KEY',
      'DASHSCOPE_API_KEY',
    ]) {
      assert.equal(privateSettings.env[name], '');
    }

    const nativeChildRecords = (await fsp.readFile(nativeEnvFile, 'utf8'))
      .trim()
      .split('\n');
    assert.equal(nativeChildRecords.some((record) => record.startsWith('claude:')), true);
    assert.equal(nativeChildRecords.some((record) => record.startsWith('codex:')), true);
    for (const record of nativeChildRecords) {
      assert.match(record, /\|{6}$/u);
      assert.equal(record.includes(fakeKey), false);
    }
  }
);

test(
  'switching from Kimi to the Anthropic default removes stale Kimi client settings',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-fable-child-env-');
    const home = path.join(root, 'home');
    const envFile = path.join(root, 'claude env.txt');
    const settingsCapture = path.join(root, 'private settings.json');
    await fsp.mkdir(home);
    const bin = await installFakeNativeTools(root);
    const env = isolatedEnvironment(home, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      FAKE_CLAUDE_ENV_FILE: envFile,
      FAKE_CLAUDE_SETTINGS_CAPTURE_FILE: settingsCapture,
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1048576',
      CLAUDE_CODE_EFFORT_LEVEL: 'max',
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1048576',
      CLAUDE_WORKFLOW_GATEWAY_MANAGED_AUTH_TOKEN: 'stale-managed-token',
      ANTHROPIC_AUTH_TOKEN: 'stale-managed-token',
      ANTHROPIC_API_KEY: 'stale-managed-token',
    });

    const result = runCli(['Reply with exactly OK.'], { env });
    assert.equal(result.status, 0, result.stderr);
    const values = (await fsp.readFile(envFile, 'utf8')).trim().split('\n');
    assert.deepEqual(values, [
      'unset',
      'unset',
      'claude-fable-5-1',
      'unset',
      '784800',
      '828400',
      'unset',
      'unset',
      'unset',
      'unset',
      'unset',
      'unset',
      'unset',
      'unset',
      'codex-astra',
      'Codex Astra',
      'codex:gpt-6-astra/max through claude-workflow',
      '1',
    ]);
    const privateSettings = JSON.parse(await fsp.readFile(settingsCapture, 'utf8'));
    assert.deepEqual(privateSettings.modelPicker, {
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
    });
    assert.equal(privateSettings.env.ANTHROPIC_MODEL, 'claude-fable-5-1');
    assert.equal(privateSettings.env.CLAUDE_CODE_EFFORT_LEVEL, '');
    assert.equal(privateSettings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '784800');
    assert.equal(privateSettings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '828400');
    assert.equal(privateSettings.env.ANTHROPIC_CUSTOM_MODEL_OPTION, 'codex-astra');
    assert.equal(
      privateSettings.env.ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES,
      'effort,xhigh_effort,max_effort'
    );
    assert.equal(privateSettings.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK, '1');
    assert.equal(Object.hasOwn(privateSettings.env, 'ANTHROPIC_AUTH_TOKEN'), false);
    assert.equal(Object.hasOwn(privateSettings.env, 'ANTHROPIC_API_KEY'), false);
  }
);
