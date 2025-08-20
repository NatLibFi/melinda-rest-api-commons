import amqplib from 'amqplib';
import createDebugLogger from 'debug';
import {promisify, inspect} from 'util';
import httpStatus from 'http-status';
import {MarcRecord} from '@natlibfi/marc-record';
import {Error as ApiError} from '@natlibfi/melinda-commons';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {CHUNK_SIZE} from './constants.js';
import {logError} from './utils.js';

export default async function (AMQP_URL, runHealthCheck = false) {
  const logger = createLogger();
  const debug = createDebugLogger('@natlibfi/melinda-rest-api-commons:amqp');
  const debugHC = debug.extend('HC');
  const debugData = debug.extend('data');
  const setTimeoutPromise = promisify(setTimeout);

  debug(`Creating an AMQP operator to ${AMQP_URL}`);
  const connection = await amqplib.connect(AMQP_URL);
  const channel = await connection.createChannel();

  const healthCheckLoop = runHealthCheck ? healthCheck() : false;

  debug(`Connection: ${connection}`);
  debug(`Channel: ${channel}`);
  debug(`HealthCheckLoop: ${healthCheckLoop ? 'Running health check' : 'Not running health check'}`);

  return {checkQueue, consumeChunk, consumeOne, ackMessages, nackMessages, sendToQueue, removeQueue, messagesToRecords, closeChannel, closeConnection};

  async function closeChannel() {
    debug(`Closing channel`);
    await channel.close();
    debug(`Channel: ${channel}`);
  }

  async function closeConnection() {
    debug(`Closing connection`);
    await connection.close();
    debug(`Connection: ${connection}`);
  }

  async function healthCheck(wait = false) {
    if (wait) {
      await setTimeoutPromise(wait);
      return healthCheck(false);
    }

    try {
      debugHC(`Health checking amqp by asserting a queue`);
      await channel.assertQueue('HEALTHCHECK', {durable: false});
      debugHC(`Waiting 200ms before running healthCheck next`);
      return healthCheck(200);
    } catch (error) {
      debugHC(`HealthCheck error ${JSON.stringify(error)}`);
      handleAmqpErrors(error);
    }
  }

  // eslint-disable-next-line max-statements
  async function checkQueue({queue, style = 'basic', toRecord = true, purge = false}) {
    debug(`checkQueue: ${queue}, Style: ${style}, toRecord: ${toRecord}, Purge: ${purge}`);

    try {

      errorUndefinedQueue(queue);
      const channelInfo = await channel.assertQueue(queue, {durable: true});

      if (purge) {
        await purgeQueue(purge);
        logger.verbose(`Queue ${queue} has purged ${channelInfo.messageCount} messages`);
        debug(`Queue ${queue} has purged ${channelInfo.messageCount} messages`);
        return checkQueue({queue, style});
      }

      if (style === 'messages') {
        return channelInfo.messageCount;
      }


      // Note: returns one message (+ record, of toRecord: true)
      // note: if toRecord is false returns just plain message / false
      // note: if toRecord is true returns {headers, records, messages} -object / false
      // should this be more consistent?
      if (style === 'one') {
        if (checkMessageCount(channelInfo)) {
          return consumeOne(queue, toRecord);
        }
        return false;
      }

      // Note: returns a chunk of (100) messages (+ records, if toRecord: true)
      // returns {headers, records, messages} object or {headers, messages} object depending on toRecord
      if (style === 'basic') {
        if (checkMessageCount(channelInfo)) {
          return consumeChunk(queue, toRecord);
        }
        return false;
      }

      // Defaults:
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `CheckQueue does not recognize style ${style}`);
    } catch (error) {
      handleAmqpErrors(error);
    }

    function checkMessageCount(channelInfo) {
      if (channelInfo.messageCount < 1) {
        debug(`checkQueue: ${channelInfo.messageCount} - ${queue} is empty`);
        return false;
      }
      debug(`Queue ${queue} has ${channelInfo.messageCount} messages`);
      return true;
    }

    function purgeQueue(purge) {
      debug(`Purging queue: ${queue}, purge: ${purge}`);
      if (purge) {
        return channel.purgeQueue(queue);
      }
    }
  }

  async function consumeChunk(queue, toRecord) {
    debug(`Prepared to consumeChunk from queue: ${queue}`);
    try {
      await channel.assertQueue(queue, {durable: true});

      // getData: next chunk (100) messages
      const messages = await getData(queue);

      // Note: headers are from the first message of the chunk
      const headers = getHeaderInfo(messages[0]);
      debug(`consumeChunk (${messages ? messages.length : '0'} from queue ${queue}) ${toRecord ? 'to records' : 'just messages'}`);

      if (toRecord) {
        const records = await messagesToRecords(messages);
        return {headers, records, messages};
      }

      return {headers, messages};
    } catch (error) {
      handleAmqpErrors(error);
    }
  }

  async function consumeOne(queue, toRecord) {
    debug(`Prepared to consumeOne from queue: ${queue}`);
    try {
      await channel.assertQueue(queue, {durable: true});

      // Returns false if 0 items in queue
      const message = await channel.get(queue);

      debugData(`Message: ${inspect(message, {colors: true, maxArrayLength: 3, depth: 3})}`);
      // Do not spam the logs
      debug(`consumeOne from queue: ${queue} ${toRecord ? 'to records' : 'just the message'}`);

      if (message) {
        if (toRecord) {
          const headers = getHeaderInfo(message);
          const records = messagesToRecords([message]);
          return {headers, records, messages: [message]};
        }

        return message;
      }

      return false;
    } catch (error) {
      handleAmqpErrors(error);
    }
  }

  function ackMessages(messages) {
    messages.forEach(message => {
      debug(`Ack message ${message.properties.correlationId}`);
      channel.ack(message);
    });
  }

  function nackMessages(messages) {
    messages.forEach(message => {
      debug(`Nack message ${message.properties.correlationId}`);
      channel.nack(message);
    });
  }

  async function sendToQueue({queue, correlationId, headers, data}) {
    debug(`sendToQueue`);
    // eslint-disable-next-line no-useless-catch
    try {
      debug(`Queue ${queue}`);
      debug(`CorrelationId ${correlationId}`);
      debugData(`Data ${JSON.stringify(data)}`);
      debug(`Headers ${JSON.stringify(headers)}`);

      errorUndefinedQueue(queue);

      debug(`Asserting queue: ${queue}`);
      await channel.assertQueue(queue, {durable: true});

      debug(`Actually sendToQueue: ${queue}`);
      await channel.sendToQueue(
        queue,
        Buffer.from(JSON.stringify({data})),
        {
          correlationId,
          persistent: true,
          headers
        }
      );
      debug(`Send message for ${correlationId} to queue: ${queue}`);


    } catch (error) {
      const errorToThrow = error;
      //if (error instanceof ApiError) {
      //  throw error;
      //}
      debug(`SendToQueue errored: ${JSON.stringify(error)}`);
      handleAmqpErrors(errorToThrow);
    }
  }

  async function removeQueue(queue) {
    // deleteQueue borks the channel if the queue does not exist
    // -> use throwaway tempChannel to avoid killing actual channel in use
    // this might be doable also with assertQueue before deleteQueue
    const tempChannel = await connection.createChannel();
    logger.verbose(`Removing queue ${queue}.`);
    debug(`Removing queue ${queue}.`);
    await tempChannel.deleteQueue(queue);

    if (tempChannel) {
      await tempChannel.close();
      return;
    }

    return;
  }

  // ----------------
  // Helper functions
  // ----------------

  function messagesToRecords(messages) {
    debug(`Parsing messages (${messages.length}) to records`);

    return messages.map(message => {
      const content = JSON.parse(message.content.toString());
      // Use subfieldValues: false validationOption here
      return new MarcRecord(content.data, {subfieldValues: false});
    });
  }

  async function getData(queue) {
    debug(`Getting queue data from ${queue}`);
    try {
      const {messageCount} = await channel.checkQueue(queue);
      debug(`There is ${messageCount} messages in queue ${queue}`);
      const messagesToGet = messageCount >= CHUNK_SIZE ? CHUNK_SIZE : messageCount;
      debug(`Getting ${messagesToGet} messages from queue ${queue}`);

      const messages = await pump(messagesToGet);

      debug(`Returning ${messages.length} unique messages`);

      return messages;
    } catch (error) {
      handleAmqpErrors(error);
    }

    async function pump(count, results = [], identifiers = []) {
      if (count === 0) {
        return results;
      }

      const message = await channel.get(queue);
      const identifier = {
        correlationId: message.properties.correlationId,
        deliveryTag: message.fields.deliveryTag
      };
      // Filter not unique messages
      if (identifiers.includes(identifier)) {
        return pump(count - 1, results, identifiers);
      }

      return pump(count - 1, results.concat(message), identifiers.concat(identifier));
    }
  }

  function getHeaderInfo(data) {
    return data.properties.headers;
  }

  function errorUndefinedQueue(queue) {
    if (queue === undefined || queue === '' || queue === null) {
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Undefined queue!`);
    }
  }

  function handleAmqpErrors(error) {
    const newError = error;
    debug(`HandleAmqpErrors got an error: ${JSON.stringify(error)}`);
    if (error instanceof ApiError) {
      debug(`We have an ApiError`);
      throw new ApiError(newError.status, newError.payload);
    }
    debug(`We have a non-ApiError`);
    logError(error);
    throw newError;
  }
}


