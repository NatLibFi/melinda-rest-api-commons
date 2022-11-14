/**
*
* @licstart  The following is the entire license notice for the JavaScript code in this file.
*
* Shared modules for microservices of Melinda rest api batch import system
*
* Copyright (C) 2022 University Of Helsinki (The National Library Of Finland)
*
* This file is part of melinda-rest-api-commons
*
* melinda-rest-api-commons program is free software: you can redistribute it and/or modify
* it under the terms of the GNU Affero General Public License as
* published by the Free Software Foundation, either version 3 of the
* License, or (at your option) any later version.
*
* melinda-rest-api-commons is distributed in the hope that it will be useful,
* but WITHOUT ANY WARRANTY; without even the implied warranty of
* MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
* GNU Affero General Public License for more details.
*
* You should have received a copy of the GNU Affero General Public License
* along with this program.  If not, see <http://www.gnu.org/licenses/>.
*
* @licend  The above is the entire license notice
* for the JavaScript code in this file.
*
*/

import {expect} from 'chai';
import {READERS} from '@natlibfi/fixura';
import createDebugLogger from 'debug';
import generateTests from '@natlibfi/fixugen';
import {amqpFactory} from './index';
import {Error as ApiError} from '@natlibfi/melinda-commons';
import {promisify} from 'util';

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
// eslint-disable-next-line functional/no-let
let amqpOperator;

generateTests({
  callback,
  path: [__dirname, '..', 'test-fixtures', 'amqp'],
  recurse: false,
  useMetadataFile: true,
  fixura: {
    failWhenNotFound: true,
    reader: READERS.JSON
  },
  mocha: {
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

// eslint-disable-next-line max-statements
async function callback({
  getFixture,
  expectToFail = false,
  expectedErrorStatus = '',
  ackMessages = false,
  nackMessages = false,
  checkNextMessage = false,
  checkQueueStyle = false,
  queue = testData.queue,
  sentToQueue,
  expectedMessageCount,
  removeQueue = false,
  expectedErrorMessage = undefined,
  expectApiError = false,
  expectFalseCheckResult = false
}) {
  try {
    await sendMessagesToQueue();

    await ackOrNackMessages();

    await checkQueue();

    await queueRemoval();

    const messageCount = await amqpOperator.checkQueue({queue, style: 'messages'});
    debug(`MessageCount: ${messageCount}`);
    expect(messageCount).to.eql(expectedMessageCount);

    if (checkNextMessage) { // eslint-disable-line
      const {headers, records} = await queueCheckNextMessage();
      const nextMessage = {headers, records};
      const expectedNextMessage = getFixture('expectedMessage.json');
      expect(nextMessage).to.eql(expectedNextMessage);
    }

  } catch (error) {
    if (!expectToFail) { // eslint-disable-line
      throw error;
    }
    expect(expectToFail, 'This is expected to fail').to.equal(true);
    testErrors(error);
  }

  function testErrors(error) {

    if (expectApiError) {
      expect(error).to.be.instanceOf(ApiError);
      expect(error.status).to.equal(expectedErrorStatus);
      // eslint-disable-next-line no-undef, functional/no-conditional-statement

      if (expectedErrorMessage) {
        expect(error.payload).to.eql(expectedErrorMessage);
        return;
      }
      return;
    }
    expect(error).not.to.be.instanceOf(ApiError);
  }

  function queueRemoval() {
    if (removeQueue) {
      return amqpOperator.removeQueue(removeQueue);
    }

    return;
  }

  function queueCheckNextMessage() {
    if (checkNextMessage) {
      return amqpOperator.consumeOne(testData.queue, true);
    }

    return false;
  }

  // eslint-disable-next-line max-statements
  async function checkQueue() {
    debug(`checkQueueStyle: ${checkQueueStyle}`);

    if (checkQueueStyle === 'oneToRecord') {
      const result = await amqpOperator.checkQueue({queue, style: 'one', toRecord: true, purge: false});

      if (expectFalseCheckResult) {
        expect(result).to.eql(false);
        return;
      }

      expect(result).to.have.property('headers');
      expect(result).to.have.property('records');
      expect(result).to.have.property('messages');
      expect(result.records.length).to.eql(1);
      expect(result.messages.length).to.eql(1);

      return;
    }

    if (checkQueueStyle === 'oneNotRecord') {
      const result = await amqpOperator.checkQueue({queue, style: 'one', toRecord: false, purge: false});
      const {fields} = result;

      if (expectFalseCheckResult) {
        expect(result).to.eql(false);
        return;
      }

      expect(fields).to.have.property('deliveryTag');
      expect(fields).to.have.property('exchange');
      expect(fields).to.have.property('messageCount');
      expect(fields).to.have.property('redelivered');
      expect(fields).to.have.property('routingKey');
      expect(typeof fields.deliveryTag).to.be.eql('number');
      expect(typeof fields.messageCount).to.be.eql('number');
      expect(typeof fields.redelivered).to.be.eql('boolean');
      expect(typeof fields.routingKey).to.be.eql('string');

      return;
    }

    if (checkQueueStyle === 'basicToRecord') {
      const result = await amqpOperator.checkQueue({queue, style: 'basic', toRecord: true, purge: false});

      if (expectFalseCheckResult) {
        expect(result).to.eql(false);
        return;
      }

      expect(result).to.have.property('headers');
      expect(result).to.have.property('records');
      expect(result).to.have.property('messages');
      expect(result.records.length).to.eql(3);
      expect(result.messages.length).to.eql(3);
      const expectedResult = getFixture('expectedResult.json');
      expect(result.records).to.eql(expectedResult);

      return;
    }

    if (checkQueueStyle === 'basicNotRecord') {
      const result = await amqpOperator.checkQueue({queue, style: 'basic', toRecord: false, purge: false});

      if (expectFalseCheckResult) {
        expect(result).to.eql(false);
        return;
      }

      expect(result).to.have.property('headers');
      expect(result).to.have.property('messages');
      expect(result.messages.length).to.eql(3);

      const [{fields}] = result.messages;

      expect(fields).to.have.property('deliveryTag');
      expect(fields).to.have.property('exchange');
      expect(fields).to.have.property('messageCount');
      expect(fields).to.have.property('redelivered');
      expect(fields).to.have.property('routingKey');

      expect(typeof fields.deliveryTag).to.be.eql('number');
      expect(typeof fields.messageCount).to.be.eql('number');
      expect(typeof fields.redelivered).to.be.eql('boolean');
      expect(typeof fields.routingKey).to.be.eql('string');

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
      await amqpOperator.ackMessages([message]);

      return setTimeoutPromise(10);
    }

    if (nackMessages) {
      const message = await amqpOperator.consumeOne(testData.queue, false);
      await amqpOperator.nackMessages([message]);

      return setTimeoutPromise(10);
    }

    return;
  }

  async function sendMessagesToQueue() {
    if (sentToQueue) {
      const messages = getFixture('input.json');
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
      expect(error).to.eql('');
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
