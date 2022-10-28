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

//import inspect from 'util';

const debug = createDebugLogger('@natlibfi/melinda-rest-api-commons:amqp:test');
//const debugData = debug.extend('data');

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

async function callback({testLocalAmqp = false}) {

  if (!testLocalAmqp) {
    debug(`Do not test amqp, if you don't have a local amqp to test with`);
    return;
  }

  debug(`Testing amqp against a local AMQP instance - we'll need some kind of mockup for this`);
  const amqpUrl = 'amqp://127.0.0.1:5672/';

  debug(`Connecting to ${amqpUrl}`);
  const amqpOperator = await amqpFactory(amqpUrl);

  //await amqpOperator.closeChannel();
  expect(amqpOperator).to.be.an('Object');

  debug(`Testing sendToQueue`);

  const queue = 'TESTQUEUE';
  const correlationId = '5b7be681-0d4d-47ca-b5d7-1531173ec6bf';
  const headers = {correlationId};
  const data = {'leader': '02518cam a2200745zi 4500', 'fields': [{'tag': '001', 'value': '000019640'}]};

  await amqpOperator.sendToQueue({queue, correlationId, headers, data});

  expect(await amqpOperator.sendToQueue({correlationId, headers, data})).to.throw();

  //await amqpOperator.closeChannel();

  //await amqpOperator.sendToQueue({queue, correlationId, headers, data});

  await amqpOperator.closeConnection();

  try {
    await amqpOperator.sendToQueue({queue, correlationId, headers, data});
  } catch (error) {
    debug(JSON.stringify(error.message));
    debug(JSON.stringify(error.stack));
    expect(error.message).to.eql('Channel closed');
  }


  //await amqpOperator.closeConnection();
  debug(`Done`);

}


/*


  await amqpOperator.sendToQueue({queue, correlationId, headers, data});

  const message = await amqpOperator.checkQueue({queue, style: 'one', toRecord: false, purge: false});
  debug(message);

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


