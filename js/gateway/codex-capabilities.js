import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

import { environmentWithoutGatewayAndAnthropicCredentials } from '../utils/child-env.js';
import { effectiveCodexHome, executableIdentity } from '../utils/runtime-identity.js';
import { GatewayError } from './model-routing.js';

const DEFAULT_RAW_CONTEXT_TOKENS = 272_000;
const DEFAULT_MAX_RAW_CONTEXT_TOKENS = 272_000;
const DEFAULT_EFFECTIVE_CONTEXT_PERCENT = 95;
const CODEX_NATIVE_COMPACT_PERCENT = 90;
const GATEWAY_OUTPUT_RESERVE_TOKENS = 64_000;
const GATEWAY_PROMPT_HEADROOM_TOKENS = 32_000;
const CATALOG_TIMEOUT_MS = 5_000;
const CATALOG_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const CATALOG_NEGATIVE_CACHE_TTL_MS = 30_000;
// Match Codex models-manager's online catalog lifetime. The bundled catalog
// is part of the executable and can stay cached until that identity changes.
const CATALOG_ONLINE_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_TOOL_OUTPUT_TRUNCATION_POLICY = Object.freeze({
  mode: 'bytes',
  limit: 10_000,
});
const KNOWN_TOOL_OUTPUT_TRUNCATION_POLICY = Object.freeze({
  mode: 'tokens',
  limit: 10_000,
});

// Each tier advances independently. Only aliases follow releases; literal IDs
// in saved configuration continue to refer to that exact model.
export const CODEX_MODEL_ALIASES = Object.freeze({
  astra: 'gpt-6.2-astra',
  terra: 'gpt-6.1-terra',
  luna: 'gpt-6-luna',
});

// This is a workflow runner policy, not a limit on Codex's model catalog.
export function assertWorkflowRunnerModel(provider, upstreamModel) {
  if (provider !== 'codex' && provider !== 'openai') return;
  const model = String(upstreamModel ?? '').trim().toLowerCase();
  const isGpt62 = /^(?:codex-)?gpt-6\.2(?!\d)/u.test(model);
  if (!isGpt62 && model !== 'sol' && model !== 'codex-sol') return;
  if (/^gpt-6\.2-astra(?:-\d{4}-\d{2}-\d{2})?$/u.test(model)) return;
  throw new GatewayError(
    400,
    'invalid_request_error',
    `GPT-6.2 workflow runners require gpt-6.2-astra; "${model}" cannot run as a delegated model. ` +
      'Run claude-workflow config --agents astra --effort low (or --effort medium). ' +
      'If a route-map override selects this model, update that override too.'
  );
}

const XHIGH_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh']);
const MAX_EFFORTS = Object.freeze([...XHIGH_EFFORTS, 'max']);
const ULTRA_EFFORTS = Object.freeze([...MAX_EFFORTS, 'ultra']);

function knownModel(contextWindow, reasoningEfforts = ULTRA_EFFORTS, maxContextWindow = 872_000) {
  return Object.freeze({
    contextWindow,
    maxContextWindow,
    effectiveContextWindowPercent: 95,
    reasoningEfforts,
    toolOutputTruncationPolicy: KNOWN_TOOL_OUTPUT_TRUNCATION_POLICY,
  });
}

// Offline defaults are keyed by literal ID, never by tier. A newly selected
// alias must not inherit its predecessor's window or reasoning levels.
const KNOWN_MODEL_CAPABILITIES = new Map([
  ['gpt-6.2-astra', knownModel(272_000)],
  ['gpt-6.2-sol', knownModel(500_000)],
  ['gpt-6.1-terra', knownModel(500_000)],
  ['gpt-6-luna', knownModel(272_000, MAX_EFFORTS)],
  ['gpt-6-astra', knownModel(272_000)],
  ['gpt-5.6-sol', knownModel(272_000)],
  ['gpt-5.6-terra', knownModel(272_000)],
  ['gpt-5.6-luna', knownModel(272_000, MAX_EFFORTS)],
  ['gpt-5.4', knownModel(272_000, XHIGH_EFFORTS, 1_000_000)],
]);

const catalogCache = new Map();

function positiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return fallback;
  }
  return Math.trunc(number);
}

function percent(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 100) {
    return fallback;
  }
  return number;
}

function normalizedToolOutputTruncationPolicy(value, fallback = null) {
  const mode = String(value?.mode || '').trim().toLowerCase();
  const limit = positiveInteger(value?.limit, 0);
  if ((mode !== 'tokens' && mode !== 'bytes') || !limit) {
    return fallback ? { ...fallback } : null;
  }

  return { mode, limit };
}

function parseCatalog(stdout) {
  const text = String(stdout || '').trim();
  if (!text) {
    return null;
  }

  // `codex debug models` owns stdout and emits one JSON document. Parse that
  // document strictly so indentation is harmless but trailing diagnostics or
  // a second payload cannot be mistaken for trusted model metadata.
  const parsed = JSON.parse(text);
  return Array.isArray(parsed?.models) ? parsed.models : null;
}

export function readCodexModelCatalog(command, cwd, env, bundledOnly) {
  const catalogCwd = path.resolve(String(cwd || process.cwd()));
  const environment = env || process.env;
  const cacheKey = JSON.stringify([
    command,
    catalogCwd,
    executableIdentity(command, { cwd: catalogCwd, environment }),
    effectiveCodexHome(environment, catalogCwd),
    bundledOnly ? 'bundled' : 'online',
  ]);
  const cached = catalogCache.get(cacheKey);
  if (cached) {
    if (cached.expiresAt > Date.now()) {
      return cached.catalog;
    }
    catalogCache.delete(cacheKey);
  }

  const args = ['debug', 'models'];
  if (bundledOnly) {
    args.push('--bundled');
  }
  const result = spawnSync(command, args, {
    cwd: catalogCwd,
    encoding: 'utf8',
    // Model discovery is local metadata lookup. Never expose unrelated
    // provider or gateway credentials to the Codex subprocess.
    env: environmentWithoutGatewayAndAnthropicCredentials(environment),
    maxBuffer: CATALOG_MAX_BUFFER_BYTES,
    shell: process.platform === 'win32',
    timeout: CATALOG_TIMEOUT_MS,
    windowsHide: true,
  });
  let catalog = null;
  if (!result.error && result.status === 0) {
    try {
      catalog = parseCatalog(result.stdout);
    } catch {
      catalog = null;
    }
  }
  const ttl = catalog === null ? CATALOG_NEGATIVE_CACHE_TTL_MS :
    bundledOnly ? Infinity : CATALOG_ONLINE_CACHE_TTL_MS;
  catalogCache.set(cacheKey, { catalog, expiresAt: Date.now() + ttl });
  return catalog;
}

function normalizedCatalogModel(model) {
  if (!model || typeof model !== 'object') {
    return null;
  }
  const contextWindow = positiveInteger(model.context_window, 0);
  if (!contextWindow) {
    return null;
  }

  return {
    contextWindow,
    maxContextWindow: positiveInteger(model.max_context_window, contextWindow),
    effectiveContextWindowPercent: percent(
      model.effective_context_window_percent,
      DEFAULT_EFFECTIVE_CONTEXT_PERCENT
    ),
    reasoningEfforts: Array.isArray(model.supported_reasoning_levels)
      ? model.supported_reasoning_levels
          .map((entry) => String(entry?.effort || '').trim().toLowerCase())
          .filter(Boolean)
      : [],
    toolOutputTruncationPolicy: normalizedToolOutputTruncationPolicy(
      model.truncation_policy,
      DEFAULT_TOOL_OUTPUT_TRUNCATION_POLICY
    ),
  };
}

export function lookupCodexCatalogModel(command, cwd, model, env) {
  // The installed binary's bundled catalog is deterministic and typically
  // loads in milliseconds. Only ask Codex to refresh its online catalog when
  // the selected model is absent, which keeps normal Claude startup off the
  // network while preserving support for remotely introduced models.
  const bundledCatalog = readCodexModelCatalog(command, cwd, env, true);
  const bundled = bundledCatalog?.find((entry) => entry?.slug === model);
  if (bundled) return { status: 'present', entry: bundled, models: bundledCatalog };
  const onlineCatalog = readCodexModelCatalog(command, cwd, env, false);
  const online = onlineCatalog?.find((entry) => entry?.slug === model);
  if (online) return { status: 'present', entry: online, models: onlineCatalog };
  return {
    status: bundledCatalog !== null && onlineCatalog !== null ? 'absent' : 'unverified',
    entry: null, models: null,
  };
}

export function codexCatalogIssue(status, model) {
  if (status === 'present') return null;
  if (status === 'absent') {
    return `Neither Codex catalog lists ${model}. Check the model ID with codex debug models or select a different route.`;
  }
  return `Could not verify ${model} in the Codex catalog. Check codex debug models and retry.`;
}

function modelCapabilities(command, cwd, model, env) {
  const { status: catalogStatus, entry } = lookupCodexCatalogModel(command, cwd, model, env);
  const discovered = normalizedCatalogModel(entry);
  if (discovered) {
    return { ...discovered, catalogStatus, source: 'codex-catalog' };
  }

  const known = KNOWN_MODEL_CAPABILITIES.get(model);
  if (known) {
    return {
      ...known,
      catalogStatus,
      reasoningEfforts: [...known.reasoningEfforts],
      toolOutputTruncationPolicy: { ...known.toolOutputTruncationPolicy },
      source: 'known-model',
    };
  }

  return {
    catalogStatus,
    contextWindow: DEFAULT_RAW_CONTEXT_TOKENS,
    maxContextWindow: DEFAULT_MAX_RAW_CONTEXT_TOKENS,
    effectiveContextWindowPercent: DEFAULT_EFFECTIVE_CONTEXT_PERCENT,
    reasoningEfforts: [],
    toolOutputTruncationPolicy: { ...DEFAULT_TOOL_OUTPUT_TRUNCATION_POLICY },
    source: 'conservative-fallback',
  };
}

export function normalizeCodexContextProfile(value, fallback = 'standard') {
  const normalized = String(value || fallback).trim().toLowerCase();
  if (normalized === 'standard' || normalized === 'long') {
    return normalized;
  }
  throw new Error('ULTRATHINK_GATEWAY_CODEX_CONTEXT must be standard or long');
}

export function resolveCodexCapabilities({
  command = 'codex',
  cwd = process.cwd(),
  model,
  contextProfile = 'standard',
  requestedContextWindow = 0,
  reasoningEffort = '',
  env = process.env,
} = {}) {
  const normalizedModel = String(model || '').trim();
  const profile = normalizeCodexContextProfile(contextProfile);
  const available = modelCapabilities(command, cwd, normalizedModel, env);
  const requested = positiveInteger(
    requestedContextWindow,
    profile === 'long' ? available.maxContextWindow : available.contextWindow
  );
  const resolvedRawContextTokens = Math.min(requested, available.maxContextWindow);
  const usableContextTokens = Math.floor(
    (resolvedRawContextTokens * available.effectiveContextWindowPercent) / 100
  );
  const autoCompactTokens = Math.min(
    usableContextTokens,
    Math.floor((resolvedRawContextTokens * CODEX_NATIVE_COMPACT_PERCENT) / 100)
  );
  const inputBudgetTokens = Math.max(
    1,
    Math.min(
      autoCompactTokens - GATEWAY_PROMPT_HEADROOM_TOKENS,
      usableContextTokens - GATEWAY_OUTPUT_RESERVE_TOKENS
    )
  );
  const normalizedEffort = String(reasoningEffort || '').trim().toLowerCase();
  const effortSupported = !normalizedEffort ? true : available.reasoningEfforts.length
    ? available.reasoningEfforts.includes(normalizedEffort) : null;

  return Object.freeze({
    model: normalizedModel,
    profile,
    source: available.source,
    catalogStatus: available.catalogStatus,
    requestedRawContextTokens: requested,
    resolvedRawContextTokens,
    usableContextTokens,
    autoCompactTokens,
    inputBudgetTokens,
    maxRawContextTokens: available.maxContextWindow,
    effectiveContextWindowPercent: available.effectiveContextWindowPercent,
    reasoningEfforts: Object.freeze([...available.reasoningEfforts]),
    toolOutputTruncationPolicy: Object.freeze({
      ...available.toolOutputTruncationPolicy,
    }),
    effortSupported,
  });
}

export function clearCodexCapabilityCacheForTests() {
  catalogCache.clear();
}
