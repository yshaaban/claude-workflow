#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { envFlag, isGatewayLoopbackHost } from '../gateway/config.js';
import { resolveModelRoute } from '../gateway/model-routing.js';
import { createGatewayServer } from '../gateway/server.js';
import {
  buildWorkflowClientEnv,
  buildWorkflowGatewayConfig,
  buildWorkflowModelPicker,
  routeProvider,
  routeTargetSummary,
} from '../gateway/workflow-config.js';
import {
  checkClaudeVersion,
  checkWorkflowPlatform,
  runConfigCommand,
  runDoctorCommand,
  runSetupCommand,
} from './onboarding.js';
import {
  environmentWithoutGatewayAndAnthropicCredentials,
  environmentWithoutGatewayCredentials,
} from '../utils/child-env.js';
import {
  CLAUDE_WORKFLOW_MANAGED_SETTINGS_ENV_NAMES,
  buildClaudeSettingsOverrideEnvironment,
  createPrivateClaudeSettingsOverride,
} from '../utils/claude-config.js';

const SIGNAL_NUMBERS = {
  SIGINT: 2,
  SIGTERM: 15,
};
const CODEX_LOGIN_STATUS_TIMEOUT_MS = 10_000;
const CODEX_LOGIN_FAILURE_PATTERN =
  /not\s+logged\s+in|logged\s+out|not\s+authenticated|not\s+signed\s+in/u;
const CODEX_LOGIN_SUCCESS_PATTERN = /logged in|authenticated|signed in/u;
const CLAUDE_OPTIONAL_VALUE_FLAGS = new Set(['--resume', '-r', '--from-pr']);
const CLAUDE_REQUIRED_VALUE_FLAGS = new Set(['--session-id']);
const CLAUDE_SESSION_FLAGS = new Set([
  '--continue',
  '-c',
  '--fork-session',
  ...CLAUDE_OPTIONAL_VALUE_FLAGS,
  ...CLAUDE_REQUIRED_VALUE_FLAGS,
]);
const CLAUDE_MODEL_FLAGS = new Set(['--model', '-m']);
const CLAUDE_PERMISSION_MODE_FLAGS = new Set(['--permission-mode']);
const CLAUDE_SETTINGS_FLAGS = new Set(['--settings']);
const CLAUDE_EFFORT_FLAGS = new Set(['--effort']);
const CLAUDE_BACKGROUND_FLAGS = new Set(['--background', '--bg']);

function usage() {
  return [
    'Usage:',
    '  claude-workflow',
    '  claude-workflow "Review the current diff."',
    '  claude-workflow run "setup the repository"',
    '  claude-workflow setup [--prepare-claude] [--shared]',
    '  claude-workflow doctor [--json]',
    '  claude-workflow config [options]',
    '  claude-workflow -- <claude options or command>',
    '',
    'Commands:',
    '  setup    Check requirements; optionally migrate shell routing and start the shared daemon',
    '  doctor   Re-run the read-only prerequisite and routing checks',
    '  config   Show or update main model, agent model, reasoning, and permissions',
    '  run      Launch a prompt whose first word is a command name',
    '',
    'Wrapper options:',
    '  --no-yolo  Restore Claude Code permission prompts for this launch',
    '  --yolo     Explicitly keep the default permission bypass',
    '  --help     Show this help',
    '  --version  Show the installed package version',
    '',
    'Use -- before native Claude options. Resume flags may be passed directly.',
    'Claude background flags (--background and --bg) are not supported.',
    'Run only in trusted repositories: permission bypass is enabled by default.',
  ].join('\n');
}

function shouldPrintStack() {
  return envFlag('CLAUDE_WORKFLOW_DEBUG', envFlag('ULTRATHINK_WORKFLOWS_DEBUG', false));
}

function printError(message) {
  process.stderr.write(`claude-workflow: ${message}\n`);
}

function isExecutableCommand(commandName) {
  if (path.isAbsolute(commandName) || commandName.includes(path.sep)) {
    try {
      fs.accessSync(commandName, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  const pathValue = process.env.PATH || '';
  for (const candidate of pathValue.split(path.delimiter)) {
    if (!candidate) {
      continue;
    }

    try {
      fs.accessSync(path.join(candidate, commandName), fs.constants.X_OK);
      return true;
    } catch {
      continue;
    }
  }

  return false;
}

function codexLoginReady(commandName) {
  const isWindows = process.platform === 'win32';
  const result = spawnSync(commandName, ['login', 'status'], {
    cwd: process.cwd(),
    env: environmentWithoutGatewayAndAnthropicCredentials(),
    encoding: 'utf8',
    timeout: CODEX_LOGIN_STATUS_TIMEOUT_MS,
    shell: isWindows,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`.toLowerCase();

  return (
    result.status === 0 &&
    !result.error &&
    !CODEX_LOGIN_FAILURE_PATTERN.test(output) &&
    CODEX_LOGIN_SUCCESS_PATTERN.test(output)
  );
}

function describeGatewayListenError(error, config) {
  if (error?.code === 'EADDRINUSE') {
    return new Error(
      `gateway port ${config.port} is already in use on ${config.host}. ` +
        'Unset ULTRATHINK_GATEWAY_PORT or set it to 0 so each claude-workflow instance gets its own free localhost port.'
    );
  }

  if (error?.code === 'EACCES') {
    return new Error(
      `gateway cannot bind ${config.host}:${config.port}; choose an unprivileged port or unset ULTRATHINK_GATEWAY_PORT.`
    );
  }

  return error;
}

function parseCliArgs(rawArgs) {
  const claudeArgs = [];
  const promptArgs = [];
  let skipPermissions = envFlag(
    'CLAUDE_WORKFLOW_SKIP_PERMISSIONS',
    envFlag('ULTRATHINK_WORKFLOWS_SKIP_PERMISSIONS', true)
  );
  let passthrough = false;
  let claudeOptionsEnded = false;
  let interactiveSession = false;
  let claudeEffortRequested = false;

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (passthrough) {
      if (claudeOptionsEnded) {
        claudeArgs.push(arg);
        continue;
      }
      if (arg === '--') {
        claudeOptionsEnded = true;
        claudeArgs.push(arg);
        continue;
      }
      const equalsIndex = arg.indexOf('=');
      const flagName = equalsIndex > 0 ? arg.slice(0, equalsIndex) : arg;
      if (CLAUDE_MODEL_FLAGS.has(flagName)) {
        throw new Error(
          `${flagName} is managed by claude-workflow; set ULTRATHINK_GATEWAY_MAIN_MODEL_ID instead`
        );
      }
      if (CLAUDE_SETTINGS_FLAGS.has(flagName)) {
        throw new Error(
          `${flagName} is reserved by claude-workflow so repository settings cannot override gateway routing`
        );
      }
      if (CLAUDE_EFFORT_FLAGS.has(flagName)) {
        claudeEffortRequested = true;
      }
      if (CLAUDE_PERMISSION_MODE_FLAGS.has(flagName)) {
        skipPermissions = false;
      }
      claudeArgs.push(arg);
      continue;
    }

    if (arg === '--') {
      passthrough = true;
      continue;
    }

    if (arg === '--yolo' || arg === '--dangerously-skip-permissions') {
      skipPermissions = true;
      continue;
    }

    if (arg === '--no-yolo') {
      skipPermissions = false;
      continue;
    }

    const equalsIndex = arg.indexOf('=');
    const flagName = equalsIndex > 0 ? arg.slice(0, equalsIndex) : arg;
    if (CLAUDE_SESSION_FLAGS.has(flagName)) {
      interactiveSession = true;
      claudeArgs.push(arg);
      if (
        equalsIndex < 0 &&
        (CLAUDE_REQUIRED_VALUE_FLAGS.has(flagName) ||
          (CLAUDE_OPTIONAL_VALUE_FLAGS.has(flagName) && !rawArgs[index + 1]?.startsWith('-')))
      ) {
        const value = rawArgs[index + 1];
        if (typeof value === 'string') {
          claudeArgs.push(value);
          index += 1;
        }
      }
      continue;
    }

    if (arg.startsWith('-')) {
      throw new Error(
        `unknown claude-workflow option ${arg}; pass Claude CLI options after --`
      );
    }

    promptArgs.push(arg);
  }

  return {
    claudeArgs,
    claudeEffortRequested,
    interactiveSession,
    promptArgs,
    skipPermissions,
  };
}

function assertForegroundClaudeLifecycle(rawArgs) {
  const backgroundFlag = rawArgs.find((arg) =>
    CLAUDE_BACKGROUND_FLAGS.has(String(arg).split('=', 1)[0])
  );
  if (!backgroundFlag) {
    return;
  }

  throw new Error(
    `${backgroundFlag} is not supported because claude-workflow owns a per-session gateway ` +
      'and private settings that are removed when the foreground Claude process exits. ' +
      'Run Claude in the foreground, or configure an explicit durable gateway integration.'
  );
}

function isHelpRequest(rawArgs) {
  return rawArgs.length === 1 && (rawArgs[0] === '--help' || rawArgs[0] === '-h');
}

function isVersionRequest(rawArgs) {
  return rawArgs.length === 1 && (rawArgs[0] === '--version' || rawArgs[0] === '-V');
}

function packageVersion() {
  const packagePath = new URL('../../package.json', import.meta.url);
  return JSON.parse(fs.readFileSync(packagePath, 'utf8')).version;
}

function waitForServer(server) {
  if (server.listening) {
    return Promise.resolve();
  }

  return new Promise(function wait(resolve, reject) {
    function cleanup() {
      server.off('listening', onListening);
      server.off('error', onError);
    }

    function onListening() {
      cleanup();
      resolve();
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    server.once('listening', onListening);
    server.once('error', onError);
  });
}

function resolvedGatewayPort(server) {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Gateway did not expose a TCP port');
  }
  return address.port;
}

function buildClaudeEnvironment(config, gatewayBaseUrl, subagentModelId, mainModelId) {
  return buildWorkflowClientEnv(config, gatewayBaseUrl, subagentModelId, mainModelId);
}

function buildClaudeArgs(
  mainModelId,
  claudeArgs,
  promptArgs,
  skipPermissions,
  interactiveSession = false,
  managedOptions = []
) {
  // Claude's global --settings option must precede positional subcommands and
  // the native `--` terminator. Keep the caller's native tail byte-for-byte.
  const effectiveClaudeArgs = [...managedOptions, ...claudeArgs];
  if (interactiveSession || promptArgs.length === 0) {
    const nextArgs = ['--model', mainModelId, ...effectiveClaudeArgs, ...promptArgs];
    if (skipPermissions) {
      nextArgs.unshift('--dangerously-skip-permissions');
    }
    return nextArgs;
  }

  const nextArgs = [
    '-p',
    '--model',
    mainModelId,
    ...effectiveClaudeArgs,
    promptArgs.join(' '),
  ];
  if (skipPermissions) {
    nextArgs.splice(1, 0, '--dangerously-skip-permissions');
  }
  return nextArgs;
}

function assertPreflight(config, mainRoute) {
  const platform = checkWorkflowPlatform(process.env, config.codex.command);
  if (!platform.ok) {
    throw new Error(`${platform.label}: ${platform.detail}`);
  }

  if (!isGatewayLoopbackHost(config.host) && !config.sharedSecret) {
    throw new Error(
      `ULTRATHINK_GATEWAY_HOST=${config.host} is not loopback. Set ULTRATHINK_GATEWAY_SHARED_SECRET for non-local binds, or use 127.0.0.1 for local workflow launches.`
    );
  }

  const requiredCommands = [
    { command: 'claude', error: 'claude CLI not found on PATH' },
    {
      command: config.codex.command,
      error: `${config.codex.command} not found or not executable`,
    },
  ];

  for (const requirement of requiredCommands) {
    if (!isExecutableCommand(requirement.command)) {
      throw new Error(requirement.error);
    }
  }

  const claudeVersion = checkClaudeVersion();
  if (!claudeVersion.ok) {
    throw new Error(`${claudeVersion.label}: ${claudeVersion.detail}`);
  }

  if (!codexLoginReady(config.codex.command)) {
    throw new Error(
      `${config.codex.command} is not logged in. Run \`${config.codex.command} login\` first.`
    );
  }

  if (config.sharedSecret && mainRoute.provider === 'anthropic' && !config.anthropic.apiKey) {
    throw new Error(
      'ULTRATHINK_GATEWAY_SHARED_SECRET is set, so the gateway cannot forward Claude OAuth upstream for Anthropic passthrough. Set the dedicated ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY on the gateway, or unset ULTRATHINK_GATEWAY_SHARED_SECRET for local OAuth usage.'
    );
  }
}

function signalExitCode(signal) {
  return 128 + (SIGNAL_NUMBERS[signal] || 0);
}

function buildClaudeChildEnvironment(extraEnv) {
  const childEnv = environmentWithoutGatewayCredentials();
  for (const name of CLAUDE_WORKFLOW_MANAGED_SETTINGS_ENV_NAMES) {
    if (name !== 'ANTHROPIC_API_KEY' && name !== 'ANTHROPIC_AUTH_TOKEN') {
      delete childEnv[name];
    }
  }
  for (const [name, value] of Object.entries(extraEnv)) {
    if (value === null || value === undefined) {
      delete childEnv[name];
    } else {
      childEnv[name] = String(value);
    }
  }
  return childEnv;
}

function runClaude(args, childEnv, onChild = null) {
  return new Promise(function run(resolve, reject) {
    const isWindows = process.platform === 'win32';
    const child = spawn('claude', args, {
      cwd: process.cwd(),
      env: childEnv,
      stdio: 'inherit',
      shell: isWindows,
    });

    onChild?.(child);
    child.on('error', reject);
    child.on('close', function onClose(code, signal) {
      if (signal) {
        resolve(signalExitCode(signal));
        return;
      }

      resolve(code ?? 0);
    });
  });
}

async function closeGateway(runtime) {
  if (!runtime) {
    return;
  }

  try {
    await runtime.close();
  } catch {
    // Best-effort cleanup only.
  }
}

function stopClaudeChild(child, signal, timeoutMs = 2_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise(function waitForClaudeExit(resolve) {
    let settled = false;
    let forceTimer = null;
    let finalTimer = null;

    function finish() {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(forceTimer);
      clearTimeout(finalTimer);
      child.off('close', finish);
      resolve();
    }

    child.once('close', finish);
    if (!child.kill(signal)) {
      finish();
      return;
    }

    forceTimer = setTimeout(function forceClaudeExit() {
      child.kill('SIGKILL');
      finalTimer = setTimeout(finish, 1_000);
    }, timeoutMs);
  });
}

async function main() {
  let rawArgs = process.argv.slice(2);

  if (isHelpRequest(rawArgs)) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (isVersionRequest(rawArgs)) {
    process.stdout.write(`${packageVersion()}\n`);
    return;
  }

  assertForegroundClaudeLifecycle(rawArgs);

  const command = rawArgs[0];
  if (command === 'setup') {
    runSetupCommand(rawArgs.slice(1));
    return;
  }
  if (command === 'doctor') {
    runDoctorCommand(rawArgs.slice(1));
    return;
  }
  if (command === 'config') {
    runConfigCommand(rawArgs.slice(1));
    return;
  }
  if (command === 'run') {
    rawArgs = rawArgs.slice(1);
  }

  const {
    claudeArgs, claudeEffortRequested, interactiveSession, promptArgs, skipPermissions,
  } = parseCliArgs(rawArgs);

  const { config, mainModelId, rawSubagentModelId, subagentModelId, subagentRoute } =
    buildWorkflowGatewayConfig();
  const resolvedMainRoute = resolveModelRoute(mainModelId, config);
  if (claudeEffortRequested && resolvedMainRoute.claudeEffort) {
    throw new Error(
      '--effort is managed by claude-workflow for this provider preset so its required client effort stays consistent'
    );
  }
  // Fail fast on launcher-managed subagent routes before starting Claude.
  resolveModelRoute(rawSubagentModelId, config);
  if (subagentModelId !== rawSubagentModelId) {
    resolveModelRoute(subagentModelId, config);
  }
  assertPreflight(config, resolvedMainRoute);

  let runtime = null;
  let claudeChild = null;
  let claudeSettingsOverride = null;
  let signalCleanup = null;
  try {
    runtime = createGatewayServer(config);
    try {
      await waitForServer(runtime.server);
    } catch (error) {
      throw describeGatewayListenError(error, config);
    }
    runtime.server.on('error', function onRuntimeServerError(error) {
      printError(`gateway server error: ${error.message}`);
    });

    signalCleanup = installSignalHandlers(
      function currentRuntime() {
        return runtime;
      },
      function currentClaudeChild() {
        return claudeChild;
      },
      function cleanupPrivateSettings() {
        claudeSettingsOverride?.cleanup();
      }
    );

    const gatewayBaseUrl = `http://${config.host}:${resolvedGatewayPort(runtime.server)}`;
    process.stderr.write(`claude-workflow: gateway ready at ${gatewayBaseUrl}\n`);
    process.stderr.write(`claude-workflow: main model ${mainModelId}\n`);
    if (routeProvider(resolvedMainRoute) !== 'anthropic') {
      process.stderr.write(
        `claude-workflow: main route ${mainModelId} -> ${routeTargetSummary(resolvedMainRoute)}\n`
      );
    }
    process.stderr.write(`claude-workflow: subagent model ${subagentModelId}\n`);
    if (subagentModelId !== rawSubagentModelId) {
      process.stderr.write(
        `claude-workflow: subagent route ${rawSubagentModelId} -> ${routeTargetSummary(subagentRoute)}\n`
      );
    }

    const claudeEnvironment = buildClaudeEnvironment(
      config,
      gatewayBaseUrl,
      subagentModelId,
      mainModelId
    );
    const claudeChildEnvironment = buildClaudeChildEnvironment(claudeEnvironment);
    claudeSettingsOverride = createPrivateClaudeSettingsOverride(
      buildClaudeSettingsOverrideEnvironment(claudeEnvironment, claudeChildEnvironment),
      buildWorkflowModelPicker(config, mainModelId, subagentModelId)
    );
    const managedClaudeOptions = ['--settings', claudeSettingsOverride.path];
    if (resolvedMainRoute.claudeEffort) {
      managedClaudeOptions.unshift(
        '--effort',
        String(resolvedMainRoute.claudeEffort)
      );
    }

    const exitCode = await runClaude(
      buildClaudeArgs(
        mainModelId,
        claudeArgs,
        promptArgs,
        skipPermissions,
        interactiveSession,
        managedClaudeOptions
      ),
      claudeChildEnvironment,
      function onChild(child) {
        claudeChild = child;
      }
    );
    process.exitCode = exitCode;
  } finally {
    signalCleanup?.();
    claudeSettingsOverride?.cleanup();
    await closeGateway(runtime);
  }
}

function installSignalHandlers(runtimeProvider, childProvider, cleanupProvider) {
  let shuttingDown = false;

  function handleSignal(signal) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    const child = childProvider();
    Promise.allSettled([
      stopClaudeChild(child, signal),
      closeGateway(runtimeProvider()),
    ]).finally(function exitAfterCleanup() {
      try {
        cleanupProvider?.();
      } finally {
        process.exit(signalExitCode(signal));
      }
    });
  }

  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);

  return function removeSignalHandlers() {
    process.off('SIGINT', handleSignal);
    process.off('SIGTERM', handleSignal);
  };
}

main().catch(function onError(error) {
  printError(error.message);
  if (shouldPrintStack() && error?.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exitCode = 1;
});
