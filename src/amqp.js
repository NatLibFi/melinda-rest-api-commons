/* eslint-disable no-unused-vars */
import amqplib from 'amqplib';
import {MarcRecord} from '@natlibfi/marc-record';
import RabbitError, {Utils} from '@natlibfi/melinda-commons';
import {CHUNK_SIZE} from './constants';
import {logError} from './utils';

const {createLogger} = Utils;

export default async function (AMQP_URL) {
	const connection = await amqplib.connect(AMQP_URL);
	const channel = await connection.createChannel();
	const logger = createLogger();

	return {checkQueue, consume, consumeOne, consumeRaw, ackNReplyMessages, ackMessages, nackMessages, sendToQueue, removeQueue};

	async function checkQueue(queue, style = 'basic', purge = false) {
		try {
			const channelInfo = await channel.assertQueue(queue, {durable: true});
			logger.log('debug', `Queue ${queue} has ${channelInfo.messageCount} records`);

			if (purge) {
				await channel.purgeQueue(queue);
			}

			if (channelInfo.messageCount < 1) {
				return false;
			}

			if (style === 'messages') {
				return channelInfo.messageCount;
			}

			if (style === 'one') {
				return consumeOne(queue);
			}

			if (style === 'raw') {
				return consumeRaw(queue);
			}

			if (style === 'basic') {
				return consume(queue);
			}

			// Defaults:
			throw new RabbitError(422);
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

			const headers = getHeaderInfo(queMessages[0]);
			logger.log('debug', `Filtering messages by ${JSON.stringify(headers)}`);

			// Check that cataloger match! headers
			const messages = queMessages.filter(message => {
				if (message.properties.headers.cataloger === headers.cataloger) {
					return true;
				}

				nacks.push(message);
				return false;
			});

			const records = messagesToRecords(messages);

			// Nack unwanted ones to back in queue;
			nackMessages(nacks);

			return {headers, records, messages};
		} catch (error) {
			logError(error);
		}
	}

	async function consumeOne(queue) {
		try {
			await channel.assertQueue(queue, {durable: true});
			// Returns false if 0 items in queue
			const message = await channel.get(queue);
			if (message) {
				const headers = getHeaderInfo(message);
				const records = messagesToRecords([message]);
				return {headers, records, messages: [message]};
			}

			return message;
		} catch (error) {
			logError(error);
		}
	}

	async function consumeRaw(queue) {
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
		logger.log('debug', 'Ack and reply messages!');
		messages.forEach((message, index) => {
			const headers = getHeaderInfo(message);
			sendToQueue({
				queue: message.properties.correlationId,
				correlationId: message.properties.correlationId,
				headers,
				data: {
					status, payload: payloads[index]
				}
			});
			// Reply consumer gets: {"data":{"status":"UPDATED","payload":"0"}}

			channel.ack(message);
		});
	}

	async function ackMessages(messages) {
		logger.log('debug', 'Ack messages!');
		// TODO?: Add ids to mongo metadata?
		messages.forEach(message => {
			channel.ack(message);
		});
	}

	async function nackMessages(messages) {
		logger.log('debug', 'Nack messages!');
		messages.forEach(message => {
			// Message, allUpTo, reQueue
			channel.nack(message, false, true);
		});
	}

	async function sendToQueue({queue, correlationId, headers, data}) {
		try {
			// Logger.log('debug', `Record queue ${queue}`)
			// logger.log('debug', `Record correlationId ${correlationId}`);
			// logger.log('debug', `Record data ${data}`);
			// logger.log('debug', `Record headers ${headers}`);

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

			logger.log('debug', `Message send to queue ${queue}`);
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
		logger.log('debug', 'Parsing messages to records');

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
		return data.properties.headers;
	}
}
