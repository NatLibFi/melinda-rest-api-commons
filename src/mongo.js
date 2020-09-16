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
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {Error as ApiError} from '@natlibfi/melinda-commons';
import {QUEUE_ITEM_STATE, PRIO_QUEUE_ITEM_STATE} from './constants';
import {logError} from './utils.js';
import moment from 'moment';
import httpStatus from 'http-status';
import sanitize from 'mongo-sanitize';

/* QueueItem:
{
  "correlationId":"FOO",
  "cataloger":"xxx0000",
  "oCatalogerIn":"xxx0000"
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
  const logger = createLogger();

  // Connect to mongo (MONGO)
  const client = await MongoClient.connect(MONGO_URI, {useNewUrlParser: true, useUnifiedTopology: true});
  const db = client.db('rest-api');
  const gridFSBucket = new GridFSBucket(db, {bucketName: 'queueItems'});

  return {createPrio, createBulk, checkAndSetState, query, queryById, remove, readContent, removeContent, getOne, getStream, setState, pushIds, pushId};

  async function createPrio({correlationId, cataloger, oCatalogerIn, operation}) {
    const time = moment().toDate();
    const newQueueItem = {
      correlationId,
      cataloger,
      operation,
      oCatalogerIn,
      queueItemState: PRIO_QUEUE_ITEM_STATE.PENDING_VALIDATION,
      creationTime: time,
      modificationTime: time,
      handledId: ''
    };
    try {
      const result = await db.collection('queue-items').insertOne(newQueueItem);
      if (result.result.n === 1 && result.result.ok === 1) {
        return;
      }
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR);
    } catch (error) {
      logError(error);
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  function createBulk({correlationId, cataloger, oCatalogerIn, operation, contentType, recordLoadParams, stream}) {
    const time = moment().toDate();
    const newQueueItem = {
      correlationId,
      cataloger,
      oCatalogerIn,
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
    const timeOut = await checkTimeOut(correlationId);
    if (timeOut) {
      return setState({correlationId, state});
    }
    return false;
  }

  async function query(params) {
    const result = await db.collection('queue-items').find(params, {projection: {_id: 0}})
      .toArray();
    logger.log('info', `Query result: ${result.length > 0 ? 'Found!' : 'Not found!'}`);
    return result;
  }

  async function queryById(correlationId, checkModTime) {
    const result = await db.collection('queue-items').findOne({correlationId});
    if (checkModTime) {
      const timeOut = await checkTimeOut(correlationId);
      if (timeOut) {
        return queryById(correlationId);
      }
      return result;
    }

    return result;
  }

  async function checkTimeOut(correlationId) {
    const result = await db.collection('queue-items').findOne({correlationId});
    const timeoutTime = moment(result.modificationTime).add(1, 'm');
    logger.log('silly', `timeOut @ ${timeoutTime}`);
    if (timeoutTime.isBefore()) {
      await setState({correlationId, state: PRIO_QUEUE_ITEM_STATE.ABORT});
      return false;
    }

    return true;
  }

  async function remove(correlationId) {
    logger.log('info', `Removing id: ${correlationId}`);
    try {
      await getFileMetadata({gridFSBucket, filename: correlationId});
      throw new ApiError(httpStatus.BAD_REQUEST, 'Remove content first');
    } catch (err) {
      if (err.status === httpStatus.NOT_FOUND) {
        await db.collection('queue-items').deleteOne(correlationId);
        return true;
      }
      throw err;
    }
  }

  async function readContent(correlationId) {
    logger.log('info', `Reading content for id: ${correlationId}`);
    const clean = sanitize(correlationId);
    const result = await db.collection('queue-items').findOne({correlationId: clean}); //ignore: node_nosqli_injection

    if (result) {
      // Check if the file exists
      await getFileMetadata({gridFSBucket, filename: clean});
      return {
        contentType: result.contentType,
        readStream: gridFSBucket.openDownloadStreamByName(clean)
      };
    }

    throw new ApiError(httpStatus.NOT_FOUND);
  }

  async function removeContent(params) {
    logger.log('info', `Removing content for id: ${params.correlationId}`);
    const clean = sanitize(params.correlationId);

    const result = await db.collection('queue-items').findOne({correlationId: clean}); //ignore: node_nosqli_injection
    if (result) {
      const {_id: fileId} = await getFileMetadata({gridFSBucket, filename: clean});
      await gridFSBucket.delete(fileId);
      return true;
    }
  }

  function getOne({operation, queueItemState}) {
    const clean2 = sanitize(queueItemState);
    try {
      if (operation === undefined) {
        logger.log('silly', `Checking DB for ${clean2}`);
        return db.collection('queue-items').findOne({clean2}); //ignore: node_nosqli_injection
      }

      const clean = sanitize(operation);

      logger.log('silly', `Checking DB for ${clean} + ${clean2}`);
      return db.collection('queue-items').findOne({operation: clean, queueItemState: clean2}); //ignore: node_nosqli_injection
    } catch (error) {
      logError(error);
    }
  }

  async function getStream(correlationId) {
    logger.log('info', `Forming stream from db: ${correlationId}`);
    const clean = sanitize(correlationId);
    try {
      // Check that content is there
      await getFileMetadata({gridFSBucket, filename: clean});

      // Return content stream
      return gridFSBucket.openDownloadStreamByName(clean);
    } catch (error) {
      logError(error);
    }
  }

  async function pushIds({correlationId, ids}) {
    logger.log('debug', `Push queue-item ids to list: ${correlationId}, ${ids}`);
    const clean = sanitize(correlationId);
    await db.collection('queue-items').updateOne({
      correlationId: clean
    }, {
      $set: {
        modificationTime: moment().toDate()
      },
      $push: {
        handledIds: {$each: ids}
      }
    });
  }

  async function pushId({correlationId, id}) {
    logger.log('debug', `Push queue-item id: ${correlationId}, ${id}`);
    const clean = sanitize(correlationId);
    await db.collection('queue-items').updateOne({
      correlationId: clean
    }, {
      $set: {
        modificationTime: moment().toDate(),
        handledId: id
      }
    });
  }

  function setState({correlationId, state}) {
    logger.log('info', `Setting queue-item state: ${correlationId}, ${state}`);
    const clean = sanitize(correlationId);
    return db.collection('queue-items').findOneAndUpdate({
      correlationId: clean
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
