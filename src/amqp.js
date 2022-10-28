/**
*
* @licstart  The following is the entire license notice for the JavaScript code in this file.
*
* Shared modules for microservices of Melinda rest api batch import system
*
* Copyright (C) 2020-2022 University Of Helsinki (The National Library Of Finland)
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

import amqplib from 'amqplib';
import {MarcRecord} from '@natlibfi/marc-record';
import {Error as ApiError} from '@natlibfi/melinda-commons';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {CHUNK_SIZE} from './constants';
import {logError} from './utils';
import {inspect} from 'util';
import httpStatus from 'http-status';

export default async function (AMQP_URL) {
  const connection = await amqplib.connect(AMQP_URL);
  const channel = await connection.createChannel();
  const logger = createLogger();

  return {checkQueue, consumeChunk, consumeOne, ackMessages, nackMessages, sendToQueue, removeQueue, messagesToRecords};

  // eslint-disable-next-line max-statements
  async function checkQueue({queue, style = 'basic', toRecord = true, purge = false}) {
    logger.silly(`checkQueue: ${queue}, Style: ${style}: toRecord: ${toRecord}, Purge: ${purge}`);

    try {

      errorUndefinedQueue(queue);
      const channelInfo = await channel.assertQueue(queue, {durable: true});

      if (purge) {
        await purgeQueue(purge);
        logger.verbose(`Queue ${queue} has purged ${channelInfo.messageCount} messages`);
        return checkQueue({queue, style});
      }

      if (channelInfo.messageCount < 1) {
        logger.silly(`checkQueue: ${channelInfo.messageCount} - ${queue} is empty`);
        return false;
      }
      logger.silly(`Queue ${queue} has ${channelInfo.messageCount} messages`);

      if (style === 'messages') {
        return channelInfo.messageCount;
      }

      // Note: returns one message (+ record, of toRecord: true)
      // note: if toRecord is false returns just plain message / false
      // note: if toRecord is true returns {headers, records, messages} -object / false
      // should this be more consistent?
      if (style === 'one') {
        return consumeOne(queue, toRecord);
      }

      // Note: returns a chunk of (100) messages (+ records, if toRecord: true)
      // returns {headers, records, messages} object or {headers, messages} object depending on toRecord
      if (style === 'basic') {
        return consumeChunk(queue, toRecord);
      }

      // Defaults:
      throw new ApiError(httpStatus.UNPROCESSABLE_ENTITY);
    } catch (error) {
      handleAmqpErrors(error);
    }

    function purgeQueue(purge) {
      if (purge) {
        return channel.purgeQueue(queue);
      }
    }
  }

  async function consumeChunk(queue, toRecord) {
    logger.silly(`Prepared to consumeChunk from queue: ${queue}`);
    try {
      await channel.assertQueue(queue, {durable: true});

      // getData: next chunk (100) messages
      const messages = await getData(queue);
      const headers = getHeaderInfo(messages[0]);
      logger.debug(`consumeChunk (${messages ? messages.length : '0'} from queue ${queue}) ${toRecord ? 'to records' : 'just messages'}`);

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
    logger.silly(`Prepared to consumeOne from queue: ${queue}`);
    try {
      await channel.assertQueue(queue, {durable: true});

      // Returns false if 0 items in queue
      const message = await channel.get(queue);

      logger.silly(`Message: ${inspect(message, {colors: true, maxArrayLength: 3, depth: 3})}`);
      // Do not spam the logs
      logger.debug(`consumeOne from queue: ${queue} ${toRecord ? 'to records' : 'just the message'}`);

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
      logger.silly(`Ack message ${message.properties.correlationId}`);
      channel.ack(message);
    });
  }

  function nackMessages(messages) {
    messages.forEach(message => {
      logger.silly(`Nack message ${message.properties.correlationId}`);
      channel.nack(message);
    });
  }

  async function sendToQueue({queue, correlationId, headers, data}) {
    try {
      logger.silly(`Queue ${queue}`);
      logger.silly(`CorrelationId ${correlationId}`);
      logger.silly(`Data ${JSON.stringify(data)}`);
      logger.silly(`Headers ${JSON.stringify(headers)}`);

      errorUndefinedQueue(queue);
      await channel.assertQueue(queue, {durable: true});

      channel.sendToQueue(
        queue,
        Buffer.from(JSON.stringify({data})),
        {
          correlationId,
          persistent: true,
          headers
        }
      );
      logger.silly(`Send message for ${correlationId} to queue: ${queue}`);
    } catch (error) {
      handleAmqpErrors(error);
    }
  }

  async function removeQueue(queue) {
    // deleteQueue borks the channel if the queue does not exist
    // -> use throwaway tempChannel to avoid killing actual channel in use
    // this might be doable also with assertQueue before deleteQueue
    const tempChannel = await connection.createChannel();
    logger.verbose(`Removing queue ${queue}.`);
    await tempChannel.deleteQueue(queue);
    if (tempChannel) { // eslint-disable-line functional/no-conditional-statement
      await tempChannel.close();
    }
  }

  // ----------------
  // Helper functions
  // ----------------

  function messagesToRecords(messages) {
    logger.debug(`Parsing messages (${messages.length}) to records`);

    return messages.map(message => {
      const content = JSON.parse(message.content.toString());
      return new MarcRecord(content.data);
    });
  }

  async function getData(queue) {
    logger.debug(`Getting queue data from ${queue}`);
    try {
      const {messageCount} = await channel.checkQueue(queue);
      logger.silly(`There is ${messageCount} messages in queue ${queue}`);
      const messagesToGet = messageCount >= CHUNK_SIZE ? CHUNK_SIZE : messageCount;
      logger.silly(`Getting ${messagesToGet} messages from queue ${queue}`);

      const messages = await pump(messagesToGet);

      logger.debug(`Returning ${messages.length} unique messages`);

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
    logError(error);
    throw new Error(error);
  }

}


