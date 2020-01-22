/* eslint-disable no-unused-vars */
import amqplib from 'amqplib';
import {EventEmitter} from 'events';
import HttpStatus from 'http-status';
import {MarcRecord} from '@natlibfi/marc-record';
import RabbitError, {Utils} from '@natlibfi/melinda-commons';
import {RECORD_IMPORT_STATE} from '@natlibfi/melinda-record-import-commons';
import {AMQP_URL, OFFLINE_BEGIN, OFFLINE_DURATION} from './config';
import {CHUNK_SIZE, PRIO_IMPORT_QUEUES} from './constants';
import {logError, checkIfOfflineHours} from './utils';

const {createLogger} = Utils;
class ReplyEmitter extends EventEmitter {}
export const replyEmitter = new ReplyEmitter();

export default async function () {
	const {REPLY, CREATE, UPDATE} = PRIO_IMPORT_QUEUES;
	const connection = await amqplib.connect(AMQP_URL);
	const channel = await connection.createChannel();
	const logger = createLogger();

	return {checkQueue, consume, consumeOne, consumeRaw, ackMessages, nackMessages, sendToQueue};

	async function checkQueue(queue, style = 'basic', purge = false) {
		try {
			await channel.assertQueue(queue, {durable: true});

			if (purge) {
				await channel.purgeQueue(queue);
			}

			let channelInfo = await channel.checkQueue(queue);
			logger.log('debug', `Queue ${queue} has ${channelInfo.messageCount} records`);

			// If Service is in offline
			const isOfflineHours = checkIfOfflineHours();
			if (isOfflineHours && channelInfo.messageCount > 0) {
				replyErrors(HttpStatus.SERVICE_UNAVAILABLE, `${HttpStatus['503_MESSAGE']} Offline hours begin at ${OFFLINE_BEGIN} and will last next ${OFFLINE_DURATION} hours.`);
			} else if (isOfflineHours) {
				return false;
			}

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
			const queDatas = await getData(queue);
			// Console.log(queDatas);

			const {cataloger, operation} = getHeaderInfo(queDatas[0]);

			// Check that cataloger match! headers
			const datas = queDatas.filter(data => {
				return (data.properties.headers.cataloger === cataloger);
			});

			const records = datasToRecords(datas);

			// Nack unwanted ones to back in queue;
			const nacks = queDatas.filter(data => {
				return (!datas.includes(data));
			});

			nackMessages(nacks);

			return {cataloger, operation, records, datas};
		} catch (error) {
			logError(error);
		}
	}

	async function consumeOne(queue) {
		try {
			await channel.assertQueue(queue, {durable: true});
			const datas = [await channel.get(queue)];
			const {cataloger, operation} = getHeaderInfo(datas[0]);
			const records = datasToRecords(datas);
			return {cataloger, operation, records, datas};
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
	async function ackMessages({queue, datas, results}) {
		if (queue === CREATE || queue === UPDATE) {
			datas.forEach((data, index) => {
				const {cataloger, operation} = getHeaderInfo(data);
				const status = (queue === CREATE) ? RECORD_IMPORT_STATE.CREATED : RECORD_IMPORT_STATE.UPDATED;
				sendToQueue({
					queue: REPLY,
					correlationId: data.properties.correlationId,
					cataloger,
					operation,
					data: {status, id: results.ids[index]}
				});
				// Reply consumer gets: {"data":{"status":"UPDATED","id":"0"}}

				channel.ack(data);
			});
		} else {
			// Bulk has no unwanted ones
			// TODO?: Add ids to mongo metadata?
			datas.forEach(data => {
				channel.ack(data);
			});
		}
	}

	async function nackMessages(datas) {
		datas.forEach(data => {
			// Message, allUpTo, reQueue
			channel.nack(data, false, true);
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

	// ----------------
	// Helper functions
	// ----------------

	function datasToRecords(datas) {
		datas.map(data => {
			data.content = JSON.parse(data.content.toString());
			data.content.record = new MarcRecord(data.content.data);
			return data;
		});

		// Collect datas.content.record to one array
		return datas.flatMap(data => {
			return data.content.record;
		});
	}

	async function replyErrors(queue, err) {
		try {
			const error = new RabbitError(err);
			const queDatas = await getData(queue);
			const promises = [];

			queDatas.forEach(data => {
				const headers = getHeaderInfo(data);
				promises.push(sendReply({correlationId: data.properties.correlationId, ...headers, data: error}));
			});

			await Promise.all(promises);
			queDatas.forEach(data => {
				channel.ack(data);
			});
		} catch (error) {
			logError(error);
		}
	}

	async function getData(queue) {
		let queDatas = [];

		try {
			const {messageCount} = await channel.checkQueue(queue);
			const messages = (messageCount >= CHUNK_SIZE) ? CHUNK_SIZE : messageCount;
			const promises = [];
			for (let i = 0; i < messages; i++) {
				promises.push(get());
			}

			await Promise.all(promises);
			return queDatas;
		} catch (error) {
			logError(error);
		}

		async function get() {
			const message = await channel.get(queue);
			if (!queDatas.includes(message)) {
				queDatas.push(message);
			}
		}
	}

	function getHeaderInfo(data) {
		return {cataloger: data.properties.headers.cataloger, operation: data.properties.headers.operation};
	}
}
