import {describe, it} from 'node:test';
import assert from 'node:assert';
import createDebugLogger from 'debug';
import {amqpFactory} from '../src/index.ts';
import type {AmqpOperator} from '../src/amqp.ts';


const debug = createDebugLogger('@natlibfi/melinda-rest-api-commons:amqp:test');
//const debugData = debug.extend('data');

import {promisify} from 'util';
const setTimeoutPromise = promisify(setTimeout);

describe('HealthCheck: amqpOperator should error if channel or connection fails', () => {

  it('healthcheck loop stops silently on closeChannel without unhandled rejections', async (t) => {
    debug(`Testing amqp against a local AMQP instance - we'll need some kind of mockup for this`);
    const amqpUrl = 'amqp://127.0.0.1:5672/';

    // pin the contract: the loop must never leak an unhandled rejection,
    // both while running and after closeChannel cancels it
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (error: unknown) => unhandled.push(error);
    process.on('unhandledRejection', onUnhandledRejection);
    t.after(() => process.off('unhandledRejection', onUnhandledRejection));

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
    assert.deepStrictEqual(unhandled, [], 'no unhandled rejections while running or after closeChannel');

    debug(`Closing connection`);
    await amqpOperator.closeConnection();

    /**
     * @param amqpOperator
     * @param close
     */
    async function awaitTime(amqpOperator: AmqpOperator, close: boolean): Promise<void> {
      if (close) {
        await amqpOperator.closeChannel();
        // note: promisify(setTimeout) never rejects, so a try/catch around it
        // can never catch; the unhandledRejection assertion above is the pin
        await setTimeoutPromise(500);
        return;
      }

      await setTimeoutPromise(500);
      return;
    }

  });
});
