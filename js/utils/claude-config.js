import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import {
  CLAUDE_TERMINAL_TITLE_ENV_NAME,
  GATEWAY_ONLY_CREDENTIAL_ENV_NAMES,
} from './child-env.js';

export const CLAUDE_WORKFLOW_MANAGED_SETTINGS_ENV_NAMES = Object.freeze([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BETAS',
  'ANTHROPIC_CUSTOM_MODEL_OPTION',
  'ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION',
  'ANTHROPIC_CUSTOM_MODEL_OPTION_NAME',
  'ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION',
  'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME',
  'ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_CODE_DISABLE_1M_CONTEXT',
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK',
  'CLAUDE_CODE_DISABLE_THINKING',
  'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL_FORCE',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_VERTEX',
]);

export function buildClaudeSettingsOverrideEnvironment(extraEnv, childEnv) {
  const settingsEnv = Object.fromEntries(
    GATEWAY_ONLY_CREDENTIAL_ENV_NAMES.map((name) => [name, ''])
  );
  for (const name of CLAUDE_WORKFLOW_MANAGED_SETTINGS_ENV_NAMES) {
    if (name === 'ANTHROPIC_API_KEY' || name === 'ANTHROPIC_AUTH_TOKEN') {
      if (childEnv[name]) {
        settingsEnv[name] = String(childEnv[name]);
      }
      continue;
    }
    const value = extraEnv[name];
    settingsEnv[name] = value === null || value === undefined ? '' : String(value);
  }
  // Direct non-Anthropic routes suppress Claude's auxiliary terminal-title
  // request. Do not publish a blank value for other routes: their parent
  // environment and persistent Claude settings remain the user's preference.
  for (const name of [CLAUDE_TERMINAL_TITLE_ENV_NAME, 'ENABLE_TOOL_SEARCH', 'MCP_CONNECTION_NONBLOCKING']) {
    if (extraEnv[name] != null) settingsEnv[name] = String(extraEnv[name]);
  }
  settingsEnv.ANTHROPIC_SMALL_FAST_MODEL = String(
    extraEnv.CLAUDE_CODE_SUBAGENT_MODEL || ''
  );
  for (const name of ['NO_PROXY', 'no_proxy']) {
    const value = extraEnv[name];
    if (value !== null && value !== undefined) {
      settingsEnv[name] = String(value);
    }
  }
  return settingsEnv;
}

function ownerOnlyModeIsEnforced(stats) {
  return process.platform === 'win32' || (stats.mode & 0o077) === 0;
}

function assertSafeRegularFile(target, stats) {
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Claude state path must be a regular file, not a symlink: ${target}`);
  }
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new Error(`Claude state file is not owned by the current user: ${target}`);
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

function optionalFile(target) {
  try {
    const stats = fs.lstatSync(target);
    assertSafeRegularFile(target, stats);
    return { content: fs.readFileSync(target, 'utf8'), stats };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { content: '', stats: null };
    }
    throw error;
  }
}

function writePrivateAtomic(target, content, expectedStats = undefined) {
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true });

  const current = optionalFile(target);

  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  );
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.fchmodSync(descriptor, 0o600);
    const temporaryStats = fs.fstatSync(descriptor);
    if (!temporaryStats.isFile() || !ownerOnlyModeIsEnforced(temporaryStats)) {
      throw new Error(
        `Claude state storage does not enforce owner-only permissions: ${directory}. ` +
          'On WSL, use the Linux filesystem or enable DrvFS metadata.'
      );
    }
    fs.closeSync(descriptor);
    descriptor = null;
    const requiredStats = expectedStats === undefined ? current.stats : expectedStats;
    const latest = optionalFile(target);
    if (requiredStats === null && latest.stats !== null) {
      throw new Error(`Claude state file appeared while it was being updated: ${target}`);
    }
    if (
      requiredStats !== null &&
      (latest.stats === null || !sameFileVersion(requiredStats, latest.stats))
    ) {
      throw new Error(`Claude state file changed while it was being updated: ${target}`);
    }
    fs.renameSync(temporary, target);
    fs.chmodSync(target, 0o600);
    const publishedStats = fs.lstatSync(target);
    assertSafeRegularFile(target, publishedStats);
    if (!ownerOnlyModeIsEnforced(publishedStats)) {
      throw new Error(
        `Claude state storage does not enforce owner-only permissions: ${target}. ` +
          'On WSL, use the Linux filesystem or enable DrvFS metadata.'
      );
    }
  } finally {
    if (descriptor !== null) {
      fs.closeSync(descriptor);
    }
    fs.rmSync(temporary, { force: true });
  }
}

function validatedModelPicker(modelPicker) {
  if (modelPicker === null || modelPicker === undefined) {
    return null;
  }
  if (!modelPicker || typeof modelPicker !== 'object' || Array.isArray(modelPicker)) {
    throw new Error('Claude settings modelPicker must be an object');
  }
  if (
    !Array.isArray(modelPicker.options) ||
    modelPicker.options.length === 0 ||
    modelPicker.options.length > 32
  ) {
    throw new Error('Claude settings modelPicker options must contain 1 to 32 rows');
  }
  if (
    modelPicker.replaceBuiltInOptions !== undefined &&
    typeof modelPicker.replaceBuiltInOptions !== 'boolean'
  ) {
    throw new Error('Claude settings modelPicker replaceBuiltInOptions must be a boolean');
  }

  const options = modelPicker.options.map(function validateModelPickerRow(row, index) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`Claude settings modelPicker row ${index + 1} must be an object`);
    }
    const model = typeof row.model === 'string' ? row.model.trim() : '';
    if (!model) {
      throw new Error(`Claude settings modelPicker row ${index + 1} requires a model`);
    }
    const result = { model };
    for (const field of ['label', 'description']) {
      if (row[field] === undefined) {
        continue;
      }
      if (typeof row[field] !== 'string' || row[field].trim() === '') {
        throw new Error(
          `Claude settings modelPicker row ${index + 1} ${field} must be a non-empty string`
        );
      }
      result[field] = row[field].trim();
    }
    return result;
  });

  return {
    options,
    replaceBuiltInOptions: modelPicker.replaceBuiltInOptions === true,
  };
}

export function createPrivateClaudeSettingsOverride(settingsEnv, modelPicker = null) {
  if (!settingsEnv || typeof settingsEnv !== 'object' || Array.isArray(settingsEnv)) {
    throw new Error('Claude settings override env must be an object');
  }
  for (const [name, value] of Object.entries(settingsEnv)) {
    if (typeof value !== 'string') {
      throw new Error(`Claude settings override ${name} must be a string`);
    }
  }
  const validatedPicker = validatedModelPicker(modelPicker);

  const temporaryRoot = os.tmpdir();
  if (!path.isAbsolute(temporaryRoot)) {
    throw new Error(`Claude settings override directory must be absolute: ${temporaryRoot}`);
  }
  const directory = fs.mkdtempSync(
    path.join(temporaryRoot, `claude-workflow-settings-${process.pid}-`)
  );
  let cleaned = false;
  try {
    fs.chmodSync(directory, 0o700);
    const directoryStats = fs.lstatSync(directory);
    if (
      directoryStats.isSymbolicLink() ||
      !directoryStats.isDirectory() ||
      (typeof process.getuid === 'function' && directoryStats.uid !== process.getuid()) ||
      !ownerOnlyModeIsEnforced(directoryStats)
    ) {
      throw new Error(
        `Claude settings override storage does not enforce owner-only permissions: ${directory}. ` +
          'On WSL, use the Linux filesystem or set TMPDIR to a private Linux path.'
      );
    }

    const target = path.join(directory, 'settings.json');
    const settings = {
      env: settingsEnv,
      ...(validatedPicker ? { modelPicker: validatedPicker } : {}),
    };
    writePrivateAtomic(target, `${JSON.stringify(settings, null, 2)}\n`, null);
    return {
      path: target,
      cleanup() {
        if (cleaned) {
          return;
        }
        cleaned = true;
        fs.rmSync(directory, { force: true, recursive: true });
      },
    };
  } catch (error) {
    fs.rmSync(directory, { force: true, recursive: true });
    throw error;
  }
}

function claudeHomeDirectory(env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  if (!path.isAbsolute(home)) {
    throw new Error(`Claude home directory must be absolute: ${home}`);
  }
  return home;
}

function configuredClaudeDirectory(env = process.env) {
  const configured = String(env.CLAUDE_CONFIG_DIR || '').trim();
  if (!configured) {
    return '';
  }
  if (!path.isAbsolute(configured)) {
    throw new Error(`CLAUDE_CONFIG_DIR must be absolute: ${configured}`);
  }
  return path.normalize(configured);
}

export function claudeUserStatePath(env = process.env) {
  const configured = configuredClaudeDirectory(env);
  return configured
    ? path.join(configured, '.claude.json')
    : path.join(claudeHomeDirectory(env), '.claude.json');
}

export function claudeUserSettingsPath(env = process.env) {
  const configured = configuredClaudeDirectory(env);
  return configured
    ? path.join(configured, 'settings.json')
    : path.join(claudeHomeDirectory(env), '.claude', 'settings.json');
}

export function prepareClaudeThirdPartyModelSupport(env = process.env) {
  const target = claudeUserStatePath(env);

  return {
    backupPath: null,
    changed: false,
    path: target,
    settingsBackupPath: null,
    settingsChanged: false,
    settingsPath: claudeUserSettingsPath(env),
    stateChanged: false,
  };
}
