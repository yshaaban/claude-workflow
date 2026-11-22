import assert from 'node:assert/strict';
import test from 'node:test';

import { CodexSessionManager } from '../js/gateway/codex-provider.js';

test('a deferred placeholder fails before starting a Codex thread', async () => {
  const manager = new CodexSessionManager({ codex: { maxSessions: 1 } });
  const body = { tools: [{ name: 'DeferredToolPlaceholder', defer_loading: true }] };
  assert.throws(() => manager.ensureSession({}, body, {}), /ENABLE_TOOL_SEARCH=false/u);
  assert.equal(manager.sessions.size, 0);
  await manager.close();
});

function idleSession(sessionKey, closed) {
  return {
    sessionKey,
    lastUsedSequence: 0,
    isCapacityEvictable() {
      return true;
    },
    async close() {
      closed.push(sessionKey);
    },
  };
}

test('admission LRU ignores wall-clock rollback', async function () {
  const originalNow = Date.now;
  let wallClock = 20_000;
  Date.now = () => wallClock;
  const closed = [];
  const manager = new CodexSessionManager({ codex: { maxSessions: 2 } });
  const first = idleSession('first', closed);
  const second = idleSession('second', closed);

  try {
    manager.markSessionUsed(first);
    wallClock = 30_000;
    manager.markSessionUsed(second);
    wallClock = 500;
    manager.markSessionUsed(first);
    manager.sessions.set(first.sessionKey, first);
    manager.sessions.set(second.sessionKey, second);

    manager.ensureSessionCapacity('incoming');
    await Promise.all([...manager.pendingSessionClosures]);

    assert.deepEqual(closed, ['second']);
    assert.equal(manager.sessions.has('first'), true);
  } finally {
    Date.now = originalNow;
    await manager.close();
  }
});

test('background excess-idle eviction uses the same monotonic recency order', async function () {
  const closed = [];
  const manager = new CodexSessionManager({ codex: { maxSessions: 2 } });
  const first = idleSession('first', closed);
  const second = idleSession('second', closed);
  const protectedSession = idleSession('protected', closed);

  manager.markSessionUsed(first);
  manager.markSessionUsed(second);
  manager.markSessionUsed(first);
  manager.markSessionUsed(protectedSession);
  manager.sessions.set(first.sessionKey, first);
  manager.sessions.set(second.sessionKey, second);
  manager.sessions.set(protectedSession.sessionKey, protectedSession);

  await manager.evictExcessIdleSessions(protectedSession);

  assert.deepEqual(closed, ['second']);
  assert.deepEqual([...manager.sessions.keys()], ['first', 'protected']);
  await manager.close();
});
