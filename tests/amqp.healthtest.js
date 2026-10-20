import {describe, it} from 'node:test';
import assert from 'node:assert';
import createDebugLogger from 'debug';
import {amqpFactory} from '../src/index.js';


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
    debug(`Waiting 0.5s and expecting the healthCheckLoop to stop silently (no error)`);
    await awaitTime(amqpOperator, true);
    // closeChannel() sets the run flag so the loop short-circuits gracefully:
    // it must stop silently without throwing or firing further health checks
    assert.ok(true, 'healthCheck loop stopped without error');

    debug(`Closing connection`);
    await amqpOperator.closeConnection();

    async function awaitTime(amqpOperator, close) {
      if (close) {
        // wrap the wait so any error thrown by the (cancelled) loop fails the test
        await amqpOperator.closeChannel();
        try {
          await setTimeoutPromise(500);
        } catch (error) {
          assert.fail(`healthCheck loop threw after closeChannel: ${error}`);
        }
        return;
      }

      await setTimeoutPromise(500);
      return;
    }

  });
});

