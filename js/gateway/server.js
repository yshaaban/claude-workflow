import { timingSafeEqual } from 'node:crypto';

import express from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

import {
  estimateAnthropicInputTokens,
  formatAnthropicError,
  mapOpenAiFinishReason,
  openAiUsageToAnthropicUsage,
  translateAnthropicMessagesRequestWithOptions,
  translateOpenAiResponseToAnthropic,
} from './anthropic-format.js';
import { isGatewayLoopbackHost, loadGatewayConfig } from './config.js';
import { CodexSessionManager } from './codex-provider.js';
import { GatewayError, listGatewayModels, resolveModelRoute } from './model-routing.js';
import { gatewayProviderProfile, providerRequiresGatewayAuth } from './provider-profiles.js';
import { proxyUrlForTarget } from './proxy.js';
import { createGatewayTracer } from './trace.js';

const proxyDispatchers = new Map();
const TOOL_REASONING_CACHE_MAX_ENTRIES = 2_048;
const CLAUDE_REQUEST_BODY_LIMIT_BYTES = 32 * 1024 * 1024;
const DEFAULT_AUTH_FAILURE_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_AUTH_FAILURE_RATE_LIMIT_MAX_REQUESTS = 60;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 32;
const DEFAULT_SSE_KEEPALIVE_INTERVAL_MS = 10_000;
const SSE_KEEPALIVE_CHUNK = 'event: ping\ndata: {"type":"ping"}\n\n';
const CREDENTIAL_LIKE_HEADER_PATTERN =
  /(?:^|-)(?:auth|authorization|bearer|cookie|credential|csrf|key|nonce|oauth|password|secret|signature|token)(?:-|$)/u;
const SAFE_ANTHROPIC_IDENTITY_HEADERS = new Set([
  'user-agent',
  'x-app',
  // Native Claude fallback provenance accompanies the retried request. Keep
  // these exact fields without admitting arbitrary x-cc-* headers.
  'x-is-refusal-fallback',
  'x-cc-fallback-latched-by',
  'x-cc-fallback-from-model',
  'x-cc-fallback-category',
  'x-cc-fallback-trigger',
  'x-cc-original-request-id',
]);
const BLOCKED_FORWARD_HEADERS = new Set([
  'authorization',
  'connection',
  'content-encoding',
  'content-length',
  'content-type',
  'cookie',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'x-api-key',
]);

export function assertGatewayBindIsSafe(config) {
  const host = config.host || '127.0.0.1';
  const protectedProvider = Object.values(config.routeMap || {}).find(function usesProtectedProvider(
    route
  ) {
    return providerRequiresGatewayAuth(route?.provider);
  });
  if (protectedProvider && !config.sharedSecret) {
    const provider = String(protectedProvider.provider || '').trim().toLowerCase();
    const label = gatewayProviderProfile(provider)?.label || provider;
    throw new GatewayError(
      500,
      'api_error',
      `${label} routes require gateway authentication, including on loopback. Set ULTRATHINK_GATEWAY_SHARED_SECRET or use a managed workflow profile.`
    );
  }
  const hasAnthropicRoute =
    (Array.isArray(config.anthropicPassthroughModels) &&
      config.anthropicPassthroughModels.length > 0) ||
    Object.values(config.routeMap || {}).some(function usesAnthropic(route) {
      return String(route?.provider || '').trim().toLowerCase() === 'anthropic';
    });
  if (
    config.sharedSecret &&
    hasAnthropicRoute &&
    (!config.anthropic?.apiKey || config.anthropic.apiKeySource === 'generic')
  ) {
    throw new GatewayError(
      500,
      'api_error',
      'A shared-secret Anthropic route requires ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY; a generic ANTHROPIC_API_KEY is not accepted for this role.'
    );
  }
  if (isGatewayLoopbackHost(host) || config.sharedSecret) {
    return;
  }

  throw new GatewayError(
    500,
    'api_error',
    `Refusing to start unauthenticated gateway on non-loopback host ${host}. Set ULTRATHINK_GATEWAY_SHARED_SECRET or bind to 127.0.0.1.`
  );
}

function authHeaderSecret(req) {
  const authorization = req.get('authorization');
  if (authorization?.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length);
  }

  const apiKey = req.get('x-api-key');
  if (typeof apiKey === 'string' && apiKey !== '') {
    return apiKey;
  }

  return '';
}

function secretsEqual(candidate, expected) {
  if (typeof expected !== 'string' || expected === '') {
    return false;
  }
  const candidateBytes = Buffer.from(String(candidate || ''), 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return (
    candidateBytes.length === expectedBytes.length &&
    timingSafeEqual(candidateBytes, expectedBytes)
  );
}

function requireGatewayAuth(config) {
  return function gatewayAuth(req, res, next) {
    if (!config.sharedSecret) {
      next();
      return;
    }

    if (!secretsEqual(authHeaderSecret(req), config.sharedSecret)) {
      discardUnreadRequestBody(req);
      res.status(401).json({
        type: 'error',
        error: {
          type: 'authentication_error',
          message: 'invalid gateway credentials',
        },
      });
      return;
    }

    next();
  };
}

function boundedPositiveInteger(value, fallback, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) {
    return fallback;
  }
  return Math.min(Math.trunc(number), maximum);
}

function requestLimitConfiguration(config) {
  return {
    authFailureWindowMs: boundedPositiveInteger(
      config.authFailureRateLimitWindowMs,
      DEFAULT_AUTH_FAILURE_RATE_LIMIT_WINDOW_MS,
      60 * 60_000
    ),
    authFailureMaxRequests: boundedPositiveInteger(
      config.authFailureRateLimitMaxRequests,
      DEFAULT_AUTH_FAILURE_RATE_LIMIT_MAX_REQUESTS,
      10_000
    ),
    maxConcurrentRequests: boundedPositiveInteger(
      config.maxConcurrentRequests,
      DEFAULT_MAX_CONCURRENT_REQUESTS,
      256
    ),
  };
}

function discardUnreadRequestBody(req) {
  if (req.destroyed || req.readableEnded) {
    return;
  }
  // These guards run before express.json(). Drain the socket without retaining
  // the body so a rejected large request cannot consume the JSON buffer budget.
  req.on('error', function ignoreRejectedRequestBodyError() {});
  req.resume();
}

function sendGatewayRateLimit(res, message, retryAfterSeconds) {
  if (!res.hasHeader('retry-after')) {
    res.setHeader('retry-after', String(Math.max(1, retryAfterSeconds)));
  }
  res.status(429).json({
    type: 'error',
    error: {
      type: 'rate_limit_error',
      message,
    },
  });
}

function shouldSkipCredentialFailureLimit(req, config) {
  if (!config.sharedSecret) {
    return true;
  }

  const suppliedSecret = authHeaderSecret(req);
  if (secretsEqual(suppliedSecret, config.sharedSecret)) {
    return true;
  }

  // Express routing is case-insensitive and non-strict by default. Classify
  // the path with the same casing and trailing-slash behavior so alternate
  // spellings cannot reach auth while skipping its failure counter.
  const lowerPath = req.path.toLowerCase();
  let routeEnd = lowerPath.length;
  while (routeEnd > 1 && lowerPath[routeEnd - 1] === '/') {
    routeEnd -= 1;
  }
  const routePath = lowerPath.slice(0, routeEnd);

  if (routePath === '/healthz') {
    // Anonymous health checks expose only the fixed basic response and must
    // remain safe for unbounded process supervisors. Supplying a wrong
    // credential is an authentication attempt and is counted.
    return suppliedSecret === '';
  }

  const isV1Route = routePath === '/v1' || routePath.startsWith('/v1/');
  return !isV1Route;
}

function createCredentialFailureRateLimiter(config, limits) {
  return rateLimit({
    windowMs: limits.authFailureWindowMs,
    limit: limits.authFailureMaxRequests,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    identifier: 'claude-workflow-invalid-credentials',
    passOnStoreError: false,
    keyGenerator(req) {
      // Never trust caller-controlled forwarding headers for an auth throttle.
      // The gateway keys attempts to the direct socket peer and lets the
      // library normalize IPv4-mapped and native IPv6 addresses.
      return ipKeyGenerator(req.socket.remoteAddress || req.ip);
    },
    skip(req) {
      return shouldSkipCredentialFailureLimit(req, config);
    },
    handler(req, res) {
      discardUnreadRequestBody(req);
      sendGatewayRateLimit(
        res,
        'too many invalid gateway credential attempts',
        Math.ceil(limits.authFailureWindowMs / 1_000)
      );
    },
  });
}

function createConcurrentRequestLimiter(maxConcurrentRequests) {
  let activeRequests = 0;

  function concurrentRequestLimiter(req, res, next) {
    if (activeRequests >= maxConcurrentRequests) {
      discardUnreadRequestBody(req);
      sendGatewayRateLimit(
        res,
        'gateway concurrent model-operation limit exceeded',
        1
      );
      return;
    }

    activeRequests += 1;
    let released = false;
    function release() {
      if (released) {
        return;
      }
      released = true;
      activeRequests = Math.max(0, activeRequests - 1);
    }
    req.once('aborted', release);
    res.once('finish', release);
    res.once('close', release);
    next();
  }

  concurrentRequestLimiter.activeRequests = function currentActiveRequests() {
    return activeRequests;
  };
  return concurrentRequestLimiter;
}

function jsonBodyErrorHandler(error, req, res, next) {
  if (!error) {
    next();
    return;
  }

  const requestTooLarge =
    error.type === 'entity.too.large' ||
    error.status === 413 ||
    error.statusCode === 413;
  const formatted = formatAnthropicError(
    requestTooLarge
      ? new GatewayError(
          413,
          'request_too_large',
          'request body exceeds the 32 MiB limit'
        )
      : new GatewayError(400, 'invalid_request_error', error.message || 'invalid JSON body')
  );
  res.status(formatted.status).json(formatted.body);
}

export function withAbortSignal(req, res, timeoutMs) {
  const controller = new AbortController();
  const timeoutError = new GatewayError(
    504,
    'api_error',
    `gateway request timed out after ${timeoutMs}ms`
  );
  const clientAbortError = new GatewayError(
    499,
    'api_error',
    'gateway request aborted by the client before completion'
  );

  function abortOnce(reason) {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  }

  const timer = setTimeout(function abortOnTimeout() {
    abortOnce(timeoutError);
  }, timeoutMs);
  timer.unref?.();

  controller.signal.addEventListener(
    'abort',
    function clearAbortTimer() {
      clearTimeout(timer);
    },
    { once: true }
  );
  req.on('aborted', function abortOnAbort() {
    abortOnce(clientAbortError);
  });
  res.on('close', function abortOnClose() {
    if (!res.writableEnded) {
      abortOnce(clientAbortError);
    }
  });
  res.on('finish', function clearOnFinish() {
    clearTimeout(timer);
  });
  return controller.signal;
}

function upstreamHeaders(headers = {}) {
  return {
    'content-type': 'application/json',
    ...headers,
  };
}

async function safeJson(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function estimateConservativeInputTokens(requestBody) {
  const serialized = JSON.stringify({
    model: requestBody?.model,
    system: requestBody?.system,
    messages: requestBody?.messages,
    tools: requestBody?.tools,
    tool_choice: requestBody?.tool_choice,
  });
  // Some third-party coding plans do not expose a compatible count_tokens
  // endpoint. One estimated token per UTF-8 byte is a deliberately early
  // compaction ceiling for byte-fallback tokenizers. It overcounts ordinary
  // source code and avoids the prior 2:1 heuristic's unsafe behavior on
  // high-entropy or multibyte input without making a second model request.
  return Math.max(1, Buffer.byteLength(serialized, 'utf8'));
}

function copyUpstreamResponseHeaders(upstream, res, options = {}) {
  const exactHeaders = new Set([
    'request-id',
    'retry-after',
    'x-request-id',
  ]);
  if (options.preserveContentType) {
    exactHeaders.add('content-type');
  }

  for (const [name, value] of upstream.headers) {
    if (
      !exactHeaders.has(name) &&
      !name.startsWith('anthropic-ratelimit-') &&
      !name.startsWith('x-ratelimit-')
    ) {
      continue;
    }
    res.setHeader(name, value);
  }
}

async function postJson(url, headers, body, signal) {
  try {
    const upstream = await undiciFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
      dispatcher: fetchDispatcherForUrl(url),
      // Never replay credentials or a model request to a redirect target.
      redirect: 'manual',
    });
    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel().catch(() => {});
      throw new GatewayError(
        502,
        'api_error',
        'upstream redirects are disabled to protect credentials and request integrity'
      );
    }
    return upstream;
  } catch (error) {
    if (signal?.aborted && signal.reason instanceof GatewayError) {
      throw signal.reason;
    }
    throw error;
  }
}

function normalizeAbortError(error, signal) {
  if (signal?.aborted && signal.reason instanceof GatewayError) {
    return signal.reason;
  }

  return error;
}

function gatewayUrl(baseUrl, relativePath) {
  const base = String(baseUrl || '').endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(relativePath.replace(/^\/+/u, ''), base);
}

function fetchDispatcherForUrl(url) {
  const proxyUrl = proxyUrlForTarget(url);
  if (!proxyUrl) {
    return undefined;
  }

  const dispatcherUrl = normalizeProxyDispatcherUrl(proxyUrl);
  if (!proxyDispatchers.has(dispatcherUrl)) {
    proxyDispatchers.set(dispatcherUrl, new ProxyAgent(dispatcherUrl));
  }

  return proxyDispatchers.get(dispatcherUrl);
}

function normalizeProxyDispatcherUrl(proxyUrl) {
  let parsed = null;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    throw new GatewayError(
      502,
      'api_error',
      'Invalid proxy URL configured for gateway upstream requests'
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new GatewayError(
      502,
      'api_error',
      `Unsupported proxy URL scheme "${parsed.protocol}" for gateway upstream requests; configure an http:// or https:// proxy URL.`
    );
  }

  return parsed.href;
}

function openAiCompatibleConfig(config, route) {
  return config[route.providerConfigKey || route.provider] || config.openai;
}

function createOpenAiCompatibleHeaders(config, route) {
  const providerConfig = openAiCompatibleConfig(config, route);
  return upstreamHeaders({
    authorization: `Bearer ${providerConfig.apiKey}`,
  });
}

function openAiCompatibleProviderLabel(route) {
  return route.providerLabel || 'OpenAI-compatible';
}

function preservesOpenAiReasoningContent(route) {
  return (
    route.preserveAssistantThinking === true ||
    route.provider === 'deepseek' ||
    route.provider === 'glm'
  );
}

function toolReasoningCacheNamespace(req) {
  return [
    req.get('x-claude-code-session-id') || 'global',
    req.get('x-claude-code-agent-id') || '',
    req.get('x-claude-code-parent-agent-id') || '',
  ].join('\x1f');
}

function rememberToolCallReasoning(cache, key, reasoningContent) {
  if (!key || typeof reasoningContent !== 'string' || reasoningContent === '') {
    return;
  }

  if (cache.has(key)) {
    cache.delete(key);
  }
  cache.set(key, reasoningContent);

  while (cache.size > TOOL_REASONING_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
}

function openAiCompatibleTranslationOptions(req, route, toolReasoningCache) {
  if (!preservesOpenAiReasoningContent(route)) {
    return {};
  }

  const cacheNamespace = toolReasoningCacheNamespace(req);
  function cacheKey(toolCallId) {
    return `${cacheNamespace}\x1f${toolCallId}`;
  }

  return {
    preserveAssistantThinking: true,
    providerLabel: route.providerLabel,
    emitReasoningContent: route.emitReasoningContent === true,
    strictThinkingReplay: route.strictThinkingReplay === true,
    reasoningContentForToolCall(toolCallId) {
      if (!toolCallId) {
        return '';
      }
      return toolReasoningCache.get(cacheKey(toolCallId)) || '';
    },
    recordToolCallReasoning(toolCallId, reasoningContent) {
      if (!toolCallId) {
        return;
      }
      rememberToolCallReasoning(
        toolReasoningCache,
        cacheKey(toolCallId),
        reasoningContent
      );
    },
  };
}

function matchesGatewaySharedSecret(value, config) {
  return secretsEqual(value, config.sharedSecret);
}

function isCredentialLikeAnthropicHeader(name) {
  return (
    name === 'anthropic-api-key' ||
    name === 'anthropic-authorization' ||
    CREDENTIAL_LIKE_HEADER_PATTERN.test(name)
  );
}

function connectionScopedHeaderNames(req) {
  const connection = req.headers?.connection;
  const values = Array.isArray(connection) ? connection : [connection];
  return new Set(
    values
      .filter((value) => typeof value === 'string')
      .flatMap((value) => value.split(','))
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  );
}

function isSafeAnthropicIdentityHeader(name, connectionScopedHeaders) {
  if (
    BLOCKED_FORWARD_HEADERS.has(name) ||
    connectionScopedHeaders.has(name) ||
    isCredentialLikeAnthropicHeader(name)
  ) {
    return false;
  }

  return (
    SAFE_ANTHROPIC_IDENTITY_HEADERS.has(name) ||
    name.startsWith('anthropic-') ||
    name.startsWith('x-claude-code-') ||
    name.startsWith('x-stainless-')
  );
}

function copyAnthropicClientIdentityHeaders(req, headers) {
  const connectionScopedHeaders = connectionScopedHeaderNames(req);
  for (const [name, value] of Object.entries(req.headers || {})) {
    if (!isSafeAnthropicIdentityHeader(name, connectionScopedHeaders)) {
      continue;
    }

    if (typeof value === 'string') {
      headers[name] = value;
      continue;
    }
    if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      headers[name] = value.join(', ');
    }
  }
}

function forwardedAnthropicCredential(req, config) {
  const authorization = req.get('authorization');
  if (authorization?.startsWith('Bearer ')) {
    const bearerToken = authorization.slice('Bearer '.length);
    if (!matchesGatewaySharedSecret(bearerToken, config)) {
      return {
        headerName: 'authorization',
        headerValue: authorization,
      };
    }
  }

  const apiKey = req.get('x-api-key');
  if (
    typeof apiKey === 'string' &&
    apiKey !== '' &&
    !matchesGatewaySharedSecret(apiKey, config)
  ) {
    return {
      headerName: 'x-api-key',
      headerValue: apiKey,
    };
  }

  return null;
}

function createAnthropicCompatibleHeaders(config, req, route) {
  const providerConfig = anthropicCompatibleProviderConfig(config, route);
  const headers = upstreamHeaders();

  copyAnthropicClientIdentityHeaders(req, headers);
  if (!headers['anthropic-version']) {
    headers['anthropic-version'] = providerConfig.version;
  }

  if (route.upstreamAuth === 'x-api-key') {
    headers['x-api-key'] = providerConfig.apiKey;
  } else {
    const forwardedCredential = forwardedAnthropicCredential(req, config);
    if (forwardedCredential) {
      headers[forwardedCredential.headerName] = forwardedCredential.headerValue;
    } else if (config.anthropic.apiKey) {
      headers['x-api-key'] = config.anthropic.apiKey;
    } else {
      throw new GatewayError(
        401,
        'authentication_error',
        'Anthropic passthrough requires inbound Claude credentials or ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY / ANTHROPIC_API_KEY'
      );
    }
  }

  return headers;
}

function anthropicCompatibleRequestUrl(baseUrl, relativePath, req) {
  const url = gatewayUrl(baseUrl, relativePath);
  const inboundUrl = new URL(req.originalUrl || req.url || '/', 'http://gateway.local');
  url.search = inboundUrl.search;
  return url;
}

function anthropicCompatibleRequestBody(requestBody, route, stream) {
  const body = {
    ...requestBody,
    model: route.upstreamModel,
    ...(stream ? { stream: true } : {}),
  };

  if (route.requestPolicy === 'kimi') {
    const outputConfig =
      requestBody?.output_config &&
      typeof requestBody.output_config === 'object' &&
      !Array.isArray(requestBody.output_config)
        ? requestBody.output_config
        : {};
    const thinking =
      requestBody?.thinking &&
      typeof requestBody.thinking === 'object' &&
      !Array.isArray(requestBody.thinking)
        ? requestBody.thinking
        : null;
    // Stock Claude Code sends adaptive thinking to K3. Preserve that known
    // compatible shape (and any explicit enabled budget); only replace a
    // missing/disabled value so the route cannot silently fall back from K3.
    body.thinking =
      thinking && thinking.type !== 'disabled' ? { ...thinking } : { type: 'adaptive' };
    body.output_config = {
      ...outputConfig,
      effort: route.reasoningEffort || 'max',
    };
  }

  return body;
}

function anthropicCompatibleProviderConfig(config, route) {
  return config[route.providerConfigKey || route.provider] || config.anthropic;
}

async function proxyAnthropicCompatibleJson(req, res, config, route, signal) {
  const providerConfig = anthropicCompatibleProviderConfig(config, route);
  const url = anthropicCompatibleRequestUrl(providerConfig.baseUrl, 'v1/messages', req);
  const upstream = await postJson(
    url,
    createAnthropicCompatibleHeaders(config, req, route),
    anthropicCompatibleRequestBody(req.body, route, false),
    signal
  );

  const body = await safeJson(upstream);
  copyUpstreamResponseHeaders(upstream, res);
  res.status(upstream.status).json(body);
}

async function proxyAnthropicCompatibleStream(req, res, config, route, signal) {
  const providerConfig = anthropicCompatibleProviderConfig(config, route);
  const url = anthropicCompatibleRequestUrl(providerConfig.baseUrl, 'v1/messages', req);
  const upstream = await postJson(
    url,
    createAnthropicCompatibleHeaders(config, req, route),
    anthropicCompatibleRequestBody(req.body, route, true),
    signal
  );

  const upstreamContentType = upstream.headers.get('content-type') || '';
  const isSseResponse =
    /^text\/event-stream(?:\s*;|\s*$)/iu.test(upstreamContentType) ||
    (upstream.ok && upstreamContentType === '');

  res.status(upstream.status);
  copyUpstreamResponseHeaders(upstream, res, { preserveContentType: true });
  if (isSseResponse && !upstreamContentType) {
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  }
  if (isSseResponse) {
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('connection', 'keep-alive');
    res.flushHeaders?.();
  }

  if (!upstream.body) {
    res.end();
    return;
  }

  try {
    if (isSseResponse) {
      await relaySseWithKeepalive(
        upstream.body,
        res,
        signal,
        configuredSseKeepaliveIntervalMs(config)
      );
      res.end();
      return;
    }

    for await (const chunk of upstream.body) {
      await writeResponseChunk(res, chunk);
    }
  } catch (error) {
    throw normalizeAbortError(error, signal);
  }
  res.end();
}

function configuredSseKeepaliveIntervalMs(config) {
  const configured = Number(config?.sseKeepaliveIntervalMs);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(1, Math.trunc(configured));
  }
  return DEFAULT_SSE_KEEPALIVE_INTERVAL_MS;
}

function nextSseFrame(buffer) {
  const boundary = /(?:\r\n|\r|\n){2}/u.exec(buffer);
  if (!boundary) {
    return null;
  }

  const end = boundary.index + boundary[0].length;
  return {
    frame: buffer.slice(0, end),
    rest: buffer.slice(end),
  };
}

async function relaySseWithKeepalive(body, res, signal, keepaliveIntervalMs) {
  const decoder = new TextDecoder();
  let buffered = '';
  let closed = false;
  let heartbeatPending = false;
  let lastWriteAt = Date.now();
  let writeFailure = null;
  let writeChain = Promise.resolve();

  function queueWrite(chunk) {
    const operation = writeChain.then(async function writeQueuedChunk() {
      if (writeFailure) {
        throw writeFailure;
      }
      await writeResponseChunk(res, chunk);
      lastWriteAt = Date.now();
    });
    writeChain = operation.catch(function rememberWriteFailure(error) {
      writeFailure ||= error;
    });
    return operation;
  }

  const heartbeat = setInterval(function emitSseKeepalive() {
    if (
      closed ||
      heartbeatPending ||
      writeFailure ||
      Date.now() - lastWriteAt < keepaliveIntervalMs
    ) {
      return;
    }

    heartbeatPending = true;
    void queueWrite(SSE_KEEPALIVE_CHUNK)
      .catch(function ignoreHeartbeatWriteFailure() {
        // The queued failure is surfaced by the relay or the request abort.
      })
      .finally(function markHeartbeatComplete() {
        heartbeatPending = false;
      });
  }, keepaliveIntervalMs);
  heartbeat.unref?.();

  function stopHeartbeat() {
    if (closed) {
      return;
    }
    closed = true;
    clearInterval(heartbeat);
  }

  function stopHeartbeatOnAbort() {
    stopHeartbeat();
  }

  signal?.addEventListener('abort', stopHeartbeatOnAbort, { once: true });
  try {
    for await (const chunk of body) {
      buffered += decoder.decode(chunk, { stream: true });
      let frame = nextSseFrame(buffered);
      while (frame) {
        buffered = frame.rest;
        await queueWrite(frame.frame);
        frame = nextSseFrame(buffered);
      }
    }

    buffered += decoder.decode();
    stopHeartbeat();
    if (buffered) {
      await queueWrite(buffered);
    }
    await writeChain;
    if (writeFailure) {
      throw writeFailure;
    }
  } catch (error) {
    stopHeartbeat();
    throw normalizeAbortError(writeFailure || error, signal);
  } finally {
    stopHeartbeat();
    signal?.removeEventListener('abort', stopHeartbeatOnAbort);
  }
}

async function writeResponseChunk(res, chunk) {
  if (res.destroyed) {
    throw new GatewayError(499, 'api_error', 'response stream closed before write completed');
  }

  if (res.write(chunk)) {
    return;
  }

  await new Promise(function waitForDrain(resolve, reject) {
    function cleanup() {
      res.off('drain', onDrain);
      res.off('close', onClose);
      res.off('error', onError);
    }

    function onDrain() {
      cleanup();
      resolve();
    }

    function onClose() {
      cleanup();
      reject(new GatewayError(499, 'api_error', 'response stream closed before drain'));
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onError);
  });
}

export async function writeSseEvent(res, event, data) {
  const eventLine = event ? `event: ${event}\n` : '';
  await writeResponseChunk(res, `${eventLine}data: ${JSON.stringify(data)}\n\n`);
}

async function writeSseErrorAndClose(res, errorBody) {
  try {
    await writeSseEvent(res, 'error', errorBody);
  } catch {
    // Best effort only; the socket may already be closing.
  }
  res.end();
}

function responseUsesSseFraming(res) {
  const contentType = String(res.getHeader('content-type') || '').toLowerCase();
  return /^text\/event-stream(?:\s*;|\s*$)/u.test(contentType);
}

function summarizeMessageRoles(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages.map(function pickRole(message) {
    return message?.role || 'unknown';
  });
}

function summarizeToolNames(tools) {
  if (!Array.isArray(tools)) {
    return [];
  }

  return tools
    .map(function pickToolName(tool) {
      return tool?.name || '';
    })
    .filter(Boolean);
}

function summarizeToolResults(messages) {
  if (!Array.isArray(messages)) {
    return {
      count: 0,
      ids: [],
    };
  }

  const toolResultIds = [];
  for (const message of messages) {
    const blocks = Array.isArray(message?.content) ? message.content : [];
    for (const block of blocks) {
      if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string' && block.tool_use_id) {
        toolResultIds.push(block.tool_use_id);
      }
    }
  }

  return {
    count: toolResultIds.length,
    ids: toolResultIds.slice(-16),
  };
}

export function summarizeRequestBody(requestBody) {
  const toolResults = summarizeToolResults(requestBody?.messages);
  return {
    model: requestBody?.model || null,
    stream: requestBody?.stream === true,
    max_tokens: requestBody?.max_tokens || null,
    message_count: Array.isArray(requestBody?.messages) ? requestBody.messages.length : 0,
    message_roles: summarizeMessageRoles(requestBody?.messages),
    tool_names: summarizeToolNames(requestBody?.tools),
    tool_result_count: toolResults.count,
    tool_result_ids: toolResults.ids,
    system_present: requestBody?.system !== undefined && requestBody?.system !== null,
  };
}

function summarizeRoute(route) {
  return {
    provider: route.provider,
    requested_model: route.requestedModel,
    upstream_model: route.upstreamModel,
    sandbox: route.sandbox || null,
    approval_policy: route.approvalPolicy || null,
    reasoning_effort: route.reasoningEffort || null,
    verbosity: route.verbosity || null,
  };
}

function routedResponseModel(route) {
  const effort = route.reasoningEffort ? `/${route.reasoningEffort}` : '';
  return `${route.provider}:${route.upstreamModel}${effort} via ${route.requestedModel}`;
}

function responseModelForRoute(config, route) {
  if (!config.displayRoutedModel || route.provider === 'anthropic') {
    return route.requestedModel;
  }

  return routedResponseModel(route);
}

function summarizeGatewayHeaders(req) {
  return {
    claude_session_id: req.get('x-claude-code-session-id') || null,
    claude_agent_id: req.get('x-claude-code-agent-id') || null,
    claude_parent_agent_id: req.get('x-claude-code-parent-agent-id') || null,
  };
}

export function summarizeGatewayTraceContext(req, route = null) {
  return {
    ...summarizeGatewayHeaders(req),
    provider: route?.provider || null,
    requested_model: route?.requestedModel || null,
    upstream_model: route?.upstreamModel || null,
    sandbox: route?.sandbox || null,
    approval_policy: route?.approvalPolicy || null,
  };
}

function summarizeError(error) {
  return {
    error_name: error?.name || null,
    error_message: error?.message || 'unknown error',
    gateway_error_type: error?.type || null,
    gateway_error_status: error?.status || null,
  };
}

function isClientAbortError(error) {
  return error instanceof GatewayError && error.status === 499;
}

function createStreamState(requestedModel, fallbackId) {
  return {
    messageId: fallbackId,
    requestedModel,
    messageStarted: false,
    reasoningBlockStarted: false,
    textBlockStarted: false,
    textBlockIndex: 0,
    toolCalls: new Map(),
    reasoningContent: '',
    finishReason: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
    },
  };
}

async function ensureMessageStarted(res, state) {
  if (!state.messageStarted) {
    await writeSseEvent(res, 'message_start', {
      type: 'message_start',
      message: {
        id: state.messageId,
        type: 'message',
        role: 'assistant',
        model: state.requestedModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: state.usage,
      },
    });
    state.messageStarted = true;
  }
}

async function ensureReasoningBlockStarted(res, state) {
  await ensureMessageStarted(res, state);
  if (state.reasoningBlockStarted) {
    return;
  }
  await closeTextBlock(res, state);

  await writeSseEvent(res, 'content_block_start', {
    type: 'content_block_start',
    index: state.textBlockIndex,
    content_block: {
      type: 'thinking',
      thinking: '',
      signature: '',
    },
  });
  state.reasoningBlockStarted = true;
}

async function closeReasoningBlock(res, state) {
  if (!state.reasoningBlockStarted) {
    return;
  }

  await writeSseEvent(res, 'content_block_stop', {
    type: 'content_block_stop',
    index: state.textBlockIndex,
  });
  state.reasoningBlockStarted = false;
  state.textBlockIndex += 1;
}

async function ensureTextBlockStarted(res, state) {
  await ensureMessageStarted(res, state);
  await closeReasoningBlock(res, state);

  if (state.textBlockStarted) {
    return;
  }

  await writeSseEvent(res, 'content_block_start', {
    type: 'content_block_start',
    index: state.textBlockIndex,
    content_block: {
      type: 'text',
      text: '',
    },
  });
  state.textBlockStarted = true;
}

function bufferToolCallDelta(toolCallDeltas, toolCalls) {
  for (const toolCall of toolCallDeltas) {
    const index = toolCall.index ?? 0;
    const existing = toolCalls.get(index) || {
      id: toolCall.id || '',
      name: '',
      arguments: '',
    };

    if (toolCall.id) {
      existing.id = toolCall.id;
    }
    if (toolCall.function?.name) {
      existing.name = toolCall.function.name;
    }
    if (toolCall.function?.arguments) {
      existing.arguments += toolCall.function.arguments;
    }

    toolCalls.set(index, existing);
  }
}

function recordStreamingToolCallReasoning(state, translationOptions) {
  if (!state.reasoningContent) {
    return;
  }

  for (const toolCall of state.toolCalls.values()) {
    translationOptions.recordToolCallReasoning?.(toolCall.id, state.reasoningContent);
  }
}

async function closeTextBlock(res, state) {
  if (!state.textBlockStarted) {
    return;
  }
  await writeSseEvent(res, 'content_block_stop', {
    type: 'content_block_stop',
    index: state.textBlockIndex,
  });
  state.textBlockStarted = false;
  state.textBlockIndex += 1;
}

async function flushToolUses(res, state) {
  const sortedToolCalls = Array.from(state.toolCalls.entries()).sort(function sortByIndex(
    left,
    right
  ) {
    return left[0] - right[0];
  });

  for (const [index, toolCall] of sortedToolCalls) {
    let input = {};
    if (toolCall.arguments) {
      try {
        input = JSON.parse(toolCall.arguments);
      } catch (error) {
        throw new GatewayError(
          502,
          'api_error',
          `upstream returned invalid tool arguments for ${toolCall.name || toolCall.id || index}`
        );
      }
    }

    const contentIndex = state.textBlockIndex + index;
    const serializedInput = JSON.stringify(input);
    await writeSseEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index: contentIndex,
      content_block: {
        type: 'tool_use',
        id: toolCall.id || `toolu_${index}`,
        name: toolCall.name || 'unknown_tool',
        input: {},
      },
    });
    await writeSseEvent(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: contentIndex,
      delta: {
        type: 'input_json_delta',
        partial_json: serializedInput,
      },
    });
    await writeSseEvent(res, 'content_block_stop', {
      type: 'content_block_stop',
      index: contentIndex,
    });
  }
}

function assertOpenAiCompletion(route, finishReason) {
  if (route.strictCompletion && !['stop', 'length', 'tool_calls'].includes(finishReason)) {
    throw new GatewayError(502, 'api_error', `${openAiCompatibleProviderLabel(route)} returned an incomplete or unsuccessful completion (finish_reason: ${String(finishReason).slice(0, 80)})`);
  }
}

function assertOpenAiToolCompletion(route, finishReason, tools) {
  if (!route.strictCompletion) return;
  assertOpenAiCompletion(route, finishReason);
  if ((tools.length > 0) !== (finishReason === 'tool_calls')) {
    throw new GatewayError(502, 'api_error', `${openAiCompatibleProviderLabel(route)} returned tool calls inconsistent with its finish reason`);
  }
  // Validate the entire batch before exposing any executable tool to Claude.
  for (const tool of tools) {
    let input;
    try { input = JSON.parse(tool.arguments); } catch { /* Rejected below. */ }
    if (!tool.id || !tool.name || !input || typeof input !== 'object' || Array.isArray(input)) {
      throw new GatewayError(502, 'api_error', `${openAiCompatibleProviderLabel(route)} returned an incomplete tool call or invalid tool arguments`);
    }
  }
}

async function streamOpenAiAsAnthropic(req, res, config, route, signal, toolReasoningCache) {
  const translationOptions = openAiCompatibleTranslationOptions(req, route, toolReasoningCache);
  const requestBody = translateAnthropicMessagesRequestWithOptions(
    req.body,
    route,
    translationOptions
  );
  const providerConfig = openAiCompatibleConfig(config, route);
  const url = gatewayUrl(providerConfig.baseUrl, 'chat/completions');
  const upstream = await postJson(
    url,
    createOpenAiCompatibleHeaders(config, route),
    requestBody,
    signal
  );
  copyUpstreamResponseHeaders(upstream, res);

  if (!upstream.ok) {
    const body = await safeJson(upstream);
    res.status(upstream.status).json({
      type: 'error',
      error: {
        type: body?.error?.type || 'api_error',
        message:
          body?.error?.message ||
          `${openAiCompatibleProviderLabel(route)} upstream returned HTTP ${upstream.status}`,
      },
    });
    return;
  }

  res.status(200);
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('connection', 'keep-alive');

  const state = createStreamState(responseModelForRoute(config, route), `msg_${Date.now()}`);
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for await (const chunk of upstream.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/u);
      buffer = events.pop() || '';

      for (const event of events) {
        let dataLines = event
          .split('\n')
          .filter(function pickData(line) {
            return line.startsWith(route.strictCompletion ? 'data:' : 'data: ');
          })
          .map(function stripPrefix(line) {
            return line.slice('data:'.length).replace(/^ /u, '').replace(/\r$/u, '');
          });
        if (route.strictCompletion && dataLines.length) dataLines = [dataLines.join('\n')];

        for (const dataLine of dataLines) {
          if (dataLine === '[DONE]') {
            assertOpenAiToolCompletion(route, state.finishReason, Array.from(state.toolCalls.values()));
            await closeReasoningBlock(res, state);
            await closeTextBlock(res, state);
            await ensureTextBlockStartedNoText(res, state);
            recordStreamingToolCallReasoning(state, translationOptions);
            await flushToolUses(res, state);
            await writeSseEvent(res, 'message_delta', {
              type: 'message_delta',
              delta: {
                stop_reason: mapOpenAiFinishReason(state.finishReason),
                stop_sequence: null,
              },
              usage: state.usage,
            });
            await writeSseEvent(res, 'message_stop', { type: 'message_stop' });
            res.end();
            return;
          }

          let payload = null;
          try {
            payload = JSON.parse(dataLine);
          } catch {
            if (route.strictCompletion) {
              throw new GatewayError(502, 'api_error', `${openAiCompatibleProviderLabel(route)} returned malformed stream JSON`);
            }
            continue;
          }
          if (route.strictCompletion && (!payload || typeof payload !== 'object' || payload.error)) {
            throw new GatewayError(502, 'api_error', `${openAiCompatibleProviderLabel(route)} returned an upstream stream error`);
          }
          if (!state.messageId && payload.id) {
            state.messageId = payload.id;
          }
          if (payload.usage) {
            state.usage = openAiUsageToAnthropicUsage(payload.usage);
          }

          const choice = payload.choices?.[0];
          if (!choice) {
            continue;
          }
          if (choice.finish_reason) {
            assertOpenAiCompletion(route, choice.finish_reason);
            state.finishReason = choice.finish_reason;
          }
          if (choice.delta?.reasoning_content) {
            state.reasoningContent += choice.delta.reasoning_content;
            if (translationOptions.emitReasoningContent) {
              await ensureReasoningBlockStarted(res, state);
              await writeSseEvent(res, 'content_block_delta', {
                type: 'content_block_delta',
                index: state.textBlockIndex,
                delta: {
                  type: 'thinking_delta',
                  thinking: choice.delta.reasoning_content,
                },
              });
            }
          }

          if (choice.delta?.content) {
            await ensureTextBlockStarted(res, state);
            await writeSseEvent(res, 'content_block_delta', {
              type: 'content_block_delta',
              index: state.textBlockIndex,
              delta: {
                type: 'text_delta',
                text: choice.delta.content,
              },
            });
          }

          if (Array.isArray(choice.delta?.tool_calls)) {
            await ensureTextBlockStartedNoText(res, state);
            bufferToolCallDelta(choice.delta.tool_calls, state.toolCalls);
          }
        }
      }
    }
  } catch (error) {
    throw normalizeAbortError(error, signal);
  }

  if (route.strictCompletion) {
    throw new GatewayError(502, 'api_error', `${openAiCompatibleProviderLabel(route)} stream ended before its [DONE] marker; the response is incomplete`);
  }
  await closeReasoningBlock(res, state);
  await closeTextBlock(res, state);
  await ensureTextBlockStartedNoText(res, state);
  recordStreamingToolCallReasoning(state, translationOptions);
  await flushToolUses(res, state);
  await writeSseEvent(res, 'message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: mapOpenAiFinishReason(state.finishReason),
      stop_sequence: null,
    },
    usage: state.usage,
  });
  await writeSseEvent(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

async function ensureTextBlockStartedNoText(res, state) {
  await ensureMessageStarted(res, state);
}

function codexOutcomeTextBlocks(text) {
  if (typeof text !== 'string' || text === '') {
    return [];
  }

  return [
    {
      type: 'text',
      text,
    },
  ];
}

function normalizeCodexUsage(usage) {
  const nextUsage = usage || {
    input_tokens: 0,
    output_tokens: 0,
  };
  const normalized = {
    input_tokens: nextUsage.input_tokens || 0,
    output_tokens: nextUsage.output_tokens || 0,
  };

  if (Number(nextUsage.cache_read_input_tokens) > 0) {
    normalized.cache_read_input_tokens = nextUsage.cache_read_input_tokens;
  }
  if (Number(nextUsage.cache_write_input_tokens) > 0) {
    normalized.cache_creation_input_tokens = nextUsage.cache_write_input_tokens;
  }

  return normalized;
}

function usageValue(usage, key) {
  return usage?.[key] || 0;
}

function sameUsage(left, right) {
  return (
    usageValue(left, 'input_tokens') === usageValue(right, 'input_tokens') &&
    usageValue(left, 'output_tokens') === usageValue(right, 'output_tokens') &&
    usageValue(left, 'cache_read_input_tokens') ===
      usageValue(right, 'cache_read_input_tokens') &&
    usageValue(left, 'cache_creation_input_tokens') ===
      usageValue(right, 'cache_creation_input_tokens')
  );
}

function codexOutcomeToAnthropic(outcome, requestedModel) {
  const content = [...codexOutcomeTextBlocks(outcome.text)];
  if (outcome.type === 'tool_use') {
    content.push({
      type: 'tool_use',
      id: outcome.toolCall.id,
      name: outcome.toolCall.name,
      input: outcome.toolCall.input || {},
    });
  }

  return {
    id: outcome.toolCall?.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content,
    stop_reason: outcome.type === 'tool_use' ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: normalizeCodexUsage(outcome.usage),
  };
}

function streamCodexResponse(
  req,
  res,
  signal,
  requestedModel,
  codexSessions,
  route,
  requestTracer
) {
  const state = createStreamState(requestedModel, `msg_${Date.now()}`);
  let emittedUsage = null;
  let closed = false;
  let eventFailure = null;
  let eventChain = Promise.resolve();
  let notifyEventFailure = null;
  const eventFailureReady = new Promise(function waitForEventFailure(resolve) {
    notifyEventFailure = resolve;
  });
  const heartbeat = setInterval(function emitPing() {
    if (closed) {
      return;
    }
    void writeSseEvent(res, 'ping', { type: 'ping' }).catch(function stopOnPingFailure() {
      closed = true;
      stopHeartbeat();
    });
  }, 10_000);
  heartbeat.unref?.();

  function stopHeartbeat() {
    clearInterval(heartbeat);
  }

  if (signal) {
    signal.addEventListener(
      'abort',
      function markClosed() {
        closed = true;
        stopHeartbeat();
      },
      { once: true }
    );
  }

  res.status(200);
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('connection', 'keep-alive');
  res.on('close', stopHeartbeat);
  res.on('finish', stopHeartbeat);

  async function writeUsageDelta(usage, stopReason = null) {
    if (closed) {
      return;
    }

    state.usage = normalizeCodexUsage(usage);
    const unchanged = emittedUsage && sameUsage(emittedUsage, state.usage);
    if (stopReason === null && unchanged) {
      return;
    }

    emittedUsage = state.usage;
    await ensureTextBlockStartedNoText(res, state);
    await writeSseEvent(res, 'message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: stopReason,
        stop_sequence: null,
      },
      usage: state.usage,
    });
  }

  async function writeToolUse(toolCall, usage) {
    if (closed) {
      return;
    }

    state.usage = normalizeCodexUsage(usage);
    await closeTextBlock(res, state);
    await ensureTextBlockStartedNoText(res, state);
    const toolBlockIndex = state.textBlockIndex;
    await writeSseEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index: toolBlockIndex,
      content_block: {
        type: 'tool_use',
        id: toolCall.id,
        name: toolCall.name,
        input: {},
      },
    });
    await writeSseEvent(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: toolBlockIndex,
      delta: {
        type: 'input_json_delta',
        partial_json: JSON.stringify(toolCall.input || {}),
      },
    });
    await writeSseEvent(res, 'content_block_stop', {
      type: 'content_block_stop',
      index: toolBlockIndex,
    });
    await writeUsageDelta(usage, 'tool_use');
    await writeSseEvent(res, 'message_stop', { type: 'message_stop' });
    res.end();
    closed = true;
    stopHeartbeat();
  }

  async function writeFinal(usage) {
    if (closed) {
      return;
    }

    state.usage = normalizeCodexUsage(usage);
    await closeTextBlock(res, state);
    await ensureTextBlockStartedNoText(res, state);
    await writeUsageDelta(usage, 'end_turn');
    await writeSseEvent(res, 'message_stop', { type: 'message_stop' });
    res.end();
    closed = true;
    stopHeartbeat();
  }

  async function handleCodexEvent(event) {
    if (closed) {
      return;
    }

    if (event.type === 'text_delta') {
      await ensureTextBlockStarted(res, state);
      await writeSseEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: state.textBlockIndex,
        delta: {
          type: 'text_delta',
          text: event.text,
        },
      });
      return;
    }

    if (event.type === 'usage') {
      await writeUsageDelta(event.usage, null);
      return;
    }

    if (event.type !== 'boundary') {
      return;
    }

    if (event.outcome.type === 'tool_use') {
      await writeToolUse(event.outcome.toolCall, event.outcome.usage);
      return;
    }

    await writeFinal(event.outcome.usage);
  }

  function recordEventFailure(error) {
    if (eventFailure) {
      return;
    }

    eventFailure = error;
    notifyEventFailure();
  }

  function enqueueCodexEvent(event) {
    const queued = eventChain.then(async function writeQueuedCodexEvent() {
      if (eventFailure) {
        return undefined;
      }

      return handleCodexEvent(event);
    });
    queued.catch(recordEventFailure);
    eventChain = queued.catch(function keepEventQueueSettled() {
      return undefined;
    });
    return queued;
  }

  async function flushCodexEvents() {
    await eventChain;
  }

  const streamResult = codexSessions
    .streamRequest(req, req.body, route, enqueueCodexEvent, requestTracer)
    .then(
      function streamSucceeded(value) {
        return { type: 'success', value };
      },
      function streamFailed(error) {
        return { type: 'failure', error };
      }
    );

  return Promise.race([
    streamResult,
    eventFailureReady.then(function eventWriteFailed() {
      return { type: 'event_failure' };
    }),
  ])
    .then(async function flushAndReturn(result) {
      await flushCodexEvents();
      if (eventFailure) {
        throw eventFailure;
      }
      if (result.type === 'failure') {
        throw result.error;
      }
      return result.value;
    })
    .finally(stopHeartbeat);
}

async function handleOpenAiJson(req, res, config, route, signal, toolReasoningCache) {
  const translationOptions = openAiCompatibleTranslationOptions(req, route, toolReasoningCache);
  const requestBody = translateAnthropicMessagesRequestWithOptions(
    req.body,
    route,
    translationOptions
  );
  const providerConfig = openAiCompatibleConfig(config, route);
  const url = gatewayUrl(providerConfig.baseUrl, 'chat/completions');
  const upstream = await postJson(
    url,
    createOpenAiCompatibleHeaders(config, route),
    requestBody,
    signal
  );
  copyUpstreamResponseHeaders(upstream, res);
  const body = await safeJson(upstream);

  if (!upstream.ok) {
    res.status(upstream.status).json({
      type: 'error',
      error: {
        type: body?.error?.type || 'api_error',
        message:
          body?.error?.message ||
          `${openAiCompatibleProviderLabel(route)} upstream returned HTTP ${upstream.status}`,
      },
    });
    return;
  }

  if (route.strictCompletion && (body?.error || !body?.choices?.[0]?.message)) {
    throw new GatewayError(502, 'api_error', `${openAiCompatibleProviderLabel(route)} returned an invalid completion`);
  }
  assertOpenAiCompletion(route, body?.choices?.[0]?.finish_reason);
  if (route.strictCompletion) {
    const choice = body.choices[0];
    const tools = choice.message.tool_calls;
    if (tools !== undefined && tools !== null && !Array.isArray(tools)) {
      throw new GatewayError(502, 'api_error', `${openAiCompatibleProviderLabel(route)} returned an invalid tool call list`);
    }
    assertOpenAiToolCompletion(route, choice.finish_reason, (tools || []).map((tool) => ({
      id: tool?.id, name: tool?.function?.name, arguments: tool?.function?.arguments,
    })));
  }
  res.json(translateOpenAiResponseToAnthropic(
    body,
    responseModelForRoute(config, route),
    body?.id,
    translationOptions
  ));
}

async function handleCodexJson(req, res, config, codexSessions, route, requestTracer) {
  const outcome = await codexSessions.processRequest(req, req.body, route, requestTracer);
  res.json(codexOutcomeToAnthropic(outcome, responseModelForRoute(config, route)));
}

async function handleCodexStream(req, res, config, codexSessions, route, signal, requestTracer) {
  await streamCodexResponse(
    req,
    res,
    signal,
    responseModelForRoute(config, route),
    codexSessions,
    route,
    requestTracer
  );
}

async function handleCountTokens(req, res, config, signal) {
  const route = resolveModelRoute(req.body?.model, config);
  switch (route.tokenCountPolicy) {
    case 'upstream': {
      const providerConfig = anthropicCompatibleProviderConfig(config, route);
      const url = anthropicCompatibleRequestUrl(
        providerConfig.baseUrl,
        'v1/messages/count_tokens',
        req
      );
      const upstream = await postJson(
        url,
        createAnthropicCompatibleHeaders(config, req, route),
        { ...req.body, model: route.upstreamModel },
        signal
      );
      const body = await safeJson(upstream);
      copyUpstreamResponseHeaders(upstream, res);
      res.status(upstream.status).json(body);
      return;
    }
    case 'estimate':
      res.json({
        input_tokens: estimateAnthropicInputTokens(req.body),
      });
      return;
    case 'conservative-estimate':
      res.json({
        input_tokens: estimateConservativeInputTokens(req.body),
      });
      return;
    default:
      throw new GatewayError(
        500,
        'api_error',
        `Unsupported token-count policy for gateway provider: ${route.provider}`
      );
  }
}

async function handleMessages(
  req,
  res,
  config,
  codexSessions,
  route,
  requestTracer,
  toolReasoningCache
) {
  const signal = withAbortSignal(req, res, config.requestTimeoutMs);
  req.abortSignal = signal;
  req.gatewayTracer = requestTracer;

  switch (route.transport) {
    case 'anthropic':
      if (req.body?.stream === true) {
        await proxyAnthropicCompatibleStream(req, res, config, route, signal);
        return route;
      }
      await proxyAnthropicCompatibleJson(req, res, config, route, signal);
      return route;
    case 'codex':
      if (!codexSessions) {
        throw new GatewayError(500, 'api_error', 'Codex session manager is not available');
      }

      if (req.body?.stream === true) {
        await handleCodexStream(req, res, config, codexSessions, route, signal, requestTracer);
        return route;
      }

      await handleCodexJson(req, res, config, codexSessions, route, requestTracer);
      return route;
    case 'openai':
      if (req.body?.stream === true) {
        await streamOpenAiAsAnthropic(req, res, config, route, signal, toolReasoningCache);
        return route;
      }
      await handleOpenAiJson(req, res, config, route, signal, toolReasoningCache);
      return route;
    default:
      throw new GatewayError(500, 'api_error', `Unsupported gateway provider: ${route.provider}`);
  }
}

export function createGatewayApp(config = loadGatewayConfig(), codexSessions = null, tracer = null) {
  assertGatewayBindIsSafe(config);
  const app = express();
  const toolReasoningCache = new Map();
  const requestLimits = requestLimitConfiguration(config);
  const credentialFailureRateLimiter = createCredentialFailureRateLimiter(
    config,
    requestLimits
  );
  const concurrentRequestLimiter = createConcurrentRequestLimiter(
    requestLimits.maxConcurrentRequests
  );
  const jsonBodyParser = express.json({ limit: CLAUDE_REQUEST_BODY_LIMIT_BYTES });

  app.use(credentialFailureRateLimiter);

  app.get('/healthz', function healthz(req, res) {
    const basicHealth = {
      ok: true,
      service: 'claude-workflow-gateway',
    };
    const mayExposeDiagnostics =
      isGatewayLoopbackHost(config.host) ||
      secretsEqual(authHeaderSecret(req), config.sharedSecret);
    if (!mayExposeDiagnostics) {
      res.json(basicHealth);
      return;
    }

    res.json({
      ...basicHealth,
      runtime_revision: config.runtimeRevision || null,
      runtime_started_at: config.runtimeStartedAt || null,
      runtime_pid: process.pid,
      trace_enabled: tracer?.enabled === true,
      trace_dir: tracer?.traceDir || config.traceDir || null,
      trace_file: tracer?.traceFilePath || null,
      trace_max_bytes: tracer?.traceMaxBytes ?? config.traceMaxBytes ?? null,
      trace_max_files: tracer?.traceMaxFiles ?? config.traceMaxFiles ?? null,
      trace_write_failed: Boolean(tracer?.lastError),
      auth_failure_rate_limit_window_ms: requestLimits.authFailureWindowMs,
      auth_failure_rate_limit_max_requests: requestLimits.authFailureMaxRequests,
      request_max_concurrent_requests: requestLimits.maxConcurrentRequests,
      request_active_operations: concurrentRequestLimiter.activeRequests(),
      codex_target_model: config.codex?.model || null,
      codex_sandbox: config.codex?.sandbox || null,
      codex_approval_policy: config.codex?.approvalPolicy || null,
      codex_reasoning_effort: config.codex?.reasoningEffort || null,
      codex_verbosity: config.codex?.verbosity || null,
      codex_enabled: Boolean(config.codex?.enabled),
      codex_input_max_tokens: config.codex?.inputMaxTokens ?? null,
      codex_tool_result_max_bytes: config.codex?.toolResultMaxBytes ?? null,
      codex_tool_result_window_max_bytes: config.codex?.toolResultWindowMaxBytes ?? null,
      codex_context_profile:
        config.codex?.capabilities?.profile || config.codex?.contextProfile || null,
      codex_context_source: config.codex?.capabilities?.source || null,
      codex_requested_raw_context_tokens:
        config.codex?.capabilities?.requestedRawContextTokens ?? null,
      codex_resolved_raw_context_tokens:
        config.codex?.capabilities?.resolvedRawContextTokens ?? null,
      codex_usable_context_tokens:
        config.codex?.capabilities?.usableContextTokens ?? null,
      codex_native_auto_compact_tokens:
        config.codex?.capabilities?.autoCompactTokens ?? null,
      codex_gateway_input_budget_tokens:
        config.codex?.capabilities?.inputBudgetTokens ?? null,
      codex_max_raw_context_tokens:
        config.codex?.capabilities?.maxRawContextTokens ?? null,
      codex_auto_compact_token_limit: config.codex?.autoCompactTokenLimit ?? null,
      codex_auto_compact_token_limit_scope:
        Number(config.codex?.autoCompactTokenLimit || 0) > 0
          ? config.codex?.autoCompactTokenLimitScope || null
          : null,
      openai_model: config.openai?.model || null,
      openai_reasoning_effort: config.openai?.reasoningEffort || null,
      deepseek_model: config.deepseek?.model || null,
      deepseek_reasoning_effort: config.deepseek?.reasoningEffort || null,
      deepseek_thinking: config.deepseek?.thinking?.type || null,
      deepseek_context_tokens: config.deepseek?.contextTokens ?? null,
      deepseek_max_output_tokens: config.deepseek?.maxOutputTokens ?? null,
      deepseek_key_configured: Boolean(config.deepseek?.apiKey),
      glm_model: config.glm?.model || null,
      glm_reasoning_effort: config.glm?.reasoningEffort || null,
      glm_thinking: config.glm?.thinking?.type || null,
      kimi_model: config.kimi?.model || null,
      kimi_reasoning_effort: config.kimi?.reasoningEffort || null,
      kimi_context_tokens: config.kimi?.contextTokens ?? null,
      kimi_key_configured: Boolean(config.kimi?.apiKey),
      qwen_model: config.qwen?.model || null,
      qwen_reasoning_effort: config.qwen?.reasoningEffort || null,
      qwen_total_context_tokens: config.qwen?.totalContextTokens ?? null,
      qwen_input_ceiling_tokens: config.qwen?.contextTokens ?? null,
      // Retain the original field for integrations that already consume it.
      qwen_context_tokens: config.qwen?.contextTokens ?? null,
      qwen_max_output_tokens: config.qwen?.maxOutputTokens ?? null,
      qwen_key_configured: Boolean(config.qwen?.apiKey),
      anthropic_passthrough_enabled:
        Array.isArray(config.anthropicPassthroughModels) &&
        config.anthropicPassthroughModels.length > 0,
      anthropic_passthrough_models: config.anthropicPassthroughModels || [],
      exposed_models: config.exposedModels || [],
      display_routed_model: Boolean(config.displayRoutedModel),
    });
  });

  app.use('/v1', requireGatewayAuth(config));

  app.get('/v1/models', function listModels(req, res) {
    res.json({
      object: 'list',
      data: listGatewayModels(config),
    });
  });

  app.post(
    '/v1/messages/count_tokens',
    concurrentRequestLimiter,
    jsonBodyParser,
    jsonBodyErrorHandler,
    async function countTokens(req, res) {
      try {
        await handleCountTokens(
          req,
          res,
          config,
          withAbortSignal(req, res, config.requestTimeoutMs)
        );
      } catch (error) {
        const formatted = formatAnthropicError(error);
        res.status(formatted.status).json(formatted.body);
      }
    }
  );

  app.post(
    '/v1/messages',
    concurrentRequestLimiter,
    jsonBodyParser,
    jsonBodyErrorHandler,
    async function messages(req, res) {
      const requestTracer =
        tracer?.scope?.({
          request_id: tracer.createId?.() || `${Date.now()}`,
        }) || null;

      requestTracer?.log?.('gateway.request.received', {
        headers: summarizeGatewayHeaders(req),
        request: summarizeRequestBody(req.body),
      });

      let route = null;

      try {
        route = resolveModelRoute(req.body?.model, config);
        requestTracer?.log?.('gateway.route.resolved', {
          ...summarizeGatewayTraceContext(req, route),
          route: summarizeRoute(route),
          response_model: responseModelForRoute(config, route),
        });

        await handleMessages(
          req,
          res,
          config,
          codexSessions,
          route,
          requestTracer,
          toolReasoningCache
        );
        requestTracer?.log?.('gateway.request.completed', {
          ...summarizeGatewayTraceContext(req, route),
          status_code: res.statusCode,
          headers_sent: res.headersSent,
          finished: res.writableEnded,
        });
      } catch (error) {
        requestTracer?.log?.(
          isClientAbortError(error) ? 'gateway.request.aborted' : 'gateway.request.failed',
          {
            ...summarizeGatewayTraceContext(req, route),
            ...summarizeError(error),
          }
        );

        if (isClientAbortError(error) && (req.destroyed || res.destroyed)) {
          return;
        }

        const formatted = formatAnthropicError(error);
        if (!res.headersSent) {
          res.status(formatted.status).json(formatted.body);
          return;
        }
        if (req.body?.stream === true && responseUsesSseFraming(res)) {
          await writeSseErrorAndClose(res, formatted.body);
          return;
        }
        // A streaming request may receive a regular JSON response from an
        // Anthropic-compatible upstream. Once those headers are committed we
        // cannot replace or extend that body with an SSE error frame. Close the
        // transport so the client observes a truncated response and can retry.
        res.destroy();
      }
    }
  );

  return app;
}

export function createGatewayServer(config = loadGatewayConfig()) {
  const tracer = createGatewayTracer(config);
  const codexSessions = new CodexSessionManager(config, { tracer });
  const app = createGatewayApp(config, codexSessions, tracer);
  const server = app.listen(config.port, config.host);
  let closePromise = null;

  return {
    app,
    server,
    config,
    tracer,
    async close() {
      if (closePromise) {
        return closePromise;
      }

      closePromise = (async function closeRuntime() {
        let closeError = null;
        try {
          await new Promise(function stopListening(resolve, reject) {
            try {
              server.close(function onClose(error) {
                if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') {
                  reject(error);
                  return;
                }
                resolve();
              });
              server.closeAllConnections?.();
            } catch (error) {
              if (error?.code === 'ERR_SERVER_NOT_RUNNING') {
                resolve();
                return;
              }
              reject(error);
            }
          });
        } catch (error) {
          closeError = error;
        } finally {
          await Promise.allSettled([codexSessions.close(), tracer.close()]);
        }

        if (closeError) {
          throw closeError;
        }
      })();

      return closePromise;
    },
  };
}
