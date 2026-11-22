import { spawnSync } from 'node:child_process';
import process from 'node:process';

import { environmentWithoutGatewayAndAnthropicCredentials } from './child-env.js';

// Only report fixed labels; Codex's status text can contain a masked key.
export function codexCredentialStatus(command, run = spawnSync, env = process.env) {
  const result = run(command, ['login', 'status'], {
    env: environmentWithoutGatewayAndAnthropicCredentials(env),
    encoding: 'utf8',
    timeout: 10_000,
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  if (result.status !== 0 || result.error) return null;
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
  if (/not\s+logged\s+in|logged\s+out|not\s+authenticated|not\s+signed\s+in/iu.test(output)) {
    return null;
  }
  // In API-key mode Codex defers authentication to the first request.
  if (/^API key configured(?:[ \t]+-|[ \t]*$)/imu.test(output)) return 'API key configured';
  return /\blogged in\b|\bauthenticated\b|\bsigned in\b/iu.test(output) ? 'authenticated' : null;
}
