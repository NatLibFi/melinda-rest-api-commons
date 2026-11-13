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

test('B-2: consumeChunk rejects with TypeError when channel.get returns null (queue drained)', async () => {
  // See zoo/bug-report.md B-2 (src/amqp.js, getData/pump):
  // pump does `message.properties.correlationId` without a null check,
  // so a drained queue (channel.get -> null) crashes with a TypeError.
  // This test documents the CURRENT (broken) behaviour.
  const amqpOperator = await makeOperator({
    checkQueue: async () => ({messageCount: 1}),
    get: async () => null
  });
  await assert.rejects(
    () => amqpOperator.consumeChunk(QUEUE, false),
    (error) => {
      assert.ok(error instanceof TypeError);
      assert.match(error.message, /null/);
      return true;
    }
  );
});

test('B-1: consumeChunk returns both duplicate messages (dedup is dead)', async () => {
  // See zoo/bug-report.md B-1 (src/amqp.js, getData/pump):
  // `identifiers.includes(identifier)` compares objects by reference,
  // so the dedup branch NEVER triggers. Duplicate messages with the
  // same correlationId + deliveryTag are all returned.
  // This test documents the CURRENT (broken) behaviour.
  const duplicate = makeMessage('c1', 1);
  const amqpOperator = await makeOperator({
    checkQueue: async () => ({messageCount: 2}),
    get: async () => duplicate
  });
  const {records, messages} = await amqpOperator.consumeChunk(QUEUE, true);
  assert.equal(messages.length, 2);
  assert.equal(records.length, 2);
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
