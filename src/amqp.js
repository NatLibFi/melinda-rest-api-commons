/**
*
* @licstart  The following is the entire license notice for the JavaScript code in this file.
*
* Shared modules for microservices of Melinda rest api batch import system
*
* Copyright (C) 2020 University Of Helsinki (The National Library Of Finland)
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
import {Error as ApiError, Utils} from '@natlibfi/melinda-commons';
import {CHUNK_SIZE} from './constants';
import {logError} from './utils';
import httpStatus from 'http-status';

export default async function (AMQP_URL) {
  const {createLogger} = Utils;
  const connection = await amqplib.connect(AMQP_URL);
  const channel = await connection.createChannel();
  const logger = createLogger();

  return {checkQueue, consumeChunk, consumeRawChunk, consumeOne, consumeRaw, ackNReplyMessages, ackMessages, nackMessages, sendToQueue, removeQueue, messagesToRecords};

  async function checkQueue(queue, style = 'basic', purge = false) {
    try {
      const channelInfo = await channel.assertQueue(queue, {durable: true});
      if (purge) {
        await purgeQueue(purge);
        logger.log('debug', `Queue ${queue} has purged ${channelInfo.messageCount} records`);
        return checkQueue(queue, style);
      }

      if (channelInfo.messageCount < 1) {
        return false;
      }
      logger.log('debug', `Queue ${queue} has ${channelInfo.messageCount} records`);

      if (style === 'messages') {
        return channelInfo.messageCount;
      }

      if (style === 'one') {
        return consumeOne(queue);
      }

      if (style === 'raw') {
        return consumeRaw(queue);
      }

      if (style === 'rawChunk') {
        return consumeRawChunk(queue);
      }

      if (style === 'basic') {
        return consumeChunk(queue);
      }

      // Defaults:
      throw new ApiError(httpStatus.UNPROCESSABLE_ENTITY);
    } catch (error) {
      logError(error);
    }

    function purgeQueue(purge) {
      if (purge) {
        return channel.purgeQueue(queue);
      }
    }
  }

  async function consumeChunk(queue) {
    logger.log('verbose', `Prepared to consumeChunk from queue: ${queue}`);
    try {
      await channel.assertQueue(queue, {durable: true});
      const queMessages = await getData(queue);

      const headers = getHeaderInfo(queMessages[0]);
      logger.log('debug', `Filtering messages by ${JSON.stringify(headers)}`);

      // Check that cataloger match! headers
      const messages = queMessages.filter(message => {
        if (message.properties.headers.cataloger === headers.cataloger) {
          return true;
        }

        // Nack unwanted ones
        channel.nack(message, false, true);
        return false;
      });

      const records = await messagesToRecords(messages);

      return {headers, records, messages};
    } catch (error) {
      logError(error);
    }
  }

  async function consumeRawChunk(queue) {
    logger.log('verbose', `Prepared to consumeRawChunk from queue: ${queue}`);
    try {
      await channel.assertQueue(queue, {durable: true});
      const queMessages = await getData(queue);

      const headers = getHeaderInfo(queMessages[0]);
      logger.log('debug', `Filtering messages by ${JSON.stringify(headers)} and timeout`);

      // Check that cataloger match! headers
      const messages = queMessages.filter(message => {
        if (message.properties.headers.cataloger === headers.cataloger) {
          return true;
        }

        // Nack unwanted ones
        channel.nack(message, false, true);
        return false;
      });

      return {headers, messages};
    } catch (error) {
      logError(error);
    }
  }

  async function consumeOne(queue) {
    logger.log('verbose', `Prepared to consume one from queue: ${queue}`);
    try {
      await channel.assertQueue(queue, {durable: true});

      // Returns false if 0 items in queue
      const message = await channel.get(queue);
      if (message) {
        const headers = getHeaderInfo(message);
        const records = messagesToRecords([message]);
        return {headers, records, messages: [message]};
      }

      return false;
    } catch (error) {
      logError(error);
    }
  }

  async function consumeRaw(queue) {
    logger.log('verbose', `Prepared to consume raw from queue: ${queue}`);
    try {
      await channel.assertQueue(queue, {durable: true});
      // Returns false if 0 items in queue
      return await channel.get(queue);
    } catch (error) {
      logError(error);
    }
  }

  // ACK records
  async function ackNReplyMessages({status, messages, payloads}) {
    logger.log('verbose', 'Ack and reply messages!');
    await messages.forEach((message, index) => {
      const headers = getHeaderInfo(message);

      // Reply consumer gets: {"data":{"status":"UPDATED","payload":"0"}}
      sendToQueue({
        queue: message.properties.correlationId,
        correlationId: message.properties.correlationId,
        headers,
        data: {
          status, payload: payloads[index]
        }
      });

      channel.ack(message);
    });
  }

  function ackMessages(messages) {
    logger.log('verbose', 'Ack messages!');
    messages.forEach(message => {
      logger.log('silly', `Ack message ${message.properties.correlationId}`);
      channel.ack(message);
    });
  }

  function nackMessages(messages) {
    logger.log('verbose', 'Nack messages!');
    messages.forEach(message => {
      logger.log('silly', `Nack message ${message.properties.correlationId}`);
      channel.nack(message);
    });
  }

  async function sendToQueue({queue, correlationId, headers, data}) {
    try {
      logger.log('silly', `Record queue ${queue}`);
      logger.log('silly', `Record correlationId ${correlationId}`);
      logger.log('silly', `Record data ${data}`);
      logger.log('silly', `Record headers ${headers}`);

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

      logger.log('silly', `Message send to queue ${queue}`);
    } catch (error) {
      logError(error);
    }
  }

  async function removeQueue(queue) {
    await channel.deleteQueue(queue);
  }

  // ----------------
  // Helper functions
  // ----------------

  function messagesToRecords(messages) {
    logger.log('verbose', 'Parsing messages to records');

    return messages.map(message => {
      const content = JSON.parse(message.content.toString());
      return new MarcRecord(content.data);
    });
  }

  async function getData(queue) {
    logger.log('verbose', `Getting queue data from ${queue}`);
    try {
      const {messageCount} = await channel.checkQueue(queue);
      const messagesToGet = messageCount >= CHUNK_SIZE ? CHUNK_SIZE : messageCount;

      const messages = await pump(messagesToGet);

      logger.log('debug', `Returning ${messages.length} unique messages`);

      return messages;
    } catch (error) {
      logError(error);
    }

    async function pump(count, results = [], identifiers = []) {
      if (count === 0) {
        return results;
      }

      const message = await channel.get(queue);
      const identifier = {
        correlationId: message.properties.correlationId,
        deliveryTag: message.fields.deliveryTag
      }
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
}
