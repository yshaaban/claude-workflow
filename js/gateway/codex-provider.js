import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

import { environmentWithoutGatewayAndAnthropicCredentials } from '../utils/child-env.js';
import { MINIMUM_CODEX_VERSION, versionAtLeast } from '../utils/cli-versions.js';
import {
  codexImageUrl, toolResultContentError, estimateCodexRequestTokens, referenceText,
  rejectCodexDocumentAttachment, renderCodexImage, turnImages,
} from './codex-content.js';
import { resolveCodexCapabilities } from './codex-capabilities.js';
import { createCodexToolCatalog } from './codex-tool-catalog.js';
import {
  codexOutputSchema, pendingUserSteer, rejectCodexCompaction, rejectInlineToolChanges,
  validateCodexSystemMessage, validatePendingOutputSchema,
} from './codex-conversation-semantics.js';
import { GatewayError } from './model-routing.js';

const DEFAULT_CLOSE_KILL_TIMEOUT_MS = 2_000;
const DEFAULT_FORK_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_PENDING_TOOL_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_TOOL_RESULT_MAX_BYTES = 10_000;
const DEFAULT_TOOL_RESULT_WINDOW_MAX_BYTES = 64_000;
const DEFAULT_CODEX_TOOL_OUTPUT_TOKEN_LIMIT = 10_000;
const CODEX_TOOL_OUTPUT_HISTORY_MULTIPLIER = 1.2;
const CODEX_TOOL_OUTPUT_BYTES_PER_TOKEN = 4;
const CODEX_READ_INLINE_BUDGET_FRACTION = 0.75;
const DEFAULT_INPUT_MAX_TOKENS = 192_000;
const DEFAULT_MAX_SESSIONS = 16;
const MAX_PENDING_INBOUND_EVENTS = 1_024;
const SUPPORTS_PROCESS_GROUP_SIGNALS = process.platform !== 'win32';
const CODEX_APP_SERVER_OVERLOADED_RPC_CODE = -32001;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const CODEX_DYNAMIC_TOOL_CALL_METHOD = 'item/tool/call';
const CODEX_INTERRUPT_TIMEOUT_MS = 2_000;
const CODEX_OVERLOAD_RETRY_DELAYS_MS = Object.freeze([75, 150, 300, 600]);
const CODEX_REPORTED_WINDOW_OUTPUT_RESERVE_TOKENS = 64_000;
const CODEX_DYNAMIC_TOOLS_ONLY_DISABLED_FEATURES = Object.freeze([
  'shell_tool',
  'view_image',
  'unified_exec',
  'hooks',
  'exec_permission_approvals',
  'request_permissions_tool',
  'web_search_request',
  'web_search_cached',
  'standalone_web_search',
  'memories',
  'external_agent_memory_import',
  'chronicle',
  'multi_agent',
  'multi_agent_v2',
  'apps',
  'enable_mcp_apps',
  'tool_suggest',
  'recommended_plugins',
  'plugins',
  'browser_use',
  'browser_use_full_cdp_access',
  'browser_use_external',
  'computer_use',
  'remote_plugin',
  'plugin_sharing',
  'image_generation',
  'skill_mcp_dependency_install',
  'skill_search',
  'default_mode_request_user_input',
  'terminal_visualization_instructions',
  'guardian_approval',
  'guardian_reuse_parent_compaction',
  'guardian_enhanced_node_repl_transcripts',
  'guardian_node_repl_transcript_images',
  'guardianv2',
  'guardian_ext',
  'goals',
  'token_budget',
  'context_management',
  'rollout_budget',
  // 0.150.1 reads sleep from current_time_reminder below; newer app-server
  // builds also expose an independent sleep_tool feature. Keep both off.
  'sleep_tool',
  'tool_call_mcp_elicitation',
  'auth_elicitation',
  'personality',
  'artifact',
]);
const INPUT_TRUNCATION_NOTICE = '[content omitted to fit Codex context budget]';
const TRANSCRIPT_OMISSION_NOTICE = '[older transcript omitted to fit Codex context budget]';
const NON_RESERVING_SELECTION_REASONS = new Set([
  'matching_tool_result',
  'boundary_replay',
  'routing_reservation_replay',
]);
const CODEX_REASONING_EFFORTS = new Set([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);
const CODEX_VERBOSITIES = new Set(['low', 'medium', 'high']);
const CODEX_CONTEXT_DROP_RESET_FRACTION = 0.8;
// Code-heavy content tokenizes near 3 chars/token, not the prose-like 4.
// Undershooting chars-per-token overflows the upstream window (fatal);
// overshooting only truncates earlier, so estimate conservatively everywhere
// budgets and recycle projections are computed.
const ESTIMATE_CHARS_PER_TOKEN = 3;
const CODEX_CONTEXT_WINDOW_ERROR_PATTERN =
  /context window|context length|maximum context|too many tokens|ran out of room|clear earlier history|prompt is too long|tokens?\s*>\s*\d+\s+maximum|autocompact is thrashing|context refilled to the limit|previous compact|tool output is likely too large/iu;
const CODEX_CONTEXT_WINDOW_DRIFT_PATTERN =
  /token|history|context|window|room|compact|truncate|too large|too long|exceed/iu;
const READ_TOOL_NAME = 'Read';
const STRUCTURED_OUTPUT_TOOL_NAME = 'StructuredOutput';
const CLAUDE_TOOL_NAME_GUIDANCE_HEADER = 'Claude Code tool name:';
const READ_GUIDANCE_HEADER = 'Codex Read guidance:';
const LARGE_OUTPUT_GUIDANCE_HEADER = 'Codex large-output guidance:';
const LARGE_OUTPUT_TOOL_NAMES = new Set(['Bash', 'Grep']);
const READ_OFFSET_SCHEMA_DESCRIPTION =
  'Optional 1-based source line at which to start reading. It matches the source line numbers shown by Read. For continuation, use the exact next offset reported by Read or the line after the last contiguous source line actually shown; never advance across omitted output.';
const READ_LIMIT_SCHEMA_DESCRIPTION =
  'Optional maximum number of source lines to read. For large or dense files, begin with a small explicit range. If even a tiny range is too large because lines are very long, use targeted Grep or Bash byte/character/JSON queries instead.';
const CLAUDE_READ_PARTIAL_NOTICE_PREFIX = '[Truncated: PARTIAL view — ';
const CODEX_READ_PAGE_METADATA_HEADER = '[Codex Read page metadata]';
const READ_OFFSET_GUIDANCE_LINES = [
  READ_GUIDANCE_HEADER,
  '- offset is the 1-based source line to start at and matches the line numbers displayed by Read.',
  '- Continue from the exact offset reported by Read, or from the line after the last contiguous source line actually shown.',
  '- Claude Read can reject a result before the gateway sees it when a page exceeds roughly 25,000 tokens or 256 KB. Reduce limit and retry.',
  '- Line paging cannot split one very long/minified line. Use targeted Grep, jq, or Bash byte/character slices for dense JSON, CSV, and generated files.',
  '- Partial, truncated, head/tail, or omitted output is not complete coverage. Never advance past or make completeness claims about an unseen gap.',
];
const LARGE_OUTPUT_GUIDANCE_LINES = [
  LARGE_OUTPUT_GUIDANCE_HEADER,
  '- For a large git diff, inventory first with git diff --stat, --numstat, and --name-only; then inspect one file and bounded hunk range at a time.',
  "- If a diff is still large, snapshot it to a temporary file, index hunk headers with rg -n '^@@', and read explicit output ranges so every hunk can be accounted for.",
  '- Prefer targeted rg/Grep queries and bounded output over printing a whole large file or diff.',
  '- Treat every partial or truncated result as incomplete. Do not claim whole-file or whole-diff coverage until each planned file/range/hunk is accounted for.',
];

function noop() {}

function parseCodexAppServerVersion(initializeResult) {
  const userAgent = String(initializeResult?.userAgent || initializeResult?.user_agent || '');
  // Codex sets the app-server originator from initialize.clientInfo.name, then
  // returns `<originator>/<codex-version> (...)`. Older releases used the
  // fixed `codex_cli_rs` originator, so parse the anchored product/version
  // token rather than a particular product name.
  const match = userAgent.match(/^[^/\r\n]+\/(\d+)\.(\d+)\.(\d+)(?:\b|[-+])/u);
  return match ? match.slice(1, 4).map(Number) : null;
}

function assertDynamicToolsOnlyCodexCompatibility(config, initializeResult) {
  if (config?.codex?.dynamicToolsOnly !== true) {
    return;
  }

  const version = parseCodexAppServerVersion(initializeResult);
  if (versionAtLeast(version, MINIMUM_CODEX_VERSION)) {
    return;
  }

  const detected = version ? version.join('.') : 'unknown';
  throw new GatewayError(
    502,
    'api_error',
    `shared gateway requires Codex CLI ${MINIMUM_CODEX_VERSION.join('.')} or newer for isolated dynamic-tool threads (detected ${detected}); update Codex and restart claude-workflow-gateway`
  );
}

function codexErrorInfoType(codexErrorInfo) {
  if (typeof codexErrorInfo === 'string') {
    return codexErrorInfo;
  }
  if (!codexErrorInfo || typeof codexErrorInfo !== 'object') {
    return null;
  }
  return Object.keys(codexErrorInfo)[0] || null;
}

function attachCodexErrorMetadata(error, metadata = {}) {
  for (const [key, value] of Object.entries(metadata)) {
    if (value !== undefined) {
      error[key] = value;
    }
  }
  return error;
}

function copyCodexErrorMetadata(target, source) {
  if (!source) {
    return target;
  }
  for (const key of [
    'code',
    'data',
    'codexRpcCode',
    'codexRpcData',
    'codexErrorInfo',
    'codexErrorType',
    'codexAdditionalDetails',
    'retryable',
  ]) {
    if (Object.hasOwn(source, key)) {
      target[key] = source[key];
    }
  }
  return target;
}

function codexRpcGatewayError(rpcError) {
  const rpcCode = rpcError?.code ?? null;
  const overloaded = rpcCode === CODEX_APP_SERVER_OVERLOADED_RPC_CODE;
  const error = new GatewayError(
    overloaded ? 503 : 502,
    overloaded ? 'overloaded_error' : 'api_error',
    rpcError?.message || 'Codex app-server request failed'
  );
  return attachCodexErrorMetadata(error, {
    code: rpcCode,
    data: Object.hasOwn(rpcError || {}, 'data') ? rpcError.data : undefined,
    codexRpcCode: rpcCode,
    codexRpcData: Object.hasOwn(rpcError || {}, 'data') ? rpcError.data : undefined,
    retryable: overloaded,
  });
}

function codexTurnGatewayError(turnError, fallbackMessage) {
  const codexErrorInfo = turnError?.codexErrorInfo ?? turnError?.codex_error_info ?? null;
  const codexErrorType = codexErrorInfoType(codexErrorInfo);
  const overloaded = codexErrorType === 'serverOverloaded';
  const rateLimited = codexErrorType === 'rateLimitExceeded';
  const usageLimited = codexErrorType === 'usageLimitExceeded';
  const limitExceeded = rateLimited || usageLimited;
  const error = new GatewayError(
    overloaded ? 503 : limitExceeded ? 429 : 502,
    overloaded ? 'overloaded_error' : limitExceeded ? 'rate_limit_error' : 'api_error',
    turnError?.message || fallbackMessage || 'Codex turn failed'
  );
  return attachCodexErrorMetadata(error, {
    codexErrorInfo,
    codexErrorType,
    codexAdditionalDetails:
      turnError?.additionalDetails ?? turnError?.additional_details ?? undefined,
    retryable: overloaded || rateLimited,
  });
}

function signalChildProcessTree(child, signal) {
  if (!child) {
    return false;
  }

  let signaled = false;
  if (SUPPORTS_PROCESS_GROUP_SIGNALS && Number.isInteger(child.pid)) {
    try {
      process.kill(-child.pid, signal);
      signaled = true;
    } catch {
      // Fall back to the direct child for launchers that are not process-group leaders.
    }
  }

  if (child.exitCode !== null || child.signalCode !== null) {
    return signaled;
  }

  try {
    return child.kill(signal) || signaled;
  } catch {
    return signaled;
  }
}

function childProcessTreeExists(child) {
  if (!child) {
    return false;
  }

  if (SUPPORTS_PROCESS_GROUP_SIGNALS && Number.isInteger(child.pid)) {
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      return error?.code === 'EPERM';
    }
  }

  return child.exitCode === null && child.signalCode === null;
}

function numberOrDefault(value, defaultValue) {
  if (value === null || value === undefined) {
    return defaultValue;
  }

  if (typeof value === 'string' && value.trim() === '') {
    return defaultValue;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : defaultValue;
}

function waitForMilliseconds(milliseconds) {
  return new Promise(function wait(resolve) {
    setTimeout(resolve, Math.max(0, milliseconds));
  });
}

function withTimeout(promise, milliseconds, fallbackValue) {
  return new Promise(function waitWithTimeout(resolve, reject) {
    const timer = setTimeout(function timedOut() {
      resolve(fallbackValue);
    }, Math.max(0, milliseconds));
    Promise.resolve(promise).then(
      function completed(value) {
        clearTimeout(timer);
        resolve(value);
      },
      function failed(error) {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function joinTextParts(parts) {
  if (parts.length === 0) {
    return '';
  }
  return parts.join('\n\n');
}

function normalizeContentBlocks(content, label) {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }

  if (Array.isArray(content)) {
    return content;
  }

  throw new GatewayError(
    400,
    'invalid_request_error',
    `${label} must be a string or an array of content blocks`
  );
}

function renderTextBlocks(blocks, label) {
  const parts = [];

  for (const block of normalizeContentBlocks(blocks, label)) {
    if (block?.type !== 'text') {
      throw new GatewayError(
        400,
        'invalid_request_error',
        `unsupported ${label} content block type: ${String(block?.type)}`
      );
    }
    parts.push(block.text || '');
  }

  return joinTextParts(parts);
}

function renderSystemPrompt(requestBody) {
  const parts = [];

  if (requestBody.system !== undefined && requestBody.system !== null) {
    parts.push(renderTextBlocks(requestBody.system, 'system'));
  }

  // Only top-level instructions belong to the whole thread. Mid-conversation
  // system entries are checked separately before thread admission.
  return parts.filter(Boolean).join('\n\n');
}

function toolSchemaSignature(tools) {
  return JSON.stringify(Array.isArray(tools) ? tools : []);
}

function defaultToolInputSchema() {
  return {
    type: 'object',
    properties: {},
    additionalProperties: true,
  };
}

function cloneJsonValue(value) {
  if (!value || typeof value !== 'object') {
    return value;
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function normalizeToolInputSchema(tool) {
  if (tool?.input_schema && typeof tool.input_schema === 'object') {
    return cloneJsonValue(tool.input_schema);
  }
  return defaultToolInputSchema();
}

function isReadToolName(name) {
  return name === READ_TOOL_NAME;
}

function readOffsetGuidance() {
  return READ_OFFSET_GUIDANCE_LINES.join('\n');
}

function largeOutputGuidance() {
  return LARGE_OUTPUT_GUIDANCE_LINES.join('\n');
}

function codexToolDescription(tool) {
  const description = tool?.description || tool?.name || '';
  const readTool = isReadToolName(tool?.name);
  const largeOutputTool = LARGE_OUTPUT_TOOL_NAMES.has(tool?.name);
  if (!readTool && !largeOutputTool) {
    return description;
  }

  const guidance = [];
  if (readTool && !description.includes(READ_GUIDANCE_HEADER)) {
    guidance.push(readOffsetGuidance());
  }
  if (largeOutputTool && !description.includes(LARGE_OUTPUT_GUIDANCE_HEADER)) {
    guidance.push(largeOutputGuidance());
  }

  const base = description || 'Reads a file from the local filesystem.';
  return guidance.length > 0 ? `${base}\n\n${guidance.join('\n\n')}` : base;
}

function appendSchemaPropertyDescription(schema, propertyName, description) {
  const properties = schema?.properties;
  if (!properties || typeof properties !== 'object') {
    return;
  }

  const property = properties[propertyName];
  if (!property || typeof property !== 'object' || Array.isArray(property)) {
    return;
  }

  const existing = typeof property.description === 'string' ? property.description.trim() : '';
  if (!existing) {
    property.description = description;
    return;
  }

  if (existing.includes(description)) {
    property.description = existing;
    return;
  }

  property.description = `${existing}\n\n${description}`;
}

function codexToolInputSchema(tool) {
  const schema = normalizeToolInputSchema(tool);
  if (!isReadToolName(tool?.name)) {
    return schema;
  }

  appendSchemaPropertyDescription(
    schema,
    'offset',
    READ_OFFSET_SCHEMA_DESCRIPTION
  );
  appendSchemaPropertyDescription(schema, 'limit', READ_LIMIT_SCHEMA_DESCRIPTION);

  return schema;
}

function codexDynamicToolDescription(tool, internalName, preserveOriginalName) {
  const description = codexToolDescription(tool);
  if (preserveOriginalName) {
    return description || tool?.name || internalName;
  }

  const originalName = tool?.name || internalName;
  const nameGuidance =
    `${CLAUDE_TOOL_NAME_GUIDANCE_HEADER} ${originalName}. ` +
    `When Claude Code instructions refer to ${originalName}, invoke this tool.`;
  return description ? `${nameGuidance}\n\n${description}` : nameGuidance;
}

export function buildCodexDynamicToolRegistry(tools) {
  const originalTools = Array.isArray(tools) ? tools : [];
  const byInternalName = new Map();
  const dynamicTools = originalTools.map(function mapTool(tool, index) {
    const preserveOriginalName =
      tool?.name === STRUCTURED_OUTPUT_TOOL_NAME && !byInternalName.has(STRUCTURED_OUTPUT_TOOL_NAME);
    const internalName = preserveOriginalName
      ? STRUCTURED_OUTPUT_TOOL_NAME
      : `ext_tool_${String(index + 1).padStart(3, '0')}`;
    const description = codexDynamicToolDescription(tool, internalName, preserveOriginalName);
    const inputSchema = codexToolInputSchema(tool);
    const record = {
      internalName,
      originalName: tool.name,
      description,
      inputSchema,
    };

    byInternalName.set(internalName, record);

    return {
      type: 'function',
      name: internalName,
      description,
      inputSchema,
    };
  });

  return {
    dynamicTools,
    byInternalName,
  };
}

function selectCodexTools(tools, toolChoice) {
  const originalTools = Array.isArray(tools) ? tools : [];
  if (toolChoice === undefined || toolChoice === null) {
    return originalTools;
  }

  if (typeof toolChoice !== 'object') {
    throw new GatewayError(400, 'invalid_request_error', 'tool_choice must be an object when provided');
  }

  switch (toolChoice.type) {
    case 'auto':
    case 'any':
      return originalTools;
    case 'none':
      return [];
    case 'tool': {
      if (typeof toolChoice.name !== 'string') {
        break;
      }

      const selectedTool = originalTools.find(function findTool(tool) {
        return tool?.name === toolChoice.name;
      });
      if (!selectedTool) {
        throw new GatewayError(
          400,
          'invalid_request_error',
          `tool_choice selected unknown tool ${toolChoice.name}`
        );
      }
      return [selectedTool];
    }
    default:
      break;
  }

  throw new GatewayError(
    400,
    'invalid_request_error',
    `unsupported tool_choice type: ${String(toolChoice.type)}`
  );
}

function effectiveCodexTools(requestBody) {
  return selectCodexTools(requestBody?.tools, requestBody?.tool_choice);
}

function effectiveToolSchemaSignature(requestBody) {
  return toolSchemaSignature(effectiveCodexTools(requestBody));
}

function originalToolName(registry, internalName) {
  return registry.byInternalName.get(internalName)?.originalName || internalName;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readFilePathFromArgs(args) {
  if (typeof args.file_path === 'string') {
    return args.file_path;
  }

  if (typeof args.path === 'string') {
    return args.path;
  }

  return null;
}

function sanitizeCodexToolCallArguments(toolName, args, callId = null) {
  const safeArgs = isPlainObject(args) ? cloneJsonValue(args) : {};
  if (!isReadToolName(toolName)) {
    return {
      arguments: safeArgs,
      readSanitization: null,
    };
  }

  const info = {
    isReadTool: true,
    callId,
    changed: false,
    reasons: [],
    hadOffset: Object.hasOwn(safeArgs, 'offset'),
    originalOffset: safeArgs.offset ?? null,
    sanitizedOffset: safeArgs.offset ?? null,
    sanitizedLimit: safeArgs.limit ?? null,
    offsetRemoved: false,
    offsetRemovedReason: null,
    limitRemoved: false,
    limitRemovedReason: null,
    emptyPagesRemoved: false,
    filePath: readFilePathFromArgs(safeArgs),
  };

  return {
    arguments: safeArgs,
    readSanitization: info,
  };
}

function readSanitizationTrace(readSanitization) {
  if (!readSanitization) {
    return null;
  }

  return {
    changed: readSanitization.changed,
    reasons: readSanitization.reasons,
    had_offset: readSanitization.hadOffset,
    original_offset: readSanitization.originalOffset,
    sanitized_offset: readSanitization.sanitizedOffset,
    sanitized_limit: readSanitization.sanitizedLimit,
    offset_removed: readSanitization.offsetRemoved,
    offset_removed_reason: readSanitization.offsetRemovedReason,
    limit_removed: readSanitization.limitRemoved,
    limit_removed_reason: readSanitization.limitRemovedReason,
    empty_pages_removed: readSanitization.emptyPagesRemoved,
    file_path: readSanitization.filePath,
  };
}

function requestFingerprint(requestBody) {
  return stableDigest(
    JSON.stringify({
      model: requestBody?.model || null,
      system: requestBody?.system || null,
      messages: requestBody?.messages || [],
      tools: requestBody?.tools || [],
      tool_choice: requestBody?.tool_choice || null,
      thinking: requestBody?.thinking || null,
      output_config: requestBody?.output_config || null,
      max_tokens: requestBody?.max_tokens || null,
    })
  );
}

function usageField(source, camelKey, snakeKey) {
  const value = Number(source?.[camelKey] ?? source?.[snakeKey] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function addPositiveUsageField(usage, key, value) {
  if (value > 0) {
    usage[key] = value;
  }
}

function normalizeUsageBreakdown(source) {
  const inputTokens = usageField(source, 'inputTokens', 'input_tokens');
  // Codex reports cache reads and writes as disjoint subsets of inputTokens.
  // Anthropic reports those subsets separately from input_tokens, so clamp a
  // malformed provider breakdown before subtracting both subsets.
  const cachedInputTokens = Math.min(
    inputTokens,
    usageField(source, 'cachedInputTokens', 'cached_input_tokens')
  );
  const cacheWriteInputTokens = Math.min(
    Math.max(0, inputTokens - cachedInputTokens),
    usageField(source, 'cacheWriteInputTokens', 'cache_write_input_tokens')
  );
  const outputTokens = usageField(source, 'outputTokens', 'output_tokens');
  const reasoningOutputTokens = usageField(
    source,
    'reasoningOutputTokens',
    'reasoning_output_tokens'
  );
  const totalTokens = usageField(source, 'totalTokens', 'total_tokens');
  const normalized = {
    input_tokens: Math.max(0, inputTokens - cachedInputTokens - cacheWriteInputTokens),
    // Codex/Responses output_tokens already includes reasoning tokens.
    output_tokens: outputTokens,
  };

  addPositiveUsageField(normalized, 'cache_read_input_tokens', cachedInputTokens);
  addPositiveUsageField(normalized, 'cache_write_input_tokens', cacheWriteInputTokens);
  addPositiveUsageField(normalized, 'reasoning_output_tokens', reasoningOutputTokens);
  addPositiveUsageField(normalized, 'total_tokens', totalTokens);

  return normalized;
}

function normalizeCodexTokenUsage(tokenUsage) {
  const total = tokenUsage?.total ? normalizeUsageBreakdown(tokenUsage.total) : null;
  const last = tokenUsage?.last ? normalizeUsageBreakdown(tokenUsage.last) : null;
  return {
    total,
    last,
    model_context_window: tokenUsage?.modelContextWindow || null,
  };
}

function emptyUsage() {
  return {
    input_tokens: 0,
    output_tokens: 0,
  };
}

function usageNumber(usage, key) {
  const value = Number(usage?.[key] || 0);
  return Number.isFinite(value) ? value : 0;
}

function contextTokensFromUsage(usage) {
  if (!usage) {
    return 0;
  }

  // Prefer the app-server's own total for the turn; fall back to summing the
  // components (ordinary + cache-read + cache-write input is the full prompt;
  // output already includes reasoning and approximates context after the turn).
  const total = usageNumber(usage, 'total_tokens');
  if (total > 0) {
    return total;
  }

  return (
    usageNumber(usage, 'input_tokens') +
    usageNumber(usage, 'cache_read_input_tokens') +
    usageNumber(usage, 'cache_write_input_tokens') +
    usageNumber(usage, 'output_tokens')
  );
}

function usageDelta(current, baseline) {
  // Codex app-server totals are expected to be monotonic; clamp anyway so compaction
  // or replay quirks cannot surface negative Anthropic usage.
  const inputTokens = Math.max(
    0,
    usageNumber(current, 'input_tokens') - usageNumber(baseline, 'input_tokens')
  );
  const outputTokens = Math.max(
    0,
    usageNumber(current, 'output_tokens') - usageNumber(baseline, 'output_tokens')
  );
  const delta = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  };

  const cacheReadInputTokens = Math.max(
    0,
    usageNumber(current, 'cache_read_input_tokens') -
      usageNumber(baseline, 'cache_read_input_tokens')
  );
  addPositiveUsageField(delta, 'cache_read_input_tokens', cacheReadInputTokens);

  const cacheWriteInputTokens = Math.max(
    0,
    usageNumber(current, 'cache_write_input_tokens') -
      usageNumber(baseline, 'cache_write_input_tokens')
  );
  addPositiveUsageField(delta, 'cache_write_input_tokens', cacheWriteInputTokens);

  const reasoningOutputTokens = Math.max(
    0,
    usageNumber(current, 'reasoning_output_tokens') -
      usageNumber(baseline, 'reasoning_output_tokens')
  );
  addPositiveUsageField(delta, 'reasoning_output_tokens', reasoningOutputTokens);

  const totalTokens = Math.max(
    0,
    usageNumber(current, 'total_tokens') - usageNumber(baseline, 'total_tokens')
  );
  addPositiveUsageField(delta, 'total_tokens', totalTokens);

  return delta;
}

function addUsage(left, right) {
  const inputTokens = usageNumber(left, 'input_tokens') + usageNumber(right, 'input_tokens');
  const outputTokens = usageNumber(left, 'output_tokens') + usageNumber(right, 'output_tokens');
  const total = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  };

  const cacheReadInputTokens =
    usageNumber(left, 'cache_read_input_tokens') +
    usageNumber(right, 'cache_read_input_tokens');
  addPositiveUsageField(total, 'cache_read_input_tokens', cacheReadInputTokens);

  const cacheWriteInputTokens =
    usageNumber(left, 'cache_write_input_tokens') +
    usageNumber(right, 'cache_write_input_tokens');
  addPositiveUsageField(total, 'cache_write_input_tokens', cacheWriteInputTokens);

  const reasoningOutputTokens =
    usageNumber(left, 'reasoning_output_tokens') +
    usageNumber(right, 'reasoning_output_tokens');
  addPositiveUsageField(total, 'reasoning_output_tokens', reasoningOutputTokens);

  const totalTokens = usageNumber(left, 'total_tokens') + usageNumber(right, 'total_tokens');
  addPositiveUsageField(total, 'total_tokens', totalTokens);

  return total;
}

function estimateTokensFromText(text) {
  return Math.max(1, Math.ceil(String(text || '').length / ESTIMATE_CHARS_PER_TOKEN));
}

function maxCharsForTokenBudget(maxTokens) {
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.max(1, Math.floor(maxTokens * ESTIMATE_CHARS_PER_TOKEN));
}

function limitTextByTokenBudget(text, maxTokens) {
  return limitTextByCharBudget(text, maxCharsForTokenBudget(maxTokens));
}

function limitTextByCharBudget(text, maxChars) {
  const value = String(text || '');
  if (!Number.isFinite(maxChars) || value.length <= maxChars) {
    return value;
  }

  const marker = `\n\n${INPUT_TRUNCATION_NOTICE}\n\n`;
  if (marker.length >= maxChars) {
    return INPUT_TRUNCATION_NOTICE.slice(0, Math.max(0, maxChars));
  }

  const remainingChars = maxChars - marker.length;
  const headChars = Math.ceil(remainingChars / 2);
  const tailChars = Math.floor(remainingChars / 2);
  return `${value.slice(0, headChars)}${marker}${value.slice(-tailChars)}`;
}

function codexToolResultMaxBytes(config) {
  const maxBytes = numberOrDefault(
    config?.codex?.toolResultMaxBytes,
    DEFAULT_TOOL_RESULT_MAX_BYTES
  );
  if (maxBytes <= 0) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.max(1, Math.trunc(maxBytes));
}

function codexToolResultWindowMaxBytes(config) {
  const maxBytes = numberOrDefault(
    config?.codex?.toolResultWindowMaxBytes,
    DEFAULT_TOOL_RESULT_WINDOW_MAX_BYTES
  );
  if (maxBytes <= 0) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.max(1, Math.trunc(maxBytes));
}

function codexToolOutputTokenLimit(config, route = null) {
  const configured = numberOrDefault(config?.codex?.toolOutputTokenLimit, 0);
  if (configured > 0) {
    return Math.max(1, Math.trunc(configured));
  }

  const policy = codexCapabilitiesForRoute(config, route)?.toolOutputTruncationPolicy;
  if (policy?.mode === 'tokens' && Number(policy.limit) > 0) {
    return Math.max(1, Math.trunc(policy.limit));
  }

  // Codex's unknown-model fallback is byte-based. Supplying the supported
  // thread override makes the app-server policy deterministic for dynamic
  // tool results and gives the gateway one unit in which to budget Read pages.
  return DEFAULT_CODEX_TOOL_OUTPUT_TOKEN_LIMIT;
}

function codexReadInlineMaxBytes(config, route = null) {
  const tokenLimit = codexToolOutputTokenLimit(config, route);
  const nativeHistoryBytes =
    CODEX_TOOL_OUTPUT_BYTES_PER_TOKEN *
    Math.ceil(CODEX_TOOL_OUTPUT_HISTORY_MULTIPLIER * tokenLimit);
  return Math.max(1, Math.floor(nativeHistoryBytes * CODEX_READ_INLINE_BUDGET_FRACTION));
}

function byteLength(text) {
  return Buffer.byteLength(String(text || ''), 'utf8');
}

function approxCodexOutputTokenCount(text) {
  return Math.max(1, Math.ceil(Buffer.byteLength(String(text || ''), 'utf8') / 4));
}

function countOutputLines(text) {
  const value = String(text || '');
  if (!value) {
    return 0;
  }

  const normalized = value.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n');
  const lines = normalized.split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }

  return lines.length;
}

function utf8PrefixByByteBudget(text, maxBytes) {
  if (maxBytes <= 0) {
    return '';
  }

  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (bytes + charBytes > maxBytes) {
      break;
    }

    bytes += charBytes;
    end += char.length;
  }

  return text.slice(0, end);
}

function utf8SuffixByByteBudget(text, maxBytes) {
  if (maxBytes <= 0) {
    return '';
  }

  let bytes = 0;
  let start = text.length;
  for (let index = text.length; index > 0;) {
    let charStart = index - 1;
    const code = text.charCodeAt(charStart);
    if (code >= 0xdc00 && code <= 0xdfff && charStart > 0) {
      charStart -= 1;
    }

    const char = text.slice(charStart, index);
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (bytes + charBytes > maxBytes) {
      break;
    }

    bytes += charBytes;
    start = charStart;
    index = charStart;
  }

  return text.slice(start);
}

function truncateMiddleByByteBudget(text, maxBytes, options = {}) {
  const value = String(text || '');
  const originalBytes = Buffer.byteLength(value, 'utf8');
  if (!Number.isFinite(maxBytes) || originalBytes <= maxBytes) {
    return {
      text: value,
      truncated: false,
      originalBytes,
      originalTokenCount: approxCodexOutputTokenCount(value),
      totalLines: countOutputLines(value),
    };
  }

  const budget = Math.max(0, Math.trunc(maxBytes));
  const marker = options.marker || '\n[...output omitted to fit byte budget...]\n';
  const markerBytes = byteLength(marker);
  if (budget <= markerBytes) {
    return {
      text: utf8PrefixByByteBudget(marker, budget),
      truncated: true,
      originalBytes,
      originalTokenCount: approxCodexOutputTokenCount(value),
      totalLines: countOutputLines(value),
    };
  }

  const contentBudget = budget - markerBytes;
  const leftBudget = Math.floor(contentBudget / 2);
  const rightBudget = contentBudget - leftBudget;
  let prefix = options.lineAligned
    ? lineAlignedPrefixByByteBudget(value, leftBudget)
    : utf8PrefixByByteBudget(value, leftBudget);
  let suffix = options.lineAligned
    ? lineAlignedSuffixByByteBudget(value, rightBudget)
    : utf8SuffixByByteBudget(value, rightBudget);

  // Very long single lines cannot be aligned without discarding the whole
  // preview, so retain byte-safe fragments while keeping the hard bound.
  if (!prefix && leftBudget > 0) {
    prefix = utf8PrefixByByteBudget(value, leftBudget);
  }
  if (!suffix && rightBudget > 0) {
    suffix = utf8SuffixByByteBudget(value, rightBudget);
  }

  return {
    text: `${prefix}${marker}${suffix}`,
    truncated: true,
    originalBytes,
    originalTokenCount: approxCodexOutputTokenCount(value),
    totalLines: countOutputLines(value),
  };
}

function lineAlignedPrefixByByteBudget(text, maxBytes) {
  const prefix = utf8PrefixByByteBudget(text, maxBytes);
  const newlineIndex = prefix.lastIndexOf('\n');
  if (newlineIndex <= 0 || prefix.length === text.length) {
    return prefix;
  }

  return prefix.slice(0, newlineIndex);
}

function lineAlignedSuffixByByteBudget(text, maxBytes) {
  const suffix = utf8SuffixByByteBudget(text, maxBytes);
  const newlineIndex = suffix.indexOf('\n');
  if (newlineIndex < 0 || suffix.length === text.length) {
    return suffix;
  }

  return suffix.slice(newlineIndex + 1);
}

function readRequestInfo(pendingToolCall) {
  const args = isPlainObject(pendingToolCall?.arguments) ? pendingToolCall.arguments : {};
  const filePath = readFilePathFromArgs(args);
  if (typeof filePath !== 'string' || filePath === '') {
    return { valid: false, reason: 'the Read request has no stable file path' };
  }

  const hasOffset = Object.hasOwn(args, 'offset') && args.offset !== null;
  const hasLimit = Object.hasOwn(args, 'limit') && args.limit !== null;
  const offset = hasOffset ? Number(args.offset) : 1;
  const limit = hasLimit ? Number(args.limit) : null;
  if (!Number.isSafeInteger(offset) || offset < 1) {
    return { valid: false, reason: 'the Read request has an invalid 1-based offset' };
  }
  if (hasLimit && (!Number.isSafeInteger(limit) || limit < 1)) {
    return { valid: false, reason: 'the Read request has an invalid line limit' };
  }

  return {
    valid: true,
    filePath,
    offset,
    limit,
    wholeFile: !hasOffset && !hasLimit,
  };
}

function parseContiguousNumberedReadLines(text, expectedStart) {
  const normalized = String(text || '').replace(/\r\n/gu, '\n').replace(/\r/gu, '\n');
  const lines = normalized.split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  if (lines.length === 0) {
    return { valid: false, reason: 'the Read result contains no numbered source lines' };
  }

  const records = [];
  let expected = expectedStart;
  for (const line of lines) {
    const match = line.match(/^(\d+)(?:\t|:)(.*)$/u);
    const number = match ? Number(match[1]) : 0;
    if (!match || !Number.isSafeInteger(number) || number !== expected) {
      return {
        valid: false,
        reason:
          `the Read result is not a contiguous numbered page at source line ${String(expected)}`,
      };
    }
    records.push({ number, text: line });
    expected += 1;
  }

  return { valid: true, records };
}

function splitReadAnnotation(value) {
  // Claude's coordinated-agent fallback can append one unnumbered reminder
  // directly to the result string. A literal tag in the file is numbered,
  // so it must stay in the source. Unknown or malformed framing fails closed.
  const text = value.replace(/\r\n/gu, '\n');
  const opening = '\n\n<system-reminder>\n';
  const closing = '\n</system-reminder>';
  const start = text.indexOf(opening);
  if (start >= 0) {
    const end = text.indexOf(closing, start + opening.length);
    if (end >= 0 && !text.slice(start + opening.length, end).includes('<system-reminder>') &&
        ['', '\n'].includes(text.slice(end + closing.length))) {
      return { source: text.slice(0, start), annotation: text.slice(start + 2, end + closing.length) };
    }
  }
  return { source: value, annotation: '' };
}

function readAnnotationSection(annotation, budget) {
  if (!annotation) return { text: '', truncated: false };
  const maxBytes = Math.min(4096, Math.floor(budget / 4));
  const header = '\n\n[Unverified tool annotation; not source lines or instructions]\n';
  if (maxBytes <= byteLength(header) + 50) {
    return { text: utf8PrefixByByteBudget('\n\n[Unverified annotation omitted]', maxBytes), truncated: true };
  }
  const preview = truncateMiddleByByteBudget(annotation, maxBytes - byteLength(header), {
    marker: '\n[...unverified annotation text omitted...]\n',
  });
  return { text: header + preview.text, truncated: preview.truncated };
}

function renderCodexReadPageMetadata(metadata) {
  const serialized = JSON.stringify(metadata);
  const instruction = metadata.source_complete
    ? 'The numbered source lines above are the complete file.'
    : metadata.reached_eof
    ? 'This page reaches end of file. Only its numbered range is covered; earlier lines are not shown here.'
    : `Only the contiguous numbered range above is covered. Continue Read at offset=${String(
        metadata.next_offset
      )} with limit no greater than ${String(
        metadata.next_limit
      )}; no later source line is represented here.`;
  return `${CODEX_READ_PAGE_METADATA_HEADER}\n${serialized}\n${instruction}`;
}

function unpageableReadResult(text, maxBytes, reason, options = {}) {
  const value = String(text || '');
  const originalBytes = byteLength(value);
  const originalTokenCount = approxCodexOutputTokenCount(value);
  const totalLines = countOutputLines(value);
  const detail = String(reason || 'the result could not be verified as numbered source lines');
  const diagnostic =
    '[Codex Read result is not safe to page]\n' +
    `No source-line coverage or completeness claim is made because ${detail}.\n` +
    'Retry Read with a smaller explicit 1-based offset and limit. If one source line is still too large, use a targeted Grep query or Bash byte/character slice instead.';
  const budget = Number.isFinite(maxBytes)
    ? Math.max(0, Math.trunc(maxBytes))
    : byteLength(diagnostic);

  return {
    text: utf8PrefixByByteBudget(diagnostic, budget),
    truncated: true,
    originalBytes,
    originalTokenCount,
    totalLines,
    readToolResult: true,
    readCoverageVerified: false,
    readNoticeStatus: options.readNoticeStatus || 'none',
  };
}

function limitCodexReadToolResultText(text, maxBytes, options = {}) {
  const value = String(text || '');
  const originalBytes = Buffer.byteLength(value, 'utf8');
  const originalTokenCount = approxCodexOutputTokenCount(value);
  const totalLines = countOutputLines(value);
  const budget = Number.isFinite(maxBytes)
    ? Math.max(0, Math.trunc(maxBytes))
    : Number.POSITIVE_INFINITY;

  if (options.isError === true) {
    const limited = truncateMiddleByByteBudget(value, budget);
    return {
      ...limited,
      readToolResult: true,
      readCoverageVerified: false,
      readNoticeStatus: options.readNoticeStatus || 'none',
    };
  }

  if (options.readNoticeStatus === 'invalid') {
    return unpageableReadResult(
      value,
      budget,
      options.readNoticeError || 'the adjacent Claude Read truncation notice failed validation',
      options
    );
  }

  if (options.readPartialNotice?.kind === 'characters') {
    const characterDetail = value.length === options.readPartialNotice.shownCharacters
      ? 'Claude reported a long-line character excerpt that cannot establish complete source lines'
      : 'the Claude long-line notice does not match the returned character excerpt';
    return unpageableReadResult(
      value,
      budget,
      characterDetail,
      options
    );
  }

  const request = readRequestInfo(options.pendingToolCall);
  if (!request.valid) {
    return unpageableReadResult(value, budget, request.reason, options);
  }

  const { source, annotation } = splitReadAnnotation(value);
  const parsed = parseContiguousNumberedReadLines(source, request.offset);
  if (!parsed.valid) {
    return unpageableReadResult(value, budget, parsed.reason, options);
  }

  const notice = options.readPartialNotice;
  const firstRecord = parsed.records[0];
  const lastRecord = parsed.records.at(-1);
  if (
    notice?.kind === 'lines' &&
    (notice.start !== firstRecord.number || notice.end !== lastRecord.number)
  ) {
    return unpageableReadResult(
      value,
      budget,
      'the validated Claude partial-view range does not match the returned numbered lines',
      { ...options, readNoticeStatus: 'invalid' }
    );
  }

  const returnedCount = parsed.records.length;
  if (request.limit !== null && returnedCount > request.limit) {
    return unpageableReadResult(value, budget, 'the numbered result exceeds the requested line limit', options);
  }
  // Absence of a PARTIAL banner is not durable evidence of EOF: a future
  // Claude version could change or omit that companion system message. An
  // explicit line limit returning fewer records is the fail-closed EOF signal
  // available in the current textual contract.
  const explicitLimitReachedEof =
    !annotation && notice?.kind !== 'lines' && request.limit !== null && returnedCount < request.limit;
  const sourceTotalLines = notice?.kind === 'lines'
    ? notice.total
    : explicitLimitReachedEof
      ? lastRecord.number
      : null;
  let selected = null;
  let bodyBytes = 0;
  const ancillary = readAnnotationSection(annotation, budget);
  const pageBudget = budget - byteLength(ancillary.text);
  for (let index = 0; index < parsed.records.length; index += 1) {
    bodyBytes += (index === 0 ? 0 : 1) + byteLength(parsed.records[index].text);
    const coveredEnd = parsed.records[index].number;
    const reachedEof = explicitLimitReachedEof && index === parsed.records.length - 1;
    const metadata = {
      path: request.filePath,
      covered_start: firstRecord.number,
      covered_end: coveredEnd,
      source_total_lines: sourceTotalLines,
      next_offset: reachedEof ? null : coveredEnd + 1,
      next_limit: reachedEof ? null : index + 1,
      contiguous: true,
      reached_eof: reachedEof,
      source_complete: reachedEof && firstRecord.number === 1,
    };
    const footer = renderCodexReadPageMetadata(metadata);
    if (bodyBytes + 2 + byteLength(footer) > pageBudget) {
      break;
    }
    selected = { footer, metadata, count: index + 1 };
  }

  if (!selected) {
    return unpageableReadResult(
      value,
      budget,
      'the first complete numbered source line and its paging metadata exceed the safe inline budget',
      options
    );
  }

  return {
    text: `${parsed.records.slice(0, selected.count).map(record => record.text).join('\n')}\n\n${selected.footer}${ancillary.text}`,
    truncated: selected.count < parsed.records.length || ancillary.truncated,
    originalBytes,
    originalTokenCount,
    totalLines,
    readToolResult: true,
    readCoverageVerified: true,
    readNoticeStatus: options.readNoticeStatus || 'none',
    readPageMetadata: selected.metadata,
  };
}

function limitCodexToolResultText(text, maxBytes, options = {}) {
  if (isReadToolName(options.toolName)) {
    return limitCodexReadToolResultText(text, maxBytes, options);
  }

  const value = String(text || '');
  const originalBytes = byteLength(value);
  if (!Number.isFinite(maxBytes) || originalBytes <= maxBytes) {
    return truncateMiddleByByteBudget(value, maxBytes);
  }

  const originalTokenCount = approxCodexOutputTokenCount(value);
  const totalLines = countOutputLines(value);
  const warning =
    `Warning: truncated output (original token count: ${originalTokenCount})\n` +
    `Total output lines: ${totalLines}\n\n`;
  const budget = Math.max(0, Math.trunc(maxBytes));
  const warningText = utf8PrefixByByteBudget(warning, budget);
  const warningBytes = byteLength(warningText);
  const body = warningBytes < budget
    ? truncateMiddleByByteBudget(value, budget - warningBytes).text
    : '';
  return {
    text: `${warningText}${body}`,
    truncated: true,
    originalBytes,
    originalTokenCount,
    totalLines,
  };
}

function codexCapabilitiesForRoute(config, route = null) {
  const model = String(route?.upstreamModel || config?.codex?.model || '').trim();
  const configured = config?.codex?.capabilities;
  if (!configured) {
    return null;
  }
  if (configured?.model === model) {
    return configured;
  }

  return resolveCodexCapabilities({
    command: config?.codex?.command || 'codex',
    cwd: config?.codex?.cwd || process.cwd(),
    model,
    contextProfile: config?.codex?.contextProfile || 'standard',
    requestedContextWindow: config?.codex?.requestedContextWindow || 0,
    reasoningEffort: route?.reasoningEffort || config?.codex?.reasoningEffort || '',
  });
}

function codexDynamicToolsOnlyConfigOverrides(discoveredConfig = null) {
  const overrides = {
    web_search: 'disabled',
    include_permissions_instructions: false,
    include_apps_instructions: false,
    include_collaboration_mode_instructions: false,
    include_environment_context: false,
    'agents.enabled': false,
    'tools.experimental_request_user_input.enabled': false,
    'tools.update_plan.enabled': false,
    'skills.include_instructions': false,
    'skills.bundled.enabled': false,
    'orchestrator.skills.enabled': false,
    'orchestrator.mcp.enabled': false,
    'memories.use_memories': false,
    'memories.dedicated_tools': false,
    // The isolated model catalog selects direct mode. Disable the optional
    // code-mode feature too, including when a user's global config enables it.
    'features.code_mode': {
      enabled: false,
      direct_only_tool_namespaces: ['functions'],
    },
    'features.current_time_reminder': {
      enabled: false,
      sleep_tool: false,
    },
  };

  for (const feature of CODEX_DYNAMIC_TOOLS_ONLY_DISABLED_FEATURES) {
    overrides[`features.${feature}`] = false;
  }

  const mcpServers = {};
  const plugins = {};
  for (const layer of discoveredConfig?.layers || []) {
    for (const name of Object.keys(layer?.config?.mcp_servers || {})) {
      mcpServers[name] = { enabled: false };
    }
    for (const name of Object.keys(layer?.config?.plugins || {})) {
      plugins[name] = { enabled: false };
    }
  }
  if (Object.keys(mcpServers).length > 0) {
    overrides.mcp_servers = mcpServers;
  }
  if (Object.keys(plugins).length > 0) {
    overrides.plugins = plugins;
  }

  return overrides;
}

function codexThreadConfigOverrides(config, route = null, isolationOverrides = null) {
  const overrides = isolationOverrides ? { ...isolationOverrides } : {};
  const capabilities = codexCapabilitiesForRoute(config, route);
  const toolOutputTokenLimit = codexToolOutputTokenLimit(config, route);
  const autoCompactTokenLimit = numberOrDefault(config?.codex?.autoCompactTokenLimit, 0);
  const autoCompactTokenLimitScope = config?.codex?.autoCompactTokenLimitScope;

  if (Number(capabilities?.resolvedRawContextTokens) > 0) {
    overrides.model_context_window = Math.trunc(capabilities.resolvedRawContextTokens);
  }

  overrides.tool_output_token_limit = toolOutputTokenLimit;

  if (autoCompactTokenLimit > 0) {
    overrides.model_auto_compact_token_limit = Math.trunc(autoCompactTokenLimit);
    if (
      typeof autoCompactTokenLimitScope === 'string' &&
      autoCompactTokenLimitScope.trim() !== ''
    ) {
      overrides.model_auto_compact_token_limit_scope = autoCompactTokenLimitScope.trim();
    }
  }

  const verbosity = String(route?.verbosity || '').trim().toLowerCase();
  if (verbosity) {
    if (!CODEX_VERBOSITIES.has(verbosity)) {
      throw new GatewayError(
        400,
        'invalid_request_error',
        `unsupported Codex verbosity ${route.verbosity}; expected low, medium, or high`
      );
    }
    overrides.model_verbosity = verbosity;
  }

  return overrides;
}

function codexInputMaxTokens(config, route = null) {
  const explicitlyConfigured = numberOrDefault(config?.codex?.inputMaxTokens, 0);
  if (explicitlyConfigured > 0) {
    return Math.max(1, Math.trunc(explicitlyConfigured));
  }

  const capabilityBudget = Number(codexCapabilitiesForRoute(config, route)?.inputBudgetTokens || 0);
  return capabilityBudget > 0
    ? Math.max(1, Math.trunc(capabilityBudget))
    : DEFAULT_INPUT_MAX_TOKENS;
}

function effectiveCodexInputMaxTokens(config, route, contextWindow) {
  const configured = codexInputMaxTokens(config, route);
  const window = Number(contextWindow || 0);
  if (window <= 0) {
    return configured;
  }

  // App-server reports the already-effective (headroom-adjusted) window.
  // Reserve output space without applying a second arbitrary percentage.
  const outputReserve = Math.min(
    CODEX_REPORTED_WINDOW_OUTPUT_RESERVE_TOKENS,
    Math.floor(window / 4)
  );
  const fromWindow = Math.max(1, Math.floor(window - outputReserve));
  return Math.min(configured, fromWindow);
}

function populateEstimatedUsage(boundary, requestBody, outcome) {
  if ((boundary.usage.output_tokens || 0) > 0) {
    return;
  }

  const outputEstimateParts = [boundary.text || ''];
  if (outcome.type === 'tool_use' && outcome.toolCall) {
    outputEstimateParts.push(outcome.toolCall.name || '');
    outputEstimateParts.push(JSON.stringify(outcome.toolCall.input || {}));
  }

  boundary.usage = {
    input_tokens: Math.max(
      boundary.usage.input_tokens || 0,
      estimateCodexRequestTokens({
        system: requestBody?.system || null,
        messages: requestBody?.messages || [],
        tools: requestBody?.tools || [],
        tool_choice: requestBody?.tool_choice || null,
      }, ESTIMATE_CHARS_PER_TOKEN)
    ),
    output_tokens: Math.max(
      boundary.usage.output_tokens || 0,
      estimateTokensFromText(outputEstimateParts.join('\n'))
    ),
  };
}

function hasMatchingToolResult(requestBody, pendingToolCall) {
  if (!pendingToolCall) {
    return false;
  }

  for (const block of latestUserContentBlocks(requestBody, 'tool_result message')) {
    if (block?.type === 'tool_result' && block.tool_use_id === pendingToolCall.callId) {
      return true;
    }
  }

  return false;
}

function createBoundary(turnId, requestBody, usageBaseline = emptyUsage()) {
  const listeners = new Set();
  const boundary = {
    turnId,
    requestFingerprint: requestFingerprint(requestBody),
    events: [],
    text: '',
    usage: emptyUsage(),
    usageBaseline: {
      ...emptyUsage(),
      ...(usageBaseline || {}),
    },
    finished: false,
    outcome: null,
    error: null,
    done: null,
    emit(event) {
      boundary.events.push(event);
      for (const listener of listeners) {
        listener(event);
      }
    },
    addListener(listener) {
      for (const event of boundary.events) {
        listener(event);
      }
      if (boundary.finished) {
        return function noop() {};
      }

      listeners.add(listener);
      return function removeListener() {
        listeners.delete(listener);
      };
    },
  };

  boundary.done = new Promise(function assignCompletion(resolve, reject) {
    boundary.resolve = resolve;
    boundary.reject = reject;
  });

  return boundary;
}

function extractLatestUserText(requestBody, options = {}) {
  const messages = Array.isArray(requestBody.messages) ? requestBody.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') {
      continue;
    }

    const textParts = [];
    for (const block of normalizeContentBlocks(message.content, 'user message')) {
      if (block?.type === 'text') {
        textParts.push(block.text || '');
      } else if (block?.type === 'image') {
        textParts.push(renderCodexImage(block, options.images));
      }
    }

    return joinTextParts(textParts);
  }

  throw new GatewayError(
    400,
    'invalid_request_error',
    'messages must include at least one user message'
  );
}

function renderToolResultContent(content, options = {}) {
  if (content === undefined) return '';
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    throw new GatewayError(
      400,
      'invalid_request_error',
      'tool_result content must be a string or an array of content blocks'
    );
  }

  const parts = [];
  for (const block of content) {
    if (block?.type === 'image') {
      parts.push(renderCodexImage(block, options.images));
      continue;
    }
    if (block?.type === 'tool_reference') {
      parts.push(referenceText(block));
      continue;
    }
    if (block?.type !== 'text') {
      throw new GatewayError(
        400,
        'invalid_request_error',
        `unsupported tool_result content block type: ${String(block?.type)}`
      );
    }
    parts.push(block.text || '');
  }

  return joinTextParts(parts);
}

function shouldAppendReadOffsetGuidance(output, pendingToolCall, isError) {
  if (!isReadToolName(pendingToolCall?.tool)) {
    return false;
  }

  if (output.includes(READ_GUIDANCE_HEADER)) {
    return false;
  }

  // Successful numbered payloads must remain parseable. Source text can
  // itself contain words such as "warning" and "offset", so content
  // heuristics must never append gateway prose to a successful Read result.
  return isError;
}

function appendReadToolResultFeedback(text, pendingToolCall, isError) {
  let output = String(text || '');
  const feedback = {
    readTool: isReadToolName(pendingToolCall?.tool),
    guidanceAppended: false,
  };

  if (!feedback.readTool) {
    return {
      text: output,
      feedback,
    };
  }

  if (shouldAppendReadOffsetGuidance(output, pendingToolCall, isError)) {
    output = `${output}\n\n${readOffsetGuidance()}`;
    feedback.guidanceAppended = true;
  }

  return {
    text: output,
    feedback,
  };
}

function renderTranscriptBlock(block, options = {}) {
  if (block?.type === 'image') return renderCodexImage(block, options.images);

  if (block?.type === 'text') {
    return block.text || '';
  }

  if (block?.type === 'tool_use') {
    return `[tool_use ${block.name || 'tool'} ${block.id || ''}]\n${JSON.stringify(block.input || {})}`;
  }

  if (block?.type === 'tool_result') {
    const budget = Math.min(options.toolResultMaxBytes ?? Infinity, options.replayBudget?.remaining ?? Infinity);
    const account = (bytes) => {
      if (options.replayBudget) options.replayBudget.remaining -= Math.min(bytes, budget);
    };
    const unsupported = toolResultContentError(block.content);
    if (unsupported) {
      const notice = utf8PrefixByByteBudget(unsupported, budget);
      account(byteLength(notice));
      return `[tool_result ${block.tool_use_id || ''} error]\n${notice}`;
    }
    const hasImage = hasImageResult(block.content);
    if (hasImage && Number.isFinite(budget)) {
      const bytes = imageResultBytes(imageResultItems(block.content));
      if (bytes > budget) {
        const failure = imageBudgetFailure(budget);
        account(byteLength(failure));
        return `[tool_result ${block.tool_use_id || ''} error]\n${failure}`;
      }
      account(bytes);
    }
    let text = renderToolResultContent(block.content, options);
    const replayToolCall = options.toolCallsById?.get(block.tool_use_id);
    const header = `[tool_result ${block.tool_use_id || ''}${block.is_error ? ' error' : ''}]\n`;
    if (isReadToolName(replayToolCall?.tool) && !hasImage) {
      const readNotice = adjacentClaudeReadPartialNotice(
        options.requestBody,
        options.messageIndex,
        replayToolCall
      );
      const raw = {
        text,
        isError: block.is_error === true,
        readNoticeStatus: readNotice.status,
        readPartialNotice: readNotice.notice,
        readNoticeError: readNotice.error,
      };
      const maxBytes = Math.min(options.readInlineMaxBytes ?? Infinity, budget);
      const pageAt = (bytes) => prepareCodexToolResultPayload(raw, replayToolCall, bytes).limitedToolResult;
      const page = pageAt(maxBytes);
      text = page.text;
      if (page.readCoverageVerified && options.captureReadPage) {
        // Keep the raw result and its call/notice together until the final
        // transcript budget is known. Never slice generated coverage claims.
        options.captureReadPage((chars) => chars <= header.length
          ? '[Read omitted]'.slice(0, chars)
          : header + pageAt(Math.min(maxBytes, chars - header.length)).text);
      }
    } else if (!hasImage && Number.isFinite(budget)) {
      text = limitCodexToolResultText(text, budget).text;
    }
    if (!hasImage) account(byteLength(text));
    return header + text;
  }

  return '';
}

function recordTranscriptToolCalls(message, toolCallsById) {
  if (message?.role !== 'assistant') {
    return;
  }
  for (const block of normalizeContentBlocks(message.content, 'assistant content')) {
    if (block?.type !== 'tool_use' || typeof block.id !== 'string' || block.id === '') {
      continue;
    }
    toolCallsById.set(block.id, {
      callId: block.id,
      tool: block.name,
      arguments: isPlainObject(block.input) ? block.input : {},
    });
  }
}

function renderMessageTranscript(message, options = {}) {
  if (message?.role === 'system') {
    return null;
  }

  const prefix = `[${message?.role || 'unknown'}]\n`;
  const parts = [];
  let afterToolOutput = false;
  for (const block of normalizeContentBlocks(message?.content, `${message?.role || 'message'} content`)) {
    let fitRead = null;
    const text = renderTranscriptBlock(block, { ...options, captureReadPage: (fit) => { fitRead = fit; } });
    if (!text) continue;
    // A resumed transcript has no live RPC to mark the end of a tool
    // result. Mark the transition back to the user's accompanying input.
    const startsUserInput = afterToolOutput && block.type !== 'tool_result';
    parts.push({ text: startsUserInput ? `[user]\n${text}` : text, fitRead });
    afterToolOutput = message?.role === 'user' && block.type === 'tool_result';
  }
  if (!parts.length) return null;
  const join = (texts) => prefix + texts.join('\n\n');
  const text = join(parts.map(part => part.text));
  const result = { text, messageIndex: options.messageIndex, role: message?.role || 'unknown' };
  const pages = parts.filter(part => part.fitRead);
  if (pages.length) {
    result.fit = (maxChars) => {
      // Non-page text (including instructions and image markers) takes
      // precedence. Only emit a footer generated for the lines that fit.
      const fixedLength = text.length - pages.reduce((n, part) => n + part.text.length, 0);
      let available = maxChars - fixedLength;
      if (available <= 0) {
        const withoutPages = join(parts.map(part => part.fitRead ? '[Read omitted; no source coverage]' : part.text));
        return limitTextByCharBudget(withoutPages, maxChars);
      }
      let remainingPages = pages.length;
      return join(parts.map(part => {
        if (!part.fitRead) return part.text;
        const share = Math.floor(available / remainingPages--);
        const fitted = part.text.length <= share ? part.text : part.fitRead(share);
        available -= fitted.length;
        return fitted;
      }));
    };
  }
  return result;
}

function latestUserContentBlocks(requestBody, label = 'latest user message') {
  const messages = Array.isArray(requestBody?.messages) ? requestBody.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user') {
      return normalizeContentBlocks(message.content, label);
    }
  }
  return [];
}

function canonicalContinuityMessage(message) {
  return [
    message?.role || 'unknown',
    normalizeContentBlocks(message?.content, `${message?.role || 'message'} content`).map(
      function renderContinuityBlock(block) {
        return renderTranscriptBlock(block);
      }
    ),
  ];
}

function continuityMessages(requestBody) {
  const messages = Array.isArray(requestBody?.messages) ? requestBody.messages : [];
  return messages
    .filter(function excludeSystemMessage(message) {
      return message?.role !== 'system';
    })
    .map(canonicalContinuityMessage);
}

function outcomeAssistantMessage(outcome) {
  const content = [];
  if (typeof outcome?.text === 'string' && outcome.text !== '') {
    content.push({ type: 'text', text: outcome.text });
  }
  if (outcome?.type === 'tool_use' && outcome.toolCall) {
    content.push({
      type: 'tool_use',
      id: outcome.toolCall.id,
      name: outcome.toolCall.name,
      input: outcome.toolCall.input || {},
    });
  }
  return { role: 'assistant', content };
}

function continuityFingerprint(messages) {
  return crypto.createHash('sha256').update(JSON.stringify(messages)).digest('hex');
}

function makeContinuityAnchor(requestBody, outcome) {
  const messages = continuityMessages(requestBody);
  messages.push(canonicalContinuityMessage(outcomeAssistantMessage(outcome)));
  return {
    messageCount: messages.length,
    fingerprint: continuityFingerprint(messages),
  };
}

function matchesContinuityAnchor(requestBody, anchor) {
  if (!anchor) {
    return true;
  }
  const messages = continuityMessages(requestBody);
  if (messages.length < anchor.messageCount) {
    return false;
  }
  return (
    continuityFingerprint(messages.slice(0, anchor.messageCount)) === anchor.fingerprint
  );
}

function renderLatestUserTranscriptInput(
  requestBody,
  maxTokens = Number.POSITIVE_INFINITY,
  renderOptions = {},
  renderedMessages = renderedTranscriptMessages(requestBody, renderOptions)
) {
  const lastUser = requestBody.messages.findLastIndex(message => message?.role === 'user');
  const entry = renderedMessages.find(item => item.messageIndex === lastUser);
  if (entry) {
    return fitTranscriptInputToBudget([entry], 0, maxTokens, renderOptions.images).text;
  }
  return limitTextByTokenBudget(extractLatestUserText(requestBody, renderOptions), maxTokens);
}

function renderedTranscriptMessages(requestBody, renderOptions = {}) {
  const renderedMessages = [];
  const messages = Array.isArray(requestBody?.messages) ? requestBody.messages : [];
  const toolCallsById = renderOptions.toolCallsById || new Map();
  const replayBudget = Number.isFinite(renderOptions.toolResultWindowMaxBytes)
    ? { remaining: renderOptions.toolResultWindowMaxBytes } : null;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!renderOptions.toolCallsById) {
      recordTranscriptToolCalls(message, toolCallsById);
    }
    const rendered = renderMessageTranscript(message, {
      ...renderOptions,
      replayBudget,
      requestBody,
      messageIndex: index,
      toolCallsById,
    });
    if (!rendered) {
      continue;
    }

    renderedMessages.push(rendered);
  }

  return renderedMessages;
}

function largestRenderedMessageSummaries(renderedMessages) {
  const summaries = renderedMessages.map(function summarizeRenderedMessage(message) {
    return {
      message_index: message.messageIndex,
      role: message.role,
      bytes: byteLength(message.text),
      estimated_tokens: estimateTokensFromText(message.text),
    };
  });

  summaries.sort(function sortBySize(left, right) {
    return right.bytes - left.bytes;
  });
  return summaries.slice(0, 5);
}

function summarizeTurnInput(requestBody, text, options = {}) {
  const messages = Array.isArray(requestBody?.messages) ? requestBody.messages : [];
  const value = String(text || '');
  return {
    mode: options.mode || 'unknown',
    max_tokens: Number.isFinite(options.maxTokens) ? options.maxTokens : null,
    message_count: messages.length,
    rendered_message_count: options.renderedMessageCount ?? null,
    selected_message_count: options.selectedMessageCount ?? null,
    omitted_message_count: options.omittedMessageCount ?? null,
    text_bytes: byteLength(value),
    text_chars: value.length,
    estimated_tokens: estimateTokensFromText(value),
    line_count: countOutputLines(value),
    largest_rendered_messages: options.largestRenderedMessages || [],
  };
}

function summarizeLatestTurnInput(
  requestBody,
  text,
  maxTokens,
  renderedMessages,
  largestRenderedMessages = largestRenderedMessageSummaries(renderedMessages)
) {
  return summarizeTurnInput(requestBody, text, {
    mode: 'latest',
    maxTokens,
    renderedMessageCount: renderedMessages.length,
    selectedMessageCount: text ? 1 : 0,
    omittedMessageCount: Math.max(0, renderedMessages.length - 1),
    largestRenderedMessages,
  });
}

function renderTranscriptInputWithSummary(
  requestBody,
  maxTokens = Number.POSITIVE_INFINITY,
  renderOptions = {}
) {
  const renderedItems = renderedTranscriptMessages(requestBody, renderOptions);
  const renderedMessages = renderedItems.map(function renderedText(item) {
    return item.text;
  });
  const largestRenderedMessages = largestRenderedMessageSummaries(renderedItems);

  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    const text = joinTextParts(renderedMessages) || extractLatestUserText(requestBody, renderOptions);
    return {
      text,
      summary: summarizeTurnInput(requestBody, text, {
        mode: 'transcript',
        maxTokens,
        renderedMessageCount: renderedMessages.length,
        selectedMessageCount: renderedMessages.length,
        omittedMessageCount: 0,
        largestRenderedMessages,
      }),
    };
  }

  const selected = [];
  let usedTokens = 0;
  let omittedCount = 0;
  for (let index = renderedMessages.length - 1; index >= 0; index -= 1) {
    const rendered = renderedMessages[index];
    const tokens = estimateTokensFromText(rendered) + (renderOptions.images?.tokens(rendered) || 0);
    if (usedTokens + tokens <= maxTokens) {
      selected.unshift(renderedItems[index]);
      usedTokens += tokens;
      continue;
    }

    if (selected.length === 0) {
      selected.unshift(renderedItems[index]);
      omittedCount = index;
    } else {
      omittedCount = index + 1;
    }
    break;
  }

  if (selected.length > 0) {
    const fitted = fitTranscriptInputToBudget(selected, omittedCount, maxTokens, renderOptions.images);
    const text = fitted.text;
    return {
      text,
      summary: summarizeTurnInput(requestBody, text, {
        mode: 'transcript',
        maxTokens,
        renderedMessageCount: renderedMessages.length,
        selectedMessageCount: renderedItems.length - fitted.omittedCount,
        omittedMessageCount: fitted.omittedCount,
        largestRenderedMessages,
      }),
    };
  }

  const text = renderLatestUserTranscriptInput(requestBody, maxTokens, renderOptions, renderedItems);
  return {
    text,
    summary: summarizeLatestTurnInput(
      requestBody,
      text,
      maxTokens,
      renderedItems,
      largestRenderedMessages
    ),
  };
}

function fitTranscriptInputToBudget(selected, omittedCount, maxTokens, images) {
  for (let start = 0; start < selected.length; start++, omittedCount++) {
    const prefix = omittedCount ? `${TRANSCRIPT_OMISSION_NOTICE}: ${omittedCount} message(s).\n\n` : '';
    const text = prefix + joinTextParts(selected.slice(start).map(entry => entry.text));
    const imageTokens = images?.tokens(text) || 0;
    const maxChars = Math.max(0, (maxTokens - imageTokens) * ESTIMATE_CHARS_PER_TOKEN);
    if (text.length <= maxChars) return { text, omittedCount };
    if (start === selected.length - 1) {
      if (imageTokens && imageTokens >= maxTokens) {
        throw new GatewayError(413, 'invalid_request_error', 'Inline images exceed the configured Codex input budget');
      }
      const entry = selected[start];
      const available = Math.max(0, maxChars - prefix.length);
      return {
        text: prefix.slice(0, maxChars) + (entry.fit
          ? entry.fit(available)
          : limitTextByCharBudget(entry.text, available)),
        omittedCount,
      };
    }
  }
  return { text: '', omittedCount };
}

function isCodexContextWindowError(error) {
  // Older app-servers supplied only error text. A typed upstream failure is
  // authoritative even when its detail happens to mention the context window.
  return error?.codexErrorType
    ? error.codexErrorType === 'contextWindowExceeded'
    : CODEX_CONTEXT_WINDOW_ERROR_PATTERN.test(error?.message || '');
}

const POST_TOOL_NOTICE = 'The tool may already have run. Check its effects before starting a new request; no tool was replayed.';
const MAX_DYNAMIC_CALLS_PER_TURN = 256;

function postToolFailure(error) {
  if (error?.unsafeToReplayToolTurn) return error;
  const overflow = isCodexContextWindowError(error);
  const failure = copyCodexErrorMetadata(new GatewayError(
    overflow ? 400 : (error?.status || 502),
    overflow ? 'invalid_request_error' : (error?.type || 'api_error'),
    `${error?.message || 'The Codex turn ended.'} ${POST_TOOL_NOTICE}`
  ), error);
  failure.unsafeToReplayToolTurn = true;
  failure.retryable = false;
  return failure;
}

// Independent of the session pool: a correction can evict a failed thread
// without making a delayed retry of its tool-emitting request safe. No raw
// request, tool id, provider message, result, or error detail is retained.
class FailedToolTurnCache {
  constructor() {
    this.identities = new Map();
  }

  remember(identity, fingerprints, calls, failure) {
    const now = Date.now();
    const expires = now + 30 * 60_000;
    let entries = this.identities.get(identity);
    if (!entries) entries = new Map();
    this.identities.delete(identity);
    this.identities.set(identity, entries);
    if (this.identities.size > 256) this.identities.delete(this.identities.keys().next().value);
    const record = { expires, status: failure.status, type: failure.type };
    const put = (key) => {
      // Later socket shutdown or pending-tool expiry must not replace the
      // original status or prolong the idempotency interval for this key.
      if ((entries.get(key)?.expires || 0) > now) return;
      entries.delete(key);
      entries.set(key, record);
      if (entries.size > 1024) entries.delete(entries.keys().next().value);
    };
    for (const call of calls) put('call:' + stableDigest(call));
    for (const fingerprint of fingerprints) put('request:' + fingerprint);
  }

  rejectReplay(identity, fingerprint, calls) {
    const entries = this.identities.get(identity);
    if (!entries) return;
    const now = Date.now();
    const check = (key) => {
      const record = entries.get(key);
      if (!record) return;
      if (record.expires <= now) { entries.delete(key); return; }
      const failure = new GatewayError(record.status, record.type, POST_TOOL_NOTICE);
      failure.unsafeToReplayToolTurn = true;
      failure.retryable = false;
      throw failure;
    };
    check('request:' + fingerprint);
    for (const call of calls) check('call:' + stableDigest(call));
  }
}

function isPossibleCodexContextWindowError(error) {
  if (isCodexContextWindowError(error)) {
    return false;
  }

  return (
    error instanceof GatewayError &&
    error.status === 502 &&
    CODEX_CONTEXT_WINDOW_DRIFT_PATTERN.test(error.message || '')
  );
}

function normalizedComparableReadPath(value) {
  let pathname = String(value || '').replace(/\\/gu, '/');
  if (!pathname) {
    return null;
  }

  let windowsSemantics = false;
  const wslDrive = pathname.match(/^\/mnt\/([a-zA-Z])(?:\/(.*))?$/u);
  if (wslDrive) {
    pathname = `${wslDrive[1]}:/${wslDrive[2] || ''}`;
    windowsSemantics = true;
  } else if (/^[a-zA-Z]:\//u.test(pathname) || pathname.startsWith('//')) {
    windowsSemantics = true;
  }

  const drive = pathname.match(/^([a-zA-Z]):\/(.*)$/u);
  const unc = !drive && pathname.startsWith('//');
  const absolute = Boolean(drive || unc || pathname.startsWith('/'));
  const prefix = drive ? `${drive[1]}:/` : unc ? '//' : pathname.startsWith('/') ? '/' : '';
  const remainder = drive ? drive[2] : pathname.slice(prefix.length);
  const segments = [];
  for (const segment of remainder.split('/')) {
    if (!segment || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (segments.length > 0 && segments.at(-1) !== '..') {
        segments.pop();
        continue;
      }
      if (absolute) {
        return null;
      }
    }
    segments.push(segment);
  }

  let normalized = `${prefix}${segments.join('/')}`;
  if (!normalized && !prefix) {
    return null;
  }
  if (normalized.length > prefix.length && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  if (windowsSemantics) {
    normalized = normalized.toLowerCase();
  }
  return { value: normalized, windowsSemantics };
}

function equivalentReadPaths(left, right) {
  if (left === right) {
    return true;
  }
  const normalizedLeft = normalizedComparableReadPath(left);
  const normalizedRight = normalizedComparableReadPath(right);
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  if (normalizedLeft.windowsSemantics !== normalizedRight.windowsSemantics) {
    return false;
  }
  return normalizedLeft.value === normalizedRight.value;
}

function safePositiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function parseClaudeReadPartialNotice(line) {
  const lineMatch = line.match(
    /^\[Truncated: PARTIAL view — (.+): showing lines (\d+)-(\d+) of (\d+) total \((\d+) tokens, cap (\d+)\)\. Call Read with offset=(\d+) limit=(\d+) for the next page, or Grep to find a specific section\. Do NOT answer from this page alone if the answer may be further in the file\.\]$/u
  );
  if (lineMatch) {
    const [start, end, total, tokenCount, tokenCap, nextOffset, nextLimit] = lineMatch
      .slice(2)
      .map(safePositiveInteger);
    if ([start, end, total, tokenCount, tokenCap, nextOffset, nextLimit].includes(null)) {
      return null;
    }
    return {
      kind: 'lines',
      path: lineMatch[1],
      start,
      end,
      total,
      tokenCount,
      tokenCap,
      nextOffset,
      nextLimit,
    };
  }

  const characterMatch = line.match(
    /^\[Truncated: PARTIAL view — (.+): showing the first (\d+) of (\d+) characters \((\d+) tokens, cap (\d+)\); this file has very long lines and cannot be paginated by line\. Use Grep to find a specific section, or Read with offset\/limit to page through it\. Do NOT answer from this excerpt alone if the answer may be elsewhere in the file\.\]$/u
  );
  if (!characterMatch) {
    return null;
  }
  const [shownCharacters, totalCharacters, tokenCount, tokenCap] = characterMatch
    .slice(2)
    .map(safePositiveInteger);
  if ([shownCharacters, totalCharacters, tokenCount, tokenCap].includes(null)) {
    return null;
  }
  return {
    kind: 'characters',
    path: characterMatch[1],
    shownCharacters,
    totalCharacters,
    tokenCount,
    tokenCap,
  };
}

function validateClaudeReadPartialNotice(notice, pendingToolCall) {
  const request = readRequestInfo(pendingToolCall);
  if (!request.valid) {
    return request.reason;
  }
  if (!equivalentReadPaths(notice.path, request.filePath)) {
    return 'the adjacent Claude Read truncation notice names a different path';
  }
  if (notice.tokenCount <= notice.tokenCap) {
    return 'the adjacent Claude Read truncation notice has an inconsistent token cap';
  }

  if (notice.kind === 'characters') {
    if (!request.wholeFile || notice.shownCharacters >= notice.totalCharacters) {
      return 'the adjacent Claude long-line notice has an inconsistent character range';
    }
    return null;
  }

  const coveredCount = notice.end - notice.start + 1;
  if (
    notice.start !== request.offset ||
    notice.end < notice.start ||
    notice.end >= notice.total ||
    notice.nextOffset !== notice.end + 1 ||
    notice.nextLimit !== coveredCount ||
    (request.limit !== null && coveredCount > request.limit)
  ) {
    return 'the adjacent Claude Read truncation notice has an inconsistent line range or continuation offset';
  }
  return null;
}

function adjacentClaudeReadPartialNotice(requestBody, messageIndex, pendingToolCall) {
  const messages = Array.isArray(requestBody?.messages) ? requestBody.messages : [];
  const message = messages[messageIndex + 1];
  if (message?.role !== 'system') {
    return { status: 'none', notice: null, error: null };
  }

  const content = typeof message.content === 'string'
    ? [{ type: 'text', text: message.content }]
    : Array.isArray(message.content)
      ? message.content
      : [];
  const candidates = [];
  for (const block of content) {
    if (block?.type !== 'text') {
      continue;
    }
    for (const line of String(block.text || '').split(/\r?\n/u)) {
      if (line.startsWith(CLAUDE_READ_PARTIAL_NOTICE_PREFIX)) {
        candidates.push(line);
      }
    }
  }
  if (candidates.length === 0) {
    return { status: 'none', notice: null, error: null };
  }
  if (candidates.length !== 1) {
    return {
      status: 'invalid',
      notice: null,
      error: 'the immediately adjacent system message contains multiple Claude Read partial-view notices',
    };
  }

  const notice = parseClaudeReadPartialNotice(candidates[0]);
  if (!notice) {
    return {
      status: 'invalid',
      notice: null,
      error: 'the immediately adjacent Claude Read partial-view notice does not match the 2.1.250 contract',
    };
  }
  const validationError = validateClaudeReadPartialNotice(notice, pendingToolCall);
  if (validationError) {
    return { status: 'invalid', notice: null, error: validationError };
  }
  return { status: 'validated', notice, error: null };
}

function hasImageResult(content) {
  return Array.isArray(content) && content.some((block) => block?.type === 'image');
}

function imageResultItems(content) {
  return content.map((part) => {
    if (part?.type === 'image') return { type: 'inputImage', imageUrl: codexImageUrl(part) };
    if (part?.type === 'text') return { type: 'inputText', text: part.text || '' };
    if (part?.type === 'tool_reference') return { type: 'inputText', text: referenceText(part) };
    throw new GatewayError(400, 'invalid_request_error', `unsupported tool_result content block type: ${String(part?.type)}`);
  });
}

function imageResultBytes(items) {
  return items.reduce((sum, item) => sum + byteLength(item.imageUrl ?? item.text), 0);
}

function imageBudgetFailure(maxBytes) {
  return utf8PrefixByByteBudget('Image omitted: Codex tool-result byte limit exceeded. Retry with a smaller image or return text.', maxBytes);
}

function toolResultPayloadFromRequest(requestBody, callId) {
  const messages = Array.isArray(requestBody?.messages) ? requestBody.messages : [];
  let messageIndex = messages.length - 1;
  while (messageIndex >= 0 && messages[messageIndex]?.role === 'system') {
    messageIndex -= 1;
  }
  const message = messages[messageIndex];
  if (message?.role !== 'user') {
    return null;
  }

  for (const block of normalizeContentBlocks(message.content, 'tool_result message')) {
    if (block?.type !== 'tool_result') {
      continue;
    }

    if (block.tool_use_id !== callId) {
      continue;
    }

    const unsupported = toolResultContentError(block.content);
    if (unsupported) return { text: unsupported, isError: true, unsupported: true, messageIndex };
    return {
      text: renderToolResultContent(block.content),
      ...(hasImageResult(block.content) ? { contentItems: imageResultItems(block.content) } : {}),
      isError: block.is_error === true,
      messageIndex,
    };
  }

  return null;
}

function extractToolResultPayload(requestBody, pendingToolCall) {
  const payload = toolResultPayloadFromRequest(requestBody, pendingToolCall.callId);
  if (payload) {
    if (!isReadToolName(pendingToolCall.tool)) {
      return payload;
    }
    const readNotice = adjacentClaudeReadPartialNotice(
      requestBody,
      payload.messageIndex,
      pendingToolCall
    );
    return {
      ...payload,
      readNoticeStatus: readNotice.status,
      readPartialNotice: readNotice.notice,
      readNoticeError: readNotice.error,
    };
  }

  throw new GatewayError(
    400,
    'invalid_request_error',
    `missing tool_result for pending tool call ${pendingToolCall.callId}`
  );
}

function prepareCodexToolResultPayload(rawToolResult, pendingToolCall, maxBytes) {
  if (rawToolResult.unsupported) {
    const text = utf8PrefixByByteBudget(rawToolResult.text, maxBytes);
    return {
      rawToolResult,
      readFeedback: { text, feedback: { readTool: isReadToolName(pendingToolCall?.tool), guidanceAppended: false } },
      limitedToolResult: { text, truncated: text !== rawToolResult.text },
    };
  }
  if (rawToolResult.contentItems) {
    // Images cannot be paged as numbered source lines or byte-truncated. An
    // explicit transport limit applies to the complete mixed result.
    const bytes = imageResultBytes(rawToolResult.contentItems);
    if (bytes > maxBytes) {
      const text = imageBudgetFailure(maxBytes);
      return {
        rawToolResult,
        readFeedback: { text, feedback: { readTool: isReadToolName(pendingToolCall?.tool), guidanceAppended: false } },
        limitedToolResult: { text, truncated: true, isError: true, bytes: byteLength(text) },
      };
    }
    return {
      rawToolResult,
      readFeedback: { text: rawToolResult.text, feedback: { readTool: false, guidanceAppended: false } },
      limitedToolResult: { text: rawToolResult.text, truncated: false, contentItems: rawToolResult.contentItems, bytes },
    };
  }
  const readFeedback = appendReadToolResultFeedback(rawToolResult.text, pendingToolCall, rawToolResult.isError);
  const limitedToolResult = limitCodexToolResultText(readFeedback.text, maxBytes, {
    toolName: pendingToolCall?.tool,
    pendingToolCall,
    isError: rawToolResult.isError,
    readNoticeStatus: rawToolResult.readNoticeStatus,
    readPartialNotice: rawToolResult.readPartialNotice,
    readNoticeError: rawToolResult.readNoticeError,
  });
  return { rawToolResult, readFeedback, limitedToolResult };
}

export function prepareCodexToolResult(requestBody, pendingToolCall, maxBytes) {
  return prepareCodexToolResultPayload(
    extractToolResultPayload(requestBody, pendingToolCall),
    pendingToolCall,
    maxBytes
  );
}

function toolResultPayloadDiagnostics(requestBody, callId) {
  try {
    return {
      payload: toolResultPayloadFromRequest(requestBody, callId),
      parseError: null,
    };
  } catch (error) {
    return {
      payload: null,
      parseError: error?.message || String(error),
    };
  }
}

function readRequestDiagnostics(requestBody, pendingToolCall = null) {
  const diagnostics = {
    pending_read_tool: isReadToolName(pendingToolCall?.tool),
    read_sanitization: readSanitizationTrace(pendingToolCall?.readSanitization),
    matching_read_tool_result: false,
    read_tool_result_bytes: 0,
    read_tool_result_estimated_tokens: 0,
    read_tool_result_lines: 0,
    read_tool_result_is_error: false,
    read_tool_result_parse_error: null,
  };

  if (!diagnostics.pending_read_tool || !pendingToolCall?.callId) {
    return diagnostics;
  }

  const payloadDiagnostics = toolResultPayloadDiagnostics(requestBody, pendingToolCall.callId);
  if (payloadDiagnostics.parseError) {
    diagnostics.read_tool_result_parse_error = payloadDiagnostics.parseError;
    return diagnostics;
  }

  const payload = payloadDiagnostics.payload;
  if (!payload) {
    return diagnostics;
  }

  diagnostics.matching_read_tool_result = true;
  diagnostics.read_tool_result_bytes = byteLength(payload.text);
  diagnostics.read_tool_result_estimated_tokens = approxCodexOutputTokenCount(payload.text);
  diagnostics.read_tool_result_lines = countOutputLines(payload.text);
  diagnostics.read_tool_result_is_error = payload.isError;
  return diagnostics;
}

function mapReasoningEffort(reasoningEffort) {
  if (typeof reasoningEffort !== 'string' || reasoningEffort.trim() === '') {
    return null;
  }

  const normalized = reasoningEffort.trim().toLowerCase();
  if (!CODEX_REASONING_EFFORTS.has(normalized)) {
    return null;
  }

  return normalized;
}

function stableDigest(text) {
  // Session routing keys separate app-server threads that may contain
  // different users, tools, and system prompts. Keep the complete SHA-256
  // digest so attacker-controlled request material cannot feasibly collide.
  return crypto.createHash('sha256').update(text).digest('hex');
}

function buildSessionIdentityKey(route, req) {
  return `identity:${stableDigest(
    JSON.stringify([
      req.get('x-claude-code-session-id') || 'no-session',
      req.get('x-claude-code-agent-id') || 'root-agent',
      req.get('x-claude-code-parent-agent-id') || 'no-parent',
      route.requestedModel,
    ])
  )}`;
}

function buildSessionBaseKey(route, req, requestBody) {
  const identityKey = buildSessionIdentityKey(route, req);
  const toolKey = stableDigest(effectiveToolSchemaSignature(requestBody));
  const systemKey = stableDigest(renderSystemPrompt(requestBody));
  return `${identityKey}:${toolKey}:${systemKey}`;
}

function buildForkSessionKey(baseKey, fingerprint) {
  return `${baseKey}:fork:${fingerprint}`;
}

function requestHeader(req, name) {
  return String(req.get(name) || '').trim();
}

export function isClaudeWorkflowAgentRequest(req) {
  const agentId = requestHeader(req, 'x-claude-code-agent-id');
  const parentAgentId = requestHeader(req, 'x-claude-code-parent-agent-id');
  return Boolean(agentId || parentAgentId);
}

function codexThreadSourceForRequest(req) {
  return isClaudeWorkflowAgentRequest(req) ? 'subagent' : 'user';
}

function traceLog(tracer, event, details = {}) {
  tracer?.log?.(event, details);
}

function validateCodexRequestControls(requestBody) {
  rejectInlineToolChanges(requestBody.messages);
  if (requestBody.compaction !== undefined) rejectCodexCompaction();
  codexOutputSchema(requestBody);
  const tools = effectiveCodexTools(requestBody);
  if (tools.some(tool => tool?.name === 'DeferredToolPlaceholder' && tool.defer_loading === true)) {
    // Claude 2.1.305+ recognizes this error and can resend the actual schemas.
    // Reject before opening a thread or performing any model/tool work.
    throw new GatewayError(400, 'invalid_request_error',
      'defer_loading is not supported for DeferredToolPlaceholder on Codex. Set ENABLE_TOOL_SEARCH=false so Claude sends its tool schemas up front.');
  }
  validateCodexContentBlocks(requestBody);
}

function extractToolResultIds(requestBody) {
  const toolResultIds = new Set();
  for (const block of latestUserContentBlocks(requestBody, 'tool_result message')) {
    if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string' && block.tool_use_id) {
      toolResultIds.add(block.tool_use_id);
    }
  }
  return toolResultIds;
}

function validateCodexContentBlocks(requestBody) {
  const messages = Array.isArray(requestBody?.messages) ? requestBody.messages : [];
  for (const [index, message] of messages.entries()) {
    const blocks = normalizeContentBlocks(
      message?.content,
      `${message?.role || 'message'} content`
    );
    if (message?.role === 'system') {
      const user = messages[index - 1];
      const assistant = messages[index - 2];
      const readCalls = assistant?.role === 'assistant' && Array.isArray(assistant.content)
        ? assistant.content.filter(b => b?.type === 'tool_use' && b.name === 'Read').map(b => b.id) : [];
      const afterRead = user?.role === 'user' && Array.isArray(user.content) &&
        user.content.some(b => b?.type === 'tool_result' && readCalls.includes(b.tool_use_id));
      validateCodexSystemMessage(blocks, line => afterRead && Boolean(parseClaudeReadPartialNotice(line)));
      continue;
    }
    for (const block of blocks) {
      if (block?.type === 'compaction') {
        rejectCodexCompaction();
      } else if (block?.type === 'document') {
        rejectCodexDocumentAttachment();
      } else if (block?.type === 'image') {
        codexImageUrl(block);
      } else if (!['text', 'tool_result', 'tool_use', 'thinking', 'redacted_thinking'].includes(block?.type)) {
        throw new GatewayError(400, 'invalid_request_error',
          `Codex cannot represent ${String(block?.type)} in a ${message?.role} message; use the native Anthropic route or supply text.`);
      }
    }
  }
}

class CodexAppServerConnection extends EventEmitter {
  constructor(config, model) {
    super();
    this.config = config;
    this.model = model;
    this.child = null;
    this.toolCatalogPromise = null;
    this.stopPromise = null;
    this.buffer = '';
    this.nextRequestId = 1;
    this.pendingRequests = new Map();
    this.inboundMessages = [];
    this.pendingInboundEvents = [];
    this.drainingInboundMessages = false;
    this.initialized = false;
    this.dynamicToolsOnlyConfigOverrides = null;
    this.closed = false;
    this.closing = false;
    this.rpcTimeoutMs = Math.max(
      5_000,
      Math.min(Number(this.config.requestTimeoutMs) || 5 * 60_000, 60_000)
    );
    this.closeKillTimeoutMs = Math.max(
      100,
      Number(this.config.codex.closeKillTimeoutMs) || DEFAULT_CLOSE_KILL_TIMEOUT_MS
    );
    this.on('error', noop);
    this.readyPromise = this.start();
    this.readyPromise.catch((error) => this.close(error).catch(noop));
  }

  async start() {
    const args = ['app-server'];
    if (this.config.codex.dynamicToolsOnly === true) {
      this.toolCatalogPromise = createCodexToolCatalog({
        command: this.config.codex.command,
        cwd: this.config.codex.cwd,
        model: this.model,
      });
      const catalog = await this.toolCatalogPromise;
      if (this.closed) {
        await catalog.dispose();
        throw new GatewayError(502, 'api_error', 'Codex app-server was closed during startup');
      }
      // Startup is required: thread/start config cannot replace the shared
      // models manager. This private snapshot lasts only for this connection.
      args.push('-c', `model_catalog_json=${JSON.stringify(catalog.filePath)}`);
    }
    this.child = spawn(this.config.codex.command, args, {
      cwd: this.config.codex.cwd,
      detached: SUPPORTS_PROCESS_GROUP_SIGNALS,
      env: environmentWithoutGatewayAndAnthropicCredentials(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', this.handleStdout.bind(this));
    this.child.stderr.on('data', this.handleStderr.bind(this));
    this.child.stdin.on('error', this.handleStdinError.bind(this));
    this.child.on('error', this.handleExit.bind(this));
    this.child.on('close', this.handleClose.bind(this));

    const initializeResult = await this.rawRequest('initialize', {
      clientInfo: {
        name: 'claude_workflow_gateway',
        title: 'Claude Workflow Gateway',
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });

    this.send({
      method: 'initialized',
    });
    this.initialized = true;
    assertDynamicToolsOnlyCodexCompatibility(this.config, initializeResult);
    if (this.config?.codex?.dynamicToolsOnly === true) {
      const discoveredConfig = await this.rawRequest('config/read', {
        cwd: this.config.codex.cwd,
        includeLayers: true,
      });
      this.dynamicToolsOnlyConfigOverrides =
        codexDynamicToolsOnlyConfigOverrides(discoveredConfig);
    }
    return initializeResult;
  }

  handleStdout(chunk) {
    this.buffer += chunk;

    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      newlineIndex = this.buffer.indexOf('\n');

      if (!line.trim()) {
        continue;
      }

      let message = null;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this.handleExit(
          new GatewayError(502, 'api_error', 'Codex app-server returned invalid JSON')
        );
        continue;
      }

      this.inboundMessages.push(message);
    }
    void this.drainInboundMessages();
  }

  async drainInboundMessages() {
    if (this.drainingInboundMessages) {
      return;
    }
    this.drainingInboundMessages = true;
    try {
      while (this.inboundMessages.length > 0) {
        const message = this.inboundMessages.shift();
        try {
          this.handleMessage(message);
        } catch (error) {
          this.handleExit(error);
        }
        // A response may resolve an awaited RPC that installs listeners for
        // the next notification or server request. Let that continuation run
        // before dispatching another line from the same stdout chunk.
        await Promise.resolve();
      }
    } finally {
      this.drainingInboundMessages = false;
      if (this.inboundMessages.length > 0) {
        void this.drainInboundMessages();
      }
    }
  }

  handleStderr(chunk) {
    const text = chunk.toString('utf8').trim();
    if (!text) {
      return;
    }
    this.emit('stderr', text);
  }

  handleStdinError(error) {
    this.handleExit(
      new GatewayError(
        502,
        'api_error',
        `Codex app-server stdin failed: ${error?.message || String(error)}`
      )
    );
  }

  handleExit(error) {
    if (this.closed && this.pendingRequests.size === 0) {
      return;
    }

    const failure =
      error instanceof GatewayError
        ? error
        : new GatewayError(
            502,
            'api_error',
            error instanceof Error ? error.message : 'Codex app-server failed'
          );

    this.closed = true;
    for (const requestId of this.pendingRequests.keys()) {
      this.rejectPendingRequest(requestId, failure);
    }
    this.emit('error', failure);
    void this.stopChild().catch(noop);
  }

  handleClose(code, signal) {
    if (this.closing) {
      this.closed = true;
      return;
    }

    let reason = `code ${String(code)}`;
    if (code === 0 && !signal && this.pendingRequests.size > 0) {
      reason = 'code 0 before pending requests completed';
    } else if (signal) {
      reason = `signal ${signal}`;
    }

    this.handleExit(
      new GatewayError(
        502,
        'api_error',
        `Codex app-server exited unexpectedly with ${reason}`
      )
    );
  }

  handleMessage(message) {
    if (message.id !== undefined && message.method === undefined && message.error === undefined) {
      this.resolvePendingRequest(message.id, message.result ?? null);
      return;
    }

    if (message.id !== undefined && message.error !== undefined) {
      this.rejectPendingRequest(message.id, codexRpcGatewayError(message.error));
      return;
    }

    if (message.method && message.id !== undefined) {
      if (message.method === CODEX_DYNAMIC_TOOL_CALL_METHOD) {
        this.dispatchInboundEvent('server-request', message);
      } else {
        this.send({
          id: message.id,
          error: {
            code: JSON_RPC_METHOD_NOT_FOUND,
            message: `Method not found: ${message.method}`,
          },
        });
      }
      return;
    }

    if (message.method) {
      this.dispatchInboundEvent('notification', message);
    }
  }

  dispatchInboundEvent(eventName, message) {
    if (this.listenerCount(eventName) > 0) {
      this.emit(eventName, message);
      return;
    }

    if (this.pendingInboundEvents.length >= MAX_PENDING_INBOUND_EVENTS) {
      throw new GatewayError(
        502,
        'api_error',
        `Codex app-server exceeded ${MAX_PENDING_INBOUND_EVENTS} queued inbound events before the turn was ready`
      );
    }
    this.pendingInboundEvents.push({ eventName, message });
  }

  subscribeToTurn(onNotification, onServerRequest, onError) {
    this.on('notification', onNotification);
    this.on('server-request', onServerRequest);
    this.on('error', onError);

    const queuedEvents = this.pendingInboundEvents.splice(0);
    for (const event of queuedEvents) {
      if (this.closed) {
        break;
      }
      try {
        this.emit(event.eventName, event.message);
      } catch (error) {
        this.handleExit(error);
        break;
      }
    }
  }

  send(message) {
    if (!this.child || this.closed) {
      throw new GatewayError(502, 'api_error', 'Codex app-server is not available');
    }

    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) {
          this.handleStdinError(error);
        }
      });
    } catch (error) {
      this.handleStdinError(error);
      throw error;
    }
  }

  async request(method, params) {
    await this.readyPromise;
    let lastError = null;
    for (let attempt = 0; attempt <= CODEX_OVERLOAD_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        return await this.rawRequest(method, params);
      } catch (error) {
        lastError = error;
        if (
          error?.codexRpcCode !== CODEX_APP_SERVER_OVERLOADED_RPC_CODE ||
          attempt >= CODEX_OVERLOAD_RETRY_DELAYS_MS.length
        ) {
          throw error;
        }
        const baseDelay = CODEX_OVERLOAD_RETRY_DELAYS_MS[attempt];
        const jitter = crypto.randomInt(0, Math.max(1, Math.floor(baseDelay / 4)));
        await waitForMilliseconds(baseDelay + jitter);
      }
    }
    throw lastError;
  }

  rawRequest(method, params) {
    const requestId = ++this.nextRequestId;

    return new Promise(function waitForResponse(resolve, reject) {
      const timeout = setTimeout(() => {
        this.rejectPendingRequest(
          requestId,
          new GatewayError(
            504,
            'api_error',
            `Codex app-server request timed out while waiting for ${method}`
          )
        );
      }, this.rpcTimeoutMs);

      this.pendingRequests.set(requestId, { resolve, reject, timeout });
      try {
        this.send({
          id: requestId,
          method,
          params,
        });
      } catch (error) {
        this.rejectPendingRequest(requestId, error);
      }
    }.bind(this));
  }

  resolvePendingRequest(requestId, result) {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(requestId);
    pending.resolve(result);
  }

  rejectPendingRequest(requestId, error) {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(requestId);
    pending.reject(error);
  }

  async close(reason = null) {
    if (this.closed) {
      await this.stopChild();
      return;
    }

    this.closed = true;
    this.closing = true;
    const failure =
      reason instanceof GatewayError
        ? reason
        : new GatewayError(502, 'api_error', 'Codex app-server was closed');
    for (const requestId of this.pendingRequests.keys()) {
      this.rejectPendingRequest(requestId, failure);
    }

    // A running turn may have no outstanding RPC: its consumer is waiting for
    // notifications. Settle that boundary before shutting down the transport.
    this.emit('error', failure);
    await this.stopChild();
  }

  async releaseToolCatalog() {
    const catalog = await this.toolCatalogPromise?.catch(() => null);
    await catalog?.dispose();
  }

  async stopChild() {
    if (this.stopPromise) {
      return this.stopPromise;
    }

    const child = this.child;
    if (!child) {
      await this.releaseToolCatalog();
      return;
    }

    this.stopPromise = new Promise((resolve) => {
      let settled = false;
      const childAlreadyExited = child.exitCode !== null || child.signalCode !== null;
      const killTimer = setTimeout(function killStubbornChild() {
        const killSignaled = signalChildProcessTree(child, 'SIGKILL');
        const childExited = child.exitCode !== null || child.signalCode !== null;
        if (childAlreadyExited || childExited || !killSignaled) {
          finish();
        }
      }, this.closeKillTimeoutMs);
      const hardStopTimer = setTimeout(
        function finishAfterHardStopDeadline() {
          signalChildProcessTree(child, 'SIGKILL');
          finish();
        },
        Math.max(this.closeKillTimeoutMs + 100, this.closeKillTimeoutMs * 2)
      );

      function finish() {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(killTimer);
        clearTimeout(hardStopTimer);
        child.off('close', finishWhenProcessTreeExited);
        resolve();
      }

      function finishWhenProcessTreeExited() {
        if (childProcessTreeExists(child)) {
          return;
        }
        finish();
      }

      if (!childAlreadyExited) {
        child.once('close', finishWhenProcessTreeExited);
      }
      if (!signalChildProcessTree(child, 'SIGTERM')) {
        finish();
      }
    }).finally(() => this.releaseToolCatalog());

    return this.stopPromise;
  }
}

class CodexGatewaySession {
  constructor(config, route, req, requestBody, sessionKey = null, tracer = null, options = {}) {
    this.config = config;
    this.route = route;
    this.requestedModel = route.requestedModel;
    this.effectiveTools = effectiveCodexTools(requestBody);
    this.toolSignature = toolSchemaSignature(this.effectiveTools);
    this.toolRegistry = buildCodexDynamicToolRegistry(this.effectiveTools);
    this.identityKey = buildSessionIdentityKey(route, req);
    this.baseSessionKey = buildSessionBaseKey(route, req, requestBody);
    this.sessionKey = sessionKey || this.baseSessionKey;
    this.tracer = tracer?.scope?.({
      base_session_key: this.baseSessionKey,
      session_key: this.sessionKey,
      requested_model: this.requestedModel,
      upstream_model: this.route.upstreamModel,
      sandbox: this.route.sandbox,
      approval_policy: this.route.approvalPolicy,
    }) || null;
    this.systemPrompt = renderSystemPrompt(requestBody);
    this.connection = new CodexAppServerConnection(config, route.upstreamModel);
    this.bootstrapMode = options.bootstrapMode || '';
    // Shared per-upstream-model context windows learned from app-server usage
    // events, provided by the owning session manager.
    this.contextWindows = options.contextWindows || null;
    this.threadSource = codexThreadSourceForRequest(req);
    this.ephemeralThread = this.threadSource === 'subagent';
    this.threadId = null;
    this.actualModel = this.route.upstreamModel;
    this.pendingToolCall = null;
    this.queuedToolCalls = [];
    this.seenToolCallIds = new Set();
    this.toolBoundaryFingerprints = new Set();
    this.failedToolTurns = options.failedToolTurns;
    this.toolTurnFailed = false;
    this.activeBoundary = null;
    this.interBoundaryListeners = null;
    this.routingReservation = null;
    this.transcriptAnchor = null;
    this.toolResultWindowBytes = 0;
    this.latestTotalUsage = emptyUsage();
    this.latestContextTokens = 0;
    this.idleTimer = null;
    this.pendingToolTimer = null;
    this.lastUsedSequence = 0;
    this.disposed = false;

    traceLog(this.tracer, 'codex.session.created', {
      tool_count: this.effectiveTools.length,
      thread_source: this.threadSource,
      ephemeral_thread: this.ephemeralThread,
      dynamic_tools_only: this.config.codex.dynamicToolsOnly === true,
    });
  }

  scopedTracer(requestTracer = null) {
    const rootTracer = requestTracer || this.tracer;
    return rootTracer?.scope?.({
      base_session_key: this.baseSessionKey,
      session_key: this.sessionKey,
      requested_model: this.requestedModel,
      upstream_model: this.route.upstreamModel,
      sandbox: this.route.sandbox,
      approval_policy: this.route.approvalPolicy,
    }) || null;
  }

  touch(
    onExpire,
    timeoutMs = this.config.codex.idleTimeoutMs,
    pendingToolTimeoutMs = DEFAULT_PENDING_TOOL_TIMEOUT_MS
  ) {
    clearTimeout(this.idleTimer);
    clearTimeout(this.pendingToolTimer);
    this.idleTimer = null;
    this.pendingToolTimer = null;
    if (this.routingReservation || (this.activeBoundary && !this.activeBoundary.finished)) {
      return;
    }

    if (this.pendingToolCall) {
      const effectivePendingTimeoutMs = Math.max(
        0,
        numberOrDefault(pendingToolTimeoutMs, DEFAULT_PENDING_TOOL_TIMEOUT_MS)
      );
      if (effectivePendingTimeoutMs <= 0) {
        return;
      }

      this.pendingToolTimer = setTimeout(() => {
        onExpire(this.sessionKey, 'pending_tool_timeout');
      }, effectivePendingTimeoutMs);
      this.pendingToolTimer.unref?.();
      return;
    }

    const effectiveTimeoutMs = Math.max(0, numberOrDefault(timeoutMs, 0));
    if (effectiveTimeoutMs <= 0 || !this.isIdle()) {
      return;
    }

    this.idleTimer = setTimeout(() => {
      onExpire(this.sessionKey, 'idle_timeout');
    }, effectiveTimeoutMs);
    this.idleTimer.unref?.();
  }

  clearIdleTimer() {
    clearTimeout(this.idleTimer);
    clearTimeout(this.pendingToolTimer);
    this.idleTimer = null;
    this.pendingToolTimer = null;
  }

  isIdle() {
    return (
      !this.routingReservation &&
      !this.pendingToolCall &&
      (!this.activeBoundary || this.activeBoundary.finished)
    );
  }

  isDisposableIdle() {
    return this.isIdle();
  }

  isCapacityEvictable() {
    if (this.isDisposableIdle() || this.pendingToolCall?.ended) {
      return true;
    }

    // StructuredOutput is terminal when Claude accepts it, but a schema
    // rejection arrives as a follow-up tool_result on this same session. Keep
    // the live session for that correction path; only treat it as disposable
    // when a full pool must admit other work. A rejected result can still
    // recover from the authoritative Claude transcript after such an eviction.
    return (
      this.ephemeralThread === true &&
      !this.routingReservation &&
      this.activeBoundary?.finished === true &&
      this.pendingToolCall?.tool === STRUCTURED_OUTPUT_TOOL_NAME
    );
  }

  isForkSession() {
    return this.sessionKey !== this.baseSessionKey;
  }

  knownModelContextWindow() {
    const own = Number(this.modelContextWindow || 0);
    if (own > 0) {
      return own;
    }

    const shared = Number(this.contextWindows?.get(this.actualModel) || 0);
    return shared > 0 ? shared : 0;
  }

  inputMaxTokens() {
    return effectiveCodexInputMaxTokens(
      this.config,
      this.route,
      this.knownModelContextWindow()
    );
  }

  bootstrapInputMaxTokens() {
    return this.inputMaxTokens();
  }

  resetToolResultWindow(reason, tracer = null) {
    if (this.toolResultWindowBytes <= 0) {
      return;
    }

    traceLog(tracer || this.tracer, 'codex.tool_result_window.reset', {
      reason,
      previous_tool_result_window_bytes: this.toolResultWindowBytes,
    });
    this.toolResultWindowBytes = 0;
  }

  applyTokenUsage(tokenUsagePayload, usageBaseline, turnId, tracer = null) {
    const tokenUsage = normalizeCodexTokenUsage(tokenUsagePayload);
    // `total` is cumulative for the app-server thread; subtract the boundary
    // baseline to capture every upstream response in this Claude turn. `last`
    // is only the final Responses API completion and can undercount turns that
    // compact, retry internally, or invoke built-in control work.
    const usage = tokenUsage.total
      ? usageDelta(tokenUsage.total, usageBaseline)
      : tokenUsage.last || emptyUsage();
    this.latestTotalUsage = tokenUsage.total || addUsage(usageBaseline, usage);
    if (tokenUsage.model_context_window) {
      this.modelContextWindow = tokenUsage.model_context_window;
      this.contextWindows?.set(this.actualModel, tokenUsage.model_context_window);
    }

    // Prefer the per-turn snapshot (tracks shrinkage after app-server
    // compaction); fall back to the cumulative total, which overestimates
    // live context — the safe direction for recycle pressure.
    const previousContextTokens = this.latestContextTokens || 0;
    const latestContextTokens =
      contextTokensFromUsage(tokenUsage.last) ||
      contextTokensFromUsage(tokenUsage.total) ||
      previousContextTokens ||
      0;
    this.latestContextTokens = latestContextTokens;
    if (
      previousContextTokens > 0 &&
      latestContextTokens > 0 &&
      latestContextTokens < Math.floor(previousContextTokens * CODEX_CONTEXT_DROP_RESET_FRACTION)
    ) {
      this.resetToolResultWindow('context_usage_drop', tracer);
    }
    traceLog(tracer || this.tracer, 'codex.usage.updated', {
      turn_id: turnId,
      usage,
      total_usage: tokenUsage.total,
      last_usage: tokenUsage.last,
      model_context_window: tokenUsage.model_context_window,
      previous_context_tokens: previousContextTokens,
      latest_context_tokens: latestContextTokens,
    });

    return usage;
  }

  applyRawResponseUsage(
    usagePayload,
    accumulatedUsage,
    usageBaseline,
    turnId,
    tracer = null
  ) {
    if (!usagePayload) {
      return null;
    }

    const responseUsage = normalizeUsageBreakdown(usagePayload);
    const usage = addUsage(accumulatedUsage, responseUsage);
    this.latestTotalUsage = addUsage(usageBaseline, usage);

    // rawResponse/completed describes one upstream response rather than an
    // accumulated thread total. Its input is nevertheless the best immediate
    // view of live context on a dynamic-tool boundary.
    const previousContextTokens = this.latestContextTokens || 0;
    const latestContextTokens =
      contextTokensFromUsage(responseUsage) || previousContextTokens || 0;
    this.latestContextTokens = latestContextTokens;
    if (
      previousContextTokens > 0 &&
      latestContextTokens > 0 &&
      latestContextTokens < Math.floor(previousContextTokens * CODEX_CONTEXT_DROP_RESET_FRACTION)
    ) {
      this.resetToolResultWindow('raw_response_context_usage_drop', tracer);
    }
    traceLog(tracer || this.tracer, 'codex.raw_response_usage.updated', {
      turn_id: turnId,
      response_usage: responseUsage,
      accumulated_usage: usage,
      previous_context_tokens: previousContextTokens,
      latest_context_tokens: latestContextTokens,
    });

    return usage;
  }

  rejectUnhandledServerRequest(message) {
    if (message?.id === undefined) {
      return;
    }
    this.connection.send({
      id: message.id,
      error: {
        code: JSON_RPC_METHOD_NOT_FOUND,
        message: `Method not found: ${message.method || 'unknown'}`,
      },
    });
  }

  handleInvalidOrPendingToolCall(message, turnId, tracer = null, fromQueue = false) {
    if (
      message.method !== 'item/tool/call' ||
      message.params?.turnId !== turnId
    ) {
      return false;
    }

    const params = message.params;
    if (this.pendingToolCall?.ended) {
      this.connection.send({ id: message.id, error: { code: -32000, message: 'Codex turn already ended' } });
      return true;
    }
    if (!this.toolRegistry.byInternalName.has(params.tool) || typeof params.callId !== 'string' || !params.callId) {
      this.connection.send({
        id: message.id,
        error: { code: -32602, message: 'Unregistered dynamic tool or missing call id' },
      });
      return true;
    }
    if ((!fromQueue && (this.seenToolCallIds.has(params.callId) || this.seenToolCallIds.size >= MAX_DYNAMIC_CALLS_PER_TURN)) ||
        (this.pendingToolCall && this.queuedToolCalls.length >= MAX_PENDING_INBOUND_EVENTS)) {
      this.connection.send({
        id: message.id,
        error: { code: -32602, message: 'Duplicate tool call id or too many tool calls on this turn' },
      });
      return true;
    }
    this.seenToolCallIds.add(params.callId);
    if (!this.pendingToolCall) return false;
    // Keep the original JSON-RPC request open. Claude owns execution and receives
    // the next tool_use as soon as it supplies the previous result, on this turn.
    this.queuedToolCalls.push(message);
    traceLog(tracer || this.tracer, 'codex.tool_call.queued', {
      turn_id: turnId,
      call_id: params.callId || null,
      tool_name: originalToolName(this.toolRegistry, params.tool),
      pending_call_id: this.pendingToolCall.callId,
      queue_length: this.queuedToolCalls.length,
    });
    return true;
  }

  stopInterBoundaryCapture() {
    if (!this.interBoundaryListeners) {
      return;
    }
    const listeners = this.interBoundaryListeners;
    this.interBoundaryListeners = null;
    this.connection.off('notification', listeners.notification);
    this.connection.off('server-request', listeners.serverRequest);
    this.connection.off('error', listeners.error);
  }

  fenceFailedToolTurn(error, fingerprint = this.activeBoundary?.requestFingerprint) {
    // An RPC merely queued by Codex has not been exposed to Claude. No tool
    // could have run until at least one tool_use boundary was delivered.
    if (!this.toolBoundaryFingerprints.size) return error;
    this.toolTurnFailed = true;
    if (fingerprint) this.toolBoundaryFingerprints.add(fingerprint);
    const failure = postToolFailure(error);
    this.failedToolTurns?.remember(this.identityKey, this.toolBoundaryFingerprints, this.seenToolCallIds, failure);
    return failure;
  }

  captureInterBoundaryEvents(turnId, usageBaseline, tracer = null) {
    this.stopInterBoundaryCapture();
    const notification = (message) => {
      const finalError = message.method === 'error' && message.params?.turnId === turnId &&
        message.params.willRetry !== true;
      const completed = message.method === 'turn/completed' && message.params?.turn?.id === turnId;
      if (finalError || completed) {
        const pending = this.pendingToolCall;
        if (pending && !pending.ended) {
          // Claude may already have executed the first tool. Keep its ID and
          // request fingerprint until the normal pending timeout: retries must
          // fail on this turn, not replay the tool or open a fresh thread.
          pending.ended = true;
          const turnError = finalError ? message.params.error : message.params.turn.error;
          this.fenceFailedToolTurn(turnError ? codexTurnGatewayError(turnError) :
            new GatewayError(400, 'invalid_request_error', 'The Codex turn ended while Claude was handling its tool call.'));
          const queued = this.queuedToolCalls.splice(0);
          traceLog(tracer || this.tracer, 'codex.tool_call.turn_ended', {
            turn_id: turnId, pending_call_id: pending.callId, discarded_calls: queued.length,
            status: finalError ? 'error' : message.params.turn.status,
          });
          for (const id of [pending.requestId, ...queued.map(call => call.id)]) {
            this.connection.send({ id, error: { code: -32000, message: 'Codex turn already ended' } });
          }
        }
        return;
      }
      if (
        message.method !== 'thread/tokenUsage/updated' ||
        message.params?.turnId !== turnId ||
        (!message.params?.tokenUsage?.total && !message.params?.tokenUsage?.last)
      ) {
        return;
      }
      this.applyTokenUsage(message.params.tokenUsage, usageBaseline, turnId, tracer);
    };
    const serverRequest = (message) => {
      if (!this.handleInvalidOrPendingToolCall(message, turnId, tracer)) {
        this.rejectUnhandledServerRequest(message);
      }
    };
    const error = () => {
      this.stopInterBoundaryCapture();
    };
    this.interBoundaryListeners = { notification, serverRequest, error };
    this.connection.on('notification', notification);
    this.connection.on('server-request', serverRequest);
    this.connection.on('error', error);
  }

  initialInputMode() {
    return this.bootstrapMode || 'transcript';
  }

  transcriptRenderOptions() {
    return {
      toolResultMaxBytes: codexToolResultMaxBytes(this.config),
      toolResultWindowMaxBytes: codexToolResultWindowMaxBytes(this.config),
      readInlineMaxBytes: Math.min(
        codexToolResultMaxBytes(this.config),
        codexReadInlineMaxBytes(this.config, this.route)
      ),
    };
  }

  isTranscriptContinuous(requestBody) {
    return matchesContinuityAnchor(requestBody, this.transcriptAnchor);
  }

  initialTurnInput(requestBody) {
    return this.prepareInitialTurnInput(requestBody).text;
  }

  prepareInitialTurnInput(requestBody, renderOptions = this.transcriptRenderOptions()) {
    const maxTokens = this.bootstrapInputMaxTokens();
    const mode = this.initialInputMode();
    if (mode === 'latest') {
      const renderedMessages = renderedTranscriptMessages(requestBody, renderOptions);
      const text = renderLatestUserTranscriptInput(requestBody, maxTokens, renderOptions, renderedMessages);
      return {
        text,
        summary: summarizeLatestTurnInput(requestBody, text, maxTokens, renderedMessages),
      };
    }

    return renderTranscriptInputWithSummary(requestBody, maxTokens, renderOptions);
  }

  prepareTurnInput(requestBody, threadExists, renderOptions = this.transcriptRenderOptions()) {
    if (!threadExists) {
      return this.prepareInitialTurnInput(requestBody, renderOptions);
    }

    const maxTokens = this.inputMaxTokens();
    const text = limitTextByTokenBudget(extractLatestUserText(requestBody, renderOptions), maxTokens);
    const renderedMessages = renderedTranscriptMessages(requestBody, renderOptions);
    return {
      text,
      summary: summarizeLatestTurnInput(requestBody, text, maxTokens, renderedMessages),
    };
  }

  assertCompatible(route, requestBody, options = {}) {
    if (route.upstreamModel !== this.route.upstreamModel) {
      throw new GatewayError(
        400,
        'invalid_request_error',
        'changing the routed Codex model inside an active Claude session is not supported yet'
      );
    }

    if (!options.skipToolSignature && effectiveToolSchemaSignature(requestBody) !== this.toolSignature) {
      throw new GatewayError(
        400,
        'invalid_request_error',
        'changing the routed tool schema inside an active Claude session is not supported yet'
      );
    }

    if (route.sandbox !== this.route.sandbox) {
      throw new GatewayError(
        400,
        'invalid_request_error',
        'changing the routed Codex sandbox inside an active Claude session is not supported yet'
      );
    }

    if (route.approvalPolicy !== this.route.approvalPolicy) {
      throw new GatewayError(
        400,
        'invalid_request_error',
        'changing the routed Codex approval policy inside an active Claude session is not supported yet'
      );
    }
  }

  async ensureThread() {
    if (this.threadId) {
      return;
    }

    await this.connection.readyPromise;
    const threadConfig = codexThreadConfigOverrides(
      this.config,
      this.route,
      this.connection.dynamicToolsOnlyConfigOverrides
    );
    const threadStartParams = {
      model: this.route.upstreamModel,
      cwd: this.config.codex.cwd,
      approvalPolicy: this.route.approvalPolicy,
      sandbox: this.route.sandbox,
      developerInstructions: this.systemPrompt || null,
      dynamicTools: this.toolRegistry.dynamicTools,
      serviceName: 'claude_workflow_gateway',
      threadSource: this.threadSource,
      ...(Object.keys(threadConfig).length > 0 ? { config: threadConfig } : {}),
      ...(this.ephemeralThread ? { ephemeral: true } : {}),
      ...(this.config.codex.dynamicToolsOnly === true
        ? { environments: [], selectedCapabilityRoots: [] }
        : {}),
    };
    const result = await this.connection.request('thread/start', threadStartParams);

    this.threadId = result.thread?.id || null;
    if (!this.threadId) {
      throw new GatewayError(502, 'api_error', 'Codex app-server did not return a thread id');
    }
    this.actualModel = result.model || this.route.upstreamModel;

    traceLog(this.tracer, 'codex.thread.started', {
      thread_id: this.threadId,
      thread_source: this.threadSource,
      ephemeral_thread: this.ephemeralThread,
      dynamic_tools_only: this.config.codex.dynamicToolsOnly === true,
      actual_model: this.actualModel,
      thread_config: threadConfig,
    });
  }

  async startTurn(requestBody, requestTracer = null) {
    const threadExists = Boolean(this.threadId);
    await this.ensureThread();
    const images = turnImages(requestBody);
    const preparedInput = this.prepareTurnInput(requestBody, threadExists, {
      ...this.transcriptRenderOptions(), images,
    });
    const imageTokens = images.tokens(preparedInput.text);
    if (imageTokens > 0) {
      const textBudget = preparedInput.summary.max_tokens - imageTokens;
      if (preparedInput.summary.max_tokens !== null && textBudget <= 0) {
        throw new GatewayError(413, 'invalid_request_error', 'Inline images exceed the configured Codex input budget');
      }
      if (textBudget > 0) preparedInput.text = limitTextByTokenBudget(preparedInput.text, textBudget);
      preparedInput.summary.text_bytes = byteLength(preparedInput.text);
      preparedInput.summary.text_chars = preparedInput.text.length;
      preparedInput.summary.estimated_tokens = imageTokens + estimateTokensFromText(preparedInput.text);
      preparedInput.summary.line_count = countOutputLines(preparedInput.text);
    }
    const tracer = this.scopedTracer(requestTracer);
    const contextWindow = this.knownModelContextWindow();
    const toolResultWindowMaxBytes = codexToolResultWindowMaxBytes(this.config);
    traceLog(tracer, 'codex.turn.input_prepared', {
      thread_id: this.threadId,
      thread_exists: threadExists,
      summary: preparedInput.summary,
      context_tokens: this.latestContextTokens || 0,
      model_context_window: contextWindow || null,
      input_max_tokens: this.inputMaxTokens(),
      bootstrap_input_max_tokens: this.bootstrapInputMaxTokens(),
      tool_result_window_bytes: this.toolResultWindowBytes,
      tool_result_window_max_bytes: Number.isFinite(toolResultWindowMaxBytes)
        ? toolResultWindowMaxBytes
        : null,
    });
    this.seenToolCallIds.clear();
    this.toolBoundaryFingerprints.clear();
    this.toolTurnFailed = false;
    const outputSchema = codexOutputSchema(requestBody);
    const result = await this.connection.request('turn/start', {
      threadId: this.threadId,
      input: images.input(preparedInput.text, latestUserContentBlocks(requestBody)),
      effort: mapReasoningEffort(this.route.reasoningEffort),
      ...(outputSchema === null ? {} : { outputSchema }),
    });

    const turnId = result.turn?.id || null;
    if (!turnId) {
      throw new GatewayError(502, 'api_error', 'Codex app-server did not return a turn id');
    }

    this.activeOutputSchema = outputSchema;
    return turnId;
  }

  async continuePendingToolCall(requestBody, requestTracer = null, signal = null) {
    if (!this.pendingToolCall) {
      throw new GatewayError(500, 'api_error', 'no pending Codex tool call exists');
    }
    validatePendingOutputSchema(this.activeOutputSchema ?? null, requestBody);
    const pending = this.pendingToolCall;
    const steer = pendingUserSteer(latestUserContentBlocks(requestBody), pending.callId);
    if (pending.steering) {
      throw new GatewayError(409, 'invalid_request_error', 'A continuation for this tool result is already being applied.');
    }

    const toolResultMaxBytes = codexToolResultMaxBytes(this.config);
    const toolResultWindowMaxBytes = codexToolResultWindowMaxBytes(this.config);
    const readInlineMaxBytes = isReadToolName(this.pendingToolCall.tool)
      ? codexReadInlineMaxBytes(this.config, this.route)
      : Number.POSITIVE_INFINITY;
    const toolResultWindowRemainingBytes = Number.isFinite(toolResultWindowMaxBytes)
      ? Math.max(0, toolResultWindowMaxBytes - this.toolResultWindowBytes)
      : Number.POSITIVE_INFINITY;
    const rawToolResult = extractToolResultPayload(requestBody, this.pendingToolCall);
    const effectiveToolResultMaxBytes = Math.min(
      toolResultMaxBytes,
      toolResultWindowRemainingBytes,
      rawToolResult.contentItems ? Number.POSITIVE_INFINITY : readInlineMaxBytes
    );
    const { readFeedback, limitedToolResult } = prepareCodexToolResultPayload(
      rawToolResult,
      this.pendingToolCall,
      effectiveToolResultMaxBytes
    );
    // Current Codex applies its model's token-aware function-output policy
    // when it records dynamic-tool results. Do not pre-truncate the response
    // again using the gateway's turn-input budget; optional byte caps above
    // remain available for operators that need a transport-level hard bound.
    const finalToolResultText = limitedToolResult.text;
    const toolResult = {
      ...rawToolResult,
      text: finalToolResultText,
      isError: rawToolResult.isError || limitedToolResult.isError === true,
    };
    if (steer.length) {
      // Queue user input with its own role while the dynamic-tool future is
      // blocked. Releasing the tool first would race the next inference.
      // The expected turn ID prevents steering a replacement turn.
      signal?.throwIfAborted();
      pending.steering = true;
      try {
        const accepted = await this.connection.request('turn/steer', {
          threadId: this.threadId, expectedTurnId: pending.turnId, input: steer,
        });
        if (accepted?.turnId !== pending.turnId || signal?.aborted ||
            this.pendingToolCall !== pending || pending.ended || this.disposed) {
          throw new Error('the pending turn changed');
        }
      } catch {
        // A lost acknowledgement makes the fate of the steer ambiguous. Do
        // not release the tool or invite an automatic replay of its effects.
        pending.ended = true;
        throw this.fenceFailedToolTurn(new GatewayError(400, 'invalid_request_error',
          'Codex could not acknowledge the user input accompanying this tool result. The result was not sent; do not rerun the tool. Start a new request with the tool outcome and the user input.'),
          requestFingerprint(requestBody));
      }
    }
    const resultBytes = limitedToolResult.bytes ?? byteLength(toolResult.text);
    this.toolResultWindowBytes += resultBytes;
    const tracer = this.scopedTracer(requestTracer);
    traceLog(tracer, 'codex.tool_result.continued', {
      call_id: this.pendingToolCall.callId,
      tool_name: this.pendingToolCall.tool,
      raw_result_bytes: byteLength(rawToolResult.text),
      prepared_result_bytes: byteLength(readFeedback.text),
      result_bytes: resultBytes,
      result_length: toolResult.text.length,
      tool_result_truncated: limitedToolResult.truncated,
      tool_result_input_budget_truncated: false,
      tool_result_max_bytes: Number.isFinite(toolResultMaxBytes) ? toolResultMaxBytes : null,
      read_inline_max_bytes: Number.isFinite(readInlineMaxBytes) ? readInlineMaxBytes : null,
      tool_result_window_bytes: this.toolResultWindowBytes,
      tool_result_window_max_bytes: Number.isFinite(toolResultWindowMaxBytes)
        ? toolResultWindowMaxBytes
        : null,
      tool_result_window_remaining_bytes: Number.isFinite(toolResultWindowRemainingBytes)
        ? toolResultWindowRemainingBytes
        : null,
      effective_tool_result_max_bytes: Number.isFinite(effectiveToolResultMaxBytes)
        ? effectiveToolResultMaxBytes
        : null,
      read_tool_result: limitedToolResult.readToolResult === true,
      read_coverage_verified: limitedToolResult.readCoverageVerified === true,
      read_notice_status: limitedToolResult.readNoticeStatus || 'none',
      read_page_metadata: limitedToolResult.readPageMetadata || null,
      read_result_feedback: readFeedback.feedback,
      read_sanitization: readSanitizationTrace(this.pendingToolCall.readSanitization),
      is_error: toolResult.isError,
    });
    signal?.throwIfAborted();
    this.stopInterBoundaryCapture();
    this.connection.send({
      id: this.pendingToolCall.requestId,
      result: {
        success: !toolResult.isError,
        contentItems: limitedToolResult.contentItems ?? [
          {
            type: 'inputText',
            text: toolResult.text,
          },
        ],
      },
    });

    const turnId = this.pendingToolCall.turnId;
    this.pendingToolCall = null;
    const boundary = createBoundary(turnId, requestBody, this.latestTotalUsage);
    this.activeBoundary = boundary;
    return this.beginBoundary(boundary, turnId, requestBody, requestTracer);
  }

  resolveAdvanceMode(requestBody) {
    if (this.pendingToolCall?.ended) {
      // A 4xx prevents automatic transport/overflow replay of a tool with
      // unknown side effects. A different user request can start a new turn.
      throw new GatewayError(400, 'invalid_request_error',
        'The Codex turn ended while Claude was handling its tool call. The tool may already have run. Check its effects before starting a new request; no tool was replayed.');
    }
    const fingerprint = requestFingerprint(requestBody);
    const matchingToolResult = hasMatchingToolResult(requestBody, this.pendingToolCall);

    if (this.pendingToolCall) {
      if (matchingToolResult) {
        return {
          mode: 'continue_tool_result',
        };
      }

      if (this.activeBoundary && this.activeBoundary.requestFingerprint === fingerprint) {
        return {
          mode: 'replay_boundary',
          boundary: this.activeBoundary,
        };
      }

      throw new GatewayError(
        400,
        'invalid_request_error',
        `missing tool_result for pending tool call ${this.pendingToolCall.callId}`
      );
    }

    if (this.activeBoundary) {
      if (this.activeBoundary.requestFingerprint === fingerprint) {
        return {
          mode: 'replay_boundary',
          boundary: this.activeBoundary,
        };
      }

      if (!this.activeBoundary.finished) {
        throw new GatewayError(
          409,
          'invalid_request_error',
          'another routed Codex turn is already in progress for this Claude session'
        );
      }

      this.activeBoundary = null;
    }

    return {
      mode: 'start_new',
    };
  }

  async advanceBoundary(requestBody, requestTracer = null, signal = null) {
    validateCodexRequestControls(requestBody);
    const resolution = this.resolveAdvanceMode(requestBody);

    if (resolution.mode === 'replay_boundary') {
      traceLog(this.scopedTracer(requestTracer), 'codex.boundary.replay', {
        turn_id: resolution.boundary.turnId,
      });
      return resolution.boundary;
    }

    if (resolution.mode === 'continue_tool_result') {
      return this.continuePendingToolCall(requestBody, requestTracer, signal);
    }

    const boundary = createBoundary(null, requestBody, this.latestTotalUsage);
    this.activeBoundary = boundary;

    try {
      const turnId = await this.startTurn(requestBody, requestTracer);
      return this.beginBoundary(boundary, turnId, requestBody, requestTracer);
    } catch (error) {
      if (this.activeBoundary === boundary) {
        this.activeBoundary = null;
      }
      boundary.finished = true;
      boundary.error = error;
      boundary.done.catch(function ignoreBoundaryStartFailure() {});
      boundary.reject(error);
      throw error;
    }
  }

  async advance(requestBody, requestTracer = null, signal = null) {
    const boundary = await this.advanceBoundary(requestBody, requestTracer, signal);
    return boundary.done;
  }

  beginBoundary(boundary, turnId, requestBody, requestTracer = null) {
    const tracer = this.scopedTracer(requestTracer);
    boundary.turnId = turnId;
    traceLog(tracer, 'codex.boundary.started', {
      turn_id: turnId,
      request_fingerprint: boundary.requestFingerprint,
    });

    const cleanup = () => {
      clearImmediate(toolUseSettleHandle);
      clearImmediate(agentTextFlushHandle);
      this.connection.off('notification', onNotification);
      this.connection.off('server-request', onServerRequest);
      this.connection.off('error', onError);
    };

    const agentMessages = new Map();
    const agentMessageOrder = [];
    let streamedAgentMessageId = null;
    let streamedAgentText = '';
    let rawUsageObserved = false;
    let toolUseSettleHandle = null;
    let agentTextFlushHandle = null;

    const normalizeAgentMessagePhase = (phase) => {
      return phase === undefined || phase === null ? null : String(phase);
    };

    const normalizeAgentMessageDelivery = (delivery) => {
      return delivery === undefined || delivery === null ? null : String(delivery);
    };

    const agentMessageRecord = (itemId) => {
      const id = String(itemId || `agent-message-${agentMessageOrder.length + 1}`);
      let record = agentMessages.get(id);
      if (!record) {
        record = {
          id,
          phase: null,
          delivery: null,
          text: '',
        };
        agentMessages.set(id, record);
        agentMessageOrder.push(record);
      }
      return record;
    };

    const selectedAgentMessage = () => {
      if (streamedAgentMessageId !== null) {
        const streamedRecord = agentMessages.get(streamedAgentMessageId);
        if (
          streamedRecord &&
          streamedRecord.delivery !== 'async' &&
          (streamedRecord.phase === 'final_answer' || streamedRecord.phase === null)
        ) {
          return streamedRecord;
        }
        return null;
      }

      for (let index = agentMessageOrder.length - 1; index >= 0; index -= 1) {
        if (
          agentMessageOrder[index].delivery !== 'async' &&
          agentMessageOrder[index].phase === 'final_answer'
        ) {
          return agentMessageOrder[index];
        }
      }
      for (let index = agentMessageOrder.length - 1; index >= 0; index -= 1) {
        if (
          agentMessageOrder[index].delivery !== 'async' &&
          agentMessageOrder[index].phase === null
        ) {
          return agentMessageOrder[index];
        }
      }
      return null;
    };

    const refreshSelectedAgentText = () => {
      boundary.text = selectedAgentMessage()?.text || '';
      return boundary.text;
    };

    const emitSelectedAgentTextSuffix = () => {
      const selected = selectedAgentMessage();
      if (!selected || !selected.text) {
        return;
      }

      if (streamedAgentMessageId === null) {
        streamedAgentMessageId = selected.id;
      }
      if (selected.id !== streamedAgentMessageId) {
        return;
      }

      const text = String(selected.text);
      if (!text.startsWith(streamedAgentText)) {
        traceLog(tracer, 'codex.agent_message.stream_diverged', {
          turn_id: turnId,
          item_id: selected.id,
          emitted_chars: streamedAgentText.length,
          completed_chars: text.length,
        });
        return;
      }

      const suffix = text.slice(streamedAgentText.length);
      if (!suffix) {
        return;
      }
      streamedAgentText = text;
      boundary.text = text;
      boundary.emit({
        type: 'text_delta',
        text: suffix,
      });
    };

    const scheduleSelectedAgentTextSuffix = () => {
      if (agentTextFlushHandle !== null) {
        return;
      }
      // Coalesce notifications already buffered in the same stdout turn. This
      // preserves phase selection when a superseding final item is delivered
      // in the same app-server batch while still streaming live deltas on the
      // next event-loop turn.
      agentTextFlushHandle = setImmediate(() => {
        agentTextFlushHandle = null;
        emitSelectedAgentTextSuffix();
      });
    };

    const failBoundary = (error) => {
      if (boundary.finished) {
        return;
      }

      error = this.fenceFailedToolTurn(error, boundary.requestFingerprint);
      cleanup();
      boundary.finished = true;
      boundary.error = error;
      traceLog(tracer, 'codex.boundary.failed', {
        turn_id: turnId,
        error_message: error?.message || 'unknown error',
      });
      boundary.reject(error);
    };

    const completeBoundary = (outcome) => {
      if (boundary.finished) {
        return;
      }

      cleanup();
      emitSelectedAgentTextSuffix();
      if (outcome.type === 'tool_use') {
        this.toolBoundaryFingerprints.add(boundary.requestFingerprint);
        this.captureInterBoundaryEvents(turnId, boundary.usageBaseline, tracer);
      } else {
        this.toolBoundaryFingerprints.clear();
      }
      boundary.finished = true;
      if (!boundary.queuedToolCall) populateEstimatedUsage(boundary, requestBody, outcome);
      this.transcriptAnchor = makeContinuityAnchor(requestBody, outcome);
      boundary.outcome = {
        ...outcome,
        usage: boundary.usage,
      };
      traceLog(tracer, 'codex.boundary.completed', {
        turn_id: turnId,
        outcome_type: outcome.type,
        output_chars: boundary.text.length,
        usage: boundary.usage,
      });
      boundary.emit({
        type: 'boundary',
        outcome: boundary.outcome,
      });
      boundary.resolve(boundary.outcome);
    };

    const onError = (error) => {
      failBoundary(error);
    };

    const onNotification = (message) => {
      if (
        message.method === 'model/rerouted' &&
        message.params?.threadId === this.threadId &&
        message.params?.turnId === turnId
      ) {
        const previousModel = this.actualModel;
        const nextModel = String(message.params?.toModel || '').trim();
        if (nextModel) {
          this.actualModel = nextModel;
          this.modelContextWindow = Number(this.contextWindows?.get(nextModel) || 0);
        }
        traceLog(tracer, 'codex.model.rerouted', {
          turn_id: turnId,
          from_model: message.params?.fromModel || previousModel,
          to_model: nextModel || previousModel,
          reason: message.params?.reason || null,
        });
        return;
      }

      if (message.method === 'error' && message.params?.turnId === turnId) {
        const willRetry = message.params?.willRetry === true;
        const turnError = codexTurnGatewayError(
          message.params?.error,
          'Codex app-server reported a turn error'
        );
        traceLog(tracer, 'codex.turn.error', {
          turn_id: turnId,
          will_retry: willRetry,
          codex_error_type: turnError.codexErrorType || null,
          error_message: turnError.message,
        });
        if (!willRetry) {
          failBoundary(turnError);
        }
        return;
      }

      if (
        (message.method === 'item/started' || message.method === 'item/completed') &&
        message.params?.turnId === turnId &&
        message.params?.item?.type === 'contextCompaction'
      ) {
        const completed = message.method === 'item/completed';
        if (completed) {
          this.resetToolResultWindow('context_compaction', tracer);
        }
        traceLog(tracer, `codex.context_compaction.${completed ? 'completed' : 'started'}`, {
          turn_id: turnId,
          item_id: message.params?.item?.id || null,
        });
        return;
      }

      if (
        message.method === 'item/started' &&
        message.params?.turnId === turnId &&
        message.params?.item?.type === 'agentMessage'
      ) {
        const item = message.params.item;
        const record = agentMessageRecord(item.id);
        if (Object.hasOwn(item, 'phase')) {
          record.phase = normalizeAgentMessagePhase(item.phase);
        }
        if (Object.hasOwn(item, 'delivery')) {
          record.delivery = normalizeAgentMessageDelivery(item.delivery);
        }
        if (typeof item.text === 'string' && item.text !== '') {
          record.text = item.text;
        }
        refreshSelectedAgentText();
        scheduleSelectedAgentTextSuffix();
        return;
      }

      if (message.method === 'item/agentMessage/delta' && message.params?.turnId === turnId) {
        const record = agentMessageRecord(message.params?.itemId);
        const text = message.params?.delta || '';
        if (text) {
          record.text += text;
          refreshSelectedAgentText();
          scheduleSelectedAgentTextSuffix();
        }
        return;
      }

      if (
        message.method === 'item/completed' &&
        message.params?.turnId === turnId &&
        message.params?.item?.type === 'agentMessage'
      ) {
        const item = message.params.item;
        const record = agentMessageRecord(item.id);
        if (Object.hasOwn(item, 'phase')) {
          record.phase = normalizeAgentMessagePhase(item.phase);
        }
        if (Object.hasOwn(item, 'delivery')) {
          record.delivery = normalizeAgentMessageDelivery(item.delivery);
        }
        if (typeof item.text === 'string') {
          record.text = item.text;
        }
        refreshSelectedAgentText();
        scheduleSelectedAgentTextSuffix();
        return;
      }

      if (
        message.method === 'rawResponse/completed' &&
        message.params?.turnId === turnId
      ) {
        const rawUsage = this.applyRawResponseUsage(
          message.params?.usage,
          boundary.usage,
          boundary.usageBaseline,
          turnId,
          tracer
        );
        if (rawUsage) {
          rawUsageObserved = true;
          boundary.usage = rawUsage;
          boundary.emit({
            type: 'usage',
            usage: boundary.usage,
          });
        }
        return;
      }

      if (
        message.method === 'thread/tokenUsage/updated' &&
        message.params?.turnId === turnId &&
        (message.params?.tokenUsage?.total || message.params?.tokenUsage?.last)
      ) {
        const tokenUsage = this.applyTokenUsage(
          message.params.tokenUsage,
          boundary.usageBaseline,
          turnId,
          tracer
        );
        if (!rawUsageObserved) {
          boundary.usage = tokenUsage;
        }
        boundary.emit({
          type: 'usage',
          usage: boundary.usage,
        });
        return;
      }

      if (message.method !== 'turn/completed' || message.params?.turn?.id !== turnId) {
        return;
      }

      const turn = message.params.turn;
      if (turn.status !== 'completed') {
        failBoundary(
          codexTurnGatewayError(
            turn.error,
            `Codex turn ended with status ${String(turn.status)}`
          )
        );
        return;
      }

      completeBoundary({
        type: 'final',
        text: refreshSelectedAgentText(),
      });
    };

    const onServerRequest = (message, fromQueue = false) => {
      if (message.method !== 'item/tool/call' || message.params?.turnId !== turnId) {
        this.rejectUnhandledServerRequest(message);
        return;
      }

      if (this.handleInvalidOrPendingToolCall(message, turnId, tracer, fromQueue)) {
        return;
      }

      const params = message.params;
      const originalName = originalToolName(this.toolRegistry, params.tool);
      const sanitizedToolCall = sanitizeCodexToolCallArguments(
        originalName,
        params.arguments || {},
        params.callId || null
      );
      if (sanitizedToolCall.readSanitization?.changed) {
        traceLog(tracer, 'codex.read_tool.arguments_sanitized', {
          turn_id: turnId,
          call_id: params.callId,
          tool_name: originalName,
          sanitization: readSanitizationTrace(sanitizedToolCall.readSanitization),
        });
      }

      this.pendingToolCall = {
        requestId: message.id,
        turnId,
        callId: params.callId,
        tool: originalName,
        arguments: sanitizedToolCall.arguments,
        readSanitization: sanitizedToolCall.readSanitization,
      };
      traceLog(tracer, 'codex.tool_call.pending', {
        turn_id: turnId,
        call_id: params.callId,
        tool_name: originalName,
        read_sanitization: readSanitizationTrace(sanitizedToolCall.readSanitization),
      });

      const toolUseOutcome = {
        type: 'tool_use',
        text: refreshSelectedAgentText(),
        toolCall: {
          id: params.callId,
          name: originalName,
          input: sanitizedToolCall.arguments,
        },
      };
      // Codex only polls dynamic-tool futures after the upstream Responses
      // stream has completed. Settle on the next event-loop turn to avoid
      // same-stack reentrancy while adding no inference or fixed wait.
      toolUseSettleHandle = setImmediate(function settleToolUseBoundary() {
        toolUseSettleHandle = null;
        completeBoundary({
          ...toolUseOutcome,
          text: refreshSelectedAgentText(),
        });
      });
    };

    if (this.queuedToolCalls.length > 0) {
      boundary.queuedToolCall = true;
      onServerRequest(this.queuedToolCalls.shift(), true);
    }
    this.connection.subscribeToTurn(onNotification, onServerRequest, onError);

    return boundary;
  }

  async stream(requestBody, onEvent, requestTracer = null, signal = null) {
    const boundary = await this.advanceBoundary(requestBody, requestTracer, signal);
    let eventFailure = null;
    let eventChain = Promise.resolve();
    let notifyEventFailure = null;
    const eventFailureReady = new Promise(function waitForEventFailure(resolve) {
      notifyEventFailure = resolve;
    });

    function recordEventFailure(error) {
      if (eventFailure) {
        return;
      }
      eventFailure = error;
      notifyEventFailure();
    }

    function queueEvent(event) {
      const queued = eventChain.then(function handleQueuedEvent() {
        if (eventFailure) {
          return undefined;
        }
        return onEvent(event);
      });
      queued.catch(recordEventFailure);
      eventChain = queued.catch(function keepEventQueueSettled() {
        return undefined;
      });
      return queued;
    }

    async function flushEvents() {
      await eventChain;
    }

    const removeListener = boundary.addListener(queueEvent);
    try {
      const boundaryResult = boundary.done.then(
        function boundarySucceeded(value) {
          return { type: 'success', value };
        },
        function boundaryFailed(error) {
          return { type: 'failure', error };
        }
      );
      const outcome = await Promise.race([
        boundaryResult,
        eventFailureReady.then(function eventWriteFailed() {
          return { type: 'event_failure' };
        }),
      ]);
      await flushEvents();
      if (eventFailure) {
        throw eventFailure;
      }
      if (outcome.type === 'failure') {
        throw outcome.error;
      }
      return outcome.value;
    } finally {
      removeListener();
    }
  }

  async interrupt(reason = null) {
    if (this.pendingToolCall?.steering) {
      // The prior tool_use HTTP boundary is finished, but its JSON-RPC tool
      // request and the steer are both still live. Fence before any await;
      // even an acknowledgement racing transport shutdown must not release it.
      this.pendingToolCall.ended = true;
      this.fenceFailedToolTurn(new GatewayError(409, 'invalid_request_error',
        'A correction was cancelled while Codex was acknowledging it.'));
      return false;
    }
    const boundary = this.activeBoundary;
    if (!boundary || boundary.finished) {
      return true;
    }
    if (!this.threadId || !boundary.turnId) {
      return false;
    }

    const interrupted = await withTimeout(
      this.connection
        .request('turn/interrupt', {
          threadId: this.threadId,
          turnId: boundary.turnId,
        })
        .then(
          function interruptAccepted() {
            return true;
          },
          function interruptFailed() {
            return false;
          }
        ),
      CODEX_INTERRUPT_TIMEOUT_MS,
      false
    );
    if (!interrupted) {
      return false;
    }

    const boundarySettled = await withTimeout(
      boundary.done.then(
        function boundaryCompleted() {
          return true;
        },
        function boundaryFailed() {
          return true;
        }
      ),
      CODEX_INTERRUPT_TIMEOUT_MS,
      false
    );
    if (!boundarySettled || !boundary.finished) {
      return false;
    }

    // A subscribed thread remains loaded in app-server even after interruption.
    // Only reuse this process if the old subscription is gone; otherwise the
    // caller retires the whole connection (including any outstanding RPC).
    const retired = await withTimeout(
      this.connection.request('thread/unsubscribe', { threadId: this.threadId })
        .then(result => ['unsubscribed', 'notSubscribed', 'notLoaded'].includes(result?.status), () => false),
      CODEX_INTERRUPT_TIMEOUT_MS,
      false
    );
    if (!retired) return false;

    // Claude may discard a partially streamed turn after cancellation while
    // Codex retains it in thread history. Keep the warm app-server process,
    // but start the next request on a fresh Codex thread bootstrapped from
    // Claude's authoritative transcript.
    this.stopInterBoundaryCapture();
    this.threadId = null;
    this.actualModel = this.route.upstreamModel;
    this.modelContextWindow = 0;
    this.pendingToolCall = null;
    this.queuedToolCalls = [];
    this.activeBoundary = null;
    this.toolBoundaryFingerprints.clear();
    this.transcriptAnchor = null;
    this.bootstrapMode = 'transcript';
    this.toolResultWindowBytes = 0;
    this.latestTotalUsage = emptyUsage();
    this.latestContextTokens = 0;
    traceLog(this.tracer, 'codex.turn.interrupted', {
      reason: reason?.message || 'gateway request aborted',
      process_reused: true,
    });
    return true;
  }

  async close(reason = null) {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    clearTimeout(this.idleTimer);
    clearTimeout(this.pendingToolTimer);
    this.stopInterBoundaryCapture();
    traceLog(this.tracer, 'codex.session.closed');
    await this.connection.close(reason);
  }
}

export class CodexSessionManager {
  constructor(config, options = {}) {
    this.config = config;
    this.sessions = new Map();
    this.failedToolTurns = new FailedToolTurnCache();
    this.pendingSessionClosures = new Set();
    this.tracer = options.tracer || null;
    this.learnedContextWindows = new Map();
    this.recencySequence = 0;
    this.createSession =
      typeof options.createSession === 'function'
        ? options.createSession
        : (route, req, requestBody, sessionKey, requestTracer = null, sessionOptions = {}) =>
            new CodexGatewaySession(
              this.config,
              route,
              req,
              requestBody,
              sessionKey,
              (requestTracer || this.tracer)?.scope?.({
                requested_model: route.requestedModel,
                upstream_model: route.upstreamModel,
              }) || null,
              {
                contextWindows: this.learnedContextWindows,
                failedToolTurns: this.failedToolTurns,
                ...sessionOptions,
              }
            );
  }

  identityEntries(identityKey) {
    return Array.from(this.sessions.entries()).filter(function matchIdentity([, session]) {
      return (
        session.identityKey === identityKey ||
        (typeof session.baseSessionKey === 'string' &&
          session.baseSessionKey.startsWith(`${identityKey}:`))
      );
    });
  }

  trackSessionClosure(promise) {
    const tracked = Promise.resolve(promise);
    this.pendingSessionClosures.add(tracked);
    const remove = () => {
      this.pendingSessionClosures.delete(tracked);
    };
    tracked.then(remove, remove);
    return tracked;
  }

  familyEntries(baseSessionKey) {
    return Array.from(this.sessions.entries()).filter(function matchBaseKey([, session]) {
      return session.baseSessionKey === baseSessionKey;
    });
  }

  hasRoutingReservation(session) {
    return Boolean(session?.routingReservation);
  }

  reserveSessionForRequest(session, selection, requestTracer = null) {
    if (!session || NON_RESERVING_SELECTION_REASONS.has(selection.selectionReason)) {
      return null;
    }

    const reservation = {
      requestFingerprint: selection.requestFingerprint,
      createdAt: Date.now(),
    };
    session.routingReservation = reservation;
    traceLog(requestTracer || this.tracer, 'codex.session.reserved', {
      session_key: session.sessionKey,
      selection_reason: selection.selectionReason,
      request_fingerprint: selection.requestFingerprint,
    });
    return reservation;
  }

  clearSessionReservation(session, reservation) {
    if (reservation && session?.routingReservation === reservation) {
      session.routingReservation = null;
    }
  }

  resolveSessionEntry(req, requestBody, route) {
    const identityKey = buildSessionIdentityKey(route, req);
    const baseSessionKey = buildSessionBaseKey(route, req, requestBody);
    const requestIdFingerprint = requestFingerprint(requestBody);
    const toolResultIds = extractToolResultIds(requestBody);
    const identityEntries = this.identityEntries(identityKey);
    const familyEntries = this.familyEntries(baseSessionKey);

    this.failedToolTurns.rejectReplay(identityKey, requestIdFingerprint, toolResultIds);

    for (const [sessionKey, session] of identityEntries) {
      if (session.pendingToolCall && toolResultIds.has(session.pendingToolCall.callId)) {
        return {
          sessionKey,
          session,
          selectionReason: 'matching_tool_result',
          requestFingerprint: requestIdFingerprint,
        };
      }
    }

    for (const [sessionKey, session] of identityEntries) {
      if (session.activeBoundary?.requestFingerprint === requestIdFingerprint) {
        return {
          sessionKey,
          session,
          selectionReason: 'boundary_replay',
          requestFingerprint: requestIdFingerprint,
        };
      }
    }

    for (const [sessionKey, session] of identityEntries) {
      if (session.routingReservation?.requestFingerprint === requestIdFingerprint) {
        return {
          sessionKey,
          session,
          selectionReason: 'routing_reservation_replay',
          requestFingerprint: requestIdFingerprint,
        };
      }
    }

    const canonical = familyEntries.find(function findCanonical([sessionKey]) {
      return sessionKey === baseSessionKey;
    });
    if (!canonical) {
      return {
        sessionKey: baseSessionKey,
        session: null,
        selectionReason: 'new_canonical',
        requestFingerprint: requestIdFingerprint,
      };
    }

    const [canonicalKey, canonicalSession] = canonical;
    if (canonicalSession.pendingToolCall) {
      const forkSessionKey = buildForkSessionKey(baseSessionKey, requestIdFingerprint);
      return {
        sessionKey: forkSessionKey,
        session: this.sessions.get(forkSessionKey) || null,
        selectionReason: 'fork_pending_tool_call',
        requestFingerprint: requestIdFingerprint,
      };
    }

    if (canonicalSession.activeBoundary && !canonicalSession.activeBoundary.finished) {
      const forkSessionKey = buildForkSessionKey(baseSessionKey, requestIdFingerprint);
      return {
        sessionKey: forkSessionKey,
        session: this.sessions.get(forkSessionKey) || null,
        selectionReason: 'fork_active_boundary',
        requestFingerprint: requestIdFingerprint,
      };
    }

    if (this.hasRoutingReservation(canonicalSession)) {
      const forkSessionKey = buildForkSessionKey(baseSessionKey, requestIdFingerprint);
      return {
        sessionKey: forkSessionKey,
        session: this.sessions.get(forkSessionKey) || null,
        selectionReason: 'fork_routing_reservation',
        requestFingerprint: requestIdFingerprint,
      };
    }

    return {
      sessionKey: canonicalKey,
      session: canonicalSession,
      selectionReason: 'canonical',
      requestFingerprint: requestIdFingerprint,
    };
  }

  ensureSessionEntry(req, requestBody, route, requestTracer = null, options = {}) {
    validateCodexRequestControls(requestBody);
    const selection = this.resolveSessionEntry(req, requestBody, route);
    let session = selection.session;

    traceLog(requestTracer || this.tracer, 'codex.session.selected', {
      requested_model: route.requestedModel,
      upstream_model: route.upstreamModel,
      session_key: selection.sessionKey,
      selection_reason: selection.selectionReason,
      request_fingerprint: selection.requestFingerprint,
    });

    if (
      session &&
      selection.selectionReason === 'canonical' &&
      session.threadId &&
      (session.toolTurnFailed || session.isTranscriptContinuous?.(requestBody) === false)
    ) {
      const divergedSession = session;
      traceLog(requestTracer || this.tracer, 'codex.session.transcript_diverged', {
        session_key: selection.sessionKey,
        selection_reason: selection.selectionReason,
        expected_message_count: divergedSession.transcriptAnchor?.messageCount || null,
        expected_fingerprint: divergedSession.transcriptAnchor?.fingerprint || null,
      });
      this.sessions.delete(selection.sessionKey);
      void this.trackSessionClosure(
        Promise.resolve()
        .then(function closeDivergedSession() {
          return divergedSession.close(
            new Error('Claude transcript diverged from the live Codex thread')
          );
        })
      ).catch(function ignoreDivergedSessionCloseFailure() {});
      session = null;
      // The current Claude request is authoritative after a rewind, branch, or
      // compaction. Seed a clean Codex thread from its bounded transcript.
      options = { ...options, bootstrapMode: 'transcript' };
    }

    if (!session) {
      this.ensureSessionCapacity(selection.sessionKey, requestTracer);
      session = this.createSession(
        route,
        req,
        requestBody,
        selection.sessionKey,
        requestTracer,
        options
      );
      this.markSessionUsed(session);
      this.sessions.set(selection.sessionKey, session);
      this.watchSession(selection.sessionKey, session);
    } else {
      session.assertCompatible(route, requestBody, {
        skipToolSignature: selection.selectionReason === 'matching_tool_result',
      });
    }

    session.clearIdleTimer?.();
    return {
      ...selection,
      session,
    };
  }

  ensureSession(req, requestBody, route, requestTracer = null) {
    return this.ensureSessionEntry(req, requestBody, route, requestTracer).session;
  }

  prepareSessionRequest(req, requestBody, route, requestTracer = null, options = {}) {
    const selection = this.ensureSessionEntry(req, requestBody, route, requestTracer, options);
    return {
      ...selection,
      reservation: this.reserveSessionForRequest(selection.session, selection, requestTracer),
    };
  }

  async processRequest(req, requestBody, route, requestTracer = null) {
    return this.runRecoverableSessionRequest({
      req,
      requestBody,
      route,
      requestTracer,
      run(session) {
        return session.advance(requestBody, requestTracer, req.abortSignal);
      },
    });
  }

  async streamRequest(req, requestBody, route, onEvent, requestTracer = null) {
    let forwardedEventCount = 0;
    function retryAwareOnEvent(event) {
      forwardedEventCount += 1;
      return onEvent(event);
    }

    return this.runRecoverableSessionRequest({
      req,
      requestBody,
      route,
      requestTracer,
      canRetry() {
        return forwardedEventCount === 0;
      },
      run(session) {
        return session.stream(requestBody, retryAwareOnEvent, requestTracer, req.abortSignal);
      },
    });
  }

  async runRecoverableSessionRequest(options) {
    // Shared across retry attempts (spread copies keep the same reference) so
    // overflow diagnostics always describe the most recently prepared session.
    options.attemptState = options.attemptState || {};
    let lastError = null;
    try {
      return await this.runPreparedSessionRequest(options);
    } catch (error) {
      if (!this.canRecoverFromContextOverflow(error, options)) {
        this.traceContextRecoverySkipped(error, options);
        throw this.describeContextOverflowError(error, options);
      }
      lastError = error;
    }

    // Recover on a fresh thread: first with the bounded full-transcript replay
    // (keeps context; fits the adaptive budget), then with latest-only input.
    // When the failed attempt was itself a fresh transcript bootstrap, a
    // transcript retry would re-send byte-identical input and deterministically
    // fail again, so skip straight to latest-only.
    const failedSession = options.attemptState.lastPreparedSession || null;
    const failedFreshTranscriptBootstrap =
      failedSession &&
      Number(failedSession.latestContextTokens || 0) === 0 &&
      failedSession.initialInputMode?.() === 'transcript';
    const recoveryModes = failedFreshTranscriptBootstrap
      ? ['latest']
      : ['transcript', 'latest'];

    for (const bootstrapMode of recoveryModes) {
      traceLog(options.requestTracer || this.tracer, 'codex.session.context_recovery_retry', {
        bootstrap_mode: bootstrapMode,
        error_message: lastError?.message || String(lastError),
        read_context: readRequestDiagnostics(
          options.requestBody,
          options.attemptState.lastPreparedSession?.pendingToolCall
        ),
      });

      try {
        return await this.runPreparedSessionRequest({
          ...options,
          sessionOptions: {
            ...(options.sessionOptions || {}),
            bootstrapMode,
          },
        });
      } catch (error) {
        if (!this.canRecoverFromContextOverflow(error, options)) {
          this.traceContextRecoverySkipped(error, options);
          throw this.describeContextOverflowError(error, options);
        }
        lastError = error;
      }
    }

    throw this.describeContextOverflowError(lastError, options);
  }

  describeContextOverflowError(error, options) {
    if (error?.unsafeToReplayToolTurn || !isCodexContextWindowError(error)) {
      return error;
    }

    const session = options.attemptState?.lastPreparedSession || null;
    const contextTokens = Number(session?.latestContextTokens || 0);
    const window = Number(session?.knownModelContextWindow?.() || 0);
    const budget = session ? session.inputMaxTokens() : codexInputMaxTokens(this.config);
    const details = [
      contextTokens > 0 ? `session context ~${contextTokens} tokens` : null,
      window > 0 ? `model window ${window} tokens` : null,
      Number.isFinite(budget) ? `gateway input budget ${budget} tokens` : null,
    ]
      .filter(Boolean)
      .join(', ');

    return copyCodexErrorMetadata(
      new GatewayError(
        400,
        'invalid_request_error',
        `Codex context window exceeded${details ? ` (${details})` : ''}: ${error?.message || String(error)}`
      ),
      error
    );
  }

  traceContextRecoverySkipped(error, options) {
    const tracer = options.requestTracer || this.tracer;
    if (isCodexContextWindowError(error)) {
      traceLog(tracer, 'codex.session.context_recovery_skipped', {
        error_message: error?.message || String(error),
        aborted: options.req?.abortSignal?.aborted === true,
        read_context: readRequestDiagnostics(
          options.requestBody,
          options.attemptState?.lastPreparedSession?.pendingToolCall
        ),
      });
      return;
    }

    if (isPossibleCodexContextWindowError(error)) {
      traceLog(tracer, 'codex.session.context_recovery_unmatched', {
        error_message: error?.message || String(error),
        gateway_error_status: error.status,
        gateway_error_type: error.type,
        read_context: readRequestDiagnostics(
          options.requestBody,
          options.attemptState?.lastPreparedSession?.pendingToolCall
        ),
      });
    }
  }

  canRecoverFromContextOverflow(error, options) {
    if (error?.unsafeToReplayToolTurn || !isCodexContextWindowError(error)) {
      return false;
    }

    if (options.req?.abortSignal?.aborted) {
      return false;
    }

    if (typeof options.canRetry === 'function' && !options.canRetry()) {
      return false;
    }

    return true;
  }

  async runPreparedSessionRequest(options) {
    const { req, requestBody, route, requestTracer, sessionOptions = {} } = options;
    const { session, reservation, selectionReason } = this.prepareSessionRequest(
      req,
      requestBody,
      route,
      requestTracer,
      sessionOptions
    );
    if (!options.attemptState) {
      options.attemptState = {};
    }
    options.attemptState.lastPreparedSession = session;

    return this.runSessionRequest(
      session,
      function runSession() {
        return options.run(session);
      },
      req.abortSignal,
      reservation,
      !['boundary_replay', 'routing_reservation_replay'].includes(selectionReason)
    );
  }

  watchSession(sessionKey, session) {
    if (!session.connection?.once) {
      return;
    }

    const manager = this;
    session.connection.once('error', function evictErroredSession(error) {
      if (!session.disposed) session.fenceFailedToolTurn?.(error);
      void manager.evictSession(sessionKey, session, error, 'codex.session.evicted');
    });
  }

  isEvictableFailure(error) {
    if (error instanceof GatewayError) {
      // Evict a pre-tool retryable failure so a later *client* retry creates
      // a fresh turn. Never retry the model automatically on rate limits.
      return error.unsafeToReplayToolTurn === true || error.status >= 500 || isCodexContextWindowError(error) ||
        (error.status === 429 && error.codexErrorType === 'rateLimitExceeded' && error.retryable === true);
    }

    return true;
  }

  sessionIdleTimeoutMs(session) {
    if (session.isForkSession?.() === true) {
      return Math.max(
        0,
        numberOrDefault(this.config.codex.forkIdleTimeoutMs, DEFAULT_FORK_IDLE_TIMEOUT_MS)
      );
    }

    return Math.max(0, numberOrDefault(this.config.codex.idleTimeoutMs, 0));
  }

  maxSessions() {
    return Math.max(
      1,
      numberOrDefault(this.config.codex.maxSessions, DEFAULT_MAX_SESSIONS)
    );
  }

  markSessionUsed(session) {
    this.recencySequence += 1;
    session.lastUsedSequence = this.recencySequence;
  }

  ensureSessionCapacity(incomingSessionKey, requestTracer = null) {
    const maxSessions = this.maxSessions();
    if (this.sessions.size < maxSessions) {
      return;
    }

    const candidates = Array.from(this.sessions.entries())
      .filter(function disposableCandidate([, session]) {
        return session.isCapacityEvictable?.() ?? session.isDisposableIdle?.();
      })
      .sort(function oldestFirst(left, right) {
        return (left[1].lastUsedSequence || 0) - (right[1].lastUsedSequence || 0);
      });

    while (this.sessions.size >= maxSessions && candidates.length > 0) {
      const [sessionKey, session] = candidates.shift();
      if (this.sessions.get(sessionKey) !== session) {
        continue;
      }

      this.sessions.delete(sessionKey);
      traceLog(requestTracer || this.tracer, 'codex.session.evicted_max_sessions', {
        session_key: sessionKey,
        incoming_session_key: incomingSessionKey,
        max_sessions: maxSessions,
        admission_eviction: true,
      });
      void this.trackSessionClosure(
        session.close(
          new GatewayError(
            499,
            'api_error',
            `Codex session pool admitted a replacement at max_sessions=${maxSessions}`
          )
        )
      ).catch((error) => {
        traceLog(requestTracer || this.tracer, 'codex.session.max_pool_cleanup_failed', {
          session_key: sessionKey,
          error_message: error?.message || String(error),
        });
      });
    }

    if (this.sessions.size >= maxSessions) {
      throw new GatewayError(
        503,
        'overloaded_error',
        `Codex session pool is at capacity (max_sessions=${maxSessions}); all sessions are active or waiting for tool results`
      );
    }
  }

  pendingToolTimeoutMs() {
    return Math.max(
      0,
      numberOrDefault(
        this.config.codex.pendingToolTimeoutMs,
        DEFAULT_PENDING_TOOL_TIMEOUT_MS
      )
    );
  }

  armIdleTimer(session) {
    if (this.sessions.get(session.sessionKey) !== session) {
      return;
    }

    this.markSessionUsed(session);
    session.touch(
      this.expireSession.bind(this),
      this.sessionIdleTimeoutMs(session),
      this.pendingToolTimeoutMs()
    );
    void this.evictExcessIdleSessions(session).catch((error) => {
      traceLog(this.tracer, 'codex.session.max_pool_cleanup_failed', {
        session_key: session.sessionKey,
        error_message: error?.message || String(error),
      });
    });
  }

  async runSessionRequest(
    session,
    run,
    signal,
    reservation = null,
    abortSessionOnSignal = true
  ) {
    try {
      return await this.runWithAbort(session, run, signal, abortSessionOnSignal);
    } catch (error) {
      if (session.connection?.closed && !signal?.aborted) {
        error = session.fenceFailedToolTurn?.(error) || error;
      }
      if (this.isEvictableFailure(error)) {
        await this.evictSession(session.sessionKey, session, error, 'codex.session.evicted');
      }
      throw error;
    } finally {
      this.clearSessionReservation(session, reservation);
      this.armIdleTimer(session);
    }
  }

  async runWithAbort(session, run, signal, abortSessionOnSignal = true) {
    if (!signal) {
      return run();
    }

    function abortError() {
      if (signal.reason instanceof GatewayError) {
        return signal.reason;
      }

      return new GatewayError(
        499,
        'api_error',
        'gateway request aborted before Codex turn completed'
      );
    }

    if (signal.aborted) {
      const error = abortError();
      if (abortSessionOnSignal) {
        await this.abortSession(session.sessionKey, error);
      }
      throw error;
    }

    const manager = this;
    return new Promise(function waitForAbort(resolve, reject) {
      let settled = false;

      function cleanup() {
        signal.removeEventListener('abort', onAbort);
      }

      function settle(fn, value) {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        fn(value);
      }

      function onAbort() {
        const error = abortError();
        if (abortSessionOnSignal) {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          Promise.resolve(manager.abortSession(session.sessionKey, error)).then(
            function abortComplete() {
              reject(error);
            },
            function abortFailed(closeError) {
              traceLog(manager.tracer, 'codex.session.abort_cleanup_failed', {
                session_key: session.sessionKey,
                error_message: closeError?.message || String(closeError),
              });
              reject(error);
            }
          );
          return;
        }
        settle(reject, error);
      }

      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }

      let runPromise = null;
      try {
        runPromise = Promise.resolve(run());
      } catch (error) {
        settle(reject, error);
        return;
      }

      runPromise.then(
        function resolveRequest(value) {
          settle(resolve, value);
        },
        function rejectRequest(error) {
          settle(reject, error);
        }
      );
    });
  }

  async abortSession(sessionKey, reason) {
    const session = this.sessions.get(sessionKey);
    if (!session) {
      return;
    }

    const interrupted = await session.interrupt?.(reason);
    if (interrupted === true) {
      traceLog(this.tracer, 'codex.session.abort_interrupted', {
        session_key: sessionKey,
        process_reused: true,
      });
      return;
    }

    await this.evictSession(sessionKey, session, reason, 'codex.session.aborted');
  }

  async evictSession(sessionKey, session, reason, eventName) {
    if (this.sessions.get(sessionKey) !== session) {
      return;
    }

    this.sessions.delete(sessionKey);
    traceLog(this.tracer, eventName, {
      session_key: sessionKey,
      reason: reason?.message || 'gateway request aborted',
    });
    await this.trackSessionClosure(session.close(reason));
  }

  async expireSession(sessionKey, reason = 'idle_timeout') {
    const session = this.sessions.get(sessionKey);
    if (!session) {
      return;
    }

    const failure = reason === 'pending_tool_timeout'
      ? new GatewayError(504, 'api_error', `Codex session expired while waiting for tool_result after ${this.pendingToolTimeoutMs()}ms`)
      : null;
    if (failure) session.fenceFailedToolTurn?.(failure);
    this.sessions.delete(sessionKey);
    traceLog(this.tracer, 'codex.session.expired', {
      session_key: sessionKey,
      reason,
    });
    await this.trackSessionClosure(session.close(failure));
  }

  async evictExcessIdleSessions(protectedSession = null) {
    const maxSessions = this.maxSessions();
    if (this.sessions.size <= maxSessions) {
      return;
    }

    const candidates = Array.from(this.sessions.entries())
      .filter(function disposableCandidate([, session]) {
        return (
          session !== protectedSession &&
          (session.isCapacityEvictable?.() ?? session.isDisposableIdle?.())
        );
      })
      .sort(function oldestFirst(left, right) {
        return (left[1].lastUsedSequence || 0) - (right[1].lastUsedSequence || 0);
      });

    for (const [sessionKey, session] of candidates) {
      if (this.sessions.size <= maxSessions) {
        return;
      }

      this.sessions.delete(sessionKey);
      traceLog(this.tracer, 'codex.session.evicted_max_sessions', {
        session_key: sessionKey,
        max_sessions: maxSessions,
      });
      await this.trackSessionClosure(
        session.close(
          new GatewayError(
            499,
            'api_error',
            `Codex session pool exceeded max_sessions=${maxSessions}`
          )
        )
      );
    }
  }

  async close() {
    const sessions = Array.from(this.sessions.values());
    this.sessions.clear();
    traceLog(this.tracer, 'codex.session_manager.closed', {
      session_count: sessions.length,
    });
    const currentClosures = sessions.map((session) =>
      this.trackSessionClosure(session.close())
    );
    await Promise.all([...this.pendingSessionClosures, ...currentClosures]);
  }
}
