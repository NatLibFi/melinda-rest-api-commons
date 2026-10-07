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


test('B-1 (fixed): consumeChunk deduplicates messages with same correlationId + deliveryTag', async () => {
  // See zoo/bug-report.md B-1 (src/amqp.js, getData/pump):
  // FIXED: dedup now compares correlationId + deliveryTag field-by-field,
  // so duplicate messages are filtered out. (Previously the includes()
  // check compared object references and never triggered.)
  const duplicate = makeMessage('c1', 1);
  const amqpOperator = await makeOperator({
    checkQueue: async () => ({messageCount: 2}),
    get: async () => duplicate
  });
  const {records, messages} = await amqpOperator.consumeChunk(QUEUE, true);
  assert.equal(messages.length, 1);
  assert.equal(records.length, 1);
});

test('B-1 (fixed): same deliveryTag with different correlationIds is NOT deduplicated', async () => {
  // Dedup key is correlationId + deliveryTag; a redelivery of a message
  // with a new correlationId must still come through.
  const messages = [makeMessage('c1', 1), makeMessage('c2', 1)];
  const amqpOperator = await makeOperator({
    checkQueue: async () => ({messageCount: 2}),
    get: async () => messages.shift()
  });
  const {messages: got} = await amqpOperator.consumeChunk(QUEUE, true);
  assert.equal(got.length, 2);
});

test('B-4 (fixed): removeQueue closes the temp channel even when deleteQueue throws', async () => {
  // See zoo/bug-report.md B-4 (src/amqp.js, removeQueue):
  // FIXED: the throwaway tempChannel is now closed in a finally block, so a
  // missing queue (deleteQueue throws) no longer leaks a channel.
  const closedChannels = [];
  const tempChannel = {
    deleteQueue: async () => {
      throw new Error('NOT_FOUND - queue missing');
    },
    close: async () => {
      // eslint-disable-next-line functional/immutable-data
      closedChannels.push('temp');
    }
  };
  const amqpOperator = await createAmqp(DUMMY_URL, false, {
    connection: {createChannel: async () => tempChannel, close: async () => {}},
    channel: makeChannel()
  });
  await assert.rejects(() => amqpOperator.removeQueue(QUEUE));
  assert.deepStrictEqual(closedChannels, ['temp']);
});

test('B-4 (fixed): removeQueue closes the temp channel on success too', async () => {
  const closedChannels = [];
  const amqpOperator = await createAmqp(DUMMY_URL, false, {
    connection: {
      createChannel: async () => ({
        deleteQueue: async () => {},
        close: async () => {
          // eslint-disable-next-line functional/immutable-data
          closedChannels.push('temp');
        }
      }),
      close: async () => {}
    },
    channel: makeChannel()
  });
  await amqpOperator.removeQueue(QUEUE);
  assert.deepStrictEqual(closedChannels, ['temp']);
});

test('B-3 (fixed): healthCheck loop stops after closeChannel and does not keep firing or throw', async () => {
  // See zoo/bug-report.md B-3 (src/amqp.js, healthCheck):
  // FIXED: closeChannel/closeConnection cancel the recursive healthCheck loop,
  // so the ~200 ms chain short-circuits instead of running until the closed
  // channel throws (which used to make graceful shutdown flaky).
  // The stub only starts throwing for the HEALTHCHECK queue once it is
  // closed, so the un-cancelled iterations before the close succeed.
  let closed = false;
  let healthCheckCalls = 0;
  const channel = {
    assertQueue: async (name) => {
      if (name === 'HEALTHCHECK') {
        // eslint-disable-next-line functional/immutable-data
        healthCheckCalls += 1;
        if (closed) {
          throw new Error('channel closed');
        }
      }
      return {messageCount: 0};
    },
    checkQueue: async () => ({messageCount: 0}),
    get: async () => false,
    ack: () => {},
    nack: () => {},
    purgeQueue: async () => {},
    close: async () => {
      // eslint-disable-next-line functional/immutable-data
      closed = true;
    }
  };
  const amqpOperator = await createAmqp(DUMMY_URL, true, {
    connection: {createChannel: async () => channel, close: async () => {}},
    channel
  });
  // let the health check run at least once, then cancel it
  await new Promise((resolve) => setTimeout(resolve, 350));
  await amqpOperator.closeChannel();
  const callsAfterClose = healthCheckCalls;
  // wait longer than the 200 ms loop interval - no further health checks may fire
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.ok(healthCheckCalls > 0, 'health check should have run before close');
  assert.equal(healthCheckCalls, callsAfterClose, 'no health checks after closeChannel');
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
