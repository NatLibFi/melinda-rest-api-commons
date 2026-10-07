import assert from 'node:assert';
import {test} from 'node:test';
import createAmqp from '../src/amqp.js';

const DUMMY_URL = 'amqp://stub:5672/';
const QUEUE = 'TESTQUEUE';

function makeMessage(correlationId, deliveryTag) {
  const data = {leader: '00000nam a22000000i 4500', fields: [{tag: '001', value: '123'}]};
  const content = JSON.stringify({data});
  return {
    content: Buffer.from(content),
    properties: {correlationId, headers: {from: 'TEST'}},
    fields: {deliveryTag}
  };
}

function makeChannel(overrides = {}) {
  return {
    assertQueue: async () => ({messageCount: 0}),
    checkQueue: async () => ({messageCount: 0}),
    get: async () => false,
    ack: () => {},
    nack: () => {},
    purgeQueue: async () => {},
    close: async () => {},
    ...overrides
  };
}

async function makeOperator(channelOverrides) {
  const channel = makeChannel(channelOverrides);
  const connection = {createChannel: async () => channel, close: async () => {}};
  return createAmqp(DUMMY_URL, false, {connection, channel});
}

test('B-2 (fixed): consumeChunk returns false when queue drains mid-pump', async () => {
  // See zoo/bug-report.md B-2 (src/amqp.js, getData/pump):
  // FIXED: pump now bails out (returns results) when channel.get -> null,
  // and consumeChunk maps an empty pump result to false, matching the
  // empty-queue contract of checkQueue. Previously this crashed with
  // TypeError: Cannot read properties of null (reading 'properties').
  const amqpOperator = await makeOperator({
    checkQueue: async () => ({messageCount: 1}),
    get: async () => null
  });
  const result = await amqpOperator.consumeChunk(QUEUE, false);
  assert.strictEqual(result, false);
});

test('B-2 (fixed): consumeChunk returns partial chunk when queue drains after first message', async () => {
  // Drains after one of two messages: pump must stop gracefully and
  // consumeChunk must return the one message it got.
  const first = makeMessage('c1', 1);
  let drained = false;
  const amqpOperator = await makeOperator({
    checkQueue: async () => ({messageCount: 2}),
    get: async () => {
      if (drained) return null;
      drained = true;
      return first;
    }
  });
  const {records, messages} = await amqpOperator.consumeChunk(QUEUE, true);
  assert.equal(messages.length, 1);
  assert.equal(records.length, 1);
});


test('happy path: consumeChunk returns two distinct messages', async () => {
  const messages = [
    makeMessage('c1', 1),
    makeMessage('c2', 2)
  ];
  const amqpOperator = await makeOperator({
    checkQueue: async () => ({messageCount: messages.length}),
    get: async () => messages.shift()
  });
  const {headers, records, messages: got} = await amqpOperator.consumeChunk(QUEUE, true);
  assert.equal(got.length, 2);
  assert.equal(records.length, 2);
  assert.deepStrictEqual(headers, {from: 'TEST'});
});
