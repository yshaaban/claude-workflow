import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INSTALLED_CLI_REQUIRED_ENV_NAME,
  installedCliPolicy,
  installedClaudePolicy,
  installedCodexPolicy,
} from './helpers/installed-cli-policy.js';
import { MINIMUM_CLAUDE_VERSION, MINIMUM_CODEX_VERSION } from '../js/utils/cli-versions.js';

const MISSING_COMMAND = 'claude-workflow-cli-that-does-not-exist';

test('missing installed CLIs remain an explicit optional-test skip by default', function () {
  const policy = installedCliPolicy({
    command: MISSING_COMMAND,
    displayName: 'Fixture CLI',
    env: {},
  });

  assert.equal(policy.available, false);
  assert.equal(policy.required, false);
  assert.match(policy.skip, /Fixture CLI is unavailable/u);
});

test('required installed CLIs fail instead of silently skipping', function () {
  assert.throws(
    () =>
      installedCliPolicy({
        command: MISSING_COMMAND,
        displayName: 'Fixture CLI',
        env: { [INSTALLED_CLI_REQUIRED_ENV_NAME]: '1' },
      }),
    /requires installed CLI contract tests to run/u
  );
});

test('an available required CLI reports its version and never skips', function () {
  const policy = installedCliPolicy({
    command: process.execPath,
    displayName: 'Node.js',
    env: { ...process.env, [INSTALLED_CLI_REQUIRED_ENV_NAME]: 'true' },
  });

  assert.equal(policy.available, true);
  assert.equal(policy.required, true);
  assert.equal(policy.skip, false);
  assert.match(policy.version, /^v\d+/u);
});

for (const [name, policy, minimum] of [
  ['Claude', installedClaudePolicy, MINIMUM_CLAUDE_VERSION],
  ['Codex', installedCodexPolicy, MINIMUM_CODEX_VERSION],
]) {
  test(`${name} contract tests skip an unsupported local CLI, but fail in required mode`, () => {
    function probe(version, required = false) {
      return policy({
        command: process.execPath,
        args: ['-e', 'console.log(process.argv[1])', version],
        env: { ...process.env, [INSTALLED_CLI_REQUIRED_ENV_NAME]: String(required) },
      });
    }
    assert.equal(probe(minimum.join('.'), true).skip, false);
    for (const version of ['0.0.1', 'unversioned']) {
      assert.match(probe(version).skip, /contract tests require .* or newer/u);
      assert.throws(() => probe(version, true), /requires installed CLI contract tests to run/u);
    }
  });
}
