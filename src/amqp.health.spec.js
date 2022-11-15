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

//import {expect} from 'chai';
import createDebugLogger from 'debug';
import {amqpFactory} from './index';


const debug = createDebugLogger('@natlibfi/melinda-rest-api-commons:amqp:test');
//const debugData = debug.extend('data');

import {promisify} from 'util';
const setTimeoutPromise = promisify(setTimeout);

describe('HealthCheck: amqpOperator should error if channel or connection fails', () => {

  it('FIX: test healthCheck - this test does not really test anything, but error can be seen in debug!', async () => {
    debug(`Testing amqp against a local AMQP instance - we'll need some kind of mockup for this`);
    const amqpUrl = 'amqp://127.0.0.1:5672/';

    const amqpOperator = await amqpFactory(amqpUrl, true);
    debug(`Connecting to ${amqpUrl}, with healthCheck running`);
    await awaitTime(amqpOperator, false);

    debug(`Testing healthCheckLoop for ${amqpOperator}`);
    debug(`Waiting 0.5s and expecting healthCheckLoop to work`);
    await awaitTime(amqpOperator, false);
    debug(`Amqp Operator should have been alive.`);

    debug(`Testing healthCheckLoop with closed channel`);
    debug(`Waiting 0.5s and expecting healthCheckLoop to throw error`);
    await awaitTime(amqpOperator, true);
    debug(`Amqp Operator should have been errored.`);

    debug(`Closing connection`);
    await amqpOperator.closeConnection();

    async function awaitTime(amqpOperator, close) {
      if (close) {
        await amqpOperator.closeChannel();
        await setTimeoutPromise(500);
        return;
      }

      await setTimeoutPromise(500);
      return;
    }

  });
});

