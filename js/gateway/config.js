import net from 'node:net';
import path from 'node:path';

import '../utils/env-loader.js';
import { environmentWithoutManagedGatewayAuth } from '../utils/child-env.js';
import { expandHomePath } from '../utils/safe-path.js';
import {
  normalizeCodexContextProfile,
  resolveCodexCapabilities,
} from './codex-capabilities.js';
import { DEEPSEEK_FLASH_DEFAULTS, QWEN_TOKEN_PLAN_DEFAULTS } from './provider-profiles.js';

const DEFAULT_EXPOSED_MODELS = Object.freeze([
  'claude-fable-5-1',
  'claude-sonnet-4-7',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
]);
const DEFAULT_ANTHROPIC_PASSTHROUGH_MODELS = Object.freeze(['claude-fable-5-1*']);

const DEFAULT_CODEX_SANDBOX = 'workspace-write';
const DEFAULT_CODEX_APPROVAL_POLICY = 'never';
export const DEFAULT_CODEX_MODEL = 'gpt-6-astra';
const DEFAULT_CODEX_AUTO_COMPACT_TOKEN_LIMIT_SCOPE = 'total';
const DEFAULT_AUTH_FAILURE_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_AUTH_FAILURE_RATE_LIMIT_MAX_REQUESTS = 60;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 32;
const DISABLED_FLAG_VALUES = new Set(['0', 'false', 'no', 'off']);
const LOOPBACK_HOSTS = new Set(['localhost', '::1', '[::1]']);
const CODEX_AUTO_COMPACT_TOKEN_LIMIT_SCOPES = new Set(['total', 'body_after_prefix']);

const CODEX_PROFILE_ENV = Object.freeze({
  model: ['ULTRATHINK_GATEWAY_CODEX_MODEL', 'ULTRATHINK_GATEWAY_OPENAI_MODEL'],
  reasoningEffort: [
    'ULTRATHINK_GATEWAY_CODEX_REASONING_EFFORT',
    'ULTRATHINK_GATEWAY_OPENAI_REASONING_EFFORT',
  ],
  verbosity: ['ULTRATHINK_GATEWAY_CODEX_VERBOSITY', 'ULTRATHINK_GATEWAY_OPENAI_VERBOSITY'],
});
const DEEPSEEK_PROFILE_ENV = Object.freeze({
  model: ['ULTRATHINK_GATEWAY_DEEPSEEK_MODEL', 'DEEPSEEK_DEFAULT_MODEL_ID'],
  reasoningEffort: [
    'ULTRATHINK_GATEWAY_DEEPSEEK_REASONING_EFFORT',
    'ULTRATHINK_DEEPSEEK_REASONING_EFFORT',
  ],
});
const GLM_PROFILE_ENV = Object.freeze({
  model: ['ULTRATHINK_GATEWAY_GLM_MODEL', 'GLM_DEFAULT_MODEL_ID', 'ZAI_DEFAULT_MODEL_ID'],
  reasoningEffort: [
    'ULTRATHINK_GATEWAY_GLM_REASONING_EFFORT',
    'ULTRATHINK_GLM_REASONING_EFFORT',
    'ZAI_REASONING_EFFORT',
  ],
});
const KIMI_PROFILE_ENV = Object.freeze({
  model: ['ULTRATHINK_GATEWAY_KIMI_MODEL'],
  reasoningEffort: ['ULTRATHINK_GATEWAY_KIMI_REASONING_EFFORT'],
});
const QWEN_PROFILE_ENV = Object.freeze({
  model: ['ULTRATHINK_GATEWAY_QWEN_MODEL', 'QWEN_MODEL'],
  reasoningEffort: [
    'ULTRATHINK_GATEWAY_QWEN_REASONING_EFFORT',
    'QWEN_REASONING_EFFORT',
  ],
});

function firstDefinedString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
  }
  return '';
}

function firstEnvString(envNames, fallback = '') {
  const values = envNames.map(function readEnv(name) {
    return process.env[name];
  });
  return firstDefinedString(...values, fallback);
}

export function envFlag(name, fallback = false) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    return fallback;
  }

  return !DISABLED_FLAG_VALUES.has(value.trim().toLowerCase());
}

function clampNumber(value, fallback, options = {}) {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    return fallback;
  }

  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }

  const min = Number.isFinite(options.min) ? options.min : number;
  const max = Number.isFinite(options.max) ? options.max : number;
  return Math.trunc(Math.max(min, Math.min(number, max)));
}

function splitCsv(value, fallback) {
  if (typeof value !== 'string' || value.trim() === '') {
    return fallback.slice();
  }

  return value
    .split(',')
    .map(function trimPart(part) {
      return part.trim();
    })
    .filter(Boolean);
}

function csvEnvironmentSetting(envNames, fallback) {
  for (const name of envNames) {
    if (!Object.hasOwn(process.env, name)) {
      continue;
    }
    const value = process.env[name];
    if (typeof value !== 'string' || value.trim() === '') {
      return fallback.slice();
    }
    if (value.trim().toLowerCase() === 'none') {
      return [];
    }
    return splitCsv(value, []);
  }
  return fallback.slice();
}

function parseRouteMap(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return {};
  }

  const parsed = JSON.parse(value);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      'ULTRATHINK_GATEWAY_ROUTE_MAP_JSON must be a JSON object keyed by exposed model id'
    );
  }

  return parsed;
}

function optionalTracePath(value) {
  const configured = firstDefinedString(value);
  if (!configured) {
    return '';
  }
  if (DISABLED_FLAG_VALUES.has(configured.toLowerCase())) {
    return '';
  }
  return path.resolve(expandHomePath(configured));
}

function codexAutoCompactTokenLimitScope(value) {
  const normalized = firstDefinedString(
    value,
    DEFAULT_CODEX_AUTO_COMPACT_TOKEN_LIMIT_SCOPE
  ).toLowerCase();
  if (!CODEX_AUTO_COMPACT_TOKEN_LIMIT_SCOPES.has(normalized)) {
    throw new Error(
      'ULTRATHINK_GATEWAY_CODEX_AUTO_COMPACT_TOKEN_LIMIT_SCOPE must be total or body_after_prefix'
    );
  }

  return normalized;
}

function codexProfileValue(key, fallback) {
  return firstEnvString(CODEX_PROFILE_ENV[key], fallback);
}

function deepSeekProfileValue(key, fallback) {
  return firstEnvString(DEEPSEEK_PROFILE_ENV[key], fallback);
}

function glmProfileValue(key, fallback) {
  return firstEnvString(GLM_PROFILE_ENV[key], fallback);
}

function kimiProfileValue(key, fallback) {
  return firstEnvString(KIMI_PROFILE_ENV[key], fallback);
}

function qwenProfileValue(key, fallback) {
  return firstEnvString(QWEN_PROFILE_ENV[key], fallback);
}

function thinkingForProvider(provider) {
  const thinkingLevel = firstEnvString(['ULTRATHINK_THINKING_LEVEL']).toUpperCase();
  if (thinkingLevel === 'OFF') {
    return { type: 'disabled' };
  }

  if (provider === 'glm') {
    return {
      type: 'enabled',
      clear_thinking: false,
    };
  }

  return { type: 'enabled' };
}

export function isGatewayLoopbackHost(host) {
  const normalized = String(host || '').trim().toLowerCase();
  if (LOOPBACK_HOSTS.has(normalized)) {
    return true;
  }

  return net.isIP(normalized) === 4 && normalized.startsWith('127.');
}

export function loadGatewayConfig() {
  // A Kimi daemon publishes a short-lived local gateway credential to Claude.
  // Ignore that owned value if a parent shell still holds it after a route
  // switch; it is not an Anthropic upstream API key.
  const credentialEnv = environmentWithoutManagedGatewayAuth(process.env);
  const routeMap = parseRouteMap(process.env.ULTRATHINK_GATEWAY_ROUTE_MAP_JSON);
  const exactRouteMapModels = Object.keys(routeMap).filter(function isExactRouteKey(modelId) {
    return !modelId.endsWith('*');
  });
  const defaultExposedModels =
    exactRouteMapModels.length > 0 ? exactRouteMapModels : DEFAULT_EXPOSED_MODELS;
  const explicitQwenBaseUrl = firstDefinedString(
    process.env.ULTRATHINK_GATEWAY_QWEN_BASE_URL,
    process.env.QWEN_BASE_URL
  );
  const qwenBaseUrl =
    explicitQwenBaseUrl || QWEN_TOKEN_PLAN_DEFAULTS.baseUrl;
  const qwenApiKey = firstDefinedString(
    process.env.ULTRATHINK_GATEWAY_QWEN_API_KEY,
    process.env.BAILIAN_TOKEN_PLAN_API_KEY,
    process.env.QWEN_API_KEY,
    explicitQwenBaseUrl ? process.env.DASHSCOPE_API_KEY : '',
    ''
  );
  const dedicatedAnthropicApiKey = firstDefinedString(
    process.env.ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY
  );
  const genericAnthropicApiKey = firstDefinedString(credentialEnv.ANTHROPIC_API_KEY);
  const codexCommand = firstEnvString(['ULTRATHINK_GATEWAY_CODEX_COMMAND'], 'codex');
  const codexCwd = path.resolve(
    expandHomePath(firstEnvString(['ULTRATHINK_GATEWAY_CODEX_CWD'], process.cwd()))
  );
  const codexModel = codexProfileValue('model', DEFAULT_CODEX_MODEL);
  const codexReasoningEffort = codexProfileValue('reasoningEffort', 'max');
  const codexContextProfile = normalizeCodexContextProfile(
    firstDefinedString(
      process.env.ULTRATHINK_GATEWAY_CODEX_CONTEXT,
      process.env.ULTRATHINK_GATEWAY_CODEX_CONTEXT_PROFILE,
      'standard'
    )
  );
  const codexRequestedContextWindow = clampNumber(
    process.env.ULTRATHINK_GATEWAY_CODEX_CONTEXT_WINDOW,
    0,
    { min: 0, max: 2_000_000 }
  );
  const codexCapabilities = resolveCodexCapabilities({
    command: codexCommand,
    cwd: codexCwd,
    model: codexModel,
    contextProfile: codexContextProfile,
    requestedContextWindow: codexRequestedContextWindow,
    reasoningEffort: codexReasoningEffort,
  });
  if (!codexCapabilities.effortSupported) {
    throw new Error(
      `${codexModel} does not support Codex reasoning effort ${codexReasoningEffort}; ` +
        `choose one of ${codexCapabilities.reasoningEfforts.join(', ')}`
    );
  }

  return {
    host: firstDefinedString(process.env.ULTRATHINK_GATEWAY_HOST, '127.0.0.1'),
    port: clampNumber(process.env.ULTRATHINK_GATEWAY_PORT, 4319, {
      min: 1,
      max: 65535,
    }),
    traceDir: optionalTracePath(process.env.ULTRATHINK_GATEWAY_TRACE_DIR),
    traceMaxBytes: clampNumber(
      process.env.ULTRATHINK_GATEWAY_TRACE_MAX_BYTES,
      8 * 1024 * 1024,
      { min: 256, max: 1024 * 1024 * 1024 }
    ),
    traceMaxFiles: clampNumber(process.env.ULTRATHINK_GATEWAY_TRACE_MAX_FILES, 3, {
      min: 1,
      max: 16,
    }),
    runtimeRevision: firstDefinedString(process.env.ULTRATHINK_GATEWAY_RUNTIME_REVISION),
    runtimeStartedAt: firstDefinedString(
      process.env.ULTRATHINK_GATEWAY_RUNTIME_STARTED_AT,
      new Date().toISOString()
    ),
    displayRoutedModel: envFlag('ULTRATHINK_GATEWAY_DISPLAY_ROUTED_MODEL', false),
    sharedSecret: firstDefinedString(process.env.ULTRATHINK_GATEWAY_SHARED_SECRET),
    requestTimeoutMs: clampNumber(
      process.env.ULTRATHINK_GATEWAY_REQUEST_TIMEOUT_MS,
      5 * 60_000,
      { min: 1_000, max: 30 * 60_000 }
    ),
    authFailureRateLimitWindowMs: clampNumber(
      process.env.ULTRATHINK_GATEWAY_AUTH_FAILURE_RATE_LIMIT_WINDOW_MS,
      DEFAULT_AUTH_FAILURE_RATE_LIMIT_WINDOW_MS,
      { min: 1_000, max: 60 * 60_000 }
    ),
    authFailureRateLimitMaxRequests: clampNumber(
      process.env.ULTRATHINK_GATEWAY_AUTH_FAILURE_RATE_LIMIT_MAX_REQUESTS,
      DEFAULT_AUTH_FAILURE_RATE_LIMIT_MAX_REQUESTS,
      { min: 1, max: 10_000 }
    ),
    maxConcurrentRequests: clampNumber(
      process.env.ULTRATHINK_GATEWAY_MAX_CONCURRENT_REQUESTS,
      DEFAULT_MAX_CONCURRENT_REQUESTS,
      { min: 1, max: 256 }
    ),
    exposedModels: splitCsv(process.env.ULTRATHINK_GATEWAY_EXPOSED_MODELS, defaultExposedModels),
    routeMap,
    anthropicPassthroughModels: csvEnvironmentSetting(
      [
        'ULTRATHINK_GATEWAY_ANTHROPIC_PASSTHROUGH_MODELS',
        'ULTRATHINK_GATEWAY_PASSTHROUGH_MODEL_IDS',
      ],
      DEFAULT_ANTHROPIC_PASSTHROUGH_MODELS
    ),
    codex: {
      enabled: envFlag('ULTRATHINK_GATEWAY_CODEX_ENABLED', true),
      command: codexCommand,
      cwd: codexCwd,
      sandbox: firstEnvString(
        ['ULTRATHINK_GATEWAY_CODEX_SANDBOX'],
        DEFAULT_CODEX_SANDBOX
      ),
      approvalPolicy: firstEnvString(
        ['ULTRATHINK_GATEWAY_CODEX_APPROVAL_POLICY'],
        DEFAULT_CODEX_APPROVAL_POLICY
      ),
      model: codexModel,
      reasoningEffort: codexReasoningEffort,
      verbosity: codexProfileValue('verbosity', 'low'),
      contextProfile: codexContextProfile,
      requestedContextWindow: codexRequestedContextWindow,
      capabilities: codexCapabilities,
      inputMaxTokens: clampNumber(
        process.env.ULTRATHINK_GATEWAY_CODEX_INPUT_MAX_TOKENS,
        0,
        { min: 0, max: 2_000_000 }
      ),
      toolResultMaxBytes: clampNumber(
        process.env.ULTRATHINK_GATEWAY_CODEX_TOOL_RESULT_MAX_BYTES,
        10_000,
        { min: 0, max: 10_000_000 }
      ),
      toolResultWindowMaxBytes: clampNumber(
        process.env.ULTRATHINK_GATEWAY_CODEX_TOOL_RESULT_WINDOW_MAX_BYTES,
        64_000,
        { min: 0, max: 100_000_000 }
      ),
      autoCompactTokenLimit: clampNumber(
        process.env.ULTRATHINK_GATEWAY_CODEX_AUTO_COMPACT_TOKEN_LIMIT,
        0,
        { min: 0, max: 1_000_000 }
      ),
      autoCompactTokenLimitScope: codexAutoCompactTokenLimitScope(
        process.env.ULTRATHINK_GATEWAY_CODEX_AUTO_COMPACT_TOKEN_LIMIT_SCOPE
      ),
      idleTimeoutMs: clampNumber(
        process.env.ULTRATHINK_GATEWAY_CODEX_IDLE_TIMEOUT_MS,
        10 * 60_000,
        { min: 0, max: 24 * 60 * 60_000 }
      ),
      forkIdleTimeoutMs: clampNumber(
        process.env.ULTRATHINK_GATEWAY_CODEX_FORK_IDLE_TIMEOUT_MS,
        30_000,
        { min: 0, max: 24 * 60 * 60_000 }
      ),
      pendingToolTimeoutMs: clampNumber(
        process.env.ULTRATHINK_GATEWAY_CODEX_PENDING_TOOL_TIMEOUT_MS,
        10 * 60_000,
        { min: 0, max: 24 * 60 * 60_000 }
      ),
      maxSessions: clampNumber(
        process.env.ULTRATHINK_GATEWAY_CODEX_MAX_SESSIONS,
        16,
        { min: 1, max: 256 }
      ),
      closeKillTimeoutMs: clampNumber(
        process.env.ULTRATHINK_GATEWAY_CODEX_CLOSE_KILL_TIMEOUT_MS,
        2_000,
        { min: 100, max: 60_000 }
      ),
    },
    openai: {
      apiKey: firstDefinedString(
        process.env.ULTRATHINK_GATEWAY_CODEX_API_KEY,
        process.env.ULTRATHINK_GATEWAY_OPENAI_API_KEY,
        process.env.OPENAI_API_KEY,
        ''
      ),
      baseUrl: firstDefinedString(
        process.env.ULTRATHINK_GATEWAY_CODEX_BASE_URL,
        process.env.ULTRATHINK_GATEWAY_OPENAI_BASE_URL,
        'https://api.openai.com/v1'
      ),
      model: codexProfileValue('model', DEFAULT_CODEX_MODEL),
      reasoningEffort: codexProfileValue('reasoningEffort', 'low'),
      verbosity: codexProfileValue('verbosity', 'low'),
    },
    deepseek: {
      apiKey: firstDefinedString(
        process.env.ULTRATHINK_GATEWAY_DEEPSEEK_API_KEY,
        process.env.DEEPSEEK_API_KEY,
        ''
      ),
      baseUrl: firstDefinedString(
        process.env.ULTRATHINK_GATEWAY_DEEPSEEK_BASE_URL,
        process.env.DEEPSEEK_BASE_URL,
        DEEPSEEK_FLASH_DEFAULTS.baseUrl
      ),
      model: deepSeekProfileValue('model', DEEPSEEK_FLASH_DEFAULTS.model),
      reasoningEffort: deepSeekProfileValue('reasoningEffort', DEEPSEEK_FLASH_DEFAULTS.reasoningEffort),
      contextTokens: clampNumber(process.env.ULTRATHINK_GATEWAY_DEEPSEEK_CONTEXT_TOKENS,
        DEEPSEEK_FLASH_DEFAULTS.contextTokens, { min: 1, max: DEEPSEEK_FLASH_DEFAULTS.contextTokens }),
      maxOutputTokens: clampNumber(process.env.ULTRATHINK_GATEWAY_DEEPSEEK_MAX_OUTPUT_TOKENS,
        DEEPSEEK_FLASH_DEFAULTS.maxOutputTokens, { min: 1, max: DEEPSEEK_FLASH_DEFAULTS.maxOutputTokens }),
      thinking: thinkingForProvider('deepseek'),
    },
    glm: {
      apiKey: firstDefinedString(
        process.env.ULTRATHINK_GATEWAY_GLM_API_KEY,
        process.env.ZAI_API_KEY,
        process.env.GLM_API_KEY,
        ''
      ),
      baseUrl: firstDefinedString(
        process.env.ULTRATHINK_GATEWAY_GLM_BASE_URL,
        process.env.ZAI_BASE_URL,
        process.env.GLM_BASE_URL,
        'https://api.z.ai/api/coding/paas/v4'
      ),
      model: glmProfileValue('model', 'glm-5.2'),
      reasoningEffort: glmProfileValue('reasoningEffort', 'max'),
      thinking: thinkingForProvider('glm'),
    },
    kimi: {
      apiKey: firstDefinedString(
        process.env.ULTRATHINK_GATEWAY_KIMI_API_KEY,
        process.env.KIMI_API_KEY,
        ''
      ),
      baseUrl: firstDefinedString(
        process.env.ULTRATHINK_GATEWAY_KIMI_BASE_URL,
        'https://api.kimi.com/coding/'
      ),
      model: kimiProfileValue('model', 'k3'),
      reasoningEffort: kimiProfileValue('reasoningEffort', 'max'),
      contextTokens: clampNumber(
        process.env.ULTRATHINK_GATEWAY_KIMI_CONTEXT_TOKENS,
        1_048_576,
        { min: 1, max: 1_048_576 }
      ),
      version: firstEnvString(['ULTRATHINK_GATEWAY_KIMI_VERSION'], '2023-06-01'),
    },
    qwen: {
      apiKey: qwenApiKey,
      baseUrl: qwenBaseUrl,
      model: qwenProfileValue('model', QWEN_TOKEN_PLAN_DEFAULTS.model),
      reasoningEffort: qwenProfileValue(
        'reasoningEffort',
        QWEN_TOKEN_PLAN_DEFAULTS.reasoningEffort
      ),
      contextTokens: clampNumber(
        process.env.ULTRATHINK_GATEWAY_QWEN_CONTEXT_TOKENS,
        QWEN_TOKEN_PLAN_DEFAULTS.contextTokens,
        { min: 1, max: QWEN_TOKEN_PLAN_DEFAULTS.contextTokens }
      ),
      totalContextTokens: QWEN_TOKEN_PLAN_DEFAULTS.totalContextTokens,
      maxOutputTokens: clampNumber(
        process.env.ULTRATHINK_GATEWAY_QWEN_MAX_OUTPUT_TOKENS,
        QWEN_TOKEN_PLAN_DEFAULTS.maxOutputTokens,
        { min: 1, max: QWEN_TOKEN_PLAN_DEFAULTS.maxOutputTokens }
      ),
    },
    anthropic: {
      apiKey: firstDefinedString(dedicatedAnthropicApiKey, genericAnthropicApiKey),
      apiKeySource: dedicatedAnthropicApiKey
        ? 'dedicated'
        : genericAnthropicApiKey
          ? 'generic'
          : 'none',
      baseUrl: firstDefinedString(
        process.env.ULTRATHINK_GATEWAY_ANTHROPIC_BASE_URL,
        'https://api.anthropic.com'
      ),
      version: firstEnvString(['ULTRATHINK_GATEWAY_ANTHROPIC_VERSION'], '2023-06-01'),
    },
  };
}
