/**
*
* @licstart  The following is the entire license notice for the JavaScript code in this file.
*
* Shared modules for microservices of Melinda rest api batch import system
*
* Copyright (C) 2020-2021 University Of Helsinki (The National Library Of Finland)
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

import {MongoClient, GridFSBucket, MongoDriverError} from 'mongodb';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {Error as ApiError} from '@natlibfi/melinda-commons';
import {QUEUE_ITEM_STATE, IMPORT_JOB_STATE} from './constants';
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
  "importJobState": {
    "CREATE": "PENDING",
    "UPDATE": "PENDING"
  },
  "creationTime":"2020-01-01T00:00:00.000Z",
  "modificationTime":"2020-01-01T00:00:01.000Z",
  "handledIds": []
}
*/

export default async function (MONGO_URI, collection) {
  const logger = createLogger();

  // Connect to mongo (MONGO)
  const client = await MongoClient.connect(MONGO_URI, {useNewUrlParser: true, useUnifiedTopology: true});
  const db = client.db('rest-api');
  const gridFSBucket = new GridFSBucket(db, {bucketName: collection});

  return {createPrio, createBulk, checkAndSetState, checkAndSetImportJobState, checkAndSetImportJobStates, query, queryById, remove, readContent, removeContent, getOne, getStream, setState, setImportJobState, pushIds, pushMessages, setOperation, setOperations};

  async function createPrio({correlationId, cataloger, oCatalogerIn, operation, noop = undefined, unique = undefined, merge = undefined, prio = true}) {
    const time = moment().toDate();
    const newQueueItem = {
      correlationId,
      cataloger,
      operation,
      operations: [operation],
      oCatalogerIn,
      operationSettings: {unique, noop, prio, merge, originalOperation: operation},
      queueItemState: QUEUE_ITEM_STATE.VALIDATOR.PENDING_VALIDATION,
      importJobState: {
        CREATE: IMPORT_JOB_STATE.EMPTY,
        UPDATE: IMPORT_JOB_STATE.EMPTY
      },
      creationTime: time,
      modificationTime: time,
      handledIds: [],
      rejectedIds: []
    };
    try {
      const result = await db.collection(collection).insertOne(newQueueItem);
      if (result.acknowledged) {
        logger.info(`New PRIO queue item for ${operation} ${correlationId} has been made in ${collection}`);
        return;
      }
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR);
    } catch (error) {
      logError(error);
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  async function createBulk({correlationId, cataloger, oCatalogerIn, operation, contentType, recordLoadParams, stream, prio = false}) {
    const time = moment().toDate();
    const newQueueItem = {
      correlationId,
      cataloger,
      oCatalogerIn,
      operation,
      operations: [operation],
      operationSettings: {prio, originalOperation: operation},
      contentType,
      recordLoadParams,
      queueItemState: stream ? QUEUE_ITEM_STATE.VALIDATOR.UPLOADING : QUEUE_ITEM_STATE.VALIDATOR.WAITING_FOR_RECORDS,
      importJobState: {
        CREATE: IMPORT_JOB_STATE.EMPTY,
        UPDATE: IMPORT_JOB_STATE.EMPTY
      },
      creationTime: time,
      modificationTime: time,
      handledIds: [],
      rejectedIds: []
    };

    // eslint-disable-next-line functional/no-conditional-statement
    if (stream) {
      try {
        // No await here, promises later
        db.collection(collection).insertOne(newQueueItem);
        logger.info(`New BULK queue item for ${operation} ${correlationId} has been made in ${collection}!`);
        return new Promise((resolve, reject) => {
          const outputStream = gridFSBucket.openUploadStream(correlationId);

          stream
            .on('error', reject)
            .on('data', chunk => outputStream.write(chunk))
            .on('end', () => outputStream.end(undefined, undefined, () => {
              resolve(correlationId);
            }));
        });
      } catch (error) {
        logError(error);
        throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR);
      }
    }

    logger.debug(`No stream`);
    // eslint-disable-next-line functional/no-conditional-statement
    if (!stream) {
      try {
        const result = await db.collection(collection).insertOne(newQueueItem);
        if (result.acknowledged) {
          logger.info(`New noStream BULK queue item for ${operation} ${correlationId} has been made in ${collection}`);
          return {correlationId, queueItemState: QUEUE_ITEM_STATE.VALIDATOR.WAITING_FOR_RECORDS};
        }
        throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR);
      } catch (error) {
        logError(error);
        throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR);
      }
    }
  }

  // Check state that the queueItem has not waited too long and set state
  async function checkAndSetState({correlationId, state, errorMessage = undefined, errorStatus = undefined}) {
    // checkTimeOut returns true, if queueItem is fresher than 1 minute and it's state is not ABORT/ERROR
    // otherwise it sets queueItem to state ABORT (408, 'Timeout')
    const timeOut = await checkTimeOut({correlationId});
    if (timeOut) {
      return setState({correlationId, state, errorMessage, errorStatus});
    }
    return false;
  }

  // Check state that the queueItem has not waited too long and set state
  async function checkAndSetImportJobState({correlationId, operation, importJobState, errorMessage = '', errorStatus = ''}) {
    // checkTimeOut returns true, if queueItem is fresher than 1 minute and it's state is not ABORT/ERROR
    // otherwise it sets queueItem to state ABORT (408, 'Timeout')
    const timeOut = await checkTimeOut({correlationId, operation, importJobState});
    if (timeOut) {
      return setImportJobState({correlationId, operation, importJobState, errorMessage, errorStatus});
    }
    return false;
  }

  // Check state that the queueItem has not waited too long and set state
  async function checkAndSetImportJobStates({correlationId, importJobState2}) {
    // checkTimeOut returns true, if queueItem is fresher than 1 minute and it's state is not ABORT/ERROR
    // otherwise it sets queueItem to state ABORT (408, 'Timeout')
    const timeOut = await checkTimeOut({correlationId, importJobState2});
    if (timeOut) {
      return setImportJobStates({correlationId, importJobState2});
    }
    return false;
  }


  async function query(params) {
    const result = await db.collection(collection).find(params, {projection: {_id: 0}})
      .toArray();
    logger.debug(`Query result: ${result.length > 0 ? 'Found!' : 'Not found!'}`);
    return result;
  }

  async function queryById({correlationId, checkModTime = false}) {
    const result = await db.collection(collection).findOne({correlationId});
    if (checkModTime) {
      const timeOut = await checkTimeOut({correlationId});
      if (timeOut) {
        return queryById({correlationId});
      }
      return result;
    }

    return result;
  }

  // Check that if the item has waited too long
  // If the last modification time for the queueItem is older than 1 minute
  // set state to ABORT and return false, otherwise return true
  // If the state is already ABORT or ERROR return false

  async function checkTimeOut({correlationId, operation, importJobState, importJobState2}) {
    const {modificationTime, queueitemState: oldState} = await db.collection(collection).findOne({correlationId});

    // should we check for DONE too?
    if ([QUEUE_ITEM_STATE.ABORT, QUEUE_ITEM_STATE.ERROR].includes(oldState)) {
      logger.silly(`${correlationId} has already state: ${oldState}`);
      return false;
    }

    const timeoutTime = moment(modificationTime).add(1, 'm');
    logger.silly(`timeOut @ ${timeoutTime}`);

    if (timeoutTime.isBefore()) {
      if (importJobState) {
        await setImportJobState({correlationId, operation, importJobState: IMPORT_JOB_STATE.ABORT});
        return false;
      }
      // importJobState2 = {"CREATE": "PENDING"};
      // -> newImportJobState = {"CREATE": "ABORT"}

      if (importJobState2) {
        const [importJobStateKey] = Object.keys(importJobState2);
        const newImportJobState2 = {[importJobStateKey]: IMPORT_JOB_STATE.ABORT};
        await setImportJobStates({correlationId, importJobState2: newImportJobState2});
        return false;
      }

      await setState({correlationId, state: QUEUE_ITEM_STATE.ABORT, errorStatus: httpStatus.REQUEST_TIMEOUT, errorMessage: `Timeout in ${oldState}`});
      return false;
    }

    return true;
  }

  async function remove(params) {
    logger.silly(`${JSON.stringify(params)}`);
    logger.info(`Removing from Mongo (${collection}) id: ${params.correlationId}`);
    const clean = sanitize(params.correlationId);
    logger.silly(`mongo/remove: clean: ${JSON.stringify(clean)}`);

    try {
      //const metadataResult = await getFileMetadata({filename: clean});
      //logger.debug(`mongo/remove: metadataResult: ${JSON.stringify(metadataResult)}`);
      const noContent = await removeContent(params);
      if (noContent) {
        await db.collection(collection).deleteOne({correlationId: clean});
        return true;
      }
    } catch (err) {
      if (err instanceof MongoDriverError) {
        if (err.message.indexOf('File not found for id') !== -1) {
          logger.silly(`mongo/remove: File not found, removing queueItem ${JSON.stringify(clean)} from ${collection}`);
          await db.collection(collection).deleteOne({correlationId: clean});
          return true;
        }
        logger.error(err.message);
        throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, err.message);
      }
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, err.message);
    }
  }

  async function readContent(correlationId) {
    logger.info(`Reading content from mongo for id: ${correlationId} in ${collection}`);
    const clean = sanitize(correlationId);
    const result = await db.collection(collection).findOne({correlationId: clean}); // njsscan-ignore: node_nosqli_injection

    if (result) {
      return {
        contentType: result.contentType,
        readStream: gridFSBucket.openDownloadStreamByName(clean)
      };
    }

    throw new ApiError(httpStatus.NOT_FOUND);
  }

  async function removeContent(params) {
    logger.info(`Removing content from mongo for id: ${params.correlationId} in ${collection}`);
    const clean = sanitize(params.correlationId);

    const result = await db.collection(collection).findOne({correlationId: clean}); // njsscan-ignore: node_nosqli_injection
    logger.silly(`mongo/removeContent: result ${JSON.stringify(result)}`);

    if (result) {
      await gridFSBucket.delete(clean);
      return true;
    }

    return true;
  }

  // eslint-disable-next-line max-statements
  function getOne({queueItemState, operation = undefined, importOperation = undefined, importJobState = undefined}) {

    // logger.debug(`Getting queueItem for ${operation ? `${operation},` : ''} queueItemState: ${queueItemState} ${importOperation ? `, importOperation: ${importOperation}` : ''} ${importJobState ? `, importJobState: ${importJobState}` : ''}`);

    const cleanOperation = operation ? {operation: sanitize(operation)} : undefined;
    const cleanQueueItemState = queueItemState ? {queueItemState: sanitize(queueItemState)} : undefined;
    const cleanImportJobState = importJobState ? sanitize(importJobState) : undefined;

    const importJobStateForFind = importOperation === 'CREATE' ? {createImportJobState: cleanImportJobState} : {updateImportJobState: cleanImportJobState};

    logger.silly(`importJobStateForFind: ${JSON.stringify(importJobStateForFind)}`);

    try {

      // Just queueItemState
      if (queueItemState && operation === undefined && importJobState === undefined) {
        logger.silly(`Checking DB ${collection} for just ${JSON.stringify(cleanQueueItemState.queueItemState)}`);
        return db.collection(collection).findOne({...cleanQueueItemState});
      }

      // queueItemState and operation
      if (queueItemState && operation && importJobState === undefined) {
        logger.silly(`Checking DB ${collection} for ${cleanQueueItemState.queueItemState} + ${cleanOperation.operation}`);
        return db.collection(collection).findOne({...cleanQueueItemState, ...cleanOperation});
      }

      // importJobState (and importOperation to choose the between updateImportJobState and createImportJobState)
      if (importJobState && importOperation && queueItemState === undefined) {
        logger.silly(`Checking DB ${collection} for ${importOperation}: ${JSON.stringify(importJobStateForFind)}`);
        return db.collection(collection).findOne({...importJobStateForFind});
      }

      // All three parameters
      if (importJobState && importOperation && queueItemState) {
        logger.silly(`Checking DB ${collection} for ${queueItemState} and ${operation} ${JSON.stringify(importJobStateForFind)}`);
        return db.collection(collection).findOne({...cleanQueueItemState, ...importJobStateForFind});
      }

      logger.debug(`getOne not working!`);
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Missing parameters, cannot get queueItem');

    } catch (error) {
      logError(error);
    }
  }

  function getStream(correlationId) {
    logger.info(`Forming stream from mongo for ${correlationId} in ${collection}`);
    const clean = sanitize(correlationId);
    try {
      // Return content stream
      return gridFSBucket.openDownloadStreamByName(clean);
    } catch (error) {
      logError(error);
    }
  }

  async function pushIds({correlationId, handledIds, rejectedIds}) {
    logger.verbose(`Push ids (${handledIds.length}) and rejectedIds (${rejectedIds.length}) ${correlationId} to ${collection}`);
    logger.debug(`ids (${handledIds.length}): ${JSON.stringify(handledIds)}, rejectedIds ${rejectedIds.length}: ${JSON.stringify(rejectedIds)}`);
    const clean = sanitize(correlationId);
    await db.collection(collection).updateOne({
      correlationId: clean
    }, {
      $set: {
        modificationTime: moment().toDate()
      },
      $push: {
        handledIds: {$each: handledIds},
        rejectedIds: {$each: rejectedIds}
      }
    });
  }

  async function pushMessages({correlationId, messages, messageField = 'messages'}) {
    logger.verbose(`Push messages (${messages.length}) to ${messageField} ${correlationId} to ${collection}`);
    logger.silly(`Messages (${messages.length}): ${JSON.stringify(messages)}}`);
    const clean = sanitize(correlationId);
    const cleanMessageField = sanitize(messageField);
    await db.collection(collection).updateOne({
      correlationId: clean
    }, {
      $set: {
        modificationTime: moment().toDate()
      },
      $push: {
        [cleanMessageField]: {$each: messages}
      }
    });
  }

  function setState({correlationId, state, errorMessage = undefined, errorStatus = undefined}) {
    const errorString = errorMessage || errorStatus ? `, Error message: '${errorMessage || ''}', Error status: '${errorStatus || ''}'` : '';
    logger.info(`Setting queue-item state ${state} for ${correlationId}${errorString} to ${collection}`);

    const stateInQueueItemStates = Object.values(QUEUE_ITEM_STATE).indexOf(state) > -1;
    const stateInQueueItemStatesValidator = Object.values(QUEUE_ITEM_STATE.VALIDATOR).indexOf(state) > -1;
    const stateInQueueItemStatesImporter = Object.values(QUEUE_ITEM_STATE.IMPORTER).indexOf(state) > -1;
    if (!stateInQueueItemStates && !stateInQueueItemStatesValidator && !stateInQueueItemStatesImporter) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Trying to set invalid state');
    }

    const clean = sanitize(correlationId);
    const updateValues = {
      queueItemState: state,
      modificationTime: moment().toDate(),
      errorMessage,
      errorStatus
    };

    // Do not update value that are undefined
    // eslint-disable-next-line functional/immutable-data
    Object.keys(updateValues).forEach(key => updateValues[key] === undefined && delete updateValues[key]);

    return db.collection(collection)
      .findOneAndUpdate(
        {correlationId: clean},
        {$set: updateValues},
        {projection: {_id: 0}, returnNewDocument: true}
      );
  }

  function setImportJobState({correlationId, operation, importJobState}) {
    logger.info(`Setting queue-item importJobState ${operation}.${importJobState} for ${correlationId}`);
    const cleanCorrelationId = sanitize(correlationId);
    const cleanImportJobState = sanitize(importJobState);

    const importJobStateForSet = operation === 'CREATE' ? 'createImportJobState' : 'updateImportJobState';

    return db.collection(collection).findOneAndUpdate({
      correlationId: cleanCorrelationId
    }, {
      $set: {
        [importJobStateForSet]: cleanImportJobState,
        modificationTime: moment().toDate()
      }
    }, {projection: {_id: 0}, returnNewDocument: true});
  }


  async function setImportJobStates({correlationId, importJobState2}) {
    // importJobState2 = {"CREATE": "DONE"}

    logger.info(`Setting queue-item importJobState ${importJobState2} for ${correlationId}`);
    const cleanCorrelationId = sanitize(correlationId);
    const {importJobState: oldImportJobState} = await db.collection(collection).findOne({correlationId});
    const newImportJobState = {importJobState2, ...oldImportJobState};
    logger.debug(`oldImportJobState: ${oldImportJobState}, newImportJobState: ${newImportJobState}`);

    return db.collection(collection).findOneAndUpdate({
      correlationId: cleanCorrelationId
    }, {
      $set: {
        importJobStates: newImportJobState,
        modificationTime: moment().toDate()
      }
    }, {projection: {_id: 0}, returnNewDocument: true});
  }

  async function setOperation({correlationId, operation}) {
    const newOperation = operation;
    const {operation: oldOperation} = await db.collection(collection).findOne({correlationId});
    logger.info(`Setting queue-item operation from ${oldOperation} to ${newOperation} for ${correlationId} to ${collection}`);
    const cleanCorrelationId = sanitize(correlationId);
    const cleanNewOperation = sanitize(newOperation);

    const result = await db.collection(collection).findOneAndUpdate({
      correlationId: cleanCorrelationId
    }, {
      $set: {
        operation: cleanNewOperation,
        modificationTime: moment().toDate()
      }
    }, {projection: {_id: 0}, returnNewDocument: true});

    return result.ok;
    // logger.debug(JSON.stringify(result));
  }

  async function setOperations({correlationId, addOperation, removeOperation = undefined}) {
    const cleanCorrelationId = sanitize(correlationId);

    //logger.info(`Setting queue-item operation from ${JSON.stringify(oldOperations)} by adding ${addOperation} and removing ${removeOperation} for ${correlationId} to ${collection}`);

    const queueItem = await db.collection(collection).findOne({correlationId: cleanCorrelationId});
    logger.debug(`We fould a queueItem: ${JSON.stringify(queueItem)}`);

    const oldOperations = queueItem.operations;

    logger.info(`Setting queue-item operation from ${JSON.stringify(oldOperations)} by adding ${addOperation} and removing ${removeOperation} for ${correlationId} to ${collection}`);

    const operationsAfterRemove = oldOperations.filter(operation => operation !== removeOperation);
    const operationsAfterRemoveAndAdd = [addOperation, ...operationsAfterRemove];

    const result = await db.collection(collection).findOneAndUpdate({
      correlationId: cleanCorrelationId
    }, {
      $set: {
        operations: operationsAfterRemoveAndAdd,
        modificationTime: moment().toDate()
      }
    }, {projection: {_id: 0}, returnNewDocument: true});

    return result.ok;
    // logger.debug(JSON.stringify(result));
  }
}
