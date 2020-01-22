/* eslint-disable no-unused-vars */
import amqplib from 'amqplib';
import HttpStatus from 'http-status';
import {MarcRecord} from '@natlibfi/marc-record';
import RabbitError, {Utils} from '@natlibfi/melinda-commons';
import {RECORD_IMPORT_STATE} from '@natlibfi/melinda-record-import-commons';
import {OFFLINE_BEGIN, OFFLINE_DURATION} from './config';
import {CHUNK_SIZE, PRIO_IMPORT_QUEUES} from './constants';
import {logError, checkIfOfflineHours} from './utils';

const {createLogger} = Utils;

export default async function (AMQP_URL) {
	const {REPLY, CREATE, UPDATE} = PRIO_IMPORT_QUEUES;
	const connection = await amqplib.connect(AMQP_URL);
	const channel = await connection.createChannel();
	const logger = createLogger();

	return {checkQueue, consume, consumeOne, consumeRaw, ackMessages, nackMessages, sendToQueue, replyErrors};

	async function checkQueue(queue, style = 'basic', purge = false) {
		try {
			await channel.assertQueue(queue, {durable: true});

			if (purge) {
				await channel.purgeQueue(queue);
			}

			let channelInfo = await channel.checkQueue(queue);
			logger.log('debug', `Queue ${queue} has ${channelInfo.messageCount} records`);

			if (channelInfo.messageCount < 1) {
				return false;
			}

			if (style === 'one') {
				return consumeOne(queue);
			}

			if (style === 'raw') {
				return consumeRaw();
			}

			return consume(queue);
		} catch (error) {
			logError(error);
		}
	}

	async function consume(queue) {
		// Debug: logger.log('debug', `Prepared to consume from queue: ${queue}`);
		try {
			await channel.assertQueue(queue, {durable: true});
			const queMessages = await getData(queue);
			const nacks = [];
			// Console.log(queDatas);

			const {cataloger, operation} = getHeaderInfo(queMessages[0]);

			// Check that cataloger match! headers
			const messages = queMessages.filter(message => {
				if (message.properties.headers.cataloger === cataloger) {
					return true;
				}

				nacks.push(message);
				return false;
			});

			const records = messagesToRecords(messages);

			// Nack unwanted ones to back in queue;
			nackMessages(nacks);

			return {cataloger, operation, records, messages};
		} catch (error) {
			logError(error);
		}
	}

	async function consumeOne(queue) {
		try {
			await channel.assertQueue(queue, {durable: true});
			const messages = [await channel.get(queue)];
			const {cataloger, operation} = getHeaderInfo(messages[0]);
			const records = messagesToRecords(messages);
			return {cataloger, operation, records, messages};
		} catch (error) {
			logError(error);
		}
	}

	async function consumeRaw() {
		try {
			await channel.assertQueue(REPLY, {durable: true});
			return await channel.get(REPLY);
		} catch (error) {
			logError(error);
		}
	}

	// ACK records
	async function ackMessages({queue, messages, results}) {
		if (queue === CREATE || queue === UPDATE) {
			messages.forEach((message, index) => {
				const {cataloger, operation} = getHeaderInfo(message);
				const status = (queue === CREATE) ? RECORD_IMPORT_STATE.CREATED : RECORD_IMPORT_STATE.UPDATED;
				sendToQueue({
					queue: REPLY,
					correlationId: message.properties.correlationId,
					cataloger,
					operation,
					data: {status, id: results.ids[index]}
				});
				// Reply consumer gets: {"data":{"status":"UPDATED","id":"0"}}

				channel.ack(message);
			});
		} else {
			// Bulk has no unwanted ones
			// TODO?: Add ids to mongo metadata?
			messages.forEach(message => {
				channel.ack(message);
			});
		}
	}

	async function nackMessages(messages) {
		messages.forEach(message => {
			// Message, allUpTo, reQueue
			channel.nack(message, false, true);
		});
	}

	async function sendToQueue({queue, correlationId, headers, data}) {
		try {
			// Logger.log('debug', `Record cataloger ${cataloger}`)
			// logger.log('debug', `Record correlationId ${correlationId}`);
			// logger.log('debug', `Record data ${data}`);
			// logger.log('debug', `Record operation ${operation}`);

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
		} catch (error) {
			logError(error);
		}
	}

	async function replyErrors({queue, errorStatus, errorPayload = ''}) {
		try {
			const error = new RabbitError(errorStatus, errorPayload);
			const messages = await getData(queue);
			const promises = [];

			messages.forEach(message => {
				const headers = getHeaderInfo(message);
				promises.push(sendToQueue({correlationId: message.properties.correlationId, headers, data: error}));
			});

			await Promise.all(promises);
			messages.forEach(message => {
				channel.ack(message);
			});
		} catch (error) {
			logError(error);
		}
	}

	// ----------------
	// Helper functions
	// ----------------

	function messagesToRecords(messages) {
		messages.map(message => {
			message.content = JSON.parse(message.content.toString());
			message.content.record = new MarcRecord(message.content.data);
			return message;
		});

		// Collect datas.content.record to one array
		return messages.flatMap(message => {
			return message.content.record;
		});
	}

	async function getData(queue) {
		let messages = [];

		try {
			const {messageCount} = await channel.checkQueue(queue);
			const messagesToGet = (messageCount >= CHUNK_SIZE) ? CHUNK_SIZE : messageCount;
			const promises = [];
			for (let i = 0; i < messagesToGet; i++) {
				promises.push(get());
			}

			await Promise.all(promises);
			return messages;
		} catch (error) {
			logError(error);
		}

		async function get() {
			const message = await channel.get(queue);
			if (!messages.includes(message)) {
				messages.push(message);
			}
		}
	}

	function getHeaderInfo(data) {
		return {cataloger: data.properties.headers.cataloger, operation: data.properties.headers.operation};
	}
}
