/* eslint-disable max-lines */


import {MongoClient, GridFSBucket, MongoDriverError} from 'mongodb';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {Error as ApiError} from '@natlibfi/melinda-commons';
import {QUEUE_ITEM_STATE, IMPORT_JOB_STATE, OPERATIONS} from './constants';
import {logError} from './utils.js';
import moment from 'moment';
import httpStatus from 'http-status';
import sanitize from 'mongo-sanitize';
import createDebugLogger from 'debug';

//import isDeepStrictEqual from 'util';

/* QueueItem:
{
  "correlationId":"FOO",
  "cataloger":"xxx0000",
  "oCatalogerIn":"xxx0000"
  "operation":"UPDATE",
  "operations":["UPDATE", "CREATE"]
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
    "CREATE": "EMPTY",
    "UPDATE": "EMPTY"
  },
  blobSize: 1,
  records: [],
  errorMessage: '',
  errorStatus: '',
  "creationTime":"2020-01-01T00:00:00.000Z",
  "modificationTime":"2020-01-01T00:00:01.000Z",
}
*/

export default async function (MONGO_URI, collection, db = 'rest-api', test = false) {
  const logger = createLogger();
  const debug = createDebugLogger('@natlibfi/melinda-rest-api-commons/mongo');
  const debugDev = debug.extend(':dev');

  // Connect to mongo (MONGO)
  const client = await MongoClient.connect(MONGO_URI);
  const dbConnection = client.db(db);
  const gridFSBucket = new GridFSBucket(dbConnection, {bucketName: collection});
  const operator = dbConnection.collection(collection);
  debugDev(`mongo: ${MONGO_URI}, db: ${db}, collection: ${collection}, test: ${test}`);

  if (test) {
    // return also internal functions if testing
    return {createPrio, createBulk, checkAndSetState, checkAndSetImportJobState, query, createProjection, queryById, checkTimeOut, remove, readContent, removeContent, getOne, getStream, setState, setImportJobState, pushIds, pushMessages, setOperation, setOperations, addBlobSize, setBlobSize};
  }
  return {createPrio, createBulk, checkAndSetState, checkAndSetImportJobState, query, queryById, remove, readContent, removeContent, getOne, getStream, setState, setImportJobState, pushIds, pushMessages, setOperation, setOperations, addBlobSize, setBlobSize};

  async function createPrio({correlationId, cataloger, oCatalogerIn, operation, operationSettings}) {
    debugDev('createPrio');
    const time = moment().toDate();
    const newQueueItem = {
      correlationId,
      cataloger,
      operation,
      operations: [operation],
      oCatalogerIn,
      operationSettings: {
        prio: true,
        ...operationSettings
      },
      queueItemState: QUEUE_ITEM_STATE.VALIDATOR.PENDING_VALIDATION,
      blobSize: 1,
      importJobState: {
        CREATE: IMPORT_JOB_STATE.EMPTY,
        UPDATE: IMPORT_JOB_STATE.EMPTY,
        FIX: IMPORT_JOB_STATE.EMPTY
      },
      records: [],
      errorMessage: '',
      errorStatus: '',
      creationTime: time,
      modificationTime: time
    };
    try {
      debugDev(`Inserting: ${JSON.stringify(newQueueItem)} to ${collection}}`);
      const result = await operator.insertOne(newQueueItem);
      debugDev(JSON.stringify(result));
      if (result.acknowledged) {
        logger.info(`New PRIO queue item for ${operation} ${correlationId} has been made in ${collection}`);
        return;
      }
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR);
    } catch (error) {
      const errorMessage = error.payload || error.message || '';
      logError(error);
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Mongo errored: ${errorMessage}`);
    }
  }

  // eslint-disable-next-line max-statements
  async function createBulk({correlationId, cataloger, oCatalogerIn, operation, contentType, recordLoadParams, stream, operationSettings}) {
    const time = moment().toDate();
    const newQueueItem = {
      correlationId,
      cataloger,
      oCatalogerIn,
      operation,
      operations: [operation],
      operationSettings: {
        prio: false,
        ...operationSettings
      },
      contentType,
      recordLoadParams,
      queueItemState: stream ? QUEUE_ITEM_STATE.VALIDATOR.UPLOADING : QUEUE_ITEM_STATE.VALIDATOR.WAITING_FOR_RECORDS,
      blobSize: 0,
      importJobState: {
        CREATE: IMPORT_JOB_STATE.EMPTY,
        UPDATE: IMPORT_JOB_STATE.EMPTY,
        FIX: IMPORT_JOB_STATE.EMPTY
      },
      records: [],
      errorMessage: '',
      errorStatus: '',
      creationTime: time,
      modificationTime: time
    };

    // eslint-disable-next-line functional/no-conditional-statements
    if (stream) {
      try {
        await new Promise((resolve, reject) => {
          const outputStream = gridFSBucket.openUploadStream(correlationId);

          stream
            .on('error', reject)
            .on('data', chunk => outputStream.write(chunk))
            .on('end', () => outputStream.end(undefined, undefined, () => {
              resolve(correlationId);
            }));
        });
        logger.info(`New BULK queue item for ${operation} ${correlationId} has been made in ${collection}!`);
        return operator.insertOne(newQueueItem);
      } catch (error) {
        const errorMessage = error.payload || error.message || '';
        logError(error);
        throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Mongo errored: ${errorMessage}`);
      }
    }

    logger.debug(`No stream`);
    // eslint-disable-next-line functional/no-conditional-statements
    if (!stream) {
      try {
        const result = await operator.insertOne(newQueueItem);
        if (result.acknowledged) {
          logger.info(`New noStream BULK queue item for ${operation} ${correlationId} has been made in ${collection}`);
          return {correlationId, queueItemState: QUEUE_ITEM_STATE.VALIDATOR.WAITING_FOR_RECORDS};
        }
        throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR);
      } catch (error) {
        const errorMessage = error.payload || error.message || '';
        logError(error);
        throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Montestgo errored: ${errorMessage}`);
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
    logger.debug(`${correlationId}, ${importJobState}, ${operation}`);
    const timeOut = await checkTimeOut({correlationId, operation, importJobState});
    if (timeOut) {
      return setImportJobState({correlationId, operation, importJobState, errorMessage, errorStatus});
    }
    return false;
  }

  async function query(params, showParams = {}) {
    logger.debug(`Querying: ${JSON.stringify(params)}, ${JSON.stringify(showParams)}`);
    const {limit = 1000, skip = 0, ...rest} = params;

    const result = await operator.find(rest, {projection: createProjection(showParams)})
      .limit(parseInt(limit, 10))
      .skip(parseInt(skip, 10))
      .toArray();
    logger.debug(`Query result: ${result.length > 0 ? 'Found!' : 'Not found!'}`);
    logger.silly(`${JSON.stringify(result)}`);
    return result;
  }

  // We default to NOT showing operations, operationSettings, recordLoadParams and importJobState when a queueItem is queried
  // These can all be shown with showAll
  // Single fields can be shown by showOperation, showOperationSettings, showRecordLoadParams and showImportJobState

  function createProjection(showParams = {}) {
    logger.silly(`Creating projection for query: ${JSON.stringify(showParams)}`);
    const {showAll = 0, showOperations = 0, showOperationSettings = 0, showRecordLoadParams = 0, showImportJobState = 0} = showParams;
    logger.debug(`showAll: ${showAll}, showOperations: ${showOperations}, showOperationSettings: ${showOperationSettings}, showRecordLoadParams: ${showRecordLoadParams}, showImportJobState: ${showImportJobState}`);

    if (showAll) {
      return {
        _id: 0
      };
    }

    const showParamToField = {
      'showOperations': 'operations',
      'showOperationSettings': 'operationSettings',
      'showRecordLoadParams': 'recordLoadParams',
      'showImportJobState': 'importJobState'
    };

    const result = Object.keys(showParams)
      .filter(param => param !== 'showAll' && showParams[param] !== true && showParams[param] !== 1)
      .filter(param => showParamToField[param])
      .map((param) => showParamToField[param]);
    logger.silly(`We want to exclude from projection: ${JSON.stringify(result)}`);

    const excludeObject = Object.fromEntries(result.map(param => [param, 0]));
    logger.silly(`We want to exclude from projection: ${JSON.stringify(excludeObject)}`);

    return {
      _id: 0,
      ...excludeObject
    };
  }

  async function queryById({correlationId, checkModTime = false}) {
    const result = await operator.findOne({correlationId});
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
  // If the state is already ABORT or ERROR or DONE return false

  async function checkTimeOut({correlationId}) {
    const {modificationTime, queueItemState: oldState, importJobState} = await operator.findOne({correlationId});
    //debug(`${modificationTime} - oldState: ${oldState}`);
    // should we check for DONE too?
    if ([QUEUE_ITEM_STATE.ABORT, QUEUE_ITEM_STATE.ERROR, QUEUE_ITEM_STATE.DONE].includes(oldState)) {
      logger.silly(`${correlationId} has already state: ${oldState}`);
      return false;
    }

    debug(`test: ${test}`);

    const timeoutTime = moment(modificationTime).add(1, 'm');
    logger.silly(`${correlationId} timeOut @ ${timeoutTime}`);

    if (timeoutTime.isBefore()) {
      const finalImportJobStates = [IMPORT_JOB_STATE.ABORT, IMPORT_JOB_STATE.DONE, IMPORT_JOB_STATE.EMPTY, IMPORT_JOB_STATE.ERROR];
      if (!finalImportJobStates.includes(importJobState.CREATE)) { // eslint-disable-line
        await setImportJobState({correlationId, operation: 'CREATE', importJobState: IMPORT_JOB_STATE.ABORT});
      }

      if (!finalImportJobStates.includes(importJobState.UPDATE)) { // eslint-disable-line
        await setImportJobState({correlationId, operation: 'UPDATE', importJobState: IMPORT_JOB_STATE.ABORT});
      }

      if (!finalImportJobStates.includes(importJobState.FIX)) { // eslint-disable-line
        await setImportJobState({correlationId, operation: 'FIX', importJobState: IMPORT_JOB_STATE.ABORT});
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
        await operator.deleteOne({correlationId: clean});
        return true;
      }
    } catch (err) {
      if (err instanceof MongoDriverError) {
        if (err.message.indexOf('File not found for id') !== -1) {
          logger.silly(`mongo/remove: File not found, removing queueItem ${JSON.stringify(clean)} from ${collection}`);
          await operator.deleteOne({correlationId: clean});
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
    const result = await operator.findOne({correlationId: clean}); // njsscan-ignore: node_nosqli_injection

    if (result) {
      const {operationSettings} = result;
      if (operationSettings.prio === false && operationSettings.noStream === false) {
        return {
          contentType: result.contentType,
          readStream: gridFSBucket.openDownloadStreamByName(clean)
        };
      }
      logger.debug(`OperationSettings for ${correlationId}: ${JSON.stringify(operationSettings)}`);
      throw new ApiError(httpStatus.BAD_REQUEST, {message: `Content is only available for streamBulk jobs. ${correlationId} is not a streamBulk job.`});
    }

    throw new ApiError(httpStatus.NOT_FOUND, {message: `Job ${correlationId} not found.`});
  }

  async function removeContent(params) {
    logger.info(`Removing content from mongo for id: ${params.correlationId} in ${collection}`);
    const clean = sanitize(params.correlationId);

    const result = await operator.findOne({correlationId: clean}); // njsscan-ignore: node_nosqli_injection
    logger.silly(`mongo/removeContent: result ${JSON.stringify(result)}`);

    if (result) {
      await gridFSBucket.delete(clean);
      return true;
    }

    return true;
  }

  function getOne({queueItemState, importJobState = undefined}) {
    //params example: "queueItemState": "IMPORTER.IN_QUEUE", "importJobState":{"importJobState.UPDATE": "IN_QUEUE"}
    logger.silly(`queueItemState: ${queueItemState}, importJobState: ${JSON.stringify(importJobState)}`);
    //debug(`queueItemState: ${queueItemState}, importJobState: ${JSON.stringify(importJobState)}`);
    const cleanQueueItemState = queueItemState ? {queueItemState: sanitize(queueItemState)} : undefined;
    const options = {projection: {_id: 0}};

    try {

      // Just queueItemState
      if (queueItemState && importJobState === undefined) {
        logger.silly(`Checking DB ${collection} for just ${JSON.stringify(cleanQueueItemState.queueItemState)}`);
        //debug(`Checking DB ${collection} for just ${JSON.stringify(cleanQueueItemState.queueItemState)}`);
        return operator.findOne({...cleanQueueItemState}, options);
      }

      // importJobState
      if (importJobState && queueItemState === undefined) {
        logger.silly(`Checking DB ${collection} for ${JSON.stringify(importJobState)}`);
        //debug(`Checking DB ${collection} for ${JSON.stringify(importJobState)}`);
        return operator.findOne({...importJobState}, options);
      }

      // importJobState and queueItemState
      if (importJobState && queueItemState) {
        logger.silly(`Checking DB ${collection} for ${queueItemState} and ${JSON.stringify(importJobState)}`);
        //debug(`Checking DB ${collection} for ${queueItemState} and ${JSON.stringify(importJobState)}`);
        return operator.findOne({...cleanQueueItemState, ...importJobState}, options);
      }

      logger.debug(`getOne not working!`);
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Missing parameters, cannot get queueItem');

    } catch (error) {
      const errorMessage = error.payload || error.message || '';
      logError(error);
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Mongo errored: ${errorMessage}`);
    }
  }

  function getStream(correlationId) {
    logger.info(`Forming stream from mongo for ${correlationId} in ${collection}`);
    const clean = sanitize(correlationId);
    try {
      // Return content stream
      return gridFSBucket.openDownloadStreamByName(clean);
    } catch (error) {
      const errorMessage = error.payload || error.message || '';
      logError(error);
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Mongo errored: ${errorMessage}`);
    }
  }

  async function pushIds({correlationId, handledIds, rejectedIds}) {
    logger.verbose(`Push ids (${handledIds.length}) and rejectedIds (${rejectedIds.length}) ${correlationId} to ${collection}`);
    logger.debug(`ids (${handledIds.length}): ${JSON.stringify(handledIds)}, rejectedIds ${rejectedIds.length}: ${JSON.stringify(rejectedIds)}`);
    const clean = sanitize(correlationId);
    await operator.updateOne({
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
    debug(`${messageField} -> ${cleanMessageField}`);
    await operator.updateOne({
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
    const errorString = errorMessage || errorStatus ? `, Error message: '${JSON.stringify(errorMessage) || ''}', Error status: '${errorStatus || ''}'` : '';
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

    return operator
      .findOneAndUpdate(
        {correlationId: clean},
        {$set: updateValues},
        {projection: {_id: 0}, returnDocument: 'after'}
      );
  }

  function setImportJobState({correlationId, operation, importJobState}) {

    // should this also get importJobState as previously created object? {}
    logger.info(`Setting queue-item importJobState: {${operation}: ${importJobState}} for ${correlationId}`);
    const cleanCorrelationId = sanitize(correlationId);
    const cleanImportJobState = sanitize(importJobState);

    if (!(operation in OPERATIONS)) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid operation for import job state');
    }

    if (!(cleanImportJobState in IMPORT_JOB_STATE)) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid import job state');
    }

    const newJobState = getNewJobState(operation, cleanImportJobState);


    function getNewJobState(operation, cleanImportJobState) {
      if (operation === OPERATIONS.CREATE) {
        return {'importJobState.CREATE': cleanImportJobState};
      }
      if (operation === OPERATIONS.UPDATE) {
        return {'importJobState.UPDATE': cleanImportJobState};
      }
      if (operation === OPERATIONS.FIX) {
        return {'importJobState.FIX': cleanImportJobState};
      }
      throw new ApiError('400', 'Invalid operation for import job state');
    }

    return operator.findOneAndUpdate({
      correlationId: cleanCorrelationId
    }, {
      $set: {
        ...newJobState,
        modificationTime: moment().toDate()
      }
    }, {projection: {_id: 0}, returnDocument: 'after'});
  }

  async function setOperation({correlationId, operation}) {
    const newOperation = operation;
    const {operation: oldOperation} = await operator.findOne({correlationId});
    logger.info(`Setting queue-item operation from ${oldOperation} to ${newOperation} for ${correlationId} to ${collection}`);
    const cleanCorrelationId = sanitize(correlationId);
    const cleanNewOperation = sanitize(newOperation);

    const result = await operator.findOneAndUpdate({
      correlationId: cleanCorrelationId
    }, {
      $set: {
        operation: cleanNewOperation,
        modificationTime: moment().toDate()
      }
    }, {projection: {_id: 0}, returnDocument: 'after'});
    debugDev(`${JSON.stringify(result)}`);
    return result.ok || result;
    // logger.debug(JSON.stringify(result));
  }

  async function setOperations({correlationId, addOperation, removeOperation = undefined}) {
    const cleanCorrelationId = sanitize(correlationId);

    const queueItem = await operator.findOne({correlationId: cleanCorrelationId});
    logger.silly(`We found a queueItem: ${JSON.stringify(queueItem)}`);

    const oldOperations = queueItem.operations;

    logger.info(`Setting queue-item operations from ${JSON.stringify(oldOperations)} by adding ${addOperation} and removing ${removeOperation} for ${correlationId} to ${collection}`);

    const operationsAfterRemove = oldOperations.filter(operation => operation !== removeOperation);
    const operationsAfterRemoveAndAdd = operationsAfterRemove.includes(addOperation) ? operationsAfterRemove : [...operationsAfterRemove, addOperation];

    logger.silly(`operationsAfterRemove: ${operationsAfterRemove}`);
    logger.silly(`operationAfterRemoveAndAdd: ${operationsAfterRemoveAndAdd}`);

    const result = await operator.findOneAndUpdate({
      correlationId: cleanCorrelationId
    }, {
      $set: {
        operations: operationsAfterRemoveAndAdd,
        modificationTime: moment().toDate()
      }
    }, {projection: {_id: 0}, returnDocument: 'after'});
    debugDev(`${JSON.stringify(result)}`);
    return result.ok || result;
    // logger.debug(JSON.stringify(result));
  }

  async function addBlobSize({correlationId}) {
    const cleanCorrelationId = sanitize(correlationId);

    const result = await operator.findOneAndUpdate({
      correlationId: cleanCorrelationId,
      queueItemState: QUEUE_ITEM_STATE.VALIDATOR.WAITING_FOR_RECORDS
    }, {
      $inc: {
        blobSize: 1
      },
      $set: {
        modificationTime: moment().toDate()
      }
    }, {projection: {_id: 0}, returnDocument: 'after'});

    logger.verbose(`AddBlobSizeResult in mongo: ${JSON.stringify(result)}`);
    debugDev(`${JSON.stringify(result)}`);
    return result;
  }

  async function setBlobSize({correlationId, blobSize}) {
    const cleanCorrelationId = sanitize(correlationId);
    const cleanBlobSize = sanitize(blobSize);

    const result = await operator.findOneAndUpdate({
      correlationId: cleanCorrelationId
    }, {
      $set: {
        blobSize: cleanBlobSize,
        modificationTime: moment().toDate()
      }
    }, {projection: {_id: 0}, returnDocument: 'after'});

    logger.verbose(`SetBlobSizeResult in mongo: ${JSON.stringify(result)}`);
    debugDev(`${JSON.stringify(result)}`);
    return result;
  }

}
