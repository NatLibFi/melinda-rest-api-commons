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
import generateTests from '@natlibfi/fixugen';
import createDebugLogger from 'debug';
import {amqpFactory} from './index';
import {Error as ApiError} from '@natlibfi/melinda-commons';
//import inspect from 'util';
import {promisify} from 'util';

const debug = createDebugLogger('@natlibfi/melinda-rest-api-commons:amqp:test');
//const debugData = debug.extend('data');

const setTimeoutPromise = promisify(setTimeout);

generateTests({
  callback,
  path: [__dirname, '..', 'test-fixtures', 'amqp'],
  recurse: false,
  useMetadataFile: true,
  fixura: {
    failWhenNotFound: false,
    reader: READERS.JSON
  }
});

// eslint-disable-next-line max-statements
async function callback() {

  const testData = {
    queue: 'TESTQUEUE',
    correlationId: '5b7be681-0d4d-47ca-b5d7-1531173ec6bf',
    data: {'leader': '02518cam a2200745zi 4500', 'fields': [{'tag': '001', 'value': '000019640'}]}
  };

  debug(`Testing amqp against a local AMQP instance - we'll need some kind of mockup for this`);
  const amqpUrl = 'amqp://127.0.0.1:5672/';

  debug(`Connecting to ${amqpUrl}, with healthCheck running`);
  const amqpOperator = await amqpFactory(amqpUrl, true);

  debug(`**********`);
  await testHealthCheckLoopWorking(amqpOperator);

  debug(`**********`);
  await testHealthCheckLoopErroring(amqpOperator);

  await amqpOperator.closeConnection();

  debug(`--- Create a new amqpOperator2 ----`);
  debug(`Connecting to ${amqpUrl}, without healthCheck running`);
  const amqpOperator2 = await amqpFactory(amqpUrl);

  debug(`**********`);
  debug(`*** Test purging the queue: ${testData.queue} *******`);
  const purgeMessage = await amqpOperator2.checkQueue({queue: testData.queue, toRecord: false, purge: true});
  expect(purgeMessage).to.eql(false);
  await testSendToQueue(amqpOperator2, testData);
  debug(`* wait, otherwise queue is not ready *`);
  await setTimeoutPromise('100');

  debug(`*** Test getting messageCount from theQueue: ${testData.queue} *******`);
  const messageCount = await amqpOperator2.checkQueue({queue: testData.queue, style: 'messages'});
  debug(messageCount);
  expect(messageCount).to.eql(1);

  debug(`*** Test checking theQueue: ${testData.queue} *******`);
  const message = await amqpOperator2.checkQueue({queue: testData.queue, style: 'one', toRecord: false, purge: false});
  expect(message).to.not.equal('goo');
  debug(message);

  debug(`*** Test nacking the message: ${testData.queue} *******`);
  await amqpOperator2.nackMessages([message]);
  debug(`* wait, otherwise queue is not ready *`);
  await setTimeoutPromise('100');

  const messageCountAfterNack = await amqpOperator2.checkQueue({queue: testData.queue, style: 'messages'});
  debug(`After nack: ${messageCountAfterNack}`);
  expect(messageCountAfterNack).to.eql(1);

  const message2 = await amqpOperator2.checkQueue({queue: testData.queue, style: 'one', toRecord: false, purge: false});

  debug(`*** Test acking the message: ${testData.queue} *******`);
  await amqpOperator2.ackMessages([message2]);
  debug(`* wait, otherwise queue is not ready *`);
  await setTimeoutPromise('100');

  const messageCountAfterAck = await amqpOperator2.checkQueue({queue: testData.queue, style: 'messages'});
  debug(`After ack: ${messageCountAfterAck}`);
  expect(messageCountAfterAck).to.eql(0);

  debug(`*** Test removing the the queue: ${testData.queue} *******`);
  const removeResult = await amqpOperator2.removeQueue(testData.queue);
  debug(removeResult);


  debug(`**********`);
  try {
    await testUndefinedQueue(amqpOperator2, testData);
  } catch (error) {
  //expect(error()).to.be.an('apierror');
    const errorAsString = JSON.stringify(error);
    expect(error).to.be.an.instanceof(ApiError);
    expect(errorAsString).to.eql(`{"status":500,"payload":"Undefined queue!"}`);
  }
  debug(`**********`);

  debug(`--- Closing amqpOperator2 ----`);
  await amqpOperator2.closeChannel();
  await amqpOperator2.closeConnection();

  debug(`**********`);

  try {
    await testSendToQueue(amqpOperator2, testData);
  } catch (error) {
    expect(error.message).to.eql(`Channel closed`);
    debug(`We got an error: ${JSON.stringify(error)}`);
  }
  debug(`**********`);

  debug(`Done`);
  //}

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

  async function testSendToQueue(amqpOperator, testData) {
  // Test sendToQueue
    debug(`*** Testing sendToQueue ***`);

    const {queue, correlationId, data} = testData;
    const headers = {correlationId};

    await amqpOperator.sendToQueue({queue, correlationId, headers, data});
    return;
  }

  /*
  async function testCheckQueue(amqpOperator, testData) {
    debug(`Testing checkQueue`);
    const {queue} = testData;
    const message = await amqpOperator.checkQueue({queue, style: 'one', toRecord: false, purge: false});
    debug(message);
    return message;
  //expect(message).to.be.defined;
  }
*/

  async function testUndefinedQueue(amqpOperator, testData) {
  // Test sendToQueue
    debug(`Testing sendToQueue with undefined queue`);
    const {correlationId, data} = testData;
    const headers = {correlationId};
    const queue = undefined;

    expect(await amqpOperator.sendToQueue({queue, correlationId, headers, data})).to.throw();
  }


  /*


  await amqpOperator.sendToQueue({queue, correlationId, headers, data});


  await amqpOperator.ackMessages([message]);
  const message2 = await amqpOperator.checkQueue({queue, style: 'one', toRecord: false, purge: false});
  await amqpOperator.ackMessages([message2]);

  expect(message2).to.be(true);


  //debug(`FOO: ${JSON.stringify(message)}`);


  // http:
  // await amqpOperator.sendToQueue({queue: 'REQUESTS', correlationId, headers, data});

  // validator:
  // const message = await amqpOperator.checkQueue({queue: 'REQUESTS', style: 'one', toRecord: false, purge: false});
  //    await amqpOperator.ackMessages([message]);
  //  const message = await amqpOperator.checkQueue({queue: validatorQueue, style: 'one', toRecord: false, purge: false});
  // amqpOperator.removeQueue(validatorQueue);
  //await amqpOperator.checkQueue({queue: operationQueue, style: 'messages', purge: true});
  //     await amqpOperator.checkQueue({queue: `${headers.operation}.${correlationId}`, style: 'messages', purge: true});

  // importer
  /*
const {headers, records, messages} = await amqpOperator.checkQueue({queue: `${operation}.${correlationId}`, style: 'basic', toRecord: true, purge: purgeQueues});
 await amqpOperator.nackMessages(messages);
  await amqpOperator.sendToQueue({
     const {messages} = await amqpOperator.checkQueue({queue, style: 'basic', toRecords: false, purge: false});
 await amqpOperator.ackMessages(messages);
  const processMessage = await amqpOperator.checkQueue({queue: processQueue, style: 'one', toRecord: false, purge: false});
 const {headers: firstMessageHeaders, messages} = await amqpOperator.checkQueue({queue, style: 'basic', toRecord: false, purge: false});
   const queueMessagesCount = await amqpOperator.checkQueue({queue, style: 'messages'});


  */

}

