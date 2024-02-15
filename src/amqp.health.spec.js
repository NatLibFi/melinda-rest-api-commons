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

