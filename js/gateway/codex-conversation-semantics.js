import { isDeepStrictEqual } from 'node:util';
import { codexImageUrl } from './codex-content.js';
import { GatewayError } from './model-routing.js';

function reject(message) {
  throw new GatewayError(400, 'invalid_request_error', message);
}

export function codexOutputSchema(requestBody) {
  const format = requestBody.output_config?.format;
  if (format === undefined) return null;
  if (format?.type !== 'json_schema' || !format.schema ||
      typeof format.schema !== 'object' || Array.isArray(format.schema)) {
    reject('Codex requires output_config.format of type json_schema with an object schema.');
  }
  return format.schema;
}

export function validatePendingOutputSchema(activeSchema, requestBody) {
  if (!isDeepStrictEqual(activeSchema, codexOutputSchema(requestBody))) {
    reject('Cannot change output_config.format while a Codex tool call is pending. Resend the same format with the tool result; a new turn can set a different format.');
  }
}

export function rejectInlineToolChanges(messages) {
  // Check the entire conversation before suggesting Claude's system-text
  // fallback; a later withdrawal must not be discarded along with an earlier
  // reminder. These are operations, not text suitable for role conversion.
  if (Array.isArray(messages) && messages.some(m => m?.role === 'system' &&
      Array.isArray(m.content) && m.content.some(b => b?.type === 'tool_addition' || b?.type === 'tool_removal'))) {
    reject('Codex cannot apply inline tool_addition or tool_removal. Send the currently available tool schemas in tools on a new turn.');
  }
}

// app-server has turn-scoped user steering, not a mid-turn developer message.
// Reject meaningful system entries in the form Claude Code recognizes: its
// native fallback preserves reminder/attachment text in user messages. Never
// put an ephemeral reminder into the thread's durable developer instructions.
export function validateCodexSystemMessage(blocks, isHandledReadLine) {
  const isAccounting = line => /^<total_tokens>\d+ tokens left<\/total_tokens>$/u.test(line);
  if (blocks.every(b => b?.type === 'text' && typeof b.text === 'string' &&
      b.text.split(/\r?\n/u).every(line => !line.trim() || isAccounting(line) ||
        isHandledReadLine(line)))) {
    // Empty entries may also carry Claude's effort. Workflow applies the
    // configured runner effort, independently of the native coordinator.
    return;
  }
  reject('Mid-conversation role "system" is not supported on Codex. Resend the reminder or attachment content in user messages.');
}

export function rejectCodexCompaction() {
  reject('Anthropic compaction requests and signed compaction blocks cannot be replayed on Codex. Use the native Anthropic route, or provide a plain-text summary in a new conversation.');
}

// A sibling block has user authority; it is not output from the tool.
// Anthropic requires tool results to precede any accompanying user input.
export function pendingUserSteer(blocks, callId) {
  const input = [];
  let seen = false;
  for (const block of blocks) {
    if (block?.type === 'tool_result') {
      if (seen || block.tool_use_id !== callId) {
        reject('Send exactly the matching tool_result for the pending Codex call; a batch of unrelated tool results cannot be applied to this call.');
      }
      seen = true;
    } else if (!seen) {
      reject('The matching tool_result must precede any accompanying user text or image.');
    } else if (block?.type === 'text' && typeof block.text === 'string') {
      if (block.text) input.push({ type: 'text', text: block.text });
    } else if (block?.type === 'image') {
      input.push({ type: 'image', url: codexImageUrl(block) });
    } else {
      reject(`Unsupported user content beside a pending tool_result: ${String(block?.type)}`);
    }
  }
  return input;
}
