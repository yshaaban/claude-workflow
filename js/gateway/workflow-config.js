/**
 * Shared Claude-workflow gateway configuration.
 *
 * Builds the routing config used by both the per-session `claude-workflow`
 * launcher and the shared `claude-workflow-gateway` daemon: the frontier main
 * model and its native Anthropic fallback targets use the main provider;
 * workflow/subagent traffic uses the configured Codex-backed profile.
 */
import crypto from 'node:crypto';
import process from 'node:process';

import { envFlag, loadGatewayConfig } from './config.js';
import { resolveCodexCapabilities } from './codex-capabilities.js';
import {
  ROUTE_ENTRY_REASONING_KEYS,
  ROUTE_ENTRY_UPSTREAM_MODEL_KEYS,
  configuredRouteMapEntry,
  modelIdWithoutBracketQualifiers,
  resolveModelRoute,
  routeEntryValue,
} from './model-routing.js';
import { proxyExclusionEnvForHost } from './proxy.js';
import {
  QWEN_TOKEN_PLAN_DEFAULTS,
  providerRequiresGatewayAuth,
} from './provider-profiles.js';
import {
  CLAUDE_TERMINAL_TITLE_ENV_NAME,
  MANAGED_GATEWAY_AUTH_ENV_NAME,
} from '../utils/child-env.js';

const WORKFLOW_CODEX_IDLE_TIMEOUT_MS = 120_000;
const WORKFLOW_CODEX_CONTEXT_PROFILE = 'long';
// Current Codex app-server releases own token-aware tool-output truncation.
// Avoid layering the gateway's byte heuristics on top for workflow sessions;
// operators can still opt into either gateway cap with its existing env var.
const WORKFLOW_CODEX_TOOL_RESULT_MAX_BYTES = 0;
const WORKFLOW_CODEX_TOOL_RESULT_WINDOW_MAX_BYTES = 0;
const GLM_AUTO_COMPACT_WINDOW = '1000000';
const CLAUDE_NATIVE_MODEL_ALIASES = new Set([
  'best',
  'default',
  'fable',
  'haiku',
  'inherit',
  'opus',
  'opusplan',
  'sonnet',
]);
const CLAUDE_MODEL_ALIAS_PREFIXES = Object.freeze([
  'ANTHROPIC_DEFAULT_FABLE',
  'ANTHROPIC_DEFAULT_HAIKU',
  'ANTHROPIC_DEFAULT_OPUS',
  'ANTHROPIC_DEFAULT_SONNET',
]);
const MANAGED_PROVIDER_CLIENT_ENV_NAMES = Object.freeze([
  'ANTHROPIC_CUSTOM_MODEL_OPTION',
  'ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION',
  'ANTHROPIC_CUSTOM_MODEL_OPTION_NAME',
  'ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK',
  'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
]);
// Opus 5 and Fable 5.1 expose their 1M windows natively. Keeping the canonical
// API IDs avoids a redundant client-only qualifier and survives model-picker
// and resume round trips unchanged.
export const OPUS_MAIN_MODEL_ID = 'claude-opus-5';
export const FABLE_MAIN_MODEL_ID = 'claude-fable-5-1';
export const DEFAULT_MAIN_MODEL_ID = FABLE_MAIN_MODEL_ID;
export const DEFAULT_SUBAGENT_REASONING_EFFORT = 'max';
export const KIMI_MAIN_MODEL_ID = 'k3';
export const QWEN_MAIN_MODEL_ID = QWEN_TOKEN_PLAN_DEFAULTS.model;

export function envString(name, fallback = '') {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    return fallback;
  }

  return value.trim();
}

function displayRoutedModel() {
  if (envString('CLAUDE_WORKFLOW_DISPLAY_ROUTED_MODEL')) {
    return envFlag('CLAUDE_WORKFLOW_DISPLAY_ROUTED_MODEL', false);
  }

  return envFlag('ULTRATHINK_GATEWAY_DISPLAY_ROUTED_MODEL', false);
}

function defaultAnthropicPassthroughPattern(mainModelId) {
  // Family wildcard for the configured main model: strips client-side bracket
  // qualifiers (e.g. [1m]) so dated variants stay on Anthropic as well.
  const family = modelIdWithoutBracketQualifiers(String(mainModelId || '').trim());
  return `${family}*`;
}

function nativeAnthropicFallbackModels(mainModelId) {
  const model = modelIdWithoutBracketQualifiers(mainModelId);
  // Keep the documented category-specific targets, not a broad Opus family
  // wildcard that could silently opt future models into Anthropic routing.
  if (/^claude-fable-5(?:-1)?(?:-\d{8})?$/u.test(model)) {
    return [OPUS_MAIN_MODEL_ID, 'claude-opus-4-8'];
  }
  if (/^claude-opus-5(?:-\d{8})?$/u.test(model)) {
    return ['claude-opus-4-8'];
  }
  return [];
}

function nativeFallbackModelAliases(modelId) {
  return [modelId, `${modelId}[1m]`];
}

export function defaultWorkflowAnthropicPassthroughModels(mainModelId) {
  return [
    defaultAnthropicPassthroughPattern(mainModelId),
    ...nativeAnthropicFallbackModels(mainModelId).flatMap(nativeFallbackModelAliases),
  ];
}

function validateNativeAnthropicFallbacks(config, mainModelId, fallbackModels) {
  for (const modelId of fallbackModels) {
    for (const alias of nativeFallbackModelAliases(modelId)) {
      const route = resolveModelRoute(alias, config);
      if (
        route.provider !== 'anthropic' ||
        route.upstreamModel !== modelId
      ) {
        throw new Error(
          `Native fallback for ${mainModelId} requires ${alias} to route unchanged to ` +
            'Anthropic. Update ULTRATHINK_GATEWAY_ROUTE_MAP_JSON or ' +
            'ULTRATHINK_GATEWAY_ANTHROPIC_PASSTHROUGH_MODELS to preserve this target; ' +
            'provider or model remapping of a native fallback target is unsupported.'
        );
      }
    }
  }
}

function routeModelAliases(modelId) {
  const normalized = typeof modelId === 'string' ? modelId.trim() : '';
  const strippedBracketQualifiers = modelIdWithoutBracketQualifiers(normalized);
  return dedupeStrings([normalized, strippedBracketQualifiers]);
}

function routeModelFamilyFallbackPattern(modelId) {
  const aliases = routeModelAliases(modelId);
  const family = aliases[aliases.length - 1];
  // Dated variants of a Claude main model (e.g. claude-opus-5-20260724)
  // follow the main route through a fallback family wildcard. User route-map
  // wildcards are inserted before this fallback and therefore retain their
  // documented precedence.
  return family.startsWith('claude-') ? `${family}*` : '';
}

function dedupeStrings(values) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    if (typeof value !== 'string' || value.trim() === '') {
      continue;
    }

    const normalized = value.trim();
    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function modelIdPart(value) {
  if (typeof value !== 'string') {
    return 'model';
  }

  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '');

  return normalized || 'model';
}

export function routeProvider(route, fallback = 'codex') {
  return String(routeEntryValue(route, ['provider'], fallback)).trim().toLowerCase();
}

function routeUpstreamModel(route, fallback) {
  return routeEntryValue(route, ROUTE_ENTRY_UPSTREAM_MODEL_KEYS, fallback);
}

function routeReasoningEffort(route, fallback = '') {
  return routeEntryValue(route, ROUTE_ENTRY_REASONING_KEYS, fallback);
}

function normalizedRouteProvider(value, fallback = 'anthropic') {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || fallback;
}

function mainRouteDefaultModel(provider, mainModelId, baseConfig) {
  switch (provider) {
    case 'anthropic':
      return modelIdWithoutBracketQualifiers(mainModelId);
    case 'codex':
      return baseConfig.codex.model;
    case 'deepseek':
      return baseConfig.deepseek.model;
    case 'glm':
      return baseConfig.glm.model;
    case 'kimi':
      return baseConfig.kimi.model;
    case 'qwen':
      return baseConfig.qwen.model;
    case 'openai':
      return baseConfig.openai.model;
    default:
      return mainModelId;
  }
}

function mainRouteDefaultReasoningEffort(provider, baseConfig) {
  switch (provider) {
    case 'codex':
      return baseConfig.codex.reasoningEffort;
    case 'deepseek':
      return baseConfig.deepseek.reasoningEffort;
    case 'glm':
      return baseConfig.glm.reasoningEffort;
    case 'kimi':
      return baseConfig.kimi.reasoningEffort;
    case 'qwen':
      return baseConfig.qwen.reasoningEffort;
    case 'openai':
      return baseConfig.openai.reasoningEffort;
    default:
      return '';
  }
}

function mainRouteDisplayName(provider) {
  switch (provider) {
    case 'anthropic':
      return 'Claude Workflow Frontier Route';
    case 'codex':
      return 'Codex Main Route';
    case 'deepseek':
      return 'DeepSeek Main Route';
    case 'glm':
      return 'GLM Main Route';
    case 'kimi':
      return 'Kimi K3 Main Route';
    case 'qwen':
      return 'Qwen 3.8 Max Main Route';
    case 'openai':
      return 'OpenAI-Compatible Main Route';
    default:
      return 'Claude Workflow Main Route';
  }
}

function routedModelId(provider, upstreamModel, requestedModel) {
  if (provider === 'anthropic') {
    return (
      modelIdWithoutBracketQualifiers(upstreamModel) ||
      modelIdWithoutBracketQualifiers(requestedModel)
    );
  }

  const durableCodexTier =
    provider === 'codex'
      ? String(upstreamModel || '').match(/^gpt-\d+(?:\.\d+)*-(astra|sol|terra|luna)$/u)?.[1]
      : null;
  if (durableCodexTier) {
    return `codex-${durableCodexTier}`;
  }

  if (provider === 'codex') {
    const upstream = modelIdPart(upstreamModel);
    return upstream.startsWith('codex-') ? upstream : `codex-${upstream}`;
  }

  // First-class third-party model IDs (k3, qwen3.8-max, and similar) are
  // already truthful and native-looking. Provider and effort remain available
  // in picker descriptions, health data, traces, and opt-in response metadata.
  return modelIdPart(upstreamModel || `${provider}-model`);
}

function assertTruthfulCustomModelId(
  modelId,
  route,
  envName = 'CLAUDE_WORKFLOW_SUBAGENT_MODEL_ID'
) {
  const provider = routeProvider(route, '');
  if (provider === 'anthropic') {
    return;
  }
  const normalized = String(modelId || '').trim();
  if (
    /^(?:anthropic|claude)(?:[^A-Za-z0-9]|$)/iu.test(normalized) ||
    /\[[^\]]+\]/u.test(normalized) ||
    CLAUDE_NATIVE_MODEL_ALIASES.has(normalized.toLowerCase())
  ) {
    throw new Error(
      `${envName} must be a truthful custom model ID without a Claude/Anthropic ` +
        'prefix, native Claude alias, or bracket context qualifier; use codex-astra ' +
      'or another concise non-Anthropic ID'
    );
  }
  if (provider === 'codex' && /^codex-(?:astra|sol|terra|luna|gpt-)/u.test(normalized)) {
    const expected = routedModelId(
      provider,
      routeUpstreamModel(route, ''),
      normalized
    );
    if (normalized !== expected) {
      throw new Error(
        `${envName}=${normalized} does not describe the resolved Codex model ` +
          `${routeUpstreamModel(route, 'unknown')}; use ${expected} or leave the alias unset`
      );
    }
  }
}

function codexCapabilitiesForRoute(config, route) {
  return resolveCodexCapabilities({
    command: config.codex.command,
    cwd: config.codex.cwd,
    model: routeUpstreamModel(route, config.codex.model),
    contextProfile: config.codex.contextProfile,
    requestedContextWindow: config.codex.requestedContextWindow,
    reasoningEffort: routeReasoningEffort(route, config.codex.reasoningEffort),
  });
}

function validateEffectiveCodexRoutes(config) {
  for (const [modelId, route] of Object.entries(config.routeMap || {})) {
    if (routeProvider(route, '') !== 'codex') {
      continue;
    }
    const capabilities = codexCapabilitiesForRoute(config, route);
    if (capabilities.effortSupported) {
      continue;
    }
    const effort = routeReasoningEffort(route, config.codex.reasoningEffort);
    throw new Error(
      `Codex route ${modelId} uses ${capabilities.model} with unsupported reasoning ` +
        `effort ${effort}; choose one of ${capabilities.reasoningEfforts.join(', ')}`
    );
  }
}

export function routeTargetSummary(route) {
  const provider = routeProvider(route);
  if (provider === 'anthropic') {
    return 'anthropic';
  }

  const model = routeUpstreamModel(route, 'default');
  const effort = routeReasoningEffort(route);
  return `${provider}:${model}${effort ? `/${effort}` : ''}`;
}

function parseRequestedPort(defaultPort = 0) {
  const configuredPort = envString('ULTRATHINK_GATEWAY_PORT');
  if (!configuredPort) {
    return defaultPort;
  }

  const parsed = Number(configuredPort);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(
      `ULTRATHINK_GATEWAY_PORT must be an integer between 0 and 65535, got ${configuredPort}`
    );
  }

  return parsed;
}

export function buildWorkflowGatewayConfig({
  defaultPort = 0,
  port = null,
  host = null,
  dynamicToolsOnly = true,
} = {}) {
  const baseConfig = loadGatewayConfig();
  const explicitMainModelId = envString('ULTRATHINK_GATEWAY_MAIN_MODEL_ID');
  const configuredMainModelId = explicitMainModelId || DEFAULT_MAIN_MODEL_ID;
  const mainProvider = normalizedRouteProvider(
    envString('ULTRATHINK_GATEWAY_MAIN_PROVIDER', envString('CLAUDE_WORKFLOW_MAIN_PROVIDER'))
  );
  // Legacy Kimi/Qwen presets used Claude's [1m] qualifier. Claude hard-codes
  // that qualifier as exactly 1,000,000 tokens and ignores the truthful
  // custom-model window, so normalize those persisted IDs at the boundary.
  const normalizedMainModelId =
    mainProvider === 'kimi' || mainProvider === 'qwen' || mainProvider === 'codex'
      ? modelIdWithoutBracketQualifiers(configuredMainModelId)
      : configuredMainModelId;
  const mainUpstreamModel = envString(
    'ULTRATHINK_GATEWAY_MAIN_UPSTREAM_MODEL',
    mainRouteDefaultModel(mainProvider, normalizedMainModelId, baseConfig)
  );
  const mainReasoningEffort = envString(
    'ULTRATHINK_GATEWAY_MAIN_REASONING_EFFORT',
    mainRouteDefaultReasoningEffort(mainProvider, baseConfig)
  );
  // `codex` was the historical direct-main preset. Resolve it to the same
  // concise, tier-specific ID used by Claude subagents so picker metadata,
  // context policy, and wire routing all describe one model identity.
  const candidateMainModelId =
    mainProvider !== 'anthropic' && !explicitMainModelId
      ? mainProvider === 'codex'
        ? routedModelId(
            mainProvider,
            mainUpstreamModel,
            normalizedMainModelId
          )
        : modelIdPart(mainUpstreamModel)
      : mainProvider === 'codex' && normalizedMainModelId === 'codex'
      ? routedModelId(
          mainProvider,
          mainUpstreamModel,
          normalizedMainModelId
        )
      : normalizedMainModelId;
  const rawSubagentModelId = envString(
    'ULTRATHINK_GATEWAY_SUBAGENT_MODEL_ID',
    'claude-sonnet-5'
  );
  const subagentUpstreamModel = envString(
    'ULTRATHINK_GATEWAY_SUBAGENT_UPSTREAM_MODEL',
    baseConfig.codex.model
  );
  const subagentReasoningEffort = envString(
    'ULTRATHINK_GATEWAY_SUBAGENT_REASONING_EFFORT',
    DEFAULT_SUBAGENT_REASONING_EFFORT
  );
  const subagentVerbosity = envString('ULTRATHINK_GATEWAY_SUBAGENT_VERBOSITY', 'high');
  const defaultMainRoute = {
    provider: mainProvider,
    model: mainUpstreamModel,
    ...(mainReasoningEffort ? { reasoningEffort: mainReasoningEffort } : {}),
    displayName: mainRouteDisplayName(mainProvider),
  };
  const defaultSubagentRoute = {
    provider: 'codex',
    model: subagentUpstreamModel,
    reasoningEffort: subagentReasoningEffort,
    verbosity: subagentVerbosity,
    displayName: 'Codex Subagent Route',
  };
  const baseRouteMap = baseConfig.routeMap || {};
  const generatedDefaultMainModelId = routedModelId(
    mainProvider,
    mainUpstreamModel,
    normalizedMainModelId
  );
  const mainModelIdIsDerived =
    mainProvider !== 'anthropic' &&
    candidateMainModelId === generatedDefaultMainModelId;
  const configuredCandidateMainRouteEntry = configuredRouteMapEntry(
    candidateMainModelId,
    baseConfig
  );
  const configuredCandidateMainRoute = configuredCandidateMainRouteEntry
    ? resolveModelRoute(candidateMainModelId, baseConfig)
    : defaultMainRoute;
  const mainModelId = mainModelIdIsDerived
    ? routedModelId(
        routeProvider(configuredCandidateMainRoute, mainProvider),
        routeUpstreamModel(configuredCandidateMainRoute, mainUpstreamModel),
        candidateMainModelId
      )
    : candidateMainModelId;
  const finalMainRouteEntry = configuredRouteMapEntry(mainModelId, baseConfig);
  const configuredMainRoute = finalMainRouteEntry
    ? resolveModelRoute(mainModelId, baseConfig)
    : configuredCandidateMainRoute;
  if (
    mainModelId !== candidateMainModelId &&
    finalMainRouteEntry &&
    routeTargetSummary(configuredMainRoute) !==
      routeTargetSummary(configuredCandidateMainRoute)
  ) {
    throw new Error(
      `${mainModelId} resolves to ${routeTargetSummary(configuredMainRoute)}, but the ` +
        `main route that generated that truthful ID resolves to ${routeTargetSummary(
          configuredCandidateMainRoute
        )}; remove the conflicting route-map alias`
    );
  }
  const configuredRawSubagentRoute = configuredRouteMapEntry(
    rawSubagentModelId,
    baseConfig
  );
  const subagentRoute = configuredRawSubagentRoute
    ? resolveModelRoute(rawSubagentModelId, baseConfig)
    : defaultSubagentRoute;
  const displayModels = displayRoutedModel();
  const codexContextExplicit =
    envString('ULTRATHINK_GATEWAY_CODEX_CONTEXT') ||
    envString('ULTRATHINK_GATEWAY_CODEX_CONTEXT_PROFILE');
  const codexContextProfile = codexContextExplicit
    ? baseConfig.codex.contextProfile
    : WORKFLOW_CODEX_CONTEXT_PROFILE;
  const codexCapabilities =
    codexContextProfile === baseConfig.codex.capabilities?.profile
      ? baseConfig.codex.capabilities
      : resolveCodexCapabilities({
          command: baseConfig.codex.command,
          cwd: baseConfig.codex.cwd,
          model: baseConfig.codex.model,
          contextProfile: codexContextProfile,
          requestedContextWindow: baseConfig.codex.requestedContextWindow,
          reasoningEffort: baseConfig.codex.reasoningEffort,
        });
  const codexToolResultMaxBytes = envString(
    'ULTRATHINK_GATEWAY_CODEX_TOOL_RESULT_MAX_BYTES'
  )
    ? baseConfig.codex.toolResultMaxBytes
    : WORKFLOW_CODEX_TOOL_RESULT_MAX_BYTES;
  const codexToolResultWindowMaxBytes = envString(
    'ULTRATHINK_GATEWAY_CODEX_TOOL_RESULT_WINDOW_MAX_BYTES'
  )
    ? baseConfig.codex.toolResultWindowMaxBytes
    : WORKFLOW_CODEX_TOOL_RESULT_WINDOW_MAX_BYTES;
  const explicitSubagentModelId = envString('CLAUDE_WORKFLOW_SUBAGENT_MODEL_ID');
  const candidateSubagentModelId =
    explicitSubagentModelId ||
    routedModelId(
      routeProvider(subagentRoute),
      routeUpstreamModel(subagentRoute, subagentUpstreamModel),
      rawSubagentModelId
    );
  const configuredSubagentRouteEntry = configuredRouteMapEntry(
    candidateSubagentModelId,
    baseConfig
  );
  const configuredSubagentRoute = configuredSubagentRouteEntry
    ? resolveModelRoute(candidateSubagentModelId, baseConfig)
    : subagentRoute;
  // Automatic IDs describe the route Claude will actually use, after both
  // raw-model and generated-ID route-map overrides have been resolved. An
  // explicit CLAUDE_WORKFLOW_SUBAGENT_MODEL_ID remains operator-owned.
  const subagentModelId = explicitSubagentModelId
    ? explicitSubagentModelId
    : routedModelId(
        routeProvider(configuredSubagentRoute),
        routeUpstreamModel(configuredSubagentRoute, subagentUpstreamModel),
        candidateSubagentModelId
      );
  const finalSubagentRouteEntry = configuredRouteMapEntry(subagentModelId, baseConfig);
  const finalSubagentRoute = finalSubagentRouteEntry
    ? resolveModelRoute(subagentModelId, baseConfig)
    : configuredSubagentRoute;
  if (
    subagentModelId !== candidateSubagentModelId &&
    finalSubagentRouteEntry &&
    routeTargetSummary(finalSubagentRoute) !== routeTargetSummary(configuredSubagentRoute)
  ) {
    throw new Error(
      `${subagentModelId} resolves to ${routeTargetSummary(finalSubagentRoute)}, but the ` +
        `route that generated that truthful ID resolves to ${routeTargetSummary(
          configuredSubagentRoute
        )}; remove the conflicting route-map alias`
    );
  }
  const sharedMainAndSubagentId = mainModelId === subagentModelId;
  if (
    sharedMainAndSubagentId &&
    routeTargetSummary(configuredMainRoute) !== routeTargetSummary(finalSubagentRoute)
  ) {
    throw new Error(
      `${mainModelId} cannot identify different main and subagent routes; ` +
        'set CLAUDE_WORKFLOW_SUBAGENT_MODEL_ID to a distinct truthful model ID'
    );
  }
  const resolvedDefaultMainRoute = sharedMainAndSubagentId
    ? {
        ...configuredMainRoute,
        ...finalSubagentRoute,
        displayName: 'Codex Main and Subagent Route',
      }
    : configuredMainRoute;
  const mainRouteMap = Object.fromEntries(
    routeModelAliases(mainModelId).map(function mapMainRoute(modelId) {
      return [modelId, resolvedDefaultMainRoute];
    })
  );
  const mainFamilyFallbackPattern = routeModelFamilyFallbackPattern(mainModelId);
  const mainFamilyFallbackRouteMap =
    mainFamilyFallbackPattern && !Object.hasOwn(baseRouteMap, mainFamilyFallbackPattern)
      ? { [mainFamilyFallbackPattern]: resolvedDefaultMainRoute }
      : {};
  const routeMap = {
    [rawSubagentModelId]: subagentRoute,
    [candidateSubagentModelId]: configuredSubagentRoute,
    ...baseRouteMap,
    [subagentModelId]: finalSubagentRoute,
    [candidateMainModelId]: configuredCandidateMainRoute,
    ...mainRouteMap,
    // Keep the generated family wildcard behind every user entry so a
    // documented user wildcard cannot be shadowed by workflow defaults.
    ...mainFamilyFallbackRouteMap,
  };
  const selectedSubagentRoute = routeMap[subagentModelId] || finalSubagentRoute;
  assertTruthfulCustomModelId(subagentModelId, selectedSubagentRoute);
  const resolvedMainProvider = routeProvider(routeMap[mainModelId], mainProvider);
  assertTruthfulCustomModelId(
    mainModelId,
    routeMap[mainModelId],
    'ULTRATHINK_GATEWAY_MAIN_MODEL_ID'
  );
  const hasKimiRoute = Object.values(routeMap).some(function usesKimi(route) {
    return routeProvider(route, '') === 'kimi';
  });
  const hasQwenRoute = Object.values(routeMap).some(function usesQwen(route) {
    return routeProvider(route, '') === 'qwen';
  });
  const hasProtectedProviderRoute = Object.values(routeMap).some(function usesProtectedProvider(
    route
  ) {
    return providerRequiresGatewayAuth(routeProvider(route, ''));
  });
  // Native Claude fallback selects exact Opus IDs, independently of agent
  // routing. Keep those targets on Anthropic along with the main family.
  // User passthrough lists and route-map entries retain precedence; validate
  // them below instead of silently replacing an incompatible override.
  const nativeFallbackModels = resolvedMainProvider === 'anthropic'
    ? nativeAnthropicFallbackModels(mainModelId)
    : [];
  const passthroughEnvProvided =
    envString('ULTRATHINK_GATEWAY_ANTHROPIC_PASSTHROUGH_MODELS') !== '' ||
    envString('ULTRATHINK_GATEWAY_PASSTHROUGH_MODEL_IDS') !== '';
  const anthropicPassthroughModels = passthroughEnvProvided
    ? baseConfig.anthropicPassthroughModels
    : resolvedMainProvider === 'anthropic'
      ? defaultWorkflowAnthropicPassthroughModels(mainModelId)
      : [];
  const hasAnthropicRoute =
    anthropicPassthroughModels.length > 0 ||
    Object.values(routeMap).some(function usesAnthropic(route) {
      return routeProvider(route, '') === 'anthropic';
    });
  const requiresClientGatewayCredential =
    hasProtectedProviderRoute || resolvedMainProvider !== 'anthropic';
  const sharedSecret =
    baseConfig.sharedSecret ||
    (requiresClientGatewayCredential ? crypto.randomBytes(32).toString('base64url') : '');
  if (
    sharedSecret &&
    hasKimiRoute &&
    hasAnthropicRoute &&
    !envString('ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY')
  ) {
    throw new Error(
      'A Kimi route combined with an Anthropic route requires a dedicated gateway-side Anthropic API key. Set ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY so the upstream credential remains gateway-only.'
    );
  }
  if (
    sharedSecret &&
    hasQwenRoute &&
    hasAnthropicRoute &&
    !envString('ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY')
  ) {
    throw new Error(
      'A Qwen route combined with an Anthropic route requires a dedicated gateway-side Anthropic API key. Set ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY so the upstream credential remains gateway-only.'
    );
  }
  if (
    sharedSecret &&
    hasAnthropicRoute &&
    !envString('ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY')
  ) {
    throw new Error(
      'A gateway shared secret with an Anthropic route requires a dedicated gateway-side ' +
        'credential. Set ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY; a generic ANTHROPIC_API_KEY ' +
        'is not accepted because the local gateway credential must remain distinct from ' +
        'upstream authentication. For a Codex-only main route, remove the explicit Anthropic ' +
        'route or set ULTRATHINK_GATEWAY_ANTHROPIC_PASSTHROUGH_MODELS=none.'
    );
  }

  const config = {
    ...baseConfig,
    sharedSecret,
    host: host ?? envString('ULTRATHINK_GATEWAY_HOST', baseConfig.host || '127.0.0.1'),
    port: port ?? parseRequestedPort(defaultPort),
    displayRoutedModel: displayModels,
    routeMap,
    anthropicPassthroughModels,
    codex: {
      ...baseConfig.codex,
      contextProfile: codexContextProfile,
      capabilities: codexCapabilities,
      dynamicToolsOnly: Boolean(dynamicToolsOnly),
      idleTimeoutMs: envString('ULTRATHINK_GATEWAY_CODEX_IDLE_TIMEOUT_MS')
        ? baseConfig.codex.idleTimeoutMs
        : WORKFLOW_CODEX_IDLE_TIMEOUT_MS,
      toolResultMaxBytes: codexToolResultMaxBytes,
      toolResultWindowMaxBytes: codexToolResultWindowMaxBytes,
    },
    exposedModels: dedupeStrings([
      ...routeModelAliases(mainModelId),
      rawSubagentModelId,
      subagentModelId,
      ...(baseConfig.exposedModels || []),
    ]),
  };
  validateNativeAnthropicFallbacks(config, mainModelId, nativeFallbackModels);
  validateEffectiveCodexRoutes(config);
  const effectiveSubagentRoute = resolveModelRoute(subagentModelId, config);
  const subagentCapabilities =
    routeProvider(effectiveSubagentRoute, '') === 'codex'
      ? codexCapabilitiesForRoute(config, effectiveSubagentRoute)
      : null;

  return {
    config,
    mainModelId,
    subagentModelId,
    rawSubagentModelId,
    subagentRoute: effectiveSubagentRoute,
    subagentCapabilities,
  };
}

export function buildWorkflowClientEnv(
  config,
  gatewayBaseUrl,
  subagentModelId,
  mainModelId = DEFAULT_MAIN_MODEL_ID
) {
  const clientEnv = {
    ...proxyExclusionEnvForHost(config.host),
    ...buildWorkflowClaudeEnv(gatewayBaseUrl, subagentModelId, mainModelId),
  };

  // These values depend on the selected provider. Null is an explicit unset
  // instruction for both per-session child environments and shared shell env
  // files, preventing Kimi settings from surviving a later route switch.
  for (const name of MANAGED_PROVIDER_CLIENT_ENV_NAMES) {
    clientEnv[name] = null;
  }
  clientEnv[MANAGED_GATEWAY_AUTH_ENV_NAME] = null;

  const mainRoute = resolveModelRoute(mainModelId, config);
  const subagentRoute = resolveModelRoute(subagentModelId, config);
  if (
    mainRoute.provider === 'anthropic' &&
    nativeAnthropicFallbackModels(mainModelId).includes(OPUS_MAIN_MODEL_ID)
  ) {
    // Claude validates this alias before arming Fable's native refusal
    // fallback. The force flag below keeps explicit Opus-pinned agents on
    // the configured agent model without disguising the fallback as Codex.
    clientEnv.ANTHROPIC_DEFAULT_OPUS_MODEL = OPUS_MAIN_MODEL_ID;
  }
  const routedContextContracts = [mainRoute, subagentRoute]
    .map((route) => routeContextContract(config, route))
    .filter(Boolean);
  if (routedContextContracts.length > 0) {
    clientEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(
      Math.min(...routedContextContracts.map((contract) => contract.usableContextTokens))
    );
    clientEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(
      Math.min(...routedContextContracts.map((contract) => contract.autoCompactTokens))
    );
  } else if (routeMapUsesProvider(config, 'glm')) {
    clientEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW = GLM_AUTO_COMPACT_WINDOW;
  }

  const customModelRoute = routeProvider(mainRoute, '') === 'anthropic' ? subagentRoute : mainRoute;
  const customModelId = routeProvider(mainRoute, '') === 'anthropic' ? subagentModelId : mainModelId;
  if (routeProvider(customModelRoute, '') !== 'anthropic') {
    clientEnv.ANTHROPIC_CUSTOM_MODEL_OPTION = customModelId;
    clientEnv.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME = customModelName(customModelRoute);
    clientEnv.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION =
      `${routeTargetSummary(customModelRoute)} through claude-workflow`;
    clientEnv.ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES =
      customModelSupportedCapabilities(config, customModelRoute);
  }

  const subagentProvider = routeProvider(subagentRoute, '');
  const subagentName = customModelName(subagentRoute);
  const subagentDescription = `${routeTargetSummary(subagentRoute)} through claude-workflow`;
  const subagentSupportedCapabilities =
    subagentProvider === 'anthropic'
      ? null
      : customModelSupportedCapabilities(config, subagentRoute);
  for (const prefix of CLAUDE_MODEL_ALIAS_PREFIXES) {
    const aliasModelName = `${prefix}_MODEL`;
    const describesSubagent =
      subagentProvider !== 'anthropic' && clientEnv[aliasModelName] === subagentModelId;
    clientEnv[`${prefix}_MODEL_NAME`] = describesSubagent ? subagentName : null;
    clientEnv[`${prefix}_MODEL_DESCRIPTION`] = describesSubagent
      ? subagentDescription
      : null;
    clientEnv[`${prefix}_MODEL_SUPPORTED_CAPABILITIES`] = describesSubagent
      ? subagentSupportedCapabilities
      : null;
  }

  // Keep Claude's session effort independent of the Codex route. An effort
  // environment variable overrides /effort, including ultracode's xhigh mode.
  // Leave the managed null above intact so stale shell/settings pins are
  // cleared. Do not use "auto" or "unset": Claude treats those as overrides
  // too. Codex still receives its exact configured route effort. Kimi/Qwen
  // retain their provider-specific client requirements below.
  // Claude may fall back from a broken stream to a non-streaming retry. A tool
  // turn is not safely replayable, so keep one intended boundary to one
  // provider request and surface the transport failure instead.
  clientEnv.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK = '1';

  if (mainRoute.suppressTerminalTitleRequest) {
    // Claude Code otherwise spends a second provider request generating a
    // terminal title. Direct third-party routes should make one request for a
    // plain no-tool prompt and return that response unchanged.
    clientEnv[CLAUDE_TERMINAL_TITLE_ENV_NAME] = '1';
  }
  if (routeProvider(mainRoute, '') === 'kimi') {
    clientEnv.CLAUDE_CODE_EFFORT_LEVEL = routeReasoningEffort(mainRoute, 'max');
  }
  if (routeProvider(mainRoute, '') === 'qwen') {
    clientEnv.CLAUDE_CODE_EFFORT_LEVEL = mainRoute.claudeEffort || 'max';
  }

  if (config.sharedSecret) {
    clientEnv.ANTHROPIC_AUTH_TOKEN = config.sharedSecret;
    clientEnv.ANTHROPIC_API_KEY = config.sharedSecret;
    clientEnv[MANAGED_GATEWAY_AUTH_ENV_NAME] = config.sharedSecret;
  }

  return clientEnv;
}

function customModelName(route) {
  const provider = routeProvider(route, '');
  if (provider === 'codex') {
    const tier = String(routeUpstreamModel(route, '')).match(/-(astra|sol|terra|luna)$/u)?.[1];
    return tier ? `Codex ${tier[0].toUpperCase()}${tier.slice(1)}` : 'Codex';
  }
  return route.displayName || mainRouteDisplayName(provider);
}

function customModelSupportedCapabilities(config, route) {
  const capabilities = ['effort'];
  const provider = routeProvider(route, '');
  if (provider === 'codex') {
    const supportedEfforts = new Set(
      codexCapabilitiesForRoute(config, route).reasoningEfforts
    );
    if (supportedEfforts.has('xhigh')) {
      capabilities.push('xhigh_effort');
    }
    if (supportedEfforts.has('max')) {
      capabilities.push('max_effort');
    }
  } else {
    capabilities.push('xhigh_effort', 'max_effort');
  }
  if (
    provider === 'kimi' ||
    route?.preserveAssistantThinking === true ||
    route?.preserveThinking === true
  ) {
    capabilities.push('thinking', 'adaptive_thinking', 'interleaved_thinking');
  }
  return capabilities.join(',');
}

function modelPickerLabel(modelId, route) {
  const provider = routeProvider(route, '');
  if (provider === 'codex') {
    return customModelName(route);
  }
  if (provider === 'kimi') {
    return 'Kimi K3';
  }
  if (provider === 'qwen') {
    return 'Qwen 3.8 Max';
  }
  if (provider === 'anthropic') {
    const normalized = modelIdWithoutBracketQualifiers(modelId);
    for (const [pattern, label] of [
      [/^claude-fable-5-1(?:-|$)/u, 'Fable 5.1'],
      [/^claude-fable-5(?:-|$)/u, 'Fable 5'],
      [/^claude-opus-5(?:-|$)/u, 'Opus 5'],
      [/^claude-sonnet-5(?:-|$)/u, 'Sonnet 5'],
    ]) {
      if (pattern.test(normalized)) {
        return label;
      }
    }
  }
  return route.displayName || modelId;
}

function modelPickerDescription(modelId, route) {
  if (routeProvider(route, '') === 'anthropic') {
    return `Anthropic ${modelIdWithoutBracketQualifiers(modelId)}`;
  }
  return `${routeTargetSummary(route)} through Claude Workflow`;
}

export function buildWorkflowModelPicker(config, mainModelId, subagentModelId) {
  const options = dedupeStrings([mainModelId, subagentModelId]).map(function modelRow(
    modelId
  ) {
    const route = resolveModelRoute(modelId, config);
    return {
      model: modelId,
      label: modelPickerLabel(modelId, route),
      description: modelPickerDescription(modelId, route),
    };
  });
  return {
    options,
    replaceBuiltInOptions: true,
  };
}

function routeContextContract(config, route) {
  switch (routeProvider(route, '')) {
    case 'codex': {
      const model = routeUpstreamModel(route, config.codex.model);
      const capabilities =
        model === config.codex.capabilities?.model
          ? config.codex.capabilities
          : resolveCodexCapabilities({
              command: config.codex.command,
              cwd: config.codex.cwd,
              model,
              contextProfile: config.codex.contextProfile,
              requestedContextWindow: config.codex.requestedContextWindow,
              reasoningEffort: routeReasoningEffort(route, config.codex.reasoningEffort),
            });
      return {
        usableContextTokens: capabilities.usableContextTokens,
        autoCompactTokens: capabilities.autoCompactTokens,
      };
    }
    case 'kimi': {
      const tokens = Number(route.contextTokens || config.kimi?.contextTokens || 0);
      return tokens > 0
        ? { usableContextTokens: Math.trunc(tokens), autoCompactTokens: Math.trunc(tokens) }
        : null;
    }
    case 'qwen': {
      const tokens = Number(route.contextTokens || config.qwen?.contextTokens || 0);
      return tokens > 0
        ? { usableContextTokens: Math.trunc(tokens), autoCompactTokens: Math.trunc(tokens) }
        : null;
    }
    default:
      return null;
  }
}

function routeMapUsesProvider(config, provider) {
  return Object.values(config.routeMap || {}).some(function hasProvider(route) {
    return routeProvider(route, '') === provider;
  });
}

function mainModelAliasSlotName(mainModelId) {
  const normalized = String(mainModelId || '').trim();
  if (normalized.startsWith('claude-opus-')) {
    return 'ANTHROPIC_DEFAULT_OPUS_MODEL';
  }
  if (normalized.startsWith('claude-fable-')) {
    return 'ANTHROPIC_DEFAULT_FABLE_MODEL';
  }
  return '';
}

export function buildWorkflowClaudeEnv(
  gatewayBaseUrl,
  subagentModelId,
  mainModelId = DEFAULT_MAIN_MODEL_ID
) {
  // Newer Claude Code resolves agent-definition models through the
  // sonnet/haiku/opus/fable alias slots and shows those labels in the TUI.
  // Remap the slots to the routed subagent model id so alias-pinned agents
  // display and request the Codex-backed id instead of raw Anthropic model
  // ids. The slot matching the main model's own family points at the main
  // model id instead. These are managed outputs, so a value exported by an
  // older shared daemon cannot override a route change.
  const aliasSlots = {
    ANTHROPIC_DEFAULT_SONNET_MODEL: subagentModelId,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: subagentModelId,
    ANTHROPIC_DEFAULT_OPUS_MODEL: subagentModelId,
    ANTHROPIC_DEFAULT_FABLE_MODEL: subagentModelId,
  };
  const mainSlot = mainModelAliasSlotName(mainModelId);
  if (mainSlot) {
    aliasSlots[mainSlot] = mainModelId;
  }

  return {
    ANTHROPIC_BASE_URL: gatewayBaseUrl,
    // The managed main-route setting must win over stale exports from a
    // previously configured shared daemon.
    ANTHROPIC_MODEL: mainModelId,
    CLAUDE_CODE_SUBAGENT_MODEL: subagentModelId,
    CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1',
    ...aliasSlots,
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '0',
  };
}
