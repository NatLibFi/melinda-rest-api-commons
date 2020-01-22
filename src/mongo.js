/* eslint-disable no-unused-vars */

import {MongoClient, GridFSBucket} from 'mongodb';
import DatabaseError, {Utils} from '@natlibfi/melinda-commons';
import {QUEUE_ITEM_STATE} from './constants';
import {logError} from './utils.js';
import moment from 'moment';

const {createLogger} = Utils;
/* QueueItem:
{
	"correlationId":"FOO",
	"cataloger":"xxx0000",
	"operation":"update",
	"contentType":"application/json",
	"queueItemState":"PENDING_QUEUING",
	"creationTime":"2020-01-01T00:00:00.000Z",
	"modificationTime":"2020-01-01T00:00:01.000Z"
}
*/

export default async function (MONGO_URI) {
	const logger = createLogger(); // eslint-disable-line no-unused-vars
	// Connect to mongo (MONGO)
	const client = await MongoClient.connect(MONGO_URI, {useNewUrlParser: true, useUnifiedTopology: true, logger: logMongo});
	const db = client.db('rest-api');
	const gridFSBucket = new GridFSBucket(db, {bucketName: 'queueItems'});

	return {create, query, remove, readContent, removeContent, getOne, getStream, setState};

	async function create({correlationId, cataloger, operation, contentType, stream}) {
		// Create QueueItem
		const newQueueItem = {
			correlationId,
			cataloger,
			operation,
			contentType,
			queueItemState: QUEUE_ITEM_STATE.UPLOADING,
			creationTime: moment().toDate(),
			modificationTime: moment().toDate()
		};

		db.collection('queue-items').insertOne(newQueueItem, (err, res) => {
			if (err) {
				throw err;
			}

			console.log('queue-item created');
		});

		return new Promise((resolve, reject) => {
			const outputStream = gridFSBucket.openUploadStream(correlationId);

			stream
				.on('error', reject)
				.on('data', chunk => outputStream.write(chunk))
				.on('end', () => outputStream.end(undefined, undefined, () => {
					resolve(correlationId);
				}));
		});
	}

	async function query(params) {
		const result = await db.collection('queue-items').find(params, {projection: {_id: 0}}).toArray();
		console.log(result);
		return result;
	}

	async function remove(params) {
		try {
			await getFileMetadata({gridFSBucket, filename: params.correlationId});
			throw new DatabaseError(400);
		} catch (err) {
			if (!(err instanceof DatabaseError && err.status === 404)) {
				throw err;
			}
		}

		await db.collection('queue-items').deleteOne(params);
		return true;
	}

	async function readContent(params) {
		const result = await db.collection('queue-items').findOne(params);
		// Check if the file exists

		if (result) {
			await getFileMetadata({gridFSBucket, filename: params.correlationId});
			console.log(result);
			return {
				contentType: result.contentType,
				readStream: gridFSBucket.openDownloadStreamByName(params.correlationId)
			};
		}

		throw new DatabaseError(404);
	}

	async function removeContent(params) {
		const result = await db.collection('queue-items').findOne(params);
		if (result) {
			const {_id: fileId} = await getFileMetadata({gridFSBucket, filename: params.correlationId});
			console.log(fileId);
			await gridFSBucket.delete(fileId);
			return true;
		}
	}

	async function getOne({operation, queueItemState}) {
		logger.log('debug', `Checking DB for ${operation} + ${queueItemState}`);
		try {
			return db.collection('queue-items').findOne({operation, queueItemState});
		} catch (error) {
			logError(error);
		}
	}

	async function getStream(correlationId) {
		try {
			// Check that content is there
			await getFileMetadata({gridFSBucket, filename: correlationId});

			// Transform gridFSBucket stream to MarcRecords -> to queue
			return {stream: gridFSBucket.openDownloadStreamByName(correlationId)};
		} catch (error) {
			logError(error);
		}
	}

	async function setState({correlationId, cataloger, operation, state}) {
		logger.log('debug', 'Setting queue item state');
		await db.collection('queue-items').updateOne({
			cataloger,
			correlationId,
			operation
		}, {
			$set: {
				queueItemState: state,
				modificationTime: moment().toDate()
			}
		});
		return db.collection('queue-items').findOne({
			cataloger,
			correlationId,
			operation
		}, {projection: {_id: 0}});
	}

	async function getFileMetadata({gridFSBucket, filename}) {
		return new Promise((resolve, reject) => {
			gridFSBucket.find({filename})
				.on('error', reject)
				.on('data', resolve)
				.on('end', () => reject(new DatabaseError(404)));
		});
	}

	// TODO: Make work properly (https://mongodb.github.io/node-mongodb-native/driver-articles/mongoclient.html logger)
	function logMongo({error = {}, log = {}, debug = {}}) {
		if (error) {
			logger.log('error', error);
		}

		if (log) {
			logger.log('info', log);
		}

		if (debug) {
			logger.log('debug', debug);
		}
	}
}
