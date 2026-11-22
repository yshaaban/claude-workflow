import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareCodexToolResult } from '../js/gateway/codex-provider.js';

const CALL_ID = 'call_read';
const POSIX_PATH = '/workspace/large.txt';

function pendingRead(argumentsValue = { file_path: POSIX_PATH }) {
  return {
    callId: CALL_ID,
    tool: 'Read',
    arguments: argumentsValue,
  };
}

function lineNotice(pathname, { start = 1, end = 2, total = 5 } = {}) {
  const count = end - start + 1;
  return (
    `[Truncated: PARTIAL view — ${pathname}: showing lines ${String(start)}-${String(
      end
    )} of ${String(total)} total (40000 tokens, cap 25000). ` +
    `Call Read with offset=${String(end + 1)} limit=${String(
      count
    )} for the next page, or Grep to find a specific section. ` +
    'Do NOT answer from this page alone if the answer may be further in the file.]'
  );
}

function characterNotice(pathname, shownCharacters, totalCharacters) {
  return (
    `[Truncated: PARTIAL view — ${pathname}: showing the first ${String(
      shownCharacters
    )} of ${String(totalCharacters)} characters (40000 tokens, cap 25000); ` +
    'this file has very long lines and cannot be paginated by line. ' +
    'Use Grep to find a specific section, or Read with offset/limit to page through it. ' +
    'Do NOT answer from this excerpt alone if the answer may be elsewhere in the file.]'
  );
}

function requestWithToolResult(text, systemMessages = [], isError = false) {
  return {
    messages: [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: CALL_ID,
            name: 'Read',
            input: { file_path: POSIX_PATH },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: CALL_ID,
            content: text,
            ...(isError ? { is_error: true } : {}),
          },
        ],
      },
      ...systemMessages.map((systemText) => ({
        role: 'system',
        content: [{ type: 'text', text: systemText }],
      })),
    ],
  };
}

function prepare({
  text,
  args = { file_path: POSIX_PATH },
  systemMessages = [],
  maxBytes = 36_000,
  isError = false,
}) {
  return prepareCodexToolResult(
    requestWithToolResult(text, systemMessages, isError),
    pendingRead(args),
    maxBytes
  );
}

function pageMetadata(text) {
  const marker = '[Codex Read page metadata]\n';
  const start = text.indexOf(marker);
  if (start < 0) {
    return null;
  }
  return JSON.parse(text.slice(start + marker.length).split('\n')[0]);
}

test('Read image output is never parsed as numbered source or truncated mid-image', () => {
  const text = [
    { type: 'text', text: 'before' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YQ==' } },
    { type: 'text', text: 'after' },
  ];
  const result = prepare({ text, maxBytes: 1024 });
  assert.deepEqual(result.limitedToolResult.contentItems, [
    { type: 'inputText', text: 'before' },
    { type: 'inputImage', imageUrl: 'data:image/png;base64,YQ==' },
    { type: 'inputText', text: 'after' },
  ]);
  const denied = prepare({ text, maxBytes: 10 }).limitedToolResult;
  assert.equal(denied.isError, true);
  assert.ok(denied.bytes <= 10);
  assert.equal(denied.contentItems, undefined);
});

test('no PARTIAL banner never proves whole-file completeness', () => {
  const result = prepare({
    text: '1\tWarning: source text mentions a file offset\n2\tstill ordinary source',
  });
  const metadata = pageMetadata(result.limitedToolResult.text);

  assert.equal(result.readFeedback.feedback.guidanceAppended, false);
  assert.equal(result.limitedToolResult.readCoverageVerified, true);
  assert.equal(metadata.covered_start, 1);
  assert.equal(metadata.covered_end, 2);
  assert.equal(metadata.source_total_lines, null);
  assert.equal(metadata.next_offset, 3);
  assert.equal(metadata.source_complete, false);
});

test('an explicit line limit returning fewer records is a bounded EOF proof', () => {
  const result = prepare({
    text: '41\tpenultimate\n42\tlast',
    args: { file_path: POSIX_PATH, offset: 41, limit: 5 },
  });
  const metadata = pageMetadata(result.limitedToolResult.text);

  assert.equal(metadata.covered_start, 41);
  assert.equal(metadata.covered_end, 42);
  assert.equal(metadata.source_total_lines, 42);
  assert.equal(metadata.next_offset, null);
  assert.equal(metadata.next_limit, null);
  assert.equal(metadata.source_complete, true);
});

test('a malformed adjacent PARTIAL banner fails closed', () => {
  const malformed =
    `[Truncated: PARTIAL view — ${POSIX_PATH}: showing lines nope.]\n\n` +
    '<total_tokens>unrelated</total_tokens>';
  const result = prepare({ text: '1\tone\n2\ttwo', systemMessages: [malformed] });
  const output = result.limitedToolResult.text;

  assert.equal(result.limitedToolResult.readCoverageVerified, false);
  assert.equal(result.limitedToolResult.readNoticeStatus, 'invalid');
  assert.match(output, /No source-line coverage or completeness claim/u);
  assert.match(output, /Retry Read with a smaller explicit 1-based offset and limit/u);
  assert.equal(output.includes('[Codex Read page metadata]'), false);
  assert.equal(output.includes('<total_tokens>'), false);
});

test('mismatched PARTIAL paths and ranges cannot attach coverage metadata', async (t) => {
  await t.test('path mismatch', () => {
    const result = prepare({
      text: '1\tone\n2\ttwo',
      systemMessages: [lineNotice('/workspace/unrelated.txt')],
    });
    assert.equal(result.limitedToolResult.readNoticeStatus, 'invalid');
    assert.equal(result.limitedToolResult.readCoverageVerified, false);
    assert.match(result.limitedToolResult.text, /names a different path/u);
  });

  await t.test('range mismatch', () => {
    const result = prepare({
      text: '1\tone\n2\ttwo',
      systemMessages: [lineNotice(POSIX_PATH, { start: 2, end: 3, total: 5 })],
    });
    assert.equal(result.limitedToolResult.readNoticeStatus, 'invalid');
    assert.equal(result.limitedToolResult.readCoverageVerified, false);
    assert.match(result.limitedToolResult.text, /inconsistent line range or continuation offset/u);
  });
});

test('only the immediately adjacent system message may carry Read metadata', () => {
  const result = prepare({
    text: '1\tone\n2\ttwo',
    systemMessages: [
      '<system-reminder>unrelated</system-reminder>',
      lineNotice(POSIX_PATH),
    ],
  });
  const metadata = pageMetadata(result.limitedToolResult.text);

  assert.equal(result.limitedToolResult.readNoticeStatus, 'none');
  assert.equal(metadata.source_total_lines, null);
  assert.equal(metadata.source_complete, false);
  assert.equal(result.limitedToolResult.text.includes('system-reminder'), false);
});

test('Windows and WSL spellings correlate without forwarding system prose', () => {
  const result = prepare({
    text: '1\tone\n2\ttwo',
    args: { file_path: 'C:\\Workspace\\large.txt' },
    systemMessages: [
      `${lineNotice('/mnt/c/workspace/large.txt')}\n\n<total_tokens>secret reminder</total_tokens>`,
    ],
  });
  const metadata = pageMetadata(result.limitedToolResult.text);

  assert.equal(result.limitedToolResult.readNoticeStatus, 'validated');
  assert.equal(metadata.path, 'C:\\Workspace\\large.txt');
  assert.equal(metadata.source_total_lines, 5);
  assert.equal(metadata.next_offset, 3);
  assert.equal(result.limitedToolResult.text.includes('<total_tokens>'), false);
});

test('a Claude long-line character excerpt makes no source-line claim', () => {
  const excerpt = 'x'.repeat(100);
  const result = prepare({
    text: excerpt,
    systemMessages: [characterNotice(POSIX_PATH, excerpt.length, 1_000)],
  });

  assert.equal(result.limitedToolResult.readNoticeStatus, 'validated');
  assert.equal(result.limitedToolResult.readCoverageVerified, false);
  assert.match(result.limitedToolResult.text, /long-line character excerpt/u);
  assert.match(result.limitedToolResult.text, /Bash byte\/character slice/u);
  assert.equal(result.limitedToolResult.text.includes('[Codex Read page metadata]'), false);
});

test('a first numbered line larger than the inline budget fails closed', () => {
  const result = prepare({
    text: `1\t${'x'.repeat(4_000)}`,
    maxBytes: 600,
  });

  assert.equal(result.limitedToolResult.readCoverageVerified, false);
  assert.equal(Buffer.byteLength(result.limitedToolResult.text, 'utf8') <= 600, true);
  assert.match(result.limitedToolResult.text, /first complete numbered source line/u);
  assert.match(result.limitedToolResult.text, /Bash byte\/character slice/u);
  assert.equal(result.limitedToolResult.text.includes('1\t'), false);
  assert.equal(result.limitedToolResult.text.includes('[Codex Read page metadata]'), false);
});
