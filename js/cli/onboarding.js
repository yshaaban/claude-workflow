import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { unsafeWslInstallPaths } from '../../scripts/validate-local-install.mjs';
import { resolveCodexCapabilities } from '../gateway/codex-capabilities.js';
import {
  DEFAULT_CODEX_MODEL,
  envFlag,
  isGatewayLoopbackHost,
  loadGatewayConfig,
} from '../gateway/config.js';
import {
  modelIdWithoutBracketQualifiers,
  resolveModelRoute,
} from '../gateway/model-routing.js';
import {
  QWEN_TOKEN_PLAN_DEFAULTS,
  kimiProfileConfigurationIssue,
  qwenProfileConfigurationIssue,
} from '../gateway/provider-profiles.js';
import {
  environmentWithoutGatewayAndAnthropicCredentials,
  environmentWithoutGatewayCredentials,
  environmentWithoutLegacyWorkflowRouting,
  environmentWithoutManagedGatewayAuth,
} from '../utils/child-env.js';
import {
  CLAUDE_WORKFLOW_MANAGED_SETTINGS_ENV_NAMES,
} from '../utils/claude-config.js';
import {
  buildWorkflowGatewayConfig,
  defaultWorkflowAnthropicPassthroughModels,
  DEFAULT_SUBAGENT_REASONING_EFFORT,
  FABLE_MAIN_MODEL_ID,
  OPUS_MAIN_MODEL_ID,
  KIMI_MAIN_MODEL_ID,
  DEEPSEEK_MAIN_MODEL_ID,
  QWEN_MAIN_MODEL_ID,
  routeProvider,
  routeTargetSummary,
} from '../gateway/workflow-config.js';

const COMMAND_TIMEOUT_MS = 10_000;
const CONFIG_LOCK_TIMEOUT_MS = 5_000;
const CONFIG_LOCK_POLL_MS = 25;
const MINIMUM_CLAUDE_VERSION = Object.freeze([2, 1, 261]);
const MINIMUM_CODEX_VERSION = Object.freeze([0, 153, 4]);
const CONFIG_FILE_NAME = '.claude-workflow.env';
const SAFE_CONFIG_VALUE = /^[A-Za-z0-9._:/[\]-]+$/u;
const REASONING_EFFORTS = new Set([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);
// Codex tiers do not all advance to the same model generation. Resolve aliases
// explicitly so switching from Astra to Terra never invents gpt-6-terra.
const AGENT_MODEL_ALIASES = Object.freeze({
  astra: 'gpt-6-astra',
  sol: 'gpt-5.6-sol',
  terra: 'gpt-5.6-terra',
  luna: 'gpt-5.6-luna',
});
const PERMISSION_MODES = new Set(['bypass', 'prompt']);
const CONTEXT_PROFILES = new Set(['standard', 'long']);
const MAIN_PRESETS = Object.freeze({
  opus: Object.freeze({ model: OPUS_MAIN_MODEL_ID, provider: 'anthropic' }),
  fable: Object.freeze({ model: FABLE_MAIN_MODEL_ID, provider: 'anthropic' }),
  codex: Object.freeze({ model: 'codex', provider: 'codex' }),
  deepseek: Object.freeze({ model: DEEPSEEK_MAIN_MODEL_ID, provider: 'deepseek' }),
  'deepseek-flash': Object.freeze({ model: DEEPSEEK_MAIN_MODEL_ID, provider: 'deepseek' }),
  'deepseek-v4.1-flash': Object.freeze({ model: DEEPSEEK_MAIN_MODEL_ID, provider: 'deepseek' }),
  kimi: Object.freeze({ model: KIMI_MAIN_MODEL_ID, provider: 'kimi' }),
  'k3[1m]': Object.freeze({ model: KIMI_MAIN_MODEL_ID, provider: 'kimi' }),
  k3: Object.freeze({ model: 'k3', provider: 'kimi', kimiContextTokens: '262144' }),
  qwen: Object.freeze({ model: QWEN_MAIN_MODEL_ID, provider: 'qwen' }),
  'qwen3.8': Object.freeze({ model: QWEN_MAIN_MODEL_ID, provider: 'qwen' }),
  'qwen3.8-max': Object.freeze({ model: QWEN_MAIN_MODEL_ID, provider: 'qwen' }),
  'qwen3.8-max[1m]': Object.freeze({ model: QWEN_MAIN_MODEL_ID, provider: 'qwen' }),
});
const SHELL_ROUTING_ENV_NAMES = Object.freeze([
  ...CLAUDE_WORKFLOW_MANAGED_SETTINGS_ENV_NAMES,
]);
const CODEX_LOGIN_FAILURE_PATTERN =
  /not\s+logged\s+in|logged\s+out|not\s+authenticated|not\s+signed\s+in/iu;
const CODEX_LOGIN_SUCCESS_PATTERN = /logged in|authenticated|signed in/iu;
const MANAGED_CONFIG_KEYS = Object.freeze([
  'ULTRATHINK_GATEWAY_MAIN_MODEL_ID',
  'ULTRATHINK_GATEWAY_MAIN_PROVIDER',
  'CLAUDE_WORKFLOW_MAIN_PROVIDER',
  'ULTRATHINK_GATEWAY_MAIN_UPSTREAM_MODEL',
  'ULTRATHINK_GATEWAY_MAIN_REASONING_EFFORT',
  'ULTRATHINK_GATEWAY_ANTHROPIC_PASSTHROUGH_MODELS',
  'ULTRATHINK_GATEWAY_KIMI_CONTEXT_TOKENS',
  'ULTRATHINK_GATEWAY_QWEN_CONTEXT_TOKENS',
  'ULTRATHINK_GATEWAY_QWEN_MAX_OUTPUT_TOKENS',
  'ULTRATHINK_GATEWAY_QWEN_MODEL',
  'ULTRATHINK_GATEWAY_QWEN_REASONING_EFFORT',
  'ULTRATHINK_GATEWAY_CODEX_MODEL',
  'ULTRATHINK_GATEWAY_CODEX_REASONING_EFFORT',
  'ULTRATHINK_GATEWAY_CODEX_CONTEXT',
  'ULTRATHINK_GATEWAY_CODEX_CONTEXT_PROFILE',
  'ULTRATHINK_GATEWAY_SUBAGENT_UPSTREAM_MODEL',
  'ULTRATHINK_GATEWAY_SUBAGENT_REASONING_EFFORT',
  'CLAUDE_WORKFLOW_SUBAGENT_MODEL_ID',
  'CLAUDE_WORKFLOW_SKIP_PERMISSIONS',
]);
const GATEWAY_MANAGER = fileURLToPath(
  new URL('../../scripts/claude-workflow-daemon.sh', import.meta.url)
);

function writeLine(stream, value = '') {
  stream.write(`${value}\n`);
}

function withProcessEnvironment(env, callback) {
  if (!env || env === process.env) {
    return callback();
  }

  const original = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, env);
    return callback();
  } finally {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, original);
  }
}

function commandResult(command, args, options = {}) {
  const childEnv = options.preserveAnthropicCredentials
    ? environmentWithoutGatewayCredentials(options.env || process.env)
    : environmentWithoutGatewayAndAnthropicCredentials(options.env || process.env);
  return spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    env: childEnv,
    encoding: 'utf8',
    timeout: options.timeout || COMMAND_TIMEOUT_MS,
    shell: process.platform === 'win32',
  });
}

function commandOutput(result) {
  return `${result?.stdout || ''}${result?.stderr || ''}`.trim();
}

function commandFailure(result) {
  if (result?.error?.code === 'ETIMEDOUT') {
    return 'timed out';
  }
  if (result?.error) {
    return result.error.message;
  }
  return `exited with status ${result?.status ?? 'unknown'}`;
}

export function findExecutable(
  commandName,
  env = process.env,
  cwd = process.cwd()
) {
  if (typeof commandName !== 'string' || commandName.trim() === '') {
    return '';
  }

  const normalizedCommand = commandName.trim();
  const baseDirectory = path.resolve(cwd);
  if (path.isAbsolute(normalizedCommand) || normalizedCommand.includes(path.sep)) {
    const candidate = path.isAbsolute(normalizedCommand)
      ? normalizedCommand
      : path.resolve(baseDirectory, normalizedCommand);
    try {
      const stats = fs.statSync(candidate);
      fs.accessSync(candidate, fs.constants.X_OK);
      return stats.isFile() ? path.resolve(candidate) : '';
    } catch {
      return '';
    }
  }

  const searchPath =
    env.PATH === undefined ? '/usr/bin:/bin' : String(env.PATH);
  for (const directory of searchPath.split(path.delimiter)) {
    const searchDirectory = directory
      ? path.resolve(baseDirectory, directory)
      : baseDirectory;
    const candidate = path.join(searchDirectory, normalizedCommand);
    try {
      const stats = fs.statSync(candidate);
      fs.accessSync(candidate, fs.constants.X_OK);
      if (stats.isFile()) {
        return candidate;
      }
    } catch {
      continue;
    }
  }
  return '';
}

export function isWsl(env = process.env) {
  if (process.platform !== 'linux') {
    return false;
  }
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) {
    return true;
  }
  try {
    return /microsoft/iu.test(fs.readFileSync('/proc/sys/kernel/osrelease', 'utf8'));
  } catch {
    return false;
  }
}

export function isWindowsMountedPath(value, mountInfo = null) {
  const normalized = String(value || '').replaceAll('\\', '/');
  if (/^\/mnt\/[a-z](?:\/|$)/iu.test(normalized) || /\.exe$/iu.test(normalized)) {
    return true;
  }
  if (process.platform !== 'linux' || !path.isAbsolute(normalized)) {
    return false;
  }
  try {
    const content =
      mountInfo ?? fs.readFileSync('/proc/self/mountinfo', 'utf8');
    return unsafeWslInstallPaths([['candidate', normalized]], content).length !== 0;
  } catch {
    return false;
  }
}

export function checkWorkflowPlatform(
  env = process.env,
  codexCommand = 'codex',
  cwd = process.cwd()
) {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    return {
      ok: false,
      label: `Platform ${process.platform}`,
      detail: 'Use macOS, Linux, or WSL with Linux-native tools.',
    };
  }

  if (!isWsl(env)) {
    return {
      ok: true,
      label: process.platform === 'darwin' ? 'Platform macOS' : 'Platform Linux',
    };
  }

  const unsafePaths = [];
  const pathCandidates = [
    ['Working directory', cwd],
    ['Working directory dependencies', path.join(cwd, 'node_modules')],
    ['Node.js', process.execPath],
    ['Claude Workflow', GATEWAY_MANAGER],
    ['Claude Code', findExecutable('claude', env, cwd)],
    ['Codex', findExecutable(codexCommand, env, cwd)],
    ['Home directory', env.HOME || env.USERPROFILE || os.homedir()],
    [
      'Gateway state',
      env.CLAUDE_WORKFLOW_GATEWAY_STATE_DIR ||
        (env.XDG_STATE_HOME
          ? path.join(env.XDG_STATE_HOME, 'claude-workflow')
          : path.join(env.HOME || os.homedir(), '.cache', 'claude-workflow')),
    ],
  ];
  for (const [label, candidate] of pathCandidates) {
    if (!candidate) {
      continue;
    }
    let resolved;
    try {
      resolved = resolveThroughExistingAncestor(candidate);
    } catch (error) {
      return {
        ok: false,
        label: 'Platform WSL',
        detail: `Could not resolve ${label}: ${error.message}`,
      };
    }
    if (isWindowsMountedPath(resolved)) {
      unsafePaths.push([label, resolved]);
    }
  }
  if (unsafePaths.length > 0) {
    return {
      ok: false,
      label: 'Platform WSL',
      detail:
        `${unsafePaths.map(([name]) => name).join(', ')} resolves to Windows or /mnt storage. ` +
        'Install Node.js, Claude Code, and Codex inside this WSL distribution and keep state under /home.',
    };
  }

  return { ok: true, label: 'Platform WSL (Linux-native tools)' };
}

function nodeCheck() {
  const major = Number(process.versions.node.split('.')[0]);
  return {
    ok: Number.isInteger(major) && major >= 20,
    label: `Node.js ${process.version}`,
    ...(
      Number.isInteger(major) && major >= 20
        ? {}
        : { detail: 'Install Node.js 20 or newer.' }
    ),
  };
}

function versionAtLeast(actual, required) {
  for (let index = 0; index < required.length; index += 1) {
    if (actual[index] > required[index]) {
      return true;
    }
    if (actual[index] < required[index]) {
      return false;
    }
  }
  return true;
}

export function checkClaudeVersion(run = commandResult, env = process.env) {
  if (!findExecutable('claude', env)) {
    return {
      ok: false,
      label: 'Claude Code',
      detail: 'Not found on PATH. Install Claude Code, then run `claude auth login`.',
    };
  }

  const versionResult = run('claude', ['--version'], {
    env,
    preserveAnthropicCredentials: true,
  });
  if (versionResult.status !== 0 || versionResult.error) {
    return {
      ok: false,
      label: 'Claude Code',
      detail: `Could not read its version: ${commandFailure(versionResult)}.`,
    };
  }

  const version = (commandOutput(versionResult).split(/\r?\n/u)[0] || 'installed')
    .replace(/\s*\(Claude Code\)\s*$/iu, '')
    .trim();
  const versionParts = version.match(/(\d+)\.(\d+)\.(\d+)/u)?.slice(1).map(Number);
  if (!versionParts || !versionAtLeast(versionParts, MINIMUM_CLAUDE_VERSION)) {
    return {
      ok: false,
      label: `Claude Code ${version}`,
      detail:
        'Claude Workflow requires Claude Code 2.1.261 or newer. Update Claude Code and try again.',
    };
  }

  return { ok: true, label: `Claude Code ${version}`, version };
}

function claudeCheck(run = commandResult, env = process.env, requireAuthentication = true) {
  const versionCheck = checkClaudeVersion(run, env);
  if (!versionCheck.ok) {
    return versionCheck;
  }
  const version = versionCheck.version;
  if (!requireAuthentication) {
    return { ok: true, label: `Claude Code ${version} (provider authentication via gateway)` };
  }
  const authResult = run('claude', ['auth', 'status', '--json'], {
    env,
    preserveAnthropicCredentials: true,
  });
  if (authResult.status !== 0 || authResult.error) {
    return {
      ok: false,
      label: `Claude Code ${version}`,
      detail: `Authentication check ${commandFailure(authResult)}. Run \`claude auth login\`.`,
    };
  }

  try {
    const status = JSON.parse(authResult.stdout || '{}');
    const loggedIn = status.loggedIn === true || status.logged_in === true;
    return loggedIn
      ? { ok: true, label: `Claude Code ${version} (authenticated)` }
      : {
          ok: false,
          label: `Claude Code ${version}`,
          detail: 'Not authenticated. Run `claude auth login`.',
        };
  } catch {
    return {
      ok: false,
      label: `Claude Code ${version}`,
      detail: 'Authentication status was not valid JSON. Update Claude Code and try again.',
    };
  }
}

function claudeThirdPartyModelCheck(env = process.env, prepareRequested = false) {
  void env;
  void prepareRequested;
  return {
    ok: true,
    label: 'Claude Code custom model routing uses documented session settings',
  };
}

function inheritedWorkflowRoutingCheck(
  env = process.env,
  { migrationRequested = false } = {}
) {
  const cleaned = environmentWithoutManagedGatewayAuth(env);
  const activeNames = SHELL_ROUTING_ENV_NAMES.filter(
    (name) =>
      Object.hasOwn(env, name) !== Object.hasOwn(cleaned, name) ||
      env[name] !== cleaned[name]
  );
  if (activeNames.length === 0) {
    return {
      ok: true,
      label: 'No inherited workflow-managed Claude routing',
    };
  }

  return {
    ok: migrationRequested,
    label: migrationRequested
      ? 'Inherited workflow-managed Claude routing will be migrated'
      : 'Inherited workflow-managed Claude routing',
    detail:
      `Active inherited values: ${activeNames.join(', ')}. ` +
      (migrationRequested
        ? 'The shell cleanup transition will remove them from new shells; source the migrated rc or open a new shell before relying on plain `claude` to be direct.'
        : 'This command cannot change its parent shell. Run `claude-workflow-gateway migrate-shell`, then source the migrated rc or open a new shell before relying on plain `claude` to be direct.'),
  };
}

function codexCheck(commandName, run = commandResult, env = process.env) {
  if (!findExecutable(commandName, env)) {
    return {
      ok: false,
      label: 'Codex CLI',
      detail: `${commandName} was not found or is not executable. Install Codex, then run \`${commandName} login\`.`,
    };
  }

  const versionResult = run(commandName, ['--version'], { env });
  if (versionResult.status !== 0 || versionResult.error) {
    return {
      ok: false,
      label: 'Codex CLI',
      detail: `Could not read its version: ${commandFailure(versionResult)}.`,
    };
  }

  const version = (commandOutput(versionResult).split(/\r?\n/u)[0] || 'installed')
    .replace(/^codex-cli\s+/iu, '')
    .trim();
  const versionParts = version.match(/(\d+)\.(\d+)\.(\d+)/u)?.slice(1).map(Number);
  if (!versionParts || !versionAtLeast(versionParts, MINIMUM_CODEX_VERSION)) {
    return {
      ok: false,
      label: `Codex CLI ${version}`,
      detail: 'Claude Workflow requires Codex CLI 0.153.4 or newer. Update Codex and try again.',
    };
  }
  const authResult = run(commandName, ['login', 'status'], { env });
  const authOutput = commandOutput(authResult).toLowerCase();
  const loggedIn =
    authResult.status === 0 &&
    !authResult.error &&
    !CODEX_LOGIN_FAILURE_PATTERN.test(authOutput) &&
    CODEX_LOGIN_SUCCESS_PATTERN.test(authOutput);
  return loggedIn
    ? { ok: true, label: `Codex CLI ${version} (authenticated)` }
    : {
        ok: false,
        label: `Codex CLI ${version}`,
        detail: `Not authenticated. Run \`${commandName} login\`.`,
      };
}

function friendlyMainName(modelId) {
  if (/^claude-fable-5-1(?:-|\[|$)/u.test(modelId)) {
    return 'Fable 5.1';
  }
  if (/^claude-opus-5(?:\[|$)/u.test(modelId)) {
    return 'Opus 5';
  }
  if (/^claude-fable-5(?:\[|$)/u.test(modelId)) {
    return 'Fable 5';
  }
  if (/^k3(?:\[|$)/u.test(modelId)) {
    return 'Kimi K3';
  }
  if (/^qwen3\.8-max(?:\[|$)/u.test(modelId)) {
    return 'Qwen 3.8 Max';
  }
  if (modelId === 'codex') {
    return 'Codex direct';
  }
  return modelId;
}

function qwenConfigurationGuidance(issue) {
  switch (issue) {
    case 'missing_key':
      return `add ULTRATHINK_GATEWAY_QWEN_API_KEY to ${configurationPath()} and keep that file owner-only.`;
    case 'anthropic_endpoint':
      return 'replace the Qwen /apps/anthropic base URL with its OpenAI-compatible compatible-mode/v1 endpoint.';
    case 'token_plan_key_mismatch':
      return 'use a matching sk-sp- Token Plan key, or configure the HTTPS base URL that belongs to the current Qwen credential.';
    case 'insecure_url':
    case 'unsupported_protocol':
      return 'use an HTTPS Qwen base URL; plain HTTP is accepted only for a loopback gateway.';
    case 'invalid_url':
      return 'set QWEN_BASE_URL or ULTRATHINK_GATEWAY_QWEN_BASE_URL to a valid HTTPS URL.';
    default:
      return '';
  }
}

function kimiConfigurationGuidance(issue) {
  switch (issue) {
    case 'missing_key':
      return `add ULTRATHINK_GATEWAY_KIMI_API_KEY to ${configurationPath()} and keep that file owner-only.`;
    case 'insecure_url':
    case 'unsupported_protocol':
      return 'use an HTTPS Kimi base URL; plain HTTP is accepted only for a loopback gateway.';
    case 'invalid_url':
      return 'set ULTRATHINK_GATEWAY_KIMI_BASE_URL to a valid HTTPS URL.';
    default:
      return '';
  }
}

function friendlyAgentName(modelId) {
  const tier = String(modelId || '').match(/-(astra|sol|terra|luna)$/u)?.[1];
  return tier ? `${tier[0].toUpperCase()}${tier.slice(1)}` : modelId;
}

export function configurationPath(env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  return path.join(path.resolve(home), CONFIG_FILE_NAME);
}

export function effectiveConfigurationSummary(env = process.env) {
  return withProcessEnvironment(env, function summarizeEffectiveConfiguration() {
    const {
      config,
      mainModelId,
      rawSubagentModelId,
      subagentModelId,
      subagentRoute,
      subagentCapabilities,
    } = buildWorkflowGatewayConfig();
    const mainRoute = resolveModelRoute(mainModelId, config);
    resolveModelRoute(rawSubagentModelId, config);
    if (subagentModelId !== rawSubagentModelId) {
      resolveModelRoute(subagentModelId, config);
    }
    if (!isGatewayLoopbackHost(config.host) && !config.sharedSecret) {
      throw new Error(
        `Gateway host ${config.host} is not loopback and has no shared secret. ` +
          'Use 127.0.0.1 or configure ULTRATHINK_GATEWAY_SHARED_SECRET.'
      );
    }
    if (
      config.sharedSecret &&
      routeProvider(mainRoute) === 'anthropic' &&
      !config.anthropic.apiKey
    ) {
      throw new Error(
        'Anthropic passthrough with a gateway shared secret requires ' +
          'the dedicated ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY.'
      );
    }
    const agentModel =
      subagentRoute.model ||
      subagentRoute.upstreamModel ||
      subagentRoute.upstream_model ||
      config.codex.model;
    const effort =
      subagentRoute.reasoningEffort ||
      subagentRoute.reasoning_effort ||
      DEFAULT_SUBAGENT_REASONING_EFFORT;
    const configPath = configurationPath(env);

    return {
      path: configPath,
      fileExists: fs.existsSync(configPath),
      main: {
        name: friendlyMainName(mainModelId),
        model: mainModelId,
        provider: routeProvider(mainRoute),
        target: routeTargetSummary(mainRoute),
      },
      agents: {
        name: friendlyAgentName(agentModel),
        displayModel: subagentModelId,
        model: agentModel,
        provider: routeProvider(subagentRoute),
        effort,
        context: subagentCapabilities?.profile || null,
        contextTokens: subagentCapabilities?.usableContextTokens || null,
      },
      permissions: envFlag(
        'CLAUDE_WORKFLOW_SKIP_PERMISSIONS',
        envFlag('ULTRATHINK_WORKFLOWS_SKIP_PERMISSIONS', true)
      )
        ? 'bypass'
        : 'prompt',
    };
  });
}

function configurationLines(summary) {
  const fileState = summary.fileExists ? '' : ' (not created; package defaults active)';
  return [
    `Config file   ${summary.path}${fileState}`,
    `Main          ${summary.main.name} -> ${summary.main.provider} (${summary.main.model})`,
    `Agents        ${summary.agents.name} -> ${summary.agents.provider} (${summary.agents.model})`,
    `Reasoning     ${summary.agents.effort}`,
    `Context       ${summary.agents.context} (${summary.agents.contextTokens} usable tokens)`,
    `Permissions   ${summary.permissions}`,
  ];
}

function assignmentKey(line) {
  return line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u)?.[1] || '';
}

export function rewriteConfigurationText(content, updates = {}, removals = []) {
  const lineEnding = String(content).includes('\r\n') ? '\r\n' : '\n';
  const hadTrailingNewline = String(content).endsWith('\n');
  const sourceLines = String(content) === '' ? [] : String(content).split(/\r?\n/u);
  if (hadTrailingNewline) {
    sourceLines.pop();
  }

  const pending = new Map(Object.entries(updates));
  const removed = new Set(removals);
  const managed = new Set([...pending.keys(), ...removed]);
  const emitted = new Set();
  const result = [];
  for (const line of sourceLines) {
    const key = assignmentKey(line);
    if (!key || !managed.has(key)) {
      result.push(line);
      continue;
    }
    if (removed.has(key) || emitted.has(key)) {
      continue;
    }
    result.push(`${key}=${pending.get(key)}`);
    emitted.add(key);
    pending.delete(key);
  }

  if (pending.size > 0) {
    if (result.length > 0 && result.at(-1) !== '') {
      result.push('');
    }
    for (const [key, value] of pending) {
      result.push(`${key}=${value}`);
    }
  }

  if (result.length === 0) {
    return '';
  }
  return `${result.join(lineEnding)}${lineEnding}`;
}

function assertSafeConfigurationValues(updates) {
  for (const [key, value] of Object.entries(updates)) {
    if (!MANAGED_CONFIG_KEYS.includes(key)) {
      throw new Error(`refusing to manage unsupported configuration key ${key}`);
    }
    const safeValue =
      key === 'CLAUDE_WORKFLOW_SUBAGENT_MODEL_ID' && value === ''
        ? true
      : key === 'ULTRATHINK_GATEWAY_ANTHROPIC_PASSTHROUGH_MODELS'
        ? value === 'none' ||
          value.split(',').every((pattern) =>
            SAFE_CONFIG_VALUE.test(pattern.endsWith('*') ? pattern.slice(0, -1) : pattern)
          )
        : SAFE_CONFIG_VALUE.test(value);
    if (!safeValue) {
      throw new Error(`invalid value for ${key}`);
    }
  }
}

function sameFileVersion(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function waitForLockPoll() {
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(waiter, 0, 0, CONFIG_LOCK_POLL_MS);
}

function acquireConfigurationLock(target) {
  const lockPath = path.join(path.dirname(target), `.${path.basename(target)}.lock`);
  const deadline = Date.now() + CONFIG_LOCK_TIMEOUT_MS;
  while (true) {
    let descriptor = null;
    try {
      descriptor = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(
        descriptor,
        `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
        'utf8'
      );
      fs.fsyncSync(descriptor);
      fs.fchmodSync(descriptor, 0o600);
      const stats = fs.fstatSync(descriptor);
      if (!stats.isFile() || (stats.mode & 0o077) !== 0) {
        throw new Error(
          `configuration storage does not enforce owner-only permissions: ${lockPath}. ` +
            'On WSL, use the Linux filesystem or enable DrvFS metadata.'
        );
      }
      return { descriptor, path: lockPath };
    } catch (error) {
      if (descriptor !== null) {
        fs.closeSync(descriptor);
        fs.rmSync(lockPath, { force: true });
      }
      if (error?.code !== 'EEXIST') {
        throw error;
      }

      let stats;
      try {
        stats = fs.lstatSync(lockPath);
      } catch (statError) {
        if (statError?.code === 'ENOENT') {
          continue;
        }
        throw statError;
      }
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new Error(`configuration lock must be a regular file: ${lockPath}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `timed out waiting for another configuration update: ${target}. ` +
            `If no config command is running, remove the stale lock ${lockPath}.`
        );
      }
      waitForLockPoll();
    }
  }
}

function releaseConfigurationLock(lock) {
  try {
    fs.closeSync(lock.descriptor);
  } finally {
    fs.rmSync(lock.path, { force: true });
  }
}

export function writeUserConfiguration(target, updates = {}, removals = []) {
  assertSafeConfigurationValues(updates);
  const absoluteTarget = path.resolve(target);
  const directory = path.dirname(absoluteTarget);
  fs.mkdirSync(directory, { recursive: true });

  const lock = acquireConfigurationLock(absoluteTarget);
  try {
    return writeUserConfigurationLocked(absoluteTarget, updates, removals);
  } finally {
    releaseConfigurationLock(lock);
  }
}

function writeUserConfigurationLocked(absoluteTarget, updates, removals) {
  const directory = path.dirname(absoluteTarget);
  let originalStats = null;
  let original = '';
  try {
    originalStats = fs.lstatSync(absoluteTarget);
    if (originalStats.isSymbolicLink() || !originalStats.isFile()) {
      throw new Error(`configuration path must be a regular file, not a symlink: ${absoluteTarget}`);
    }
    if (typeof process.getuid === 'function' && originalStats.uid !== process.getuid()) {
      throw new Error(`configuration file is not owned by the current user: ${absoluteTarget}`);
    }
    original = fs.readFileSync(absoluteTarget, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  const next = rewriteConfigurationText(original, updates, removals);
  if (next === original) {
    if (originalStats && (originalStats.mode & 0o077) !== 0) {
      fs.chmodSync(absoluteTarget, 0o600);
      const hardenedStats = fs.lstatSync(absoluteTarget);
      if ((hardenedStats.mode & 0o077) !== 0) {
        throw new Error(
          `configuration storage does not enforce owner-only permissions: ${absoluteTarget}. ` +
            'On WSL, use the Linux filesystem or enable DrvFS metadata.'
        );
      }
    }
    return { changed: false, path: absoluteTarget };
  }

  const temporary = path.join(
    directory,
    `.${path.basename(absoluteTarget)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  );
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, next, 'utf8');
    fs.fsyncSync(descriptor);
    fs.fchmodSync(descriptor, 0o600);
    const temporaryStats = fs.fstatSync(descriptor);
    if (!temporaryStats.isFile() || (temporaryStats.mode & 0o077) !== 0) {
      throw new Error(
        `configuration storage does not enforce owner-only permissions: ${directory}. ` +
          'On WSL, use the Linux filesystem or enable DrvFS metadata.'
      );
    }
    fs.closeSync(descriptor);
    descriptor = null;

    if (originalStats) {
      const currentStats = fs.lstatSync(absoluteTarget);
      if (!sameFileVersion(originalStats, currentStats)) {
        throw new Error(`configuration changed while it was being updated: ${absoluteTarget}`);
      }
    } else if (fs.existsSync(absoluteTarget)) {
      throw new Error(`configuration appeared while it was being created: ${absoluteTarget}`);
    }

    fs.renameSync(temporary, absoluteTarget);
    const publishedStats = fs.lstatSync(absoluteTarget);
    if (!publishedStats.isFile() || publishedStats.isSymbolicLink() || (publishedStats.mode & 0o077) !== 0) {
      throw new Error(`published configuration is not an owner-only regular file: ${absoluteTarget}`);
    }
  } finally {
    if (descriptor !== null) {
      fs.closeSync(descriptor);
    }
    fs.rmSync(temporary, { force: true });
  }

  return { changed: true, path: absoluteTarget };
}

function parseNamedOptions(args, allowed) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-h' && allowed.has('help')) {
      if (Object.hasOwn(parsed, 'help')) {
        throw new Error('--help may be specified only once');
      }
      parsed.help = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      throw new Error(`unexpected argument ${arg}`);
    }
    const separator = arg.indexOf('=');
    const name = separator > 0 ? arg.slice(2, separator) : arg.slice(2);
    if (!allowed.has(name)) {
      throw new Error(`unknown option --${name}`);
    }
    if (Object.hasOwn(parsed, name)) {
      throw new Error(`--${name} may be specified only once`);
    }
    if (allowed.get(name) === false) {
      if (separator > 0) {
        throw new Error(`--${name} does not take a value`);
      }
      parsed[name] = true;
      continue;
    }
    const value = separator > 0 ? arg.slice(separator + 1) : args[++index];
    if (!value || value.startsWith('--')) {
      throw new Error(`--${name} requires a value`);
    }
    parsed[name] = value;
  }
  return parsed;
}

function normalizeModel(value, label) {
  const normalized = String(value || '').trim();
  if (!SAFE_CONFIG_VALUE.test(normalized)) {
    throw new Error(`${label} must be a model id without spaces or shell characters`);
  }
  return normalized;
}

function agentModel(value) {
  const trimmed = String(value || '').trim();
  const normalized = trimmed.toLowerCase();
  return Object.hasOwn(AGENT_MODEL_ALIASES, normalized)
    ? AGENT_MODEL_ALIASES[normalized]
    : normalizeModel(trimmed, '--agents');
}

function configUsage() {
  return [
    'Usage:',
    '  claude-workflow config',
    '  claude-workflow config --agents astra --effort max --context long',
    '  claude-workflow config --main fable --permissions bypass',
    '  claude-workflow config --main opus',
    '  claude-workflow config --main codex',
    '  claude-workflow config --main kimi',
    '  claude-workflow config --main qwen',
    '  claude-workflow config --main deepseek',
    '  claude-workflow config --reset',
    '',
    'Options:',
    '  --main <opus|fable|codex|kimi|k3|qwen|deepseek|anthropic-model-id>  Main route; deepseek selects V4.1 Flash',
    '  --agents <astra|sol|terra|luna|id>  Shared Codex model for agents and direct main',
    '  --effort <level>              Codex effort, validated against the selected model catalog',
    '  --context <standard|long>     Codex context profile; also sets the launch-wide shared compaction ceiling',
    '  --permissions <mode>          bypass or prompt',
    '  --reset                       Remove settings managed by this command',
    '  --json                        Print the effective configuration as JSON',
    '  --path                        Print the user configuration path',
    '  --help, -h                    Show this help',
    '',
    `Saved settings use ${CONFIG_FILE_NAME} in the home directory. Exported environment variables take precedence.`,
  ].join('\n');
}

export function runConfigCommand(args, options = {}) {
  const stdout = options.stdout || process.stdout;
  const parsed = parseNamedOptions(
    args,
    new Map([
      ['main', true],
      ['agents', true],
      ['effort', true],
      ['context', true],
      ['permissions', true],
      ['reset', false],
      ['json', false],
      ['path', false],
      ['help', false],
    ])
  );
  if (parsed.help) {
    writeLine(stdout, configUsage());
    return;
  }
  if (parsed.path) {
    if (Object.keys(parsed).length !== 1) {
      throw new Error('--path cannot be combined with other config options');
    }
    writeLine(stdout, configurationPath());
    return;
  }

  const writeOptions = ['main', 'agents', 'effort', 'context', 'permissions'].filter(
    (name) => parsed[name]
  );
  const selectedMainPreset = MAIN_PRESETS[String(parsed.main || '').trim().toLowerCase()] || null;
  const selectsKimiMain = selectedMainPreset?.provider === 'kimi';
  const selectsQwenMain = selectedMainPreset?.provider === 'qwen';
  const selectsDeepSeekMain = selectedMainPreset?.provider === 'deepseek';
  const selectsCodexMain = selectedMainPreset?.provider === 'codex';
  if (parsed.reset && writeOptions.length > 0) {
    throw new Error('--reset cannot be combined with configuration values');
  }
  if (parsed.json && (parsed.reset || writeOptions.length > 0)) {
    throw new Error('--json cannot be combined with configuration changes');
  }

  if (!parsed.reset && writeOptions.length === 0) {
    const summary = effectiveConfigurationSummary();
    if (parsed.json) {
      writeLine(stdout, JSON.stringify(summary, null, 2));
      return;
    }
    for (const line of configurationLines(summary)) {
      writeLine(stdout, line);
    }
    return;
  }

  const updates = {};
  const removals = new Set();
  if (parsed.reset) {
    for (const key of MANAGED_CONFIG_KEYS) {
      removals.add(key);
    }
  } else {
    const provisionalAgentModel = parsed.agents
      ? agentModel(parsed.agents)
      : null;
    const selectedMainModel = parsed.main
      ? selectedMainPreset?.model || normalizeModel(parsed.main, '--main')
      : null;
    const selectedMainProvider = parsed.main
      ? selectedMainPreset?.provider || 'anthropic'
      : null;
    // A config mutation must be able to repair stale legacy identities and an
    // effort/model pair that the proposed values replace. Build the preview
    // from those proposed values instead of validating the broken pre-mutation
    // fixed point first.
    const mutationPreviewEnv = { ...process.env };
    if (parsed.agents || parsed.effort) {
      mutationPreviewEnv.CLAUDE_WORKFLOW_SUBAGENT_MODEL_ID = '';
    }
    if (provisionalAgentModel) {
      mutationPreviewEnv.ULTRATHINK_GATEWAY_CODEX_MODEL = provisionalAgentModel;
      mutationPreviewEnv.ULTRATHINK_GATEWAY_SUBAGENT_UPSTREAM_MODEL =
        provisionalAgentModel;
    }
    if (parsed.effort) {
      mutationPreviewEnv.ULTRATHINK_GATEWAY_CODEX_REASONING_EFFORT =
        parsed.effort.toLowerCase();
      mutationPreviewEnv.ULTRATHINK_GATEWAY_SUBAGENT_REASONING_EFFORT =
        parsed.effort.toLowerCase();
    }
    const configuredMainProvider = String(
      process.env.ULTRATHINK_GATEWAY_MAIN_PROVIDER ||
        process.env.CLAUDE_WORKFLOW_MAIN_PROVIDER ||
        'anthropic'
    )
      .trim()
      .toLowerCase();
    if ((parsed.agents || parsed.effort) && configuredMainProvider === 'codex') {
      mutationPreviewEnv.ULTRATHINK_GATEWAY_MAIN_MODEL_ID = 'codex';
      if (provisionalAgentModel) {
        mutationPreviewEnv.ULTRATHINK_GATEWAY_MAIN_UPSTREAM_MODEL =
          provisionalAgentModel;
      }
      if (parsed.effort) {
        mutationPreviewEnv.ULTRATHINK_GATEWAY_MAIN_REASONING_EFFORT =
          parsed.effort.toLowerCase();
      }
    }
    if (selectedMainModel) {
      // Preview the proposed main route as well as the agent route. Otherwise
      // upgrading an old Fable-only passthrough configuration fails validation
      // before this command can restore its required native fallback targets.
      // Kimi/Qwen presets must be configurable before their keys are stored.
      // Their post-save guidance diagnoses provider setup; this preview only
      // needs the proposed Codex agent profile, not an authenticated main route.
      const previewMainProvider = selectsKimiMain || selectsQwenMain
        ? 'codex'
        : selectedMainProvider;
      const previewMainModel = selectsKimiMain || selectsQwenMain
        ? 'codex'
        : selectedMainModel;
      mutationPreviewEnv.ULTRATHINK_GATEWAY_MAIN_MODEL_ID = previewMainModel;
      mutationPreviewEnv.ULTRATHINK_GATEWAY_MAIN_PROVIDER = previewMainProvider;
      mutationPreviewEnv.ULTRATHINK_GATEWAY_MAIN_UPSTREAM_MODEL =
        previewMainProvider === 'codex'
          ? provisionalAgentModel ||
            mutationPreviewEnv.ULTRATHINK_GATEWAY_SUBAGENT_UPSTREAM_MODEL ||
            mutationPreviewEnv.ULTRATHINK_GATEWAY_CODEX_MODEL || DEFAULT_CODEX_MODEL
          : modelIdWithoutBracketQualifiers(previewMainModel);
      mutationPreviewEnv.ULTRATHINK_GATEWAY_ANTHROPIC_PASSTHROUGH_MODELS =
        previewMainProvider === 'anthropic'
          ? defaultWorkflowAnthropicPassthroughModels(previewMainModel).join(',')
          : 'none';
      mutationPreviewEnv.ULTRATHINK_GATEWAY_MAIN_REASONING_EFFORT =
        previewMainProvider === 'codex'
          ? parsed.effort?.toLowerCase() ||
            mutationPreviewEnv.ULTRATHINK_GATEWAY_SUBAGENT_REASONING_EFFORT ||
            DEFAULT_SUBAGENT_REASONING_EFFORT
          : '';
    }
    const current =
      parsed.agents || parsed.effort || selectsCodexMain || selectedMainProvider === 'anthropic'
        ? effectiveConfigurationSummary(mutationPreviewEnv)
        : null;
    const requestedMainProvider = parsed.main
      ? selectedMainPreset?.provider || 'anthropic'
      : current?.main.provider || '';
    const directCodexMainActive = requestedMainProvider === 'codex';
    const selectedAgentModel = provisionalAgentModel;
    if (parsed.main) {
      updates.ULTRATHINK_GATEWAY_MAIN_MODEL_ID = selectedMainModel;
      updates.ULTRATHINK_GATEWAY_MAIN_PROVIDER = selectedMainProvider;
      updates.ULTRATHINK_GATEWAY_MAIN_UPSTREAM_MODEL =
        selectedMainProvider === 'codex'
          ? selectedAgentModel || current?.agents.model || DEFAULT_CODEX_MODEL
          : modelIdWithoutBracketQualifiers(selectedMainModel);
      updates.ULTRATHINK_GATEWAY_ANTHROPIC_PASSTHROUGH_MODELS =
        selectedMainProvider === 'anthropic'
          ? defaultWorkflowAnthropicPassthroughModels(selectedMainModel).join(',')
          : 'none';
      removals.add('CLAUDE_WORKFLOW_MAIN_PROVIDER');
      // Main presets own the passthrough family. Writing it explicitly shadows
      // older values in the legacy ~/.ultrathink.env fallback.
      // Explicit route values also shadow older values in ~/.ultrathink.env.
      // Agent changes below keep a direct Codex main route in sync.
      if (selectedMainProvider === 'qwen') {
        updates.ULTRATHINK_GATEWAY_MAIN_REASONING_EFFORT =
          QWEN_TOKEN_PLAN_DEFAULTS.reasoningEffort;
      } else if (selectedMainProvider === 'kimi' || selectedMainProvider === 'deepseek') {
        updates.ULTRATHINK_GATEWAY_MAIN_REASONING_EFFORT = 'max';
      } else if (selectedMainProvider === 'codex') {
        updates.ULTRATHINK_GATEWAY_MAIN_REASONING_EFFORT =
          parsed.effort || current?.agents.effort || DEFAULT_SUBAGENT_REASONING_EFFORT;
      } else {
        removals.add('ULTRATHINK_GATEWAY_MAIN_REASONING_EFFORT');
      }
      if (selectedMainPreset?.kimiContextTokens) {
        updates.ULTRATHINK_GATEWAY_KIMI_CONTEXT_TOKENS = selectedMainPreset.kimiContextTokens;
      } else if (selectedMainProvider === 'kimi') {
        updates.ULTRATHINK_GATEWAY_KIMI_CONTEXT_TOKENS = '1048576';
      } else {
        removals.add('ULTRATHINK_GATEWAY_KIMI_CONTEXT_TOKENS');
      }
      if (selectsQwenMain) {
        updates.ULTRATHINK_GATEWAY_QWEN_CONTEXT_TOKENS = String(
          QWEN_TOKEN_PLAN_DEFAULTS.contextTokens
        );
        updates.ULTRATHINK_GATEWAY_QWEN_MAX_OUTPUT_TOKENS = String(
          QWEN_TOKEN_PLAN_DEFAULTS.maxOutputTokens
        );
        updates.ULTRATHINK_GATEWAY_QWEN_MODEL = QWEN_TOKEN_PLAN_DEFAULTS.model;
        updates.ULTRATHINK_GATEWAY_QWEN_REASONING_EFFORT =
          QWEN_TOKEN_PLAN_DEFAULTS.reasoningEffort;
      }
    }
    if (parsed.agents) {
      updates.ULTRATHINK_GATEWAY_CODEX_MODEL = selectedAgentModel;
      updates.ULTRATHINK_GATEWAY_SUBAGENT_UPSTREAM_MODEL = selectedAgentModel;
      if (directCodexMainActive) {
        updates.ULTRATHINK_GATEWAY_MAIN_UPSTREAM_MODEL = selectedAgentModel;
      }
    }
    if (parsed.agents || parsed.effort) {
      // An empty primary assignment both enables automatic truthful IDs and
      // prevents a stale alias in legacy ~/.ultrathink.env from resurfacing.
      updates.CLAUDE_WORKFLOW_SUBAGENT_MODEL_ID = '';
      removals.delete('CLAUDE_WORKFLOW_SUBAGENT_MODEL_ID');
      if (directCodexMainActive) {
        updates.ULTRATHINK_GATEWAY_MAIN_MODEL_ID = 'codex';
      }
    }
    if (parsed.effort) {
      const effort = parsed.effort.toLowerCase();
      if (!REASONING_EFFORTS.has(effort)) {
        throw new Error(`unsupported reasoning effort ${parsed.effort}`);
      }
      updates.ULTRATHINK_GATEWAY_CODEX_REASONING_EFFORT = effort;
      updates.ULTRATHINK_GATEWAY_SUBAGENT_REASONING_EFFORT = effort;
      if (directCodexMainActive) {
        updates.ULTRATHINK_GATEWAY_MAIN_REASONING_EFFORT = effort;
      }
    }
    if (parsed.agents || parsed.effort) {
      const gatewayConfig = withProcessEnvironment(mutationPreviewEnv, function loadPreview() {
        return loadGatewayConfig();
      });
      const proposedAgentModel = selectedAgentModel || current.agents.model;
      const proposedEffort = String(parsed.effort || current.agents.effort).toLowerCase();
      const proposedCapabilities = resolveCodexCapabilities({
        command: gatewayConfig.codex.command,
        cwd: gatewayConfig.codex.cwd,
        model: proposedAgentModel,
        contextProfile: gatewayConfig.codex.contextProfile,
        requestedContextWindow: gatewayConfig.codex.requestedContextWindow,
        reasoningEffort: proposedEffort,
      });
      if (!proposedCapabilities.effortSupported) {
        throw new Error(
          `${proposedAgentModel} does not support Codex reasoning effort ${proposedEffort}; ` +
            `choose one of ${proposedCapabilities.reasoningEfforts.join(', ')}`
        );
      }
    }
    if (parsed.context) {
      const context = parsed.context.toLowerCase();
      if (!CONTEXT_PROFILES.has(context)) {
        throw new Error('--context must be standard or long');
      }
      updates.ULTRATHINK_GATEWAY_CODEX_CONTEXT = context;
      removals.add('ULTRATHINK_GATEWAY_CODEX_CONTEXT_PROFILE');
    }
    if (parsed.permissions) {
      const permissions = parsed.permissions.toLowerCase();
      if (!PERMISSION_MODES.has(permissions)) {
        throw new Error('--permissions must be bypass or prompt');
      }
      updates.CLAUDE_WORKFLOW_SKIP_PERMISSIONS =
        permissions === 'bypass' ? 'true' : 'false';
    }
  }

  const result = writeUserConfiguration(configurationPath(), updates, [...removals]);
  writeLine(stdout, `${result.changed ? 'Saved' : 'Already current'}: ${result.path}`);
  if (parsed.reset) {
    writeLine(
      stdout,
      'Managed settings were removed. Package defaults apply unless parent or legacy configuration overrides them.'
    );
  } else {
    for (const name of writeOptions) {
      const value = parsed[name];
      writeLine(stdout, `${name[0].toUpperCase()}${name.slice(1)}: ${value}`);
    }
    const kimiConfigurationIssue = selectsKimiMain
      ? kimiProfileConfigurationIssue(loadGatewayConfig().kimi)
      : '';
    if (kimiConfigurationIssue) {
      writeLine(
        stdout,
        `Next: ${kimiConfigurationGuidance(kimiConfigurationIssue)}`
      );
    }
    const qwenConfigurationIssue = selectsQwenMain
      ? qwenProfileConfigurationIssue(loadGatewayConfig().qwen)
      : '';
    if (qwenConfigurationIssue) {
      writeLine(
        stdout,
        `Next: ${qwenConfigurationGuidance(qwenConfigurationIssue)}`
      );
    }
    if (selectsDeepSeekMain && !loadGatewayConfig().deepseek.apiKey) {
      writeLine(stdout, 'Next: set DEEPSEEK_API_KEY in ~/.claude-workflow.env, then run claude-workflow setup.');
    }
    if (selectsKimiMain || selectsQwenMain || selectsCodexMain || selectsDeepSeekMain) {
      writeLine(
        stdout,
        'Next: start a new `claude-workflow` session. Custom models use documented per-session Claude Code settings.'
      );
    }
    writeLine(stdout, 'These settings apply to new commands. Exported environment variables take precedence.');
    writeLine(stdout, 'Custom route-map entries can override the common agent settings.');
    writeLine(
      stdout,
      'Shared daemon changes require `claude-workflow-gateway restart`; opening a new shell does not reload a running daemon.'
    );
  }
}

function diagnosticReport(options = {}) {
  const env = options.env || process.env;
  return withProcessEnvironment(env, function buildDiagnosticReport() {
    let routeCheck;
    let summary = null;
    try {
      summary = effectiveConfigurationSummary(process.env);
      routeCheck = {
        ok: true,
        label: `Routing ${summary.main.name} main; ${summary.agents.name}/${summary.agents.effort} agents`,
      };
    } catch (error) {
      routeCheck = {
        ok: false,
        label: 'Routing configuration',
        detail: error.message,
      };
    }

    let codexCommand = 'codex';
    try {
      codexCommand = buildWorkflowGatewayConfig().config.codex.command;
    } catch {
      // The routing check above reports invalid configuration. Use the default
      // command so the remaining diagnostics still provide useful information.
    }
    const run = options.run || commandResult;
    const checks = [
      checkWorkflowPlatform(env, codexCommand, options.cwd || process.cwd()),
      nodeCheck(),
      inheritedWorkflowRoutingCheck(env, {
        migrationRequested: options.migrateShell === true,
      }),
      claudeCheck(run, env, summary?.main?.provider === 'anthropic'),
      codexCheck(codexCommand, run, env),
      routeCheck,
    ];
    if (summary?.main?.provider && summary.main.provider !== 'anthropic') {
      checks.splice(3, 0, claudeThirdPartyModelCheck(env, options.prepareClaude === true));
    }
    return { checks, ok: checks.every((check) => check.ok) };
  });
}

function printDiagnosticReport(report, stdout) {
  for (const check of report.checks) {
    writeLine(stdout, `[${check.ok ? 'ok' : 'error'}] ${check.label}`);
    if (check.detail) {
      writeLine(stdout, `        ${check.detail}`);
    }
  }
}

function setupUsage() {
  return [
    'Usage:',
    '  claude-workflow setup',
    '  claude-workflow setup --shared',
    '',
    'Checks Node.js, Claude Code, Codex, authentication, platform paths, routing, and inherited shell routing.',
    'When Bash is available, setup also removes historical shell routing and refreshes an owned running shared daemon after upgrades.',
    'It does not start a stopped shared daemon unless --shared is supplied.',
    '',
    'Options:',
    '  --prepare-claude  Compatibility no-op for Claude state; custom models use documented per-session settings',
    '  --shared  Migrate historical shell routing, then start the shared gateway',
    '  --json    Print diagnostics as JSON (cannot be combined with --shared or --prepare-claude)',
    '  --help, -h Show this help',
    '',
    'Shared state owns claude-workflow-gateway.env and gateway-trace directly below',
    'CLAUDE_WORKFLOW_GATEWAY_STATE_DIR; external env/trace paths are rejected.',
  ].join('\n');
}

function runGatewayAction(action, options = {}) {
  const result = spawnSync('bash', [GATEWAY_MANAGER, action], {
    cwd: process.cwd(),
    env: options.env || process.env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (!options.quiet && result.stdout) {
    (options.stdout || process.stdout).write(result.stdout);
  }
  if (!options.quiet && result.stderr) {
    (options.stderr || process.stderr).write(result.stderr);
  }
  if (result.status !== 0 || result.error) {
    throw new Error(`shared gateway ${action} failed: ${commandFailure(result)}`);
  }
}

function managerPathSetting(env, name) {
  const value = String(env[name] || '').trim();
  if (value && !path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`);
  }
  return value;
}

function resolveThroughExistingAncestor(value, visited = new Set()) {
  const absolute = path.resolve(value);
  if (visited.has(absolute) || visited.size >= 40) {
    throw new Error(`path contains a symlink cycle: ${value}`);
  }
  visited.add(absolute);
  const parsed = path.parse(absolute);
  const parts = absolute
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean);
  let candidate = parsed.root;

  for (let index = 0; index < parts.length; index += 1) {
    candidate = path.join(candidate, parts[index]);
    let stats;
    try {
      stats = fs.lstatSync(candidate);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return path.join(candidate, ...parts.slice(index + 1));
      }
      if (error?.code === 'ENOTDIR') {
        throw new Error(`path has a non-directory ancestor: ${candidate}`);
      }
      throw error;
    }

    if (!stats.isSymbolicLink()) {
      continue;
    }
    const linkTarget = fs.readlinkSync(candidate);
    const resolvedTarget = path.isAbsolute(linkTarget)
      ? linkTarget
      : path.resolve(path.dirname(candidate), linkTarget);
    return resolveThroughExistingAncestor(
      path.join(resolvedTarget, ...parts.slice(index + 1)),
      visited
    );
  }

  return candidate;
}

export function validateSharedSetup(env = process.env, cwd = process.cwd()) {
  if (!findExecutable('bash', env, cwd)) {
    throw new Error('shared setup requires bash on PATH');
  }
  fs.accessSync(GATEWAY_MANAGER, fs.constants.R_OK);
  if (new Set(['1', 'true', 'yes', 'on']).has(
    String(env.CLAUDE_WORKFLOW_LOAD_PROJECT_ENV || '').trim().toLowerCase()
  )) {
    throw new Error(
      'shared mode cannot load a repository .env; use the per-session `claude-workflow` launcher when CLAUDE_WORKFLOW_LOAD_PROJECT_ENV is enabled'
    );
  }

  managerPathSetting(env, 'CLAUDE_WORKFLOW_GATEWAY_STATE_DIR');
  managerPathSetting(env, 'CLAUDE_WORKFLOW_GATEWAY_ENV_FILE');
  const homeDirectory = env.HOME || os.homedir();
  const canonicalStateDirectory = path.join(
    env.XDG_STATE_HOME || path.join(homeDirectory, '.cache'),
    'claude-workflow'
  );
  const legacyStateDirectory = path.join(homeDirectory, '.cache', 'ultrathink');
  const legacyHasPriorState =
    !fs.existsSync(canonicalStateDirectory) &&
    [
      'claude-workflow-gateway.pid',
      'claude-workflow-gateway.env',
      '.claude-workflow-gateway.owner',
    ].some((entry) => fs.existsSync(path.join(legacyStateDirectory, entry)));
  const sharedStateDirectory =
    env.CLAUDE_WORKFLOW_GATEWAY_STATE_DIR ||
    (legacyHasPriorState ? legacyStateDirectory : canonicalStateDirectory);
  const sharedEnvironmentFile =
    env.CLAUDE_WORKFLOW_GATEWAY_ENV_FILE ||
    path.join(sharedStateDirectory, 'claude-workflow-gateway.env');
  const expectedEnvironmentFile = path.join(
    sharedStateDirectory,
    'claude-workflow-gateway.env'
  );
  if (
    path.resolve(sharedStateDirectory) !== sharedStateDirectory ||
    path.resolve(sharedEnvironmentFile) !== sharedEnvironmentFile ||
    sharedEnvironmentFile !== expectedEnvironmentFile
  ) {
    throw new Error(
      `CLAUDE_WORKFLOW_GATEWAY_ENV_FILE must be exactly ${expectedEnvironmentFile} inside the normalized shared gateway state directory`
    );
  }

  const configuredCodexCommand = String(
    env.ULTRATHINK_GATEWAY_CODEX_COMMAND || ''
  ).trim();
  const codexCommand = configuredCodexCommand || 'codex';
  const callerCodex = findExecutable(codexCommand, env, cwd);
  const sharedCodex = findExecutable(codexCommand, env, sharedStateDirectory);
  let sameCodexExecutable = false;
  if (callerCodex && sharedCodex) {
    try {
      sameCodexExecutable =
        fs.realpathSync(callerCodex) === fs.realpathSync(sharedCodex);
    } catch {
      sameCodexExecutable = false;
    }
  }
  if (!sameCodexExecutable) {
    throw new Error(
      'shared setup must resolve the same Codex executable from the current ' +
        'working directory and the managed state directory; set ' +
        'ULTRATHINK_GATEWAY_CODEX_COMMAND to an absolute executable path or ' +
        'remove cwd-relative PATH entries'
    );
  }
  const traceDirectory = String(env.ULTRATHINK_GATEWAY_TRACE_DIR || '').trim();
  const disabledTraceValues = new Set(['0', 'false', 'no', 'off']);
  if (
    traceDirectory &&
    !disabledTraceValues.has(traceDirectory.toLowerCase()) &&
    traceDirectory !== path.join(sharedStateDirectory, 'gateway-trace')
  ) {
    throw new Error(
      `shared-daemon ULTRATHINK_GATEWAY_TRACE_DIR must be ${path.join(sharedStateDirectory, 'gateway-trace')} or disabled`
    );
  }

  if (isWsl(env)) {
    for (const [label, candidate] of [
      ['Claude Workflow installation', GATEWAY_MANAGER],
      ['Shared gateway state', env.CLAUDE_WORKFLOW_GATEWAY_STATE_DIR || ''],
      ['Shared gateway env file', env.CLAUDE_WORKFLOW_GATEWAY_ENV_FILE || ''],
      ['Shared gateway trace directory', traceDirectory],
    ]) {
      if (candidate && isWindowsMountedPath(resolveThroughExistingAncestor(candidate))) {
        throw new Error(`${label} must use the WSL Linux filesystem, not ${candidate}`);
      }
    }
  }
}

export function runSetupCommand(args, options = {}) {
  const stdout = options.stdout || process.stdout;
  const parsed = parseNamedOptions(
    args,
    new Map([
      ['shared', false],
      ['prepare-claude', false],
      ['json', false],
      ['help', false],
    ])
  );
  if (parsed.help) {
    writeLine(stdout, setupUsage());
    return;
  }
  if (parsed.json && (parsed.shared || parsed['prepare-claude'])) {
    throw new Error('--json cannot be combined with --shared or --prepare-claude');
  }

  const env = options.env || process.env;
  if (parsed.shared) {
    validateSharedSetup(env, options.cwd || process.cwd());
  }
  const canRunUpgradeMaintenance =
    !parsed.json && Boolean(findExecutable('bash', env));
  const report = diagnosticReport({
    ...options,
    migrateShell: parsed.shared === true || canRunUpgradeMaintenance,
    prepareClaude: parsed['prepare-claude'] === true,
  });
  if (parsed.json) {
    writeLine(stdout, JSON.stringify(report, null, 2));
  } else {
    writeLine(stdout, 'Claude Workflow setup');
    writeLine(stdout);
    printDiagnosticReport(report, stdout);
  }
  if (!report.ok) {
    throw new Error('setup checks failed; resolve the errors above and run setup again');
  }

  if (parsed['prepare-claude']) {
    writeLine(
      stdout,
      'No Claude state changes are required. Custom models are configured through documented per-session settings.'
    );
  }

  if (parsed.shared) {
    const gatewayAction = options.runGatewayAction || runGatewayAction;
    gatewayAction('migrate-shell', options);
    gatewayAction('start', {
      ...options,
      env: environmentWithoutManagedGatewayAuth(env),
    });
    writeLine(
      stdout,
      'Historical Bash/zsh routing was migrated to cleanup-only mode. Shared gateway started from a clean environment for explicit clients. Source the migrated rc or open a new shell before using plain `claude`; use `claude-workflow` for scoped routing.'
    );
  } else if (canRunUpgradeMaintenance) {
    const gatewayAction = options.runGatewayAction || runGatewayAction;
    gatewayAction('migrate-shell-upgrade', { ...options, quiet: true });
    gatewayAction('reconcile', {
      ...options,
      quiet: true,
      env: environmentWithoutManagedGatewayAuth(env),
    });
    if (!parsed.json) {
      writeLine(stdout);
      writeLine(stdout, 'Ready. Run `claude-workflow` in a trusted repository.');
      writeLine(stdout, 'Optional: use `claude-workflow config` to inspect or change defaults.');
    }
  } else if (!parsed.json) {
    writeLine(stdout);
    writeLine(stdout, 'Ready. Run `claude-workflow` in a trusted repository.');
    writeLine(stdout, 'Optional: use `claude-workflow config` to inspect or change defaults.');
  }
}

export function runDoctorCommand(args, options = {}) {
  const stdout = options.stdout || process.stdout;
  const parsed = parseNamedOptions(
    args,
    new Map([
      ['json', false],
      ['help', false],
    ])
  );
  if (parsed.help) {
    writeLine(
      stdout,
      'Usage: claude-workflow doctor [--json]\n\nRe-runs the read-only prerequisite, routing, and inherited shell-routing checks.\n\nOptions:\n  --json     Print diagnostics as JSON\n  --help, -h Show this help'
    );
    return;
  }

  const report = diagnosticReport(options);
  if (parsed.json) {
    writeLine(stdout, JSON.stringify(report, null, 2));
  } else {
    writeLine(stdout, 'Claude Workflow doctor');
    writeLine(stdout);
    printDiagnosticReport(report, stdout);
  }
  if (!report.ok) {
    throw new Error('diagnostics failed');
  }
}
