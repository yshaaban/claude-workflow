import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { codexCatalogIssue, lookupCodexCatalogModel } from './codex-capabilities.js';
import { GatewayError } from './model-routing.js';

async function verifyPrivateStorage(target, mode) {
  const stats = await fs.lstat(target);
  if (
    stats.isSymbolicLink() ||
    !(mode === 0o700 ? stats.isDirectory() : stats.isFile()) ||
    (typeof process.getuid === 'function' && stats.uid !== process.getuid()) ||
    (process.platform !== 'win32' && (stats.mode & 0o777) !== mode)
  ) {
    throw new GatewayError(
      502,
      'api_error',
      `Codex catalog storage does not enforce owner-only permissions: ${target}. ` +
        'On WSL, use the Linux filesystem or set TMPDIR to a private Linux path.'
    );
  }
}

export async function createCodexToolCatalog({ command, cwd, model, env = process.env }) {
  const temporaryRoot = os.tmpdir();
  if (!path.isAbsolute(temporaryRoot)) {
    throw new GatewayError(502, 'api_error', 'Codex catalog TMPDIR must be an absolute path');
  }
  const requiredModel = String(model || '').trim();
  const { models, status } = lookupCodexCatalogModel(command, cwd, requiredModel, env);
  if (!requiredModel || status !== 'present') {
    throw new GatewayError(
      502,
      'api_error',
      `cannot isolate Codex tools: ${codexCatalogIssue(status, requiredModel || 'the routed model')}`
    );
  }

  // These fields register native handlers independently of feature flags.
  // CodeModeOnly itself adds MCP resource tools even without MCP servers.
  // Expose Claude's dynamic tools directly and retain other model metadata.
  const isolatedModels = models.map((entry) => ({
    ...entry,
    experimental_supported_tools: [],
    apply_patch_tool_type: null,
    tool_mode: 'direct',
  }));
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'claude-workflow-codex-catalog-'));
  let disposal = null;
  const dispose = () => {
    disposal ||= fs.rm(directory, { recursive: true, force: true, maxRetries: 3 });
    return disposal;
  };
  try {
    await fs.chmod(directory, 0o700);
    await verifyPrivateStorage(directory, 0o700);
    const filePath = path.join(directory, 'models.json');
    await fs.writeFile(filePath, JSON.stringify({ models: isolatedModels }), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await fs.chmod(filePath, 0o600);
    await verifyPrivateStorage(filePath, 0o600);
    return { filePath, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
