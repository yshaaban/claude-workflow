import { createHash } from 'node:crypto';

import { GatewayError } from './model-routing.js';

// Codex 0.171 history.rs estimates resized (non-original-detail) images at
// 7,373 model-visible bytes, or 1,844 tokens. The encoded data is transport.
const IMAGE_TOKENS = 1_844;

const PDF_RESULT_ERROR = 'Codex cannot view a whole PDF tool result. No PDF content was forwarded. For a local file, use Read with a small pages range such as "1-3"; otherwise request page images or extracted text.';
const DOCUMENT_RESULT_ERROR = 'Codex cannot view this document tool result. No document content was forwarded. Request text or page images instead.';
const UNSUPPORTED_RESULT = 'Codex cannot use this tool result. No content was forwarded. Return text, inline images, or named tool references.';

export function toolResultContentError(content) {
  if (content === undefined || typeof content === 'string') return null;
  if (!Array.isArray(content)) return UNSUPPORTED_RESULT;
  const document = content.find(block => block?.type === 'document');
  if (document) return document.source?.media_type === 'application/pdf' ? PDF_RESULT_ERROR : DOCUMENT_RESULT_ERROR;
  for (const block of content) {
    if (block?.type === 'image') {
      const error = imageSourceError(block.source);
      if (error) return `Tool image omitted: ${error}. No content was forwarded.`;
    } else if (block?.type === 'text' && typeof block.text === 'string') {
      continue;
    } else if (block?.type !== 'tool_reference' || typeof block.tool_name !== 'string' || !block.tool_name) {
      return UNSUPPORTED_RESULT;
    }
  }
  return null;
}

export function rejectCodexDocumentAttachment() {
  throw new GatewayError(400, 'invalid_request_error',
    'Codex does not accept direct document attachments. Provide text or page images; for a local PDF, ask Claude to use Read with a pages range.');
}

export function estimateCodexRequestTokens(body, bytesPerToken = 2) {
  let imageTokens = 0;
  const blockForEstimate = (block) => {
    if (block?.type === 'document') rejectCodexDocumentAttachment();
    if (block?.type === 'image') {
      codexImageUrl(block);
      imageTokens += IMAGE_TOKENS;
      return { type: 'image' };
    }
    if (block?.type === 'tool_result') {
      const error = toolResultContentError(block.content);
      if (error) return { ...block, content: error, is_error: true };
      if (Array.isArray(block.content)) return { ...block, content: block.content.map(blockForEstimate) };
    }
    return block;
  };
  const serialized = JSON.stringify({
    model: body.model,
    system: body.system,
    messages: Array.isArray(body.messages) ? body.messages.map((message) => Array.isArray(message?.content)
      ? { ...message, content: message.content.map(blockForEstimate) }
      : message) : body.messages,
    tools: body.tools,
    tool_choice: body.tool_choice,
  });
  return Math.max(1, imageTokens + Math.ceil(Buffer.byteLength(serialized, 'utf8') / bytesPerToken));
}

function imageSourceError(source) {
  // app-server rejects remote URLs in both turn/start and item/tool/call.
  if (source?.type !== 'base64') {
    return 'Codex images require inline base64 data; remote URLs and file references are not supported';
  }
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(source.media_type) ||
      typeof source.data !== 'string' || !source.data || source.data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/u.test(source.data)) {
    return 'Invalid inline image: supply base64 data and a PNG, JPEG, WebP or GIF media type';
  }
  return null;
}

export function codexImageUrl(block) {
  const source = block?.source;
  const error = imageSourceError(source);
  if (error) throw new GatewayError(400, 'invalid_request_error', error);
  return `data:${source.media_type};base64,${source.data}`;
}

export function referenceText(block) {
  if (typeof block.tool_name !== 'string' || !block.tool_name) {
    throw new GatewayError(400, 'invalid_request_error', 'tool_reference must include tool_name');
  }
  // Codex has no tool_reference output item. Its dynamic tool descriptions
  // identify the original Claude tool by this exact name.
  return `[Claude tool reference: ${JSON.stringify(block.tool_name)}]`;
}

export function renderCodexImage(block, images) {
  return images ? images.mark(block) :
    `[inline image sha256:${createHash('sha256').update(codexImageUrl(block)).digest('hex')}]`;
}

// The transcript budget operates on text. Represent each image as one atomic
// character while selecting history, then emit the actual typed item in place.
// Reserve only characters absent from the request, so literal user text can
// never synthesize an attachment and truncation cannot split an attachment.
export function turnImages(requestBody) {
  const byMarker = new Map();
  const byBlock = new WeakMap();
  let reserved = null;
  let next = 0xe000;
  return {
    tokens(text) {
      if (!byMarker.size) return 0;
      let count = 0;
      for (const match of text.matchAll(/[\ue000-\uf8ff]/gu)) {
        if (byMarker.has(match[0])) count++;
      }
      return count * IMAGE_TOKENS;
    },
    mark(block) {
      if (byBlock.has(block)) return byBlock.get(block);
      if (!reserved) {
        reserved = new Set();
        for (const match of JSON.stringify(requestBody.messages).matchAll(/[\ue000-\uf8ff]/gu)) {
          reserved.add(match[0]);
        }
      }
      while (next <= 0xf8ff && reserved.has(String.fromCharCode(next))) next++;
      if (next > 0xf8ff) throw new GatewayError(413, 'invalid_request_error', 'Too many distinct inline image markers for a single request');
      const marker = String.fromCharCode(next++);
      byMarker.set(marker, { type: 'image', url: codexImageUrl(block) });
      byBlock.set(block, marker);
      return marker;
    },
    input(text, latestBlocks) {
      if (!byMarker.size) return [{ type: 'text', text }];
      let start = 0;
      const input = [];
      const emitted = new Set();
      for (const match of text.matchAll(/[\ue000-\uf8ff]/gu)) {
        const image = byMarker.get(match[0]);
        if (!image) continue;
        emitted.add(match[0]);
        if (match.index > start) input.push({ type: 'text', text: text.slice(start, match.index) });
        input.push(image);
        start = match.index + 1;
      }
      if (start < text.length) input.push({ type: 'text', text: text.slice(start) });
      for (const block of latestBlocks.flatMap((b) => b?.type === 'tool_result' && Array.isArray(b.content) ? b.content : [b])) {
        if (byBlock.has(block) && !emitted.has(byBlock.get(block))) {
          throw new GatewayError(413, 'invalid_request_error', 'The latest message and its images do not fit the configured Codex input budget');
        }
      }
      return input;
    },
  };
}
