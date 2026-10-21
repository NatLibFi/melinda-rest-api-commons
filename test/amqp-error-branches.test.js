import assert from 'node:assert';
import {test} from 'node:test';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Error as ApiError} from '@natlibfi/melinda-commons';
import createAmqp from '../src/amqp.js';

const AMQP_MODULE_PATH = fileURLToPath(new URL('../src/amqp.js', import.meta.url));

const DUMMY_URL = 'amqp://stub:5672/';
const QUEUE = 'TESTQUEUE';

/**
 * @param {*} correlationId
 * @param {*} deliveryTag
 * @returns {*}
 */
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
    sendToQueue: async () => {},
    ...overrides
  };
}

/**
 * @param {*} channelOverrides
 * @returns {Promise<*>}
 */
async function makeOperator(channelOverrides = undefined) {
  const channel = makeChannel(channelOverrides);
  const connection = {createChannel: async () => channel, close: async () => {}};
  return createAmqp(DUMMY_URL, false, {connection, channel});
}

test('consumeChunk returns false when queue drains mid-pump', async () => {
  // (src/amqp.js, getData/pump):
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

test('consumeChunk returns partial chunk when queue drains after first message', async () => {
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


test('consumeChunk deduplicates messages with same correlationId + deliveryTag', async () => {
  // (src/amqp.js, getData/pump):
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

test('same deliveryTag with different correlationIds is NOT deduplicated', async () => {
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

test('removeQueue closes the temp channel even when deleteQueue throws', async () => {
  // (src/amqp.js, removeQueue):
  // FIXED: the throwaway tempChannel is now closed in a finally block, so a
  // missing queue (deleteQueue throws) no longer leaks a channel.
  /** @type {any[]} */
  const closedChannels = [];
  const tempChannel = {
    deleteQueue: async () => {
      throw new Error('NOT_FOUND - queue missing');
    },
    close: async () => {
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

test('removeQueue closes the temp channel on success too', async () => {
  /** @type {any[]} */
  const closedChannels = [];
  const amqpOperator = await createAmqp(DUMMY_URL, false, {
    connection: {
      createChannel: async () => ({
        deleteQueue: async () => {},
        close: async () => {
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

test('healthCheck loop stops after closeChannel and does not keep firing or throw', async () => {
  // (src/amqp.js, healthCheck):
  // FIXED: closeChannel/closeConnection cancel the recursive healthCheck loop,
  // so the ~200 ms chain short-circuits instead of running until the closed
  // channel throws (which used to make graceful shutdown flaky).
  // The stub only starts throwing for the HEALTHCHECK queue once it is
  // closed, so the un-cancelled iterations before the close succeed.
  let closed = false;
  let healthCheckCalls = 0;
  const channel = {
    assertQueue: /** @param {*} name */ async (name) => {
      if (name === 'HEALTHCHECK') {
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

// ---------------------------------------------------------------------------
// checkQueue styles
// ---------------------------------------------------------------------------

test('checkQueue style messages returns the message count', async () => {
  for (const count of [0, 3, 42]) {
    const amqpOperator = await makeOperator({assertQueue: async () => ({messageCount: count})});
    const result = await amqpOperator.checkQueue({queue: QUEUE, style: 'messages'});
    assert.strictEqual(result, count);
  }
});

test('checkQueue style one returns the {headers, records, messages} form when toRecord is true', async () => {
  const message = makeMessage('c1', 1);
  const amqpOperator = await makeOperator({
    assertQueue: async () => ({messageCount: 1}),
    get: async () => message
  });
  const {headers, records, messages} = await amqpOperator.checkQueue({queue: QUEUE, style: 'one', toRecord: true});
  assert.deepStrictEqual(headers, {from: 'TEST'});
  assert.equal(records.length, 1);
  assert.strictEqual(messages.length, 1);
  assert.strictEqual(messages[0], message);
});

test('checkQueue style one returns the plain message when toRecord is false', async () => {
  const message = makeMessage('c1', 1);
  const amqpOperator = await makeOperator({
    assertQueue: async () => ({messageCount: 1}),
    get: async () => message
  });
  const result = await amqpOperator.checkQueue({queue: QUEUE, style: 'one', toRecord: false});
  assert.strictEqual(result, message);
});

test('checkQueue style one returns false for an empty queue', async () => {
  const amqpOperator = await makeOperator({
    assertQueue: async () => ({messageCount: 0}),
    get: async () => false
  });
  const result = await amqpOperator.checkQueue({queue: QUEUE, style: 'one'});
  assert.strictEqual(result, false);
});

test('checkQueue style basic returns false for an empty queue', async () => {
  const amqpOperator = await makeOperator({assertQueue: async () => ({messageCount: 0})});
  const result = await amqpOperator.checkQueue({queue: QUEUE, style: 'basic'});
  assert.strictEqual(result, false);
});

test('checkQueue style basic returns a chunk of records and messages when the queue is not empty', async () => {
  const messages = [makeMessage('c1', 1), makeMessage('c2', 2)];
  const amqpOperator = await makeOperator({
    assertQueue: async () => ({messageCount: messages.length}),
    checkQueue: async () => ({messageCount: messages.length}),
    get: async () => messages.shift()
  });
  const {headers, records, messages: got} = await amqpOperator.checkQueue({queue: QUEUE, style: 'basic', toRecord: true});
  assert.deepStrictEqual(headers, {from: 'TEST'});
  assert.equal(records.length, 2);
  assert.equal(got.length, 2);
});

test('checkQueue rejects with a 500 ApiError for an unknown style', async () => {
  const amqpOperator = await makeOperator({assertQueue: async () => ({messageCount: 0})});
  await assert.rejects(
    async () => amqpOperator.checkQueue({queue: QUEUE, style: 'unknown-style'}),
    (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 500);
      return true;
    }
  );
});

test('checkQueue purges the queue before returning the style result', async () => {
  /** @type {any[]} */
  const purgeCalls = [];
  let assertCalls = 0;
  const amqpOperator = await makeOperator({
    assertQueue: async () => {
      assertCalls += 1;
      // first call (before the purge) reports 3 pending, after the purge 0
      return assertCalls === 1 ? {messageCount: 3} : {messageCount: 0};
    },
    purgeQueue: /** @param {*} name */ async (name) => {
      purgeCalls.push(name);
    }
  });
  const result = await amqpOperator.checkQueue({queue: QUEUE, style: 'messages', purge: true});
  assert.deepStrictEqual(purgeCalls, [QUEUE]);
  assert.strictEqual(result, 0);
});

// ---------------------------------------------------------------------------
// consumeOne
// ---------------------------------------------------------------------------

test('consumeOne returns the plain message when toRecord is false', async () => {
  const message = makeMessage('c1', 1);
  const amqpOperator = await makeOperator({get: async () => message});
  const result = await amqpOperator.consumeOne(QUEUE, false);
  assert.strictEqual(result, message);
});

test('consumeOne returns the {headers, records, messages} form when toRecord is true', async () => {
  const message = makeMessage('c1', 1);
  const amqpOperator = await makeOperator({get: async () => message});
  const {headers, records, messages} = await amqpOperator.consumeOne(QUEUE, true);
  assert.deepStrictEqual(headers, {from: 'TEST'});
  assert.equal(records.length, 1);
  assert.strictEqual(messages.length, 1);
  assert.strictEqual(messages[0], message);
});

test('consumeOne returns false when the queue is empty', async () => {
  const amqpOperator = await makeOperator({get: async () => false});
  const result = await amqpOperator.consumeOne(QUEUE, true);
  assert.strictEqual(result, false);
});

test('consumeOne rejects when channel.get throws a plain Error', async () => {
  const amqpOperator = await makeOperator({
    get: async () => {
      throw new Error('get exploded');
    }
  });
  await assert.rejects(async () => amqpOperator.consumeOne(QUEUE, true), /get exploded/);
});

// ---------------------------------------------------------------------------
// consumeChunk extra branches
// ---------------------------------------------------------------------------

test('consumeChunk returns {headers, messages} without records when toRecord is false', async () => {
  const messages = [makeMessage('c1', 1), makeMessage('c2', 2)];
  const amqpOperator = await makeOperator({
    checkQueue: async () => ({messageCount: messages.length}),
    get: async () => messages.shift()
  });
  const {headers, messages: got} = await amqpOperator.consumeChunk(QUEUE, false);
  assert.deepStrictEqual(headers, {from: 'TEST'});
  assert.equal(got.length, 2);
});

test('consumeChunk rejects when the amqplib checkQueue throws a plain Error', async () => {
  const amqpOperator = await makeOperator({
    checkQueue: async () => {
      throw new Error('count exploded');
    }
  });
  await assert.rejects(async () => amqpOperator.consumeChunk(QUEUE, true), /count exploded/);
});

// ---------------------------------------------------------------------------
// ackMessages / nackMessages
// ---------------------------------------------------------------------------

test('ackMessages acks every message on the channel', async () => {
  /** @type {any[]} */
  const acked = [];
  const messages = [makeMessage('c1', 1), makeMessage('c2', 2)];
  const amqpOperator = await makeOperator({
    ack: /** @param {*} message */ (message) => {
      acked.push(message);
    }
  });
  amqpOperator.ackMessages(messages);
  assert.deepStrictEqual(acked, messages);
});

test('nackMessages nacks every message on the channel', async () => {
  /** @type {any[]} */
  const nacked = [];
  const messages = [makeMessage('c1', 1), makeMessage('c2', 2)];
  const amqpOperator = await makeOperator({
    nack: /** @param {*} message */ (message) => {
      nacked.push(message);
    }
  });
  amqpOperator.nackMessages(messages);
  assert.deepStrictEqual(nacked, messages);
});

// ---------------------------------------------------------------------------
// sendToQueue
// ---------------------------------------------------------------------------

test('sendToQueue sends the JSON body with correlationId, persistent and headers options', async () => {
  /** @type {any[]} */
  const sent = [];
  const amqpOperator = await makeOperator({
    sendToQueue: /** @param {*} queue @param {*} content @param {*} options */ async (queue, content, options) => {
      sent.push({queue, content, options});
    }
  });
  const data = {title: 'Test record', tags: ['a', 'b']};
  await amqpOperator.sendToQueue({
    queue: QUEUE,
    correlationId: 'cid-1',
    headers: {h: 1},
    data
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].queue, QUEUE);
  assert.ok(Buffer.isBuffer(sent[0].content));
  assert.deepStrictEqual(JSON.parse(sent[0].content.toString()), {data});
  assert.deepStrictEqual(sent[0].options, {correlationId: 'cid-1', persistent: true, headers: {h: 1}});
});

test('sendToQueue rejects with a 500 ApiError when the queue is undefined', async () => {
  const amqpOperator = await makeOperator();
  await assert.rejects(
    async () => amqpOperator.sendToQueue({queue: undefined, correlationId: 'cid', data: {}}),
    (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 500);
      assert.equal(err.payload, 'Undefined queue!');
      return true;
    }
  );
});

test('checkQueue rejects with a 500 ApiError when the queue is an empty string', async () => {
  const amqpOperator = await makeOperator();
  await assert.rejects(
    async () => amqpOperator.checkQueue({queue: '', style: 'basic'}),
    (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 500);
      assert.equal(err.payload, 'Undefined queue!');
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// closeConnection / healthCheck error handling
// ---------------------------------------------------------------------------

test('closeConnection closes the connection and the operator resolves', async () => {
  /** @type {any[]} */
  const closed = [];
  const channel = makeChannel();
  const amqpOperator = await createAmqp(DUMMY_URL, false, {
    connection: {
      createChannel: async () => channel,
      close: async () => {
        closed.push('connection');
      }
    },
    channel
  });
  await amqpOperator.closeConnection();
  assert.deepStrictEqual(closed, ['connection']);
});

test('healthCheck error arriving after cancel does not rethrow and stops the loop', async () => {
  /** @type {*} */
  let rejectAssert;
  const pending = new Promise((_, reject) => {
    rejectAssert = reject;
  });
  let healthCheckCalls = 0;
  const channel = makeChannel({
    assertQueue: /** @param {*} name */ async (name) => {
      if (name === 'HEALTHCHECK') {
        healthCheckCalls += 1;
        return pending;
      }
      return {messageCount: 0};
    }
  });
  const amqpOperator = await createAmqp(DUMMY_URL, true, {
    connection: {createChannel: async () => channel, close: async () => {}},
    channel
  });
  // by now the loop is suspended on the pending assertQueue call;
  // cancel first, then let the error arrive so the catch sees the flag already cleared
  await amqpOperator.closeChannel();
  rejectAssert(new Error('amqp down after close'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(healthCheckCalls, 1, 'no further health checks after cancel');
});

test('healthCheck error while running rethrows into the un-awaited loop promise', async () => {
  // When assertQueue rejects while healthCheckRunning is still true, the catch
  // rethrows via handleAmqpErrors into the loop promise, which is never
  // awaited -> the rejection escapes as an unhandled rejection.
  // The node test runner fails a test on any in-process unhandled rejection,
  // so the escape is verified in a child node process that installs its own
  // unhandledRejection handler before triggering the error.
  const script = `
    import createAmqp from '${AMQP_MODULE_PATH}';
    const channel = {
      assertQueue: /** @param {*} name */ async (name) => {
        if (name === 'HEALTHCHECK') {
          throw new Error('amqp down');
        }
        return {messageCount: 0};
      },
      checkQueue: async () => ({messageCount: 0}),
      get: async () => false,
      ack: () => {},
      nack: () => {},
      purgeQueue: async () => {},
      close: async () => {},
      sendToQueue: async () => {}
    };
    const captured = [];
    process.on('unhandledRejection', (err) => captured.push(err));
    await createAmqp('amqp://stub:5672/', true, {
      connection: {createChannel: async () => channel, close: async () => {}},
      channel
    });
    // the first loop iteration rejects and the error escapes the un-awaited loop promise
    await new Promise((resolve) => setTimeout(resolve, 50));
    const ok = captured.length === 1 && /amqp down/.test(String(captured[0] && captured[0].message));
    process.stdout.write(ok ? 'OK' : 'FAIL:' + JSON.stringify(captured.map((e) => String(e && e.message))));
    process.exit(ok ? 0 : 1);
  `;
  const {code, stdout} = await new Promise((resolve) => {
    const child = execFile(process.execPath, ['--input-type=module', '-e', script], (err, out) => {
      resolve({code: err ? (err.code ?? 1) : 0, stdout: out ?? ''});
    });
    void child;
  });
  assert.equal(code, 0, `child process output: ${stdout}`);
  // handleAmqpErrors logs the error to stdout before the escape, so only the tail matters
  assert.ok(stdout.endsWith('OK'), `expected child output to end with OK, got: ${stdout}`);
});
