#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  INSTALLED_CLI_REQUIRED_ENV_NAME,
  installedCliPolicy,
} from './helpers/installed-cli-policy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_FILES = Object.freeze([
  'test/codex-appserver-installed-contract.test.js',
  'test/installed-claude-codex.test.js',
  'test/installed-claude-deepseek.test.js',
  'test/installed-claude-fable.test.js',
  'test/installed-claude-kimi.test.js',
  'test/installed-claude-qwen.test.js',
]);

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function assertExpectedVersion(displayName, actual, expected) {
  if (!expected) {
    return;
  }
  const versionToken = new RegExp(
    `(?:^|[^0-9.])${escapeRegExp(expected)}(?:$|[^0-9.])`,
    'u'
  );
  if (!versionToken.test(actual)) {
    throw new Error(`${displayName} version mismatch: expected ${expected}, received ${actual}`);
  }
}

function main() {
  const requiredEnvironment = {
    ...process.env,
    [INSTALLED_CLI_REQUIRED_ENV_NAME]: '1',
  };
  const claude = installedCliPolicy({
    command: 'claude',
    displayName: 'Claude Code',
    env: requiredEnvironment,
  });
  const codexCommand = process.env.ULTRATHINK_GATEWAY_CODEX_COMMAND || 'codex';
  const codex = installedCliPolicy({
    command: codexCommand,
    displayName: 'Codex CLI',
    env: requiredEnvironment,
  });

  assertExpectedVersion(
    'Claude Code',
    claude.version,
    process.env.CLAUDE_WORKFLOW_EXPECT_CLAUDE_VERSION
  );
  assertExpectedVersion(
    'Codex CLI',
    codex.version,
    process.env.CLAUDE_WORKFLOW_EXPECT_CODEX_VERSION
  );
  process.stdout.write(`Claude Code: ${claude.version}\nCodex CLI: ${codex.version}\n`);

  const result = spawnSync(
    process.execPath,
    ['--test', '--test-concurrency=1', ...CONTRACT_FILES],
    {
      cwd: ROOT,
      env: requiredEnvironment,
      stdio: 'inherit',
      timeout: 180_000,
      windowsHide: true,
    }
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exitCode = result.status || 1;
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
