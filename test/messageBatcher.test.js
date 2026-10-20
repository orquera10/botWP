import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageBatcher } from '../src/messageBatcher.js';

test('message batcher combines multiple quick messages into a single newline-separated text', async () => {
  const batcher = createMessageBatcher({ debounceMs: 50, maxWaitMs: 200 });
  const executed = [];
  let typingCount = 0;

  const p1 = batcher.enqueue('chat1', 'hola', async text => {
    executed.push(text);
    return 'response1';
  }, () => typingCount++);

  await new Promise(r => setTimeout(r, 20));
  const p2 = batcher.enqueue('chat1', 'cómo estás?', async text => {
    executed.push(text);
    return 'response2';
  }, () => typingCount++);

  await new Promise(r => setTimeout(r, 20));
  const p3 = batcher.enqueue('chat1', 'tenés cancha para hoy?', async text => {
    executed.push(text);
    return 'response3';
  }, () => typingCount++);

  const [res1, res2, res3] = await Promise.all([p1, p2, p3]);
  assert.equal(executed.length, 1);
  assert.equal(executed[0], 'hola\ncómo estás?\ntenés cancha para hoy?');
  assert.equal(res1, 'response1');
  assert.equal(res2, 'response1');
  assert.equal(res3, 'response1');
  assert.equal(typingCount, 3);
});

test('message batcher flushes on maxWaitMs even if user continuously sends messages', async () => {
  const batcher = createMessageBatcher({ debounceMs: 100, maxWaitMs: 150 });
  const executed = [];

  const p1 = batcher.enqueue('chat2', 'msg1', async text => {
    executed.push(text);
    return 'ok';
  });

  await new Promise(r => setTimeout(r, 80));
  batcher.enqueue('chat2', 'msg2', async () => {});

  await new Promise(r => setTimeout(r, 80));
  batcher.enqueue('chat2', 'msg3', async () => {});

  await p1;
  assert.equal(executed.length, 1);
  assert.match(executed[0], /msg1\nmsg2/);
});

test('different chats do not interfere with each other', async () => {
  const batcher = createMessageBatcher({ debounceMs: 30, maxWaitMs: 100 });
  const executed = [];

  const p1 = batcher.enqueue('userA', 'hola de A', async text => {
    executed.push(text);
    return 'A';
  });
  const p2 = batcher.enqueue('userB', 'hola de B', async text => {
    executed.push(text);
    return 'B';
  });

  const [resA, resB] = await Promise.all([p1, p2]);
  assert.equal(resA, 'A');
  assert.equal(resB, 'B');
  assert.equal(executed.length, 2);
  assert.ok(executed.includes('hola de A'));
  assert.ok(executed.includes('hola de B'));
});
