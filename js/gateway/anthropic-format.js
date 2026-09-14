import crypto from 'node:crypto';

import { GatewayError } from './model-routing.js';

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function parseJsonObject(jsonText, label) {
  try {
    return JSON.parse(jsonText);
  } catch (error) {
    throw new GatewayError(
      502,
      'api_error',
      `upstream returned invalid JSON for ${label}`
    );
  }
}

function joinTextParts(parts) {
  if (parts.length === 0) {
    return '';
  }
  return parts.join('\n\n');
}

function normalizedBlocks(content) {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  if (Array.isArray(content)) {
    return content;
  }
  throw new GatewayError(
    400,
    'invalid_request_error',
    'message content must be a string or an array of content blocks'
  );
}

function renderToolResultContent(content, options = {}) {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    throw new GatewayError(
      400,
      'invalid_request_error',
      'tool_result content must be a string or an array of text blocks'
    );
  }

  if (options.supportsToolResultImages && content.some((block) => block?.type === 'image')) {
    return content.map((block) => {
      if (block?.type === 'text') return { type: 'text', text: block.text || '' };
      if (block?.type === 'image') {
        return { type: 'image_url', image_url: { url: translateImageSource(block.source) } };
      }
      throw new GatewayError(400, 'invalid_request_error',
        `unsupported tool_result content block type: ${String(block?.type)}`);
    });
  }

  const textParts = [];
  for (const block of content) {
    if (block?.type !== 'text') {
      throw new GatewayError(
        400,
        'invalid_request_error',
        `unsupported tool_result content block type: ${String(block?.type)}`
      );
    }
    textParts.push(block.text || '');
  }
  return joinTextParts(textParts);
}

function translateImageSource(source) {
  if (source?.type === 'base64') {
    if (!source.media_type || !source.data) {
      throw new GatewayError(
        400,
        'invalid_request_error',
        'image source with type base64 must include media_type and data'
      );
    }

    return `data:${source.media_type};base64,${source.data}`;
  }

  if (source?.type === 'url' && typeof source.url === 'string' && source.url !== '') {
    return source.url;
  }

  throw new GatewayError(
    400,
    'invalid_request_error',
    `unsupported image source type: ${String(source?.type)}`
  );
}

function openAiUserContent(parts) {
  if (parts.length === 0) {
    return '';
  }

  if (parts.every(function isTextPart(part) { return part.type === 'text'; })) {
    return joinTextParts(parts.map(function textPart(part) { return part.text; }));
  }

  return parts;
}

function translateUserMessage(message, options = {}) {
  const blocks = normalizedBlocks(message.content);
  const contentParts = [];
  const toolResults = [];

  for (const block of blocks) {
    if (block?.type === 'text') {
      contentParts.push({
        type: 'text',
        text: block.text || '',
      });
      continue;
    }

    if (block?.type === 'image') {
      contentParts.push({
        type: 'image_url',
        image_url: {
          url: translateImageSource(block.source),
        },
      });
      continue;
    }

    if (block?.type === 'tool_result') {
      toolResults.push({
        role: 'tool',
        tool_call_id: block.tool_use_id,
        content: renderToolResultContent(block.content, options),
      });
      continue;
    }

    throw new GatewayError(
      400,
      'invalid_request_error',
      `unsupported user content block type: ${String(block?.type)}`
    );
  }

  const translated = [...toolResults];
  if (contentParts.length > 0) {
    translated.push({
      role: 'user',
      content: openAiUserContent(contentParts),
    });
  }

  if (translated.length === 0) {
    translated.push({ role: 'user', content: '' });
  }

  return translated;
}

function toolCallReasoningContent(toolCalls, options) {
  for (const toolCall of toolCalls) {
    const reasoningContent = options.reasoningContentForToolCall?.(toolCall.id);
    if (typeof reasoningContent === 'string' && reasoningContent !== '') {
      return reasoningContent;
    }
  }

  return '';
}

function thinkingBlockText(block) {
  if (typeof block?.thinking === 'string' && block.thinking !== '') {
    return block.thinking;
  }

  if (typeof block?.text === 'string' && block.text !== '') {
    return block.text;
  }

  return '';
}

function assistantReasoningContent(reasoningParts, toolCalls, options) {
  if (reasoningParts.length > 0) {
    return joinTextParts(reasoningParts);
  }

  return toolCallReasoningContent(toolCalls, options);
}

function assistantMessageContent(textParts, toolCalls) {
  const text = joinTextParts(textParts);
  if (text !== '') {
    return text;
  }

  if (toolCalls.length > 0) {
    return null;
  }

  return '';
}

function translateAssistantMessage(message, options = {}) {
  const blocks = normalizedBlocks(message.content);
  const textParts = [];
  const reasoningParts = [];
  const toolCalls = [];

  for (const block of blocks) {
    if (block?.type === 'text') {
      textParts.push(block.text || '');
      continue;
    }

    if (block?.type === 'tool_use') {
      toolCalls.push({
        id: block.id || randomId('toolu'),
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input || {}),
        },
      });
      continue;
    }

    if (block?.type === 'thinking') {
      const text = thinkingBlockText(block);
      if (options.preserveAssistantThinking && text) {
        reasoningParts.push(text);
      }
      continue;
    }

    if (block?.type === 'redacted_thinking') {
      if (options.strictThinkingReplay) {
        throw new GatewayError(
          400,
          'invalid_request_error',
          `${options.providerLabel || 'Qwen'} cannot replay redacted_thinking without changing the preserved reasoning; start a new turn or remove the incompatible history block`
        );
      }
      continue;
    }

    throw new GatewayError(
      400,
      'invalid_request_error',
      `unsupported assistant content block type: ${String(block?.type)}`
    );
  }

  if (options.strictThinkingReplay && reasoningParts.length > 1) {
    throw new GatewayError(
      400,
      'invalid_request_error',
      `${options.providerLabel || 'Qwen'} requires one unmodified thinking block per assistant message; multiple thinking blocks cannot be merged safely`
    );
  }

  const reasoningContent = assistantReasoningContent(reasoningParts, toolCalls, options);
  if (textParts.length === 0 && toolCalls.length === 0 && !reasoningContent) {
    return [];
  }
  const content = assistantMessageContent(textParts, toolCalls);

  return [
    {
      role: 'assistant',
      content,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
    },
  ];
}

function translateSystemMessage(message, options = {}) {
  const blocks = normalizedBlocks(message.content);
  const textParts = [];

  for (const block of blocks) {
    if (block?.type !== 'text') {
      throw new GatewayError(
        400,
        'invalid_request_error',
        `unsupported system content block type: ${String(block?.type)}`
      );
    }
    textParts.push(block.text || '');
  }

  return [
    {
      role: options.systemRole || 'developer',
      content: joinTextParts(textParts),
    },
  ];
}

function translateMessages(messages, options = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new GatewayError(
      400,
      'invalid_request_error',
      'messages must be a non-empty array'
    );
  }

  const translated = [];
  for (const message of messages) {
    if (message?.role === 'system') {
      translated.push(...translateSystemMessage(message, options));
      continue;
    }
    if (message?.role === 'user') {
      translated.push(...translateUserMessage(message, options));
      continue;
    }
    if (message?.role === 'assistant') {
      translated.push(...translateAssistantMessage(message, options));
      continue;
    }
    throw new GatewayError(
      400,
      'invalid_request_error',
      `unsupported message role: ${String(message?.role)}`
    );
  }
  return translated;
}

function translateSystemPrompt(system) {
  if (system === undefined || system === null) {
    return '';
  }

  if (typeof system === 'string') {
    return system;
  }

  if (!Array.isArray(system)) {
    throw new GatewayError(
      400,
      'invalid_request_error',
      'system must be a string or an array of text blocks'
    );
  }

  const parts = [];
  for (const block of system) {
    if (block?.type !== 'text') {
      throw new GatewayError(
        400,
        'invalid_request_error',
        `unsupported system content block type: ${String(block?.type)}`
      );
    }
    parts.push(block.text || '');
  }
  return joinTextParts(parts);
}

function translateTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return undefined;
  }

  return tools.map(function mapTool(tool) {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.input_schema || {
          type: 'object',
          properties: {},
        },
      },
    };
  });
}

function translateToolChoice(toolChoice) {
  if (toolChoice === undefined || toolChoice === null) {
    return undefined;
  }

  if (typeof toolChoice !== 'object') {
    throw new GatewayError(
      400,
      'invalid_request_error',
      'tool_choice must be an object when provided'
    );
  }

  if (toolChoice.type === 'auto') {
    return 'auto';
  }
  if (toolChoice.type === 'any') {
    return 'required';
  }
  if (toolChoice.type === 'tool' && toolChoice.name) {
    return {
      type: 'function',
      function: {
        name: toolChoice.name,
      },
    };
  }
  if (toolChoice.type === 'none') {
    return 'none';
  }

  throw new GatewayError(
    400,
    'invalid_request_error',
    `unsupported tool_choice type: ${String(toolChoice.type)}`
  );
}

function validateRouteToolChoice(route, toolChoice) {
  if (route.toolChoicePolicy !== 'auto-none' || toolChoice === undefined || toolChoice === null) {
    return;
  }

  if (typeof toolChoice === 'object' && ['auto', 'none'].includes(toolChoice.type)) {
    return;
  }

  throw new GatewayError(
    400,
    'invalid_request_error',
    `${route.providerLabel || 'Qwen'} deep-thinking routes support only tool_choice auto or none; required and named tool choices cannot be preserved`
  );
}

function shouldTranslateToolChoice(route) {
  return !(route.provider === 'deepseek' && route.thinking?.type === 'enabled' &&
    !route.preserveAssistantThinking);
}

function supportsThinkingControls(route) {
  return route.provider === 'deepseek' || route.provider === 'glm';
}

function shouldTranslateReasoningEffort(route) {
  return !(supportsThinkingControls(route) && route.thinking?.type === 'disabled');
}

function parseToolArguments(toolCall) {
  const parsed = parseJsonObject(
    toolCall.function?.arguments || '{}',
    `tool call ${toolCall.id || toolCall.function?.name || 'unknown'}`
  );

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GatewayError(
      502,
      'api_error',
      'upstream returned tool arguments that were not a JSON object'
    );
  }

  return parsed;
}

function textBlocksFromMessageContent(content) {
  if (!content) {
    return [];
  }
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }

  if (!Array.isArray(content)) {
    throw new GatewayError(
      502,
      'api_error',
      'upstream returned unsupported assistant content'
    );
  }

  const blocks = [];
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string') {
      blocks.push({ type: 'text', text: part.text });
      continue;
    }
  }
  return blocks;
}

export function translateAnthropicMessagesRequest(requestBody, route) {
  return translateAnthropicMessagesRequestWithOptions(requestBody, route);
}

export function translateAnthropicMessagesRequestWithOptions(requestBody, route, options = {}) {
  const messages = [];
  const systemPrompt = translateSystemPrompt(requestBody.system);
  const systemRole = route.systemRole || 'developer';
  const translationOptions = {
    ...options,
    supportsToolResultImages: route.supportsToolResultImages === true,
    systemRole,
  };

  if (systemPrompt) {
    messages.push({
      role: systemRole,
      content: systemPrompt,
    });
  }

  messages.push(...translateMessages(requestBody.messages, translationOptions));

  const translated = {
    model: route.upstreamModel,
    messages,
    stream: requestBody.stream === true,
  };

  if (typeof requestBody.max_tokens === 'number') {
    const maxTokensField = route.maxTokensField || 'max_completion_tokens';
    const routeMaximum = Number(route.maxOutputTokens);
    translated[maxTokensField] =
      Number.isFinite(routeMaximum) && routeMaximum > 0
        ? Math.min(requestBody.max_tokens, routeMaximum)
        : requestBody.max_tokens;
  }
  if (typeof requestBody.temperature === 'number') {
    translated.temperature = requestBody.temperature;
  }
  if (typeof requestBody.top_p === 'number') {
    translated.top_p = requestBody.top_p;
  }
  if (Array.isArray(requestBody.stop_sequences) && requestBody.stop_sequences.length > 0) {
    translated.stop = requestBody.stop_sequences;
  }

  const tools = translateTools(requestBody.tools);
  if (tools) {
    translated.tools = tools;
  }

  if (shouldTranslateToolChoice(route)) {
    validateRouteToolChoice(route, requestBody.tool_choice);
    const toolChoice = translateToolChoice(requestBody.tool_choice);
    if (toolChoice !== undefined) {
      translated.tool_choice = toolChoice;
    }
    if (route.explicitParallelToolCalls && tools) {
      translated.parallel_tool_calls =
        requestBody.tool_choice?.type !== 'none' &&
        requestBody.tool_choice?.disable_parallel_tool_use !== true;
    } else if (
      requestBody.tool_choice?.disable_parallel_tool_use === true &&
      route.supportsParallelToolCalls !== false
    ) {
      translated.parallel_tool_calls = false;
    }
  }

  if (route.reasoningEffort && shouldTranslateReasoningEffort(route)) {
    translated.reasoning_effort = route.reasoningEffort;
  }
  if (route.verbosity) {
    translated.verbosity = route.verbosity;
  }
  if (route.thinking) {
    translated.thinking = route.thinking;
  }
  if (route.enableThinking) {
    translated.enable_thinking = true;
  }
  if (route.preserveThinking) {
    translated.preserve_thinking = true;
  }
  if (translated.stream) {
    translated.stream_options = { include_usage: true };
    if (route.toolStream && tools) {
      translated.tool_stream = true;
    }
  }

  return translated;
}

export function mapOpenAiFinishReason(finishReason) {
  if (finishReason === 'tool_calls') {
    return 'tool_use';
  }
  if (finishReason === 'length') {
    return 'max_tokens';
  }
  if (finishReason === 'stop' || finishReason === null || finishReason === undefined) {
    return finishReason === null || finishReason === undefined ? null : 'end_turn';
  }
  return 'end_turn';
}

export function openAiUsageToAnthropicUsage(usage) {
  const normalized = {
    input_tokens: usage?.prompt_tokens || 0,
    output_tokens: usage?.completion_tokens || 0,
  };
  const cachedTokens = Number(usage?.prompt_tokens_details?.cached_tokens || 0);
  if (cachedTokens > 0) {
    normalized.cache_read_input_tokens = cachedTokens;
  }

  return normalized;
}

export function translateOpenAiResponseToAnthropic(
  responseBody,
  requestedModel,
  requestId,
  options = {}
) {
  const choice = responseBody.choices?.[0];
  if (!choice?.message) {
    throw new GatewayError(
      502,
      'api_error',
      'upstream returned no assistant message'
    );
  }

  const toolCalls = choice.message.tool_calls || [];
  const reasoningContent = choice.message.reasoning_content || '';
  if (reasoningContent) {
    for (const toolCall of toolCalls) {
      options.recordToolCallReasoning?.(toolCall.id, reasoningContent);
    }
  }

  const content = [
    ...(options.emitReasoningContent && reasoningContent
      ? [{ type: 'thinking', thinking: reasoningContent, signature: '' }]
      : []),
    ...textBlocksFromMessageContent(choice.message.content),
    ...toolCalls.map(function toToolUse(toolCall) {
      return {
        type: 'tool_use',
        id: toolCall.id || randomId('toolu'),
        name: toolCall.function?.name || 'unknown_tool',
        input: parseToolArguments(toolCall),
      };
    }),
  ];

  return {
    id: requestId || responseBody.id || randomId('msg'),
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content,
    stop_reason: mapOpenAiFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: openAiUsageToAnthropicUsage(responseBody.usage),
  };
}

export function estimateAnthropicInputTokens(requestBody) {
  const serialized = JSON.stringify({
    model: requestBody.model,
    system: requestBody.system,
    messages: requestBody.messages,
    tools: requestBody.tools,
    tool_choice: requestBody.tool_choice,
  });
  // This endpoint supplies a local preflight estimate for routes whose native
  // tokenizer is unavailable. The 2:1 UTF-8-byte heuristic intentionally
  // favors source code but is not a formal upper bound. Actual Codex turn usage
  // remains authoritative once app-server reports it. Providers that need an
  // early fail-closed ceiling use the separate conservative-estimate policy.
  return Math.max(1, Math.ceil(Buffer.byteLength(serialized, 'utf8') / 2));
}

export function formatAnthropicError(error) {
  if (error instanceof GatewayError) {
    return {
      status: error.status,
      body: {
        type: 'error',
        error: {
          type: error.type,
          message: error.message,
        },
      },
    };
  }

  return {
    status: 500,
    body: {
      type: 'error',
      error: {
        type: 'api_error',
        message:
          error instanceof Error ? error.message : 'unexpected gateway failure',
      },
    },
  };
}
