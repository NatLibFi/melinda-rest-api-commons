import amqplib from 'amqplib';
import createDebugLogger from 'debug';
import {promisify, inspect} from 'util';
import httpStatus from 'http-status';
import {MarcRecord} from '@natlibfi/marc-record';
import type {MarcRecordObject} from '@natlibfi/marc-record';
import {createLogger, Error as ApiError} from '@natlibfi/melinda-commons';
import type {Channel, ChannelModel, GetMessage, Message, Replies} from 'amqplib';
import {CHUNK_SIZE} from './constants.ts';
import {logError} from './utils.ts';

// ----------------
// Queue-item message payload types
// ----------------

/**
 * Message payload of a consumed queue-item chunk (toRecord: true):
 * the AMQP message properties headers of the first message of the chunk,
 * the MARC records parsed from the message bodies, and the raw consumed
 * messages.
 */
export interface QueueItemRecordPayload {
  headers: Record<string, unknown> | undefined;
  records: MarcRecord[];
  messages: Message[];
}

/**
 * Message payload of a consumed queue-item chunk (toRecord: false):
 * the same shape as QueueItemRecordPayload without the parsed records.
 */
export interface QueueItemMessagePayload {
  headers: Record<string, unknown> | undefined;
  messages: Message[];
}

/**
 * Params for checkQueue. `style` is free-form on purpose: checkQueue
 * throws a 500 ApiError for any style it does not recognize.
 */
export interface CheckQueueParams {
  queue: string;
  style?: string;
  toRecord?: boolean;
  purge?: boolean;
}

/**
 * The return shape of checkQueue: the message count (style 'messages'),
 * false (empty queue), the plain message (style 'one', toRecord false)
 * or a message payload object (toRecord true).
 */
export type CheckQueueResult = number | boolean | QueueItemMessagePayload | QueueItemRecordPayload | GetMessage;

/**
 * Params for sendToQueue. `queue` is optional on purpose: a missing queue
 * is rejected with a 500 ApiError (see errorUndefinedQueue).
 */
export interface SendToQueueParams {
  queue?: string;
  correlationId: string;
  headers?: Record<string, unknown>;
  data: unknown;
}

/**
 * The AMQP operator object returned by the factory.
 */
export interface AmqpOperator {
  checkQueue: (params: CheckQueueParams) => Promise<CheckQueueResult>;
  consumeChunk: (queue: string, toRecord: boolean) => Promise<false | QueueItemMessagePayload | QueueItemRecordPayload>;
  consumeOne: (queue: string, toRecord: boolean) => Promise<false | GetMessage | QueueItemRecordPayload>;
  ackMessages: (messages: Message[]) => void;
  nackMessages: (messages: Message[]) => void;
  sendToQueue: (params: SendToQueueParams) => Promise<void>;
  removeQueue: (queue: string) => Promise<void>;
  messagesToRecords: (messages: Message[]) => MarcRecord[];
  closeChannel: () => Promise<void>;
  closeConnection: () => Promise<void>;
}

/**
 * Dedup key used while pumping messages from a queue
 */
interface MessageIdentifier {
  correlationId: string;
  deliveryTag: number;
}

/**
 * Create AMQP operator
 * @param AMQP_URL amqp connection url
 * @param runHealthCheck run the health check loop
 * @param deps optional dependencies, defaults {}. deps.connection / deps.channel (amqplib objects) may be injected by unit tests
 * @returns the AMQP operator object
 */
export default async function (AMQP_URL: string, runHealthCheck = false, deps: {connection?: unknown, channel?: unknown} = {}): Promise<AmqpOperator> {
  const logger = createLogger();
  const debug = createDebugLogger('@natlibfi/melinda-rest-api-commons:amqp');
  const debugHC = debug.extend('HC');
  const debugData = debug.extend('data');
  const setTimeoutPromise = promisify(setTimeout);

  debug(`Creating an AMQP operator to ${AMQP_URL}`);
  // deps allows injecting stubbed connection/channel in unit tests
  const connection: ChannelModel = (deps.connection as ChannelModel | undefined) ?? await amqplib.connect(AMQP_URL);
  const channel: Channel = (deps.channel as Channel | undefined) ?? await connection.createChannel();

  // the recursive healthCheck loop is never awaited and kept firing
  // ~every 200 ms even after the connection was closed. This flag is cleared
  // by closeChannel/closeConnection so the loop short-circuits on graceful
  // shutdown instead of running until the closed channel throws.
  let healthCheckRunning = runHealthCheck;
  const healthCheckLoop = runHealthCheck ? healthCheck() : false;

  debug(`Connection: ${connection}`);
  debug(`Channel: ${channel}`);
  debug(`HealthCheckLoop: ${healthCheckLoop ? 'Running health check' : 'Not running health check'}`);

  return {checkQueue, consumeChunk, consumeOne, ackMessages, nackMessages, sendToQueue, removeQueue, messagesToRecords, closeChannel, closeConnection};

  async function closeChannel() {
    // stop the health check loop before closing so it does not keep
    // firing on a closed channel during graceful shutdown
    healthCheckRunning = false;
    debug(`Closing channel`);
    await channel.close();
    debug(`Channel: ${channel}`);
  }

  async function closeConnection() {
    // stop the health check loop before closing
    healthCheckRunning = false;
    debug(`Closing connection`);
    await connection.close();
    debug(`Connection: ${connection}`);
  }

  /**
   * @param wait false cancels/starts, a number of ms waits before re-checking
   * @returns false when the loop stopped, the loop re-arms otherwise
   */
  async function healthCheck(wait: number | false = false): Promise<boolean> {
    // cancellable - closeChannel/closeConnection set this to false
    if (!healthCheckRunning) {
      debugHC(`HealthCheck cancelled, not running`);
      return false;
    }
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
      // if we were asked to stop, do not rethrow - a closed channel
      // throwing during shutdown would keep the process alive / crash it
      if (!healthCheckRunning) {
        debugHC(`HealthCheck cancelled while erroring, not throwing`);
        return false;
      }
      handleAmqpErrors(error);
    }
  }

  /**
   * Check a queue: consume one message or a chunk, return the message count, or purge
   * @param params
   * @returns false (empty queue) | message count (style 'messages') | message/records/chunk object (style 'one'/'basic')
   */
  async function checkQueue({queue, style = 'basic', toRecord = true, purge = false}: CheckQueueParams): Promise<CheckQueueResult> {
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

    function checkMessageCount(channelInfo: Replies.AssertQueue): boolean {
      if (channelInfo.messageCount < 1) {
        debug(`checkQueue: ${channelInfo.messageCount} - ${queue} is empty`);
        return false;
      }
      debug(`Queue ${queue} has ${channelInfo.messageCount} messages`);
      return true;
    }

    function purgeQueue(purge: boolean): Promise<Replies.PurgeQueue> | undefined {
      debug(`Purging queue: ${queue}, purge: ${purge}`);
      if (purge) {
        return channel.purgeQueue(queue);
      }
      return undefined;
    }
  }

  /**
   * Consume a chunk of messages from a queue
   * @returns false (drained queue) or {headers, [records,] messages}
   */
  async function consumeChunk(queue: string, toRecord: boolean): Promise<false | QueueItemMessagePayload | QueueItemRecordPayload> {
    debug(`Prepared to consumeChunk from queue: ${queue}`);
    try {
      await channel.assertQueue(queue, {durable: true});

      // getData: next chunk (100) messages
      const messages = await getData(queue);

      // queue can drain before/during the pump -> nothing to return,
      // matches the `false` contract checkQueue uses for an empty queue
      if (messages.length === 0) {
        debug(`consumeChunk: queue ${queue} drained, returning false`);
        return false;
      }

      // Note: headers are from the first message of the chunk
      // (the length check above guarantees messages[0] exists)
      const headers = getHeaderInfo(messages[0] as Message);
      debug(`consumeChunk (${messages ? messages.length : '0'} from queue ${queue}) ${toRecord ? 'to records' : 'just messages'}`);

      if (toRecord) {
        const records = messagesToRecords(messages);
        return {headers, records, messages};
      }

      return {headers, messages};
    } catch (error) {
      handleAmqpErrors(error);
    }
  }

  /**
   * Consume one message from a queue
   * @returns false (empty queue) or the message / {headers, records, messages}
   */
  async function consumeOne(queue: string, toRecord: boolean): Promise<false | GetMessage | QueueItemRecordPayload> {
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

  /**
   * Ack a list of messages
   * @param messages
   */
  function ackMessages(messages: Message[]) {
    messages.forEach(message => {
      debug(`Ack message ${message.properties.correlationId}`);
      channel.ack(message);
    });
  }

  /**
   * Nack a list of messages
   * @param messages
   */
  function nackMessages(messages: Message[]) {
    messages.forEach(message => {
      debug(`Nack message ${message.properties.correlationId}`);
      channel.nack(message);
    });
  }

  /**
   * Send a message to a queue (correlationId is delivered via message properties only)
   * @param params
   */
  async function sendToQueue({queue, correlationId, headers, data}: SendToQueueParams): Promise<void> {
    debug(`sendToQueue`);
    try {
      debug(`Queue ${queue}`);
      debug(`CorrelationId ${correlationId}`);
      debugData(`Data ${JSON.stringify(data)}`);
      debug(`Headers ${JSON.stringify(headers)}`);

      errorUndefinedQueue(queue);

      debug(`Asserting queue: ${queue}`);
      await channel.assertQueue(queue, {durable: true});

      // `correlationId` is deliberately delivered ONLY via AMQP message
      // properties (headers) — it is NOT included in the message body
      // (which is just `JSON.stringify({data})`). Consumers MUST read it from
      // `message.properties.correlationId`, not from the body. Do not add it
      // to the body without changing the message contract.
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

  /**
   * Delete a queue via a throwaway channel
   * @param queue
   */
  async function removeQueue(queue: string): Promise<void> {
    // deleteQueue borks the channel if the queue does not exist
    // -> use throwaway tempChannel to avoid killing actual channel in use
    // this might be doable also with assertQueue before deleteQueue
    let tempChannel: Channel | undefined;
    try {
      tempChannel = await connection.createChannel();
      logger.verbose(`Removing queue ${queue}.`);
      debug(`Removing queue ${queue}.`);
      await tempChannel.deleteQueue(queue);
    } finally {
      // if deleteQueue throws (e.g. the queue does not exist) the
      // throwaway channel used to leak -> always close it
      if (tempChannel) {
        await tempChannel.close();
      }
    }
  }

  // ----------------
  // Helper functions
  // ----------------

  /**
   * Parse a list of consumed messages to MarcRecords
   * @param messages
   * @returns MarcRecord[]
   */
  function messagesToRecords(messages: Message[]): MarcRecord[] {
    debug(`Parsing messages (${messages.length}) to records`);

    return messages.map(message => {
      const content = JSON.parse(message.content.toString());
      // Use subfieldValues: false validationOption here
      return new MarcRecord(content.data as MarcRecordObject, {subfieldValues: false});
    });
  }

  /**
   * Get the next chunk of messages from a queue
   * @param queue
   * @returns Promise<Message[]>
   */
  async function getData(queue: string): Promise<Message[]> {
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

    /**
     * Recursively pump messages until count is reached or the queue drains
     * @param count
     * @param results
     * @param identifiers
     * @returns Promise<Message[]>
     */
    async function pump(count: number, results: Message[] = [], identifiers: MessageIdentifier[] = []): Promise<Message[]> {
      if (count === 0) {
        return results;
      }

      const message = await channel.get(queue);
      // queue can drain between the messageCount read and channel.get
      // (race, purge, other consumer) -> channel.get returns false
      if (!message) {
        return results;
      }

      const identifier: MessageIdentifier = {
        correlationId: message.properties.correlationId,
        deliveryTag: message.fields.deliveryTag
      };
      // filter not unique messages (compare by key, not by object reference)
      const isDuplicate = identifiers.some(
        i => i.correlationId === identifier.correlationId && i.deliveryTag === identifier.deliveryTag
      );
      if (isDuplicate) {
        return pump(count - 1, results, identifiers);
      }

      return pump(count - 1, results.concat(message), identifiers.concat(identifier));
    }
  }

  /**
   * Get the message properties headers of a message
   * @param data a consumed amqplib message
   * @returns the message headers
   */
  function getHeaderInfo(data: Message): Record<string, unknown> | undefined {
    return data.properties.headers;
  }

  /**
   * Throw 500 when the queue is undefined/empty/null; asserts a string queue
   * for the call sites that pass a possibly-optional queue
   * @param queue
   */
  function errorUndefinedQueue(queue: string | null | undefined): asserts queue is string {
    if (queue === undefined || queue === '' || queue === null) {
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Undefined queue!`);
    }
  }

  /**
   * Rethrow ApiErrors as ApiError and log + rethrow anything else; always throws
   * @param error
   */
  function handleAmqpErrors(error: unknown): never {
    const newError = error;
    debug(`HandleAmqpErrors got an error: ${JSON.stringify(error)}`);
    if (error instanceof ApiError) {
      debug(`We have an ApiError`);
      throw new ApiError(error.status, error.payload);
    }
    debug(`We have a non-ApiError`);
    logError(error);
    throw newError;
  }
}
