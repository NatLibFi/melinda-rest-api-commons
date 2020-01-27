/* eslint-disable no-unused-vars */

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
	"operation":"UPDATE",
	"contentType":"application/json",
	"queueItemState":"PENDING_QUEUING",
	"creationTime":"2020-01-01T00:00:00.000Z",
	"modificationTime":"2020-01-01T00:00:01.000Z",
	"handledIds": []
}
*/

export default async function (MONGO_URI) {
	const logger = createLogger(); // eslint-disable-line no-unused-vars
	// Connect to mongo (MONGO)
	const client = await MongoClient.connect(MONGO_URI, {useNewUrlParser: true, useUnifiedTopology: true, logger: {error: logMongoError, log: logMongoLog, debug: logMongoDebug}});
	const db = client.db('rest-api');
	const gridFSBucket = new GridFSBucket(db, {bucketName: 'queueItems'});

	return {create, query, remove, readContent, removeContent, getOne, getStream, setState, pushIds};

	async function create({correlationId, cataloger, operation, contentType, stream}) {
		// Create QueueItem
		const newQueueItem = {
			correlationId,
			cataloger,
			operation,
			contentType,
			queueItemState: QUEUE_ITEM_STATE.UPLOADING,
			creationTime: moment().toDate(),
			modificationTime: moment().toDate(),
			handledIds: []
		};

		db.collection('queue-items').insertOne(newQueueItem, (err, res) => {
			if (err) {
				throw err;
			}

			logger.log('debug', 'Queue-item created to Mongo');
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
		logger.log('debug', `Query result: ${JSON.stringify(result)}`);
		return result;
	}

	async function remove(correlationId) {
		try {
			await getFileMetadata({gridFSBucket, filename: correlationId});
			throw new DatabaseError(400);
		} catch (err) {
			if (!(err instanceof DatabaseError && err.status === 404)) {
				throw err;
			}
		}

		await db.collection('queue-items').deleteOne(correlationId);
		return true;
	}

	async function readContent(correlationId) {
		logger.log('info', `Reading content for id: ${correlationId}`);
		const result = await db.collection('queue-items').findOne({correlationId});
		// Check if the file exists

		if (result) {
			await getFileMetadata({gridFSBucket, filename: correlationId});
			return {
				contentType: result.contentType,
				readStream: gridFSBucket.openDownloadStreamByName(correlationId)
			};
		}

		throw new DatabaseError(404);
	}

	async function removeContent(params) {
		logger.log('info', `Removing content for id: ${params.correlationId}`);
		const result = await db.collection('queue-items').findOne(params);
		if (result) {
			const {_id: fileId} = await getFileMetadata({gridFSBucket, filename: params.correlationId});
			await gridFSBucket.delete(fileId);
			return true;
		}
	}

	async function getOne({operation, queueItemState}) {
		try {
			if (operation === undefined) {
				logger.log('debug', `Checking DB for ${queueItemState}`);
				return db.collection('queue-items').findOne({queueItemState});
			}

			logger.log('debug', `Checking DB for ${operation} + ${queueItemState}`);
			return db.collection('queue-items').findOne({operation, queueItemState});
		} catch (error) {
			logError(error);
		}
	}

	async function getStream(correlationId) {
		logger.log('info', `Forming stream from db: ${correlationId}`);

		try {
			// Check that content is there
			await getFileMetadata({gridFSBucket, filename: correlationId});

			// Transform gridFSBucket stream to MarcRecords -> to queue
			return gridFSBucket.openDownloadStreamByName(correlationId);
		} catch (error) {
			logError(error);
		}
	}

	async function pushIds({correlationId, ids}) {
		logger.log('info', `Push queue-item ids to list: ${correlationId}, ${ids}`);
		await db.collection('queue-items').updateOne({
			correlationId
		}, {
			$set: {
				modificationTime: moment().toDate()
			},
			$push: {
				handledIds: {$each: ids}
			}
		});
	}

	async function setState({correlationId, state}) {
		logger.log('info', `Setting queue-item state: ${correlationId}, ${state}`);
		await db.collection('queue-items').updateOne({
			correlationId
		}, {
			$set: {
				queueItemState: state,
				modificationTime: moment().toDate()
			}
		});
		return db.collection('queue-items').findOne({
			correlationId,
			queueItemState: state
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
	function logMongoDebug(message, object) {
		logger.log('debug', message);
	}

	function logMongoError(message, object) {
		logger.log('error', message);
	}

	function logMongoLog(message, object) {
		logger.log('info', message);
	}
}
