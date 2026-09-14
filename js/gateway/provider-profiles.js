export const DEEPSEEK_FLASH_DEFAULTS = Object.freeze({
  model: 'deepseek-flash',
  baseUrl: 'https://api.deepseek.com',
  reasoningEffort: 'max',
  // Conservative decimal interpretation of DeepSeek's documented 1M window.
  contextTokens: 1_000_000,
  maxOutputTokens: 393_216,
});

export function isDeepSeekFlashModel(model) {
  return ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(model);
}

export const QWEN_TOKEN_PLAN_DEFAULTS = Object.freeze({
  baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
  model: 'qwen3.8-max',
  reasoningEffort: 'xhigh',
  totalContextTokens: 1_000_000,
  // Alibaba's documented thinking-mode input ceiling. Keep this separate from
  // the total window because output and chain-of-thought consume the balance.
  contextTokens: 983_616,
  maxOutputTokens: 131_072,
});

const PROVIDER_PROFILES = Object.freeze({
  anthropic: Object.freeze({
    id: 'anthropic',
    label: 'Anthropic',
    configKey: 'anthropic',
    transport: 'anthropic',
    upstreamAuth: 'forwarded',
    tokenCountPolicy: 'upstream',
    requiresGatewayAuth: false,
    credentialEnvNames: Object.freeze(['ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY']),
  }),
  codex: Object.freeze({
    id: 'codex',
    label: 'Codex',
    configKey: 'codex',
    transport: 'codex',
    upstreamAuth: 'local-cli',
    tokenCountPolicy: 'estimate',
    requiresGatewayAuth: false,
    credentialEnvNames: Object.freeze([]),
  }),
  deepseek: Object.freeze({
    id: 'deepseek',
    label: 'DeepSeek',
    configKey: 'deepseek',
    transport: 'openai',
    upstreamAuth: 'bearer',
    tokenCountPolicy: 'estimate',
    requiresGatewayAuth: false,
    credentialEnvNames: Object.freeze([
      'DEEPSEEK_API_KEY',
      'ULTRATHINK_GATEWAY_DEEPSEEK_API_KEY',
    ]),
  }),
  glm: Object.freeze({
    id: 'glm',
    label: 'GLM',
    configKey: 'glm',
    transport: 'openai',
    upstreamAuth: 'bearer',
    tokenCountPolicy: 'estimate',
    requiresGatewayAuth: false,
    credentialEnvNames: Object.freeze([
      'GLM_API_KEY',
      'ULTRATHINK_GATEWAY_GLM_API_KEY',
      'ZAI_API_KEY',
    ]),
  }),
  kimi: Object.freeze({
    id: 'kimi',
    label: 'Kimi',
    configKey: 'kimi',
    transport: 'anthropic',
    upstreamAuth: 'x-api-key',
    tokenCountPolicy: 'conservative-estimate',
    requestPolicy: 'kimi',
    requiresGatewayAuth: true,
    credentialEnvNames: Object.freeze([
      'KIMI_API_KEY',
      'ULTRATHINK_GATEWAY_KIMI_API_KEY',
    ]),
  }),
  openai: Object.freeze({
    id: 'openai',
    label: 'OpenAI-compatible',
    configKey: 'openai',
    transport: 'openai',
    upstreamAuth: 'bearer',
    tokenCountPolicy: 'estimate',
    requiresGatewayAuth: false,
    credentialEnvNames: Object.freeze([
      'OPENAI_API_KEY',
      'ULTRATHINK_GATEWAY_CODEX_API_KEY',
      'ULTRATHINK_GATEWAY_OPENAI_API_KEY',
    ]),
  }),
  qwen: Object.freeze({
    id: 'qwen',
    label: 'Qwen',
    configKey: 'qwen',
    transport: 'openai',
    upstreamAuth: 'bearer',
    tokenCountPolicy: 'conservative-estimate',
    requiresGatewayAuth: true,
    credentialEnvNames: Object.freeze([
      'BAILIAN_TOKEN_PLAN_API_KEY',
      'DASHSCOPE_API_KEY',
      'QWEN_API_KEY',
      'ULTRATHINK_GATEWAY_QWEN_API_KEY',
    ]),
  }),
});

export const GATEWAY_PROVIDER_IDS = Object.freeze(Object.keys(PROVIDER_PROFILES));

export const GATEWAY_PROVIDER_CREDENTIAL_ENV_NAMES = Object.freeze(
  Array.from(
    new Set(
      GATEWAY_PROVIDER_IDS.flatMap(function providerCredentialNames(provider) {
        return PROVIDER_PROFILES[provider].credentialEnvNames;
      })
    )
  )
);

export function gatewayProviderProfile(provider) {
  const normalized = String(provider || '').trim().toLowerCase();
  return PROVIDER_PROFILES[normalized] || null;
}

export function providerRequiresGatewayAuth(provider) {
  return gatewayProviderProfile(provider)?.requiresGatewayAuth === true;
}

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || '').toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '[::1]' ||
    normalized === '::1' ||
    /^127(?:\.\d{1,3}){3}$/u.test(normalized)
  );
}

function endpointTransportConfigurationIssue(baseUrl) {
  let endpoint;
  try {
    endpoint = new URL(baseUrl);
  } catch {
    return { endpoint: null, issue: 'invalid_url' };
  }
  if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') {
    return { endpoint, issue: 'unsupported_protocol' };
  }
  if (endpoint.protocol === 'http:' && !isLoopbackHostname(endpoint.hostname)) {
    return { endpoint, issue: 'insecure_url' };
  }
  return { endpoint, issue: '' };
}

export function kimiProfileConfigurationIssue(profile) {
  if (!profile?.apiKey) {
    return 'missing_key';
  }
  return endpointTransportConfigurationIssue(profile.baseUrl).issue;
}

export function kimiProfileIsUsable(profile) {
  return kimiProfileConfigurationIssue(profile) === '';
}

export function qwenProfileConfigurationIssue(profile) {
  if (!profile?.apiKey) {
    return 'missing_key';
  }

  const transport = endpointTransportConfigurationIssue(profile.baseUrl);
  if (transport.issue) {
    return transport.issue;
  }
  const endpoint = transport.endpoint;
  if (endpoint.pathname.includes('/apps/anthropic')) {
    return 'anthropic_endpoint';
  }
  if (
    endpoint.hostname.startsWith('token-plan.') &&
    !String(profile.apiKey).startsWith('sk-sp-')
  ) {
    return 'token_plan_key_mismatch';
  }
  return '';
}

export function qwenProfileIsUsable(profile) {
  return qwenProfileConfigurationIssue(profile) === '';
}

export function routeProviderMetadata(provider) {
  const profile = gatewayProviderProfile(provider);
  if (!profile) {
    return {};
  }

  return {
    transport: profile.transport,
    providerConfigKey: profile.configKey,
    providerLabel: profile.label,
    upstreamAuth: profile.upstreamAuth,
    tokenCountPolicy: profile.tokenCountPolicy,
    requestPolicy: profile.requestPolicy || '',
    requiresGatewayAuth: profile.requiresGatewayAuth,
    suppressTerminalTitleRequest: profile.id !== 'anthropic',
  };
}
