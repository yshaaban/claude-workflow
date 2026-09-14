import {
  DEEPSEEK_FLASH_DEFAULTS,
  GATEWAY_PROVIDER_IDS,
  QWEN_TOKEN_PLAN_DEFAULTS,
  gatewayProviderProfile,
  isDeepSeekFlashModel,
  normalizeDeepSeekReasoningEffort,
  kimiProfileConfigurationIssue,
  qwenProfileConfigurationIssue,
  routeProviderMetadata,
} from './provider-profiles.js';

function formatClaudeFamily(modelId) {
  if (typeof modelId !== 'string' || modelId.trim() === '') {
    return 'Claude model';
  }

  return modelId
    .split('-')
    .map(function normalizePart(part) {
      if (/^\d/u.test(part)) {
        return part;
      }
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(' ');
}

export class GatewayError extends Error {
  constructor(status, type, message) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.type = type;
  }
}

const ROUTE_PROVIDERS = Object.freeze({
  ANTHROPIC: 'anthropic',
  DEEPSEEK: 'deepseek',
  GLM: 'glm',
  KIMI: 'kimi',
  QWEN: 'qwen',
  OPENAI: 'openai',
  CODEX: 'codex',
});

const ROUTE_PROVIDER_BUILDERS = Object.freeze({
  [ROUTE_PROVIDERS.ANTHROPIC]: buildAnthropicRoute,
  [ROUTE_PROVIDERS.DEEPSEEK]: buildDeepSeekRoute,
  [ROUTE_PROVIDERS.GLM]: buildGlmRoute,
  [ROUTE_PROVIDERS.KIMI]: buildKimiRoute,
  [ROUTE_PROVIDERS.QWEN]: buildQwenRoute,
  [ROUTE_PROVIDERS.OPENAI]: buildOpenAiRoute,
  [ROUTE_PROVIDERS.CODEX]: buildCodexRoute,
});

export const ROUTE_ENTRY_UPSTREAM_MODEL_KEYS = Object.freeze([
  'upstreamModel',
  'upstream_model',
  'model',
]);
export const ROUTE_ENTRY_REASONING_KEYS = Object.freeze([
  'reasoningEffort',
  'reasoning_effort',
]);
const ROUTE_ENTRY_DISPLAY_NAME_KEYS = Object.freeze([
  'displayName',
  'display_name',
]);
const ROUTE_ENTRY_THINKING_KEYS = Object.freeze([
  'thinking',
]);

const VALID_CODEX_SANDBOXES = Object.freeze([
  'read-only',
  'workspace-write',
  'danger-full-access',
]);
const VALID_CODEX_APPROVAL_POLICIES = Object.freeze([
  'untrusted',
  'on-failure',
  'on-request',
  'never',
]);

const DEFAULT_CODEX_SANDBOX = 'workspace-write';
const DEFAULT_CODEX_APPROVAL_POLICY = 'never';
const DEFAULT_ANTHROPIC_PASSTHROUGH_MODELS = Object.freeze(['claude-fable-5-1*']);
const KIMI_REASONING_EFFORT_MAP = Object.freeze({
  light: 'low',
  low: 'low',
  minimum: 'low',
  high: 'high',
  medium: 'high',
  max: 'max',
  ultra: 'max',
  xhigh: 'max',
});
const QWEN_REASONING_EFFORT_MAP = Object.freeze({
  light: 'low',
  low: 'low',
  minimal: 'low',
  minimum: 'low',
  medium: 'medium',
  high: 'xhigh',
  max: 'xhigh',
  ultra: 'xhigh',
  xhigh: 'xhigh',
});
const QWEN_CLAUDE_EFFORT_MAP = Object.freeze({
  low: 'low',
  medium: 'medium',
  xhigh: 'max',
});

function routeValue(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
  }
  return '';
}

export function routeEntryValue(entry, keys, ...fallbacks) {
  const values = keys.map(function readKey(key) {
    return entry?.[key];
  });
  return routeValue(...values, ...fallbacks);
}

export function modelIdWithoutBracketQualifiers(modelId) {
  if (typeof modelId !== 'string') {
    return '';
  }

  const normalized = modelId.trim();
  const retained = [];
  let retainedStart = 0;
  let qualifierStart = -1;

  // Scan once instead of using a backtracking expression. Model IDs cross the
  // HTTP trust boundary, and a long unmatched run of '[' characters makes the
  // equivalent global regular expression retry from every opening bracket.
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (qualifierStart === -1) {
      if (character === '[') {
        qualifierStart = index;
      }
      continue;
    }

    if (character !== ']') {
      continue;
    }

    if (index === qualifierStart + 1) {
      // Empty brackets were never treated as a qualifier.
      qualifierStart = -1;
      continue;
    }

    retained.push(normalized.slice(retainedStart, qualifierStart));
    retainedStart = index + 1;
    qualifierStart = -1;
  }

  retained.push(normalized.slice(retainedStart));
  return retained.join('');
}

function formatAllowedValues(values) {
  return values.map(function quoteValue(value) {
    return `"${value}"`;
  }).join(', ');
}

function validateCodexRouteOption(modelId, optionName, value, validValues) {
  if (!value) {
    return '';
  }

  if (validValues.includes(value)) {
    return value;
  }

  throw new GatewayError(
    500,
    'api_error',
    `Codex route for ${modelId} must set ${optionName} to ${formatAllowedValues(validValues)}`
  );
}

function buildDisplayName(modelId, entry, fallback) {
  return routeEntryValue(entry, ROUTE_ENTRY_DISPLAY_NAME_KEYS, fallback);
}

function routeObjectValue(entry, keys, fallback = undefined) {
  for (const key of keys) {
    const value = entry?.[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value;
    }
  }

  return fallback;
}

function validateRouteMapEntry(modelId, entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new GatewayError(
      500,
      'api_error',
      `ULTRATHINK_GATEWAY_ROUTE_MAP_JSON entry for ${modelId} must be an object`
    );
  }

  return entry;
}

export function configuredRouteMapEntry(modelId, config) {
  const routeMap = config.routeMap || {};
  const exactEntry = routeMap[modelId];
  if (exactEntry !== undefined) {
    return validateRouteMapEntry(modelId, exactEntry);
  }

  for (const [pattern, entry] of Object.entries(routeMap)) {
    if (pattern === modelId || !matchesModelPattern(modelId, pattern)) {
      continue;
    }

    return validateRouteMapEntry(pattern, entry);
  }

  return null;
}

function buildAnthropicRoute(modelId, config, entry = null) {
  const upstreamModel = routeEntryValue(
    entry,
    ROUTE_ENTRY_UPSTREAM_MODEL_KEYS,
    modelIdWithoutBracketQualifiers(modelId)
  );

  return {
    ...routeProviderMetadata(ROUTE_PROVIDERS.ANTHROPIC),
    provider: ROUTE_PROVIDERS.ANTHROPIC,
    requestedModel: modelId,
    upstreamModel,
    displayName: buildDisplayName(modelId, entry, `${formatClaudeFamily(modelId)} direct`),
  };
}

function buildOpenAiCompatibleRoute(modelId, config, entry, options) {
  const providerConfig = config[options.configKey] || {};
  if (!providerConfig.apiKey) {
    throw new GatewayError(
      500,
      'api_error',
      options.missingKeyMessage
    );
  }

  const configuredUpstreamModel = routeEntryValue(
    entry,
    ROUTE_ENTRY_UPSTREAM_MODEL_KEYS,
    providerConfig.model
  );
  const upstreamModel = options.stripModelBracketQualifiers
    ? modelIdWithoutBracketQualifiers(configuredUpstreamModel)
    : configuredUpstreamModel;
  const reasoningEffort = routeEntryValue(
    entry,
    ROUTE_ENTRY_REASONING_KEYS,
    providerConfig.reasoningEffort
  );
  const verbosity = routeValue(entry?.verbosity, providerConfig.verbosity);
  const thinking = routeObjectValue(entry, ROUTE_ENTRY_THINKING_KEYS, providerConfig.thinking);

  return {
    ...routeProviderMetadata(options.provider),
    provider: options.provider,
    requestedModel: modelId,
    upstreamModel,
    reasoningEffort,
    verbosity,
    thinking,
    maxTokensField: options.maxTokensField,
    systemRole: options.systemRole,
    preserveAssistantThinking: options.preserveAssistantThinking === true,
    emitReasoningContent: options.emitReasoningContent === true,
    enableThinking: options.enableThinking === true,
    preserveThinking: options.preserveThinking === true,
    toolStream: options.toolStream === true,
    supportsParallelToolCalls: options.supportsParallelToolCalls !== false,
    explicitParallelToolCalls: options.explicitParallelToolCalls === true,
    toolChoicePolicy: options.toolChoicePolicy || '',
    strictThinkingReplay: options.strictThinkingReplay === true,
    displayName: buildDisplayName(
      modelId,
      entry,
      `${formatClaudeFamily(modelId)} via ${options.displayProvider} ${upstreamModel}/${reasoningEffort}`
    ),
  };
}

function buildOpenAiRoute(modelId, config, entry = null) {
  return buildOpenAiCompatibleRoute(modelId, config, entry, {
    provider: ROUTE_PROVIDERS.OPENAI,
    configKey: 'openai',
    displayProvider: 'Codex profile',
    maxTokensField: 'max_completion_tokens',
    systemRole: 'developer',
    missingKeyMessage:
      'Codex-targeted OpenAI routing is configured but ULTRATHINK_GATEWAY_CODEX_API_KEY, ULTRATHINK_GATEWAY_OPENAI_API_KEY, or OPENAI_API_KEY is missing',
  });
}

function buildDeepSeekRoute(modelId, config, entry = null) {
  const route = buildOpenAiCompatibleRoute(modelId, config, entry, {
    provider: ROUTE_PROVIDERS.DEEPSEEK,
    configKey: 'deepseek',
    displayProvider: 'DeepSeek',
    maxTokensField: 'max_tokens',
    systemRole: 'system',
    stripModelBracketQualifiers: true,
    missingKeyMessage:
      'DeepSeek routing is configured but ULTRATHINK_GATEWAY_DEEPSEEK_API_KEY or DEEPSEEK_API_KEY is missing',
  });
  if (!isDeepSeekFlashModel(route.upstreamModel)) {
    return route;
  }
  let reasoningEffort;
  try {
    reasoningEffort = normalizeDeepSeekReasoningEffort(route.reasoningEffort);
  } catch (error) {
    throw new GatewayError(500, 'api_error', error.message);
  }
  let thinking = route.thinking ?? { type: 'enabled' };
  if (!['enabled', 'disabled'].includes(thinking.type)) {
    throw new GatewayError(500, 'api_error', 'DeepSeek thinking.type must be enabled or disabled');
  }
  if (reasoningEffort === 'none') thinking = { type: 'disabled' };
  return {
    ...route,
    reasoningEffort,
    thinking,
    preserveAssistantThinking: true,
    emitReasoningContent: true,
    strictThinkingReplay: true,
    strictCompletion: true,
    // Live V4.1 rejects required/named tool choices while thinking is enabled.
    // Preserve auto/none instead of silently discarding the caller's choice.
    toolChoicePolicy: thinking.type === 'enabled' ? 'auto-none' : '',
    supportsParallelToolCalls: false,
    supportsToolResultImages: true,
    contextTokens: config.deepseek.contextTokens || DEEPSEEK_FLASH_DEFAULTS.contextTokens,
    maxOutputTokens: config.deepseek.maxOutputTokens || DEEPSEEK_FLASH_DEFAULTS.maxOutputTokens,
  };
}

function buildGlmRoute(modelId, config, entry = null) {
  return buildOpenAiCompatibleRoute(modelId, config, entry, {
    provider: ROUTE_PROVIDERS.GLM,
    configKey: 'glm',
    displayProvider: 'GLM',
    maxTokensField: 'max_tokens',
    systemRole: 'system',
    stripModelBracketQualifiers: true,
    missingKeyMessage:
      'GLM routing is configured but ULTRATHINK_GATEWAY_GLM_API_KEY, ZAI_API_KEY, or GLM_API_KEY is missing',
  });
}

function normalizedQwenReasoningEffort(modelId, value) {
  const normalized = routeValue(
    value,
    QWEN_TOKEN_PLAN_DEFAULTS.reasoningEffort
  ).toLowerCase();
  const mapped = Object.hasOwn(QWEN_REASONING_EFFORT_MAP, normalized)
    ? QWEN_REASONING_EFFORT_MAP[normalized]
    : '';
  if (mapped) {
    return mapped;
  }

  throw new GatewayError(
    500,
    'api_error',
    `Qwen route for ${modelId} must set reasoningEffort to low, medium, or xhigh`
  );
}

function validateQwenEndpointAndCredential(providerConfig) {
  const issue = qwenProfileConfigurationIssue(providerConfig);
  if (issue === 'invalid_url') {
    throw new GatewayError(
      500,
      'api_error',
      'Qwen routing requires a valid ULTRATHINK_GATEWAY_QWEN_BASE_URL'
    );
  }

  if (issue === 'unsupported_protocol') {
    throw new GatewayError(
      500,
      'api_error',
      'Qwen routing requires an https:// base URL; http:// is allowed only for a loopback gateway'
    );
  }

  if (issue === 'insecure_url') {
    throw new GatewayError(
      500,
      'api_error',
      'Qwen routing refuses remote http:// base URLs because they would expose the upstream credential; use https:// or a loopback HTTP gateway'
    );
  }

  if (issue === 'anthropic_endpoint') {
    throw new GatewayError(
      500,
      'api_error',
      'Qwen routing uses Alibaba\'s OpenAI-compatible transport; configure the compatible-mode/v1 endpoint, not the apps/anthropic endpoint'
    );
  }

  if (issue === 'token_plan_key_mismatch') {
    throw new GatewayError(
      500,
      'api_error',
      'The Alibaba Token Plan endpoint requires its matching sk-sp- credential. Use ULTRATHINK_GATEWAY_QWEN_API_KEY or BAILIAN_TOKEN_PLAN_API_KEY, or configure a matching custom Qwen base URL.'
    );
  }
}

function buildQwenRoute(modelId, config, entry = null) {
  const providerConfig = config.qwen || {};
  if (!providerConfig.apiKey) {
    throw new GatewayError(
      500,
      'api_error',
      'Qwen routing is configured but ULTRATHINK_GATEWAY_QWEN_API_KEY, BAILIAN_TOKEN_PLAN_API_KEY, or QWEN_API_KEY is missing; DASHSCOPE_API_KEY requires an explicit matching QWEN_BASE_URL'
    );
  }
  validateQwenEndpointAndCredential(providerConfig);

  const upstreamModel = modelIdWithoutBracketQualifiers(
    routeEntryValue(
      entry,
      ROUTE_ENTRY_UPSTREAM_MODEL_KEYS,
      providerConfig.model,
      QWEN_TOKEN_PLAN_DEFAULTS.model
    )
  );
  const reasoningEffort = normalizedQwenReasoningEffort(
    modelId,
    routeEntryValue(
      entry,
      ROUTE_ENTRY_REASONING_KEYS,
      providerConfig.reasoningEffort,
      QWEN_TOKEN_PLAN_DEFAULTS.reasoningEffort
    )
  );

  const route = buildOpenAiCompatibleRoute(modelId, config, entry, {
    provider: ROUTE_PROVIDERS.QWEN,
    configKey: 'qwen',
    displayProvider: 'Qwen',
    // Alibaba's Qwen Token Plan treats max_tokens as the answer budget while
    // reasoning_effort independently selects the thinking budget. Using
    // max_completion_tokens here would force reasoning and the answer to share
    // Claude's typically much smaller answer allowance.
    maxTokensField: 'max_tokens',
    systemRole: 'system',
    stripModelBracketQualifiers: true,
    preserveAssistantThinking: true,
    emitReasoningContent: true,
    enableThinking: true,
    preserveThinking: true,
    toolStream: true,
    supportsParallelToolCalls: true,
    explicitParallelToolCalls: true,
    toolChoicePolicy: 'auto-none',
    strictThinkingReplay: true,
    missingKeyMessage:
      'Qwen routing is configured but ULTRATHINK_GATEWAY_QWEN_API_KEY, BAILIAN_TOKEN_PLAN_API_KEY, or QWEN_API_KEY is missing; DASHSCOPE_API_KEY requires an explicit matching QWEN_BASE_URL',
  });

  return {
    ...route,
    upstreamModel,
    reasoningEffort,
    contextTokens: providerConfig.contextTokens || QWEN_TOKEN_PLAN_DEFAULTS.contextTokens,
    totalContextTokens:
      providerConfig.totalContextTokens || QWEN_TOKEN_PLAN_DEFAULTS.totalContextTokens,
    maxOutputTokens:
      providerConfig.maxOutputTokens || QWEN_TOKEN_PLAN_DEFAULTS.maxOutputTokens,
    claudeEffort: QWEN_CLAUDE_EFFORT_MAP[reasoningEffort],
    displayName: buildDisplayName(
      modelId,
      entry,
      `${formatClaudeFamily(modelId)} via Qwen ${upstreamModel}/${reasoningEffort}`
    ),
  };
}

function normalizedKimiReasoningEffort(modelId, value) {
  const normalized = routeValue(value, 'max').toLowerCase();
  const mapped = Object.hasOwn(KIMI_REASONING_EFFORT_MAP, normalized)
    ? KIMI_REASONING_EFFORT_MAP[normalized]
    : '';
  if (mapped) {
    return mapped;
  }

  throw new GatewayError(
    500,
    'api_error',
    `Kimi route for ${modelId} must set reasoningEffort to low, high, or max`
  );
}

function validateKimiEndpoint(providerConfig) {
  const issue = kimiProfileConfigurationIssue(providerConfig);
  if (issue === 'invalid_url') {
    throw new GatewayError(
      500,
      'api_error',
      'Kimi routing requires a valid ULTRATHINK_GATEWAY_KIMI_BASE_URL'
    );
  }
  if (issue === 'unsupported_protocol') {
    throw new GatewayError(
      500,
      'api_error',
      'Kimi routing requires an https:// base URL; http:// is allowed only for a loopback gateway'
    );
  }
  if (issue === 'insecure_url') {
    throw new GatewayError(
      500,
      'api_error',
      'Kimi routing refuses remote http:// base URLs because they would expose the upstream credential; use https:// or a loopback HTTP gateway'
    );
  }
}

function buildKimiRoute(modelId, config, entry = null) {
  const providerConfig = config.kimi || {};
  if (!providerConfig.apiKey) {
    throw new GatewayError(
      500,
      'api_error',
      'Kimi routing is configured but ULTRATHINK_GATEWAY_KIMI_API_KEY or KIMI_API_KEY is missing'
    );
  }
  validateKimiEndpoint(providerConfig);

  const upstreamModel = modelIdWithoutBracketQualifiers(
    routeEntryValue(entry, ROUTE_ENTRY_UPSTREAM_MODEL_KEYS, providerConfig.model, 'k3')
  );
  const reasoningEffort = normalizedKimiReasoningEffort(
    modelId,
    routeEntryValue(entry, ROUTE_ENTRY_REASONING_KEYS, providerConfig.reasoningEffort, 'max')
  );

  return {
    ...routeProviderMetadata(ROUTE_PROVIDERS.KIMI),
    provider: ROUTE_PROVIDERS.KIMI,
    requestedModel: modelId,
    upstreamModel,
    reasoningEffort,
    claudeEffort: reasoningEffort,
    contextTokens: providerConfig.contextTokens || 1_048_576,
    displayName: buildDisplayName(
      modelId,
      entry,
      `${formatClaudeFamily(modelId)} via Kimi ${upstreamModel}/${reasoningEffort}`
    ),
  };
}

function buildCodexRoute(modelId, config, entry = null) {
  if (!config.codex?.enabled) {
    throw new GatewayError(
      500,
      'api_error',
      'Codex routing is disabled. Set ULTRATHINK_GATEWAY_CODEX_ENABLED=true to enable it.'
    );
  }

  const upstreamModel = routeEntryValue(
    entry,
    ROUTE_ENTRY_UPSTREAM_MODEL_KEYS,
    config.codex.model
  );
  const sandbox = validateCodexRouteOption(
    modelId,
    'sandbox',
    routeValue(entry?.sandbox, config.codex.sandbox, DEFAULT_CODEX_SANDBOX),
    VALID_CODEX_SANDBOXES
  );
  const approvalPolicy = validateCodexRouteOption(
    modelId,
    'approvalPolicy',
    routeValue(
      entry?.approvalPolicy,
      entry?.approval_policy,
      config.codex.approvalPolicy,
      DEFAULT_CODEX_APPROVAL_POLICY
    ),
    VALID_CODEX_APPROVAL_POLICIES
  );
  const reasoningEffort = routeEntryValue(
    entry,
    ROUTE_ENTRY_REASONING_KEYS,
    config.codex.reasoningEffort
  );
  const verbosity = routeValue(entry?.verbosity, config.codex.verbosity);

  return {
    ...routeProviderMetadata(ROUTE_PROVIDERS.CODEX),
    provider: ROUTE_PROVIDERS.CODEX,
    requestedModel: modelId,
    upstreamModel,
    sandbox,
    approvalPolicy,
    reasoningEffort,
    verbosity,
    displayName: buildDisplayName(
      modelId,
      entry,
      `${formatClaudeFamily(modelId)} via Codex ${upstreamModel}/${reasoningEffort}`
    ),
  };
}

function configuredProvider(entry, modelId) {
  const provider = routeValue(entry?.provider).toLowerCase();
  if (gatewayProviderProfile(provider) && Object.hasOwn(ROUTE_PROVIDER_BUILDERS, provider)) {
    return provider;
  }

  throw new GatewayError(
    500,
    'api_error',
    `ULTRATHINK_GATEWAY_ROUTE_MAP_JSON entry for ${modelId} must set provider to ${GATEWAY_PROVIDER_IDS.map(function quoteProvider(value) { return `"${value}"`; }).join(', ')}`
  );
}

export function isOpusPassthroughModel(modelId) {
  return matchesModelPattern(modelId, 'claude-opus-5*');
}

function matchesModelPattern(modelId, pattern) {
  if (
    typeof modelId !== 'string' ||
    typeof pattern !== 'string' ||
    modelId.trim() === '' ||
    pattern.trim() === ''
  ) {
    return false;
  }

  const normalizedPattern = pattern.trim();
  if (normalizedPattern.endsWith('*')) {
    return modelId.startsWith(normalizedPattern.slice(0, -1));
  }

  return modelId === normalizedPattern;
}

export function isAnthropicPassthroughModel(modelId, config) {
  const passthroughModels = Array.isArray(config?.anthropicPassthroughModels)
    ? config.anthropicPassthroughModels
    : DEFAULT_ANTHROPIC_PASSTHROUGH_MODELS;

  return passthroughModels.some(function matchesPassthroughModel(pattern) {
    return matchesModelPattern(modelId, pattern);
  });
}

export function resolveModelRoute(modelId, config) {
  if (typeof modelId !== 'string' || modelId.trim() === '') {
    throw new GatewayError(
      400,
      'invalid_request_error',
      'messages requests must include a non-empty model id'
    );
  }

  const configuredRoute = configuredRouteMapEntry(modelId, config);
  if (configuredRoute) {
    const provider = configuredProvider(configuredRoute, modelId);
    return ROUTE_PROVIDER_BUILDERS[provider](modelId, config, configuredRoute);
  }

  if (isAnthropicPassthroughModel(modelId, config)) {
    return buildAnthropicRoute(modelId, config);
  }

  if (config.codex?.enabled) {
    return buildCodexRoute(modelId, config);
  }

  return buildOpenAiRoute(modelId, config);
}

function resolveModelRouteForDiscovery(modelId, config) {
  try {
    return resolveModelRoute(modelId, config);
  } catch (error) {
    if (error instanceof GatewayError) {
      return {
        provider: 'unavailable',
        displayName: `${formatClaudeFamily(modelId)} unavailable`,
      };
    }
    throw error;
  }
}

export function listGatewayModels(config) {
  return config.exposedModels.map(function buildModel(exposedModelId) {
    const route = resolveModelRouteForDiscovery(exposedModelId, config);
    return {
      type: 'model',
      id: exposedModelId,
      display_name: route.displayName,
    };
  });
}
