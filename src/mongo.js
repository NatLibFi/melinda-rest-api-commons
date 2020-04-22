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
import {Error as ApiError, Utils} from '@natlibfi/melinda-commons';
import {QUEUE_ITEM_STATE, PRIO_QUEUE_ITEM_STATE} from './constants';
import {logError} from './utils.js';
import moment from 'moment';
import httpStatus from 'http-status';


/* QueueItem:
{
  "correlationId":"FOO",
  "cataloger":"xxx0000",
  "operation":"UPDATE",
  "contentType":"application/json",
  "recordLoadParams": {
    "pActiveLibrary": "XXX00",
    "pInputFile": "filename.seq",
    "pRejectFile": "filename.rej",
    "pLogFile": "filename.syslog",
    "pOldNew": "NEW"
  },
  "queueItemState":"PENDING_QUEUING",
  "creationTime":"2020-01-01T00:00:00.000Z",
  "modificationTime":"2020-01-01T00:00:01.000Z",
  "handledIds": []
}
*/

export default async function (MONGO_URI) {
  const {createLogger} = Utils;
  const logger = createLogger();

  // Connect to mongo (MONGO)
  const client = await MongoClient.connect(MONGO_URI, {useNewUrlParser: true, useUnifiedTopology: true});
  const db = client.db('rest-api');
  const gridFSBucket = new GridFSBucket(db, {bucketName: 'queueItems'});

  return {createPrio, createBulk, checkAndSetState, query, queryById, remove, readContent, removeContent, getOne, getStream, setState, pushIds};

  function createPrio({correlationId, cataloger, operation}) {
    const time = moment().toDate();
    const newQueueItem = {
      correlationId,
      cataloger,
      operation,
      queueItemState: PRIO_QUEUE_ITEM_STATE.PENDING_VALIDATION,
      creationTime: time,
      modificationTime: time,
      handledId: ''
    };
    try {
      const result = Promise.resolve(db.collection('queue-items').insertOne(newQueueItem));
      console.log(result); // eslint-disable-line no-console
      if (result.acknowledged) {
        return time;
      }
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'no ack');
    } catch (error) {
      logError(error);
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  function createBulk({correlationId, cataloger, operation, contentType, recordLoadParams, stream}) {
    const time = moment().toDate();
    const newQueueItem = {
      correlationId,
      cataloger,
      operation,
      contentType,
      recordLoadParams,
      queueItemState: QUEUE_ITEM_STATE.UPLOADING,
      creationTime: time,
      modificationTime: time,
      handledIds: []
    };
    try {
      db.collection('queue-items').insertOne(newQueueItem);
      logger.log('info', 'New queue item has been made!');
    } catch (error) {
      logError(error);
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR);
    }

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

  async function checkAndSetState({correlationId, state}) {
    const current = await db.collection('queue-items').findOne({correlationId});

    if (current.queueItemState === PRIO_QUEUE_ITEM_STATE.ABORT) {
      return current;
    }

    return setState({correlationId, state});
  }

  async function query(params) {
    const result = await db.collection('queue-items').find(params, {projection: {_id: 0}})
      .toArray();
    logger.log('info', `Query result: ${result.length > 0 ? 'Found!' : 'Not found!'}`);
    return result;
  }

  function queryById(correlationId) {
    return db.collection('queue-items').findOne({correlationId});
  }

  async function remove(correlationId) {
    logger.log('info', `Removing id: ${correlationId}`);
    try {
      await getFileMetadata({gridFSBucket, filename: correlationId});
      throw new ApiError(httpStatus.BAD_REQUEST, 'Remove content first');
    } catch (err) {
      if (err.status === httpStatus.NOT_FOUND) { // eslint-disable-line functional/no-conditional-statement
        await db.collection('queue-items').deleteOne(correlationId);
        return true;
      }
      throw err;
    }
  }

  async function readContent(correlationId) {
    logger.log('info', `Reading content for id: ${correlationId}`);
    const result = await db.collection('queue-items').findOne({correlationId});

    if (result) {
      // Check if the file exists
      await getFileMetadata({gridFSBucket, filename: correlationId});
      return {
        contentType: result.contentType,
        readStream: gridFSBucket.openDownloadStreamByName(correlationId)
      };
    }

    throw new ApiError(404);
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

  function getOne({operation, queueItemState}) {
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

      // Return content stream
      return gridFSBucket.openDownloadStreamByName(correlationId);
    } catch (error) {
      logError(error);
    }
  }

  async function pushIds({correlationId, ids}) {
    logger.log('debug', `Push queue-item ids to list: ${correlationId}, ${ids}`);
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

  function setState({correlationId, state}) {
    logger.log('info', `Setting queue-item state: ${correlationId}, ${state}`);
    return db.collection('queue-items').findOneAndUpdate({
      correlationId
    }, {
      $set: {
        queueItemState: state,
        modificationTime: moment().toDate()
      }
    }, {projection: {_id: 0}, returnNewDocument: true});
  }

  function getFileMetadata({gridFSBucket, filename}) {
    return new Promise((resolve, reject) => {
      gridFSBucket.find({filename})
        .on('error', reject)
        .on('data', resolve)
        .on('end', () => reject(new ApiError(httpStatus.NOT_FOUND, 'No content')));
    });
  }
}
