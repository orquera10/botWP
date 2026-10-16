import test from 'node:test';
import assert from 'node:assert/strict';
import { aiEnabled } from '../src/aiConversation.js';

test('saved response mode overrides the default and always requires a Gemini key', () => {
  const oldFlag = process.env.AI_CONVERSATION_ENABLED;
  const oldKey = process.env.GEMINI_API_KEY;
  try {
    process.env.GEMINI_API_KEY = 'test-only';
    process.env.AI_CONVERSATION_ENABLED = 'false';
    assert.equal(aiEnabled({}), false);
    assert.equal(aiEnabled({ aiEnabled: true }), true);
    process.env.AI_CONVERSATION_ENABLED = 'true';
    assert.equal(aiEnabled({}), true);
    assert.equal(aiEnabled({ aiEnabled: false }), false);
    assert.equal(aiEnabled(JSON.parse(JSON.stringify({ aiEnabled: false }))), false);
    delete process.env.GEMINI_API_KEY;
    assert.equal(aiEnabled({ aiEnabled: true }), false);
    assert.equal(aiEnabled({}), false);
  } finally {
    if (oldFlag === undefined) delete process.env.AI_CONVERSATION_ENABLED;
    else process.env.AI_CONVERSATION_ENABLED = oldFlag;
    if (oldKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = oldKey;
  }
});
