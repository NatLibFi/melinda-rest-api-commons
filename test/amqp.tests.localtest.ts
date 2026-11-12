import assert from 'node:assert';
import createDebugLogger from 'debug';
import {promisify} from 'util';
import {READERS} from '@natlibfi/fixura';
import generateTests from '@natlibfi/fixugen';
import type {CallbackArgs} from '@natlibfi/fixugen';
import {Error as ApiError} from '@natlibfi/melinda-commons';
import type {GetMessage, Message} from 'amqplib';
import {amqpFactory} from '../src/index.ts';
import type {AmqpOperator, QueueItemMessagePayload, QueueItemRecordPayload, SendToQueueParams} from '../src/amqp.ts';

const setTimeoutPromise = promisify(setTimeout);
const debug = createDebugLogger('@natlibfi/melinda-rest-api-commons:amqp:test');
//const debugData = debug.extend('data');

const testData = {
  queue: 'TESTQUEUE',
  correlationId: 'aaaaaaaa-0000-aaaa-0000-000000000000',
  data: {'leader': '02518cam a2200745zi 4500', 'fields': [{'tag': '001', 'value': '000019640'}]}
};

debug(`Testing amqp against a local AMQP instance - we'll need some kind of mockup for this`);
const amqpUrl = 'amqp://127.0.0.1:5672/';
let amqpOperator: AmqpOperator;

generateTests({
  callback,
  path: [import.meta.dirname, '..', 'test-fixtures', 'amqp'],
  recurse: false,
  useMetadataFile: true,
  fixura: {
    failWhenNotFound: true,
    reader: READERS.JSON
  },
  hooks: {
    before: async () => {
      debug(`Connecting to ${amqpUrl}, with healthCheck running`);
      amqpOperator = await amqpFactory(amqpUrl, true);
    },
    beforeEach: async () => {
      await amqpOperator.checkQueue({queue: testData.queue, toRecord: false, purge: true});
    },
    afterEach: async () => {
      await amqpOperator.removeQueue(testData.queue);
    },
    after: async () => {
      await amqpOperator.closeConnection();
      //await testHeathCheck();
    }
  }
});

/**
 * One fixture case. See the fixture metadata files in test-fixtures/amqp
 * for the possible keys (getFixture, expectToFail, expectedErrorStatus,
 * ackMessages, nackMessages, checkNextMessage, checkQueueStyle, queue,
 * sentToQueue, expectedMessageCount, removeQueue, expectedErrorMessage,
 * expectApiError, expectFalseCheckResult).
 */
async function callback(callbackParams: CallbackArgs) {
  const {
  getFixture,
  expectToFail = false,
  expectedErrorStatus = '',
  ackMessages = false,
  nackMessages = false,
  checkNextMessage = false,
  checkQueueStyle = false,
  queue: queueFromFixture = testData.queue,
  sentToQueue,
  expectedMessageCount,
  removeQueue = false,
  expectedErrorMessage = undefined,
  expectApiError = false,
  expectFalseCheckResult = false
  } = callbackParams;
  // the fixture contract passes the queue name as a string
  const queue = queueFromFixture as string;
  try {
    await sendMessagesToQueue();

    await ackOrNackMessages();

    await checkQueue();

    await queueRemoval();

    const messageCount = await amqpOperator.checkQueue({queue, style: 'messages'});
    debug(`MessageCount: ${messageCount}`);
    assert.equal(messageCount, expectedMessageCount);

    if (checkNextMessage) {
      const {headers, records} = (await queueCheckNextMessage()) as QueueItemRecordPayload;
      const nextMessage = {headers, records};
      const expectedNextMessage = getFixture('expectedMessage.json');
      assert.deepStrictEqual(
        JSON.parse(JSON.stringify(nextMessage)),
        expectedNextMessage,
      );
      return;
    }

  } catch (error) {
    if (!expectToFail) {
      throw error;
    }
    assert.equal(expectToFail, true, 'This is expected to fail');
    testErrors(error);
  }

  /**
   * @param error
   */
  function testErrors(error: unknown) {
    const isApiError = error instanceof ApiError;
    if (expectApiError) {
      assert.equal(isApiError, true);
      debug(`We expected and got an ApiError`);
      const apiError = error as ApiError;
      assert.equal(apiError.status, expectedErrorStatus);

      if (expectedErrorMessage) {
        assert.equal(apiError.payload, expectedErrorMessage);
        return;
      }

      return;
    }
    assert.equal(isApiError, false);
    debug(`We expected and got an non-ApiError`);
    const maybeError = error as Error;
    debug(`Error is a ${maybeError.constructor.name}`);
  }

  function queueRemoval() {
    if (removeQueue) {
      return amqpOperator.removeQueue(removeQueue as string);
    }

    return;
  }

  function queueCheckNextMessage(): Promise<QueueItemRecordPayload> | false {
    if (checkNextMessage) {
      return amqpOperator.consumeOne(testData.queue, true) as Promise<QueueItemRecordPayload>;
    }

    return false;
  }

  async function checkQueue() {
    debug(`checkQueueStyle: ${checkQueueStyle}`);

    if (checkQueueStyle === 'oneToRecord') {
      const result = await amqpOperator.checkQueue({queue, style: 'one', toRecord: true, purge: false});

      if (expectFalseCheckResult) {
        assert.strictEqual(result, false);
        return;
      }

      const recordResult = result as QueueItemRecordPayload;
      assert.equal(Object.hasOwn(recordResult, 'headers'), true);
      assert.equal(Object.hasOwn(recordResult, 'records'), true);
      assert.equal(Object.hasOwn(recordResult, 'messages'), true);
      assert.equal(recordResult.records.length, 1);
      assert.equal(recordResult.messages.length, 1);

      return;
    }

    if (checkQueueStyle === 'oneNotRecord') {
      const result = await amqpOperator.checkQueue({queue, style: 'one', toRecord: false, purge: false});
      const {fields} = result as GetMessage;

      if (expectFalseCheckResult) {
        assert.strictEqual(result, false);
        return;
      }

      assert.equal(typeof fields.deliveryTag, 'number');
      assert.equal(typeof fields.messageCount, 'number');
      assert.equal(typeof fields.redelivered, 'boolean');
      assert.equal(typeof fields.routingKey, 'string');

      return;
    }

    if (checkQueueStyle === 'basicToRecord') {
      const result = await amqpOperator.checkQueue({queue, style: 'basic', toRecord: true, purge: false});

      if (expectFalseCheckResult) {
        assert.strictEqual(result, false);
        return;
      }

      const recordResult = result as QueueItemRecordPayload;
      assert.equal(Object.hasOwn(recordResult, 'headers'), true);
      assert.equal(Object.hasOwn(recordResult, 'records'), true);
      assert.equal(Object.hasOwn(recordResult, 'messages'), true);
      assert.equal(recordResult.records.length, 3);
      assert.equal(recordResult.messages.length, 3);
      const expectedResult = getFixture('expectedResult.json');
      assert.deepStrictEqual(
        JSON.parse(JSON.stringify(recordResult.records)),
        expectedResult,
      );

      return;
    }

    if (checkQueueStyle === 'basicNotRecord') {
      const result = await amqpOperator.checkQueue({queue, style: 'basic', toRecord: false, purge: false});

      if (expectFalseCheckResult) {
        assert.strictEqual(result, false);
        return;
      }

      const messageResult = result as QueueItemMessagePayload;
      assert.equal(Object.hasOwn(messageResult, 'headers'), true);
      assert.equal(Object.hasOwn(messageResult, 'messages'), true);
      assert.equal(messageResult.messages.length, 3);

      const [firstMessage] = messageResult.messages as [Message, ...Message[]];
      const {fields} = firstMessage;

      assert.equal(typeof fields.deliveryTag, 'number');
      assert.equal(typeof fields.messageCount, 'number');
      assert.equal(typeof fields.redelivered, 'boolean');
      assert.equal(typeof fields.routingKey, 'string');

      return;
    }

    if (checkQueueStyle === 'purge') {
      return amqpOperator.checkQueue({queue, style: 'messages', purge: true});
    }

    if (checkQueueStyle === 'foobar') {
      return amqpOperator.checkQueue({queue, style: 'foobar', toRecord: false, purge: false});
    }

    return false;
  }

  async function ackOrNackMessages() {
    if (ackMessages) {
      const message = await amqpOperator.consumeOne(testData.queue, false);
      await amqpOperator.ackMessages([message as GetMessage]);

      return setTimeoutPromise(10);
    }

    if (nackMessages) {
      const message = await amqpOperator.consumeOne(testData.queue, false);
      await amqpOperator.nackMessages([message as GetMessage]);

      return setTimeoutPromise(10);
    }

    return;
  }

  async function sendMessagesToQueue() {
    if (sentToQueue) {
      const messages = getFixture('input.json') as SendToQueueParams[];
      // {queue, correlationId, headers, data}

      const promises = messages.map(message => amqpOperator.sendToQueue(message));
      await Promise.all(promises);

      return setTimeoutPromise(10);
    }

    return;
  }
}

/*
function testHeathCheck() {
  return it('expects healthCheck', async () => {

    const amqpOperator2 = await amqpFactory(amqpUrl, true);
    try {

      debug(`**********`);
      await testHealthCheckLoopWorking(amqpOperator2);

      debug(`**********`);
      await testHealthCheckLoopErroring(amqpOperator2);
    } catch (error) {
      debug(error);
      assert.strictEqual(error, '');
    } finally {
      amqpOperator2.closeConnection();
    }

    async function testHealthCheckLoopWorking(amqpOperator) {
      debug(`Testing healthCheckLoop for ${amqpOperator}`);
      debug(`Waiting 0.5s and expecting healthCheckLoop to work`);
      await setTimeoutPromise('500');
      debug(`Amqp Operator should have been alive.`);
    }

    async function testHealthCheckLoopErroring(amqpOperator) {
      debug(`Testing healthCheckLoop with closed channel`);
      amqpOperator.closeChannel();
      debug(`Waiting 0.5s and expecting healthCheckLoop to throw error`);
      await setTimeoutPromise('500');
      debug(`amqpOperator should have errored`);
    }
  });
}
*/
