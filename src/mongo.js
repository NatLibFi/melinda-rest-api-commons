/* eslint-disable max-lines */

import {MongoClient, GridFSBucket, MongoDriverError} from 'mongodb';
import httpStatus from 'http-status';
import createDebugLogger from 'debug';
import {createLogger, Error as ApiError, parseBoolean} from '@natlibfi/melinda-commons';
import {QUEUE_ITEM_STATE, IMPORT_JOB_STATE, OPERATIONS} from './constants.js';
import {logError, assertString, assertNumber, assertImportJobStateFilter} from './utils.js';

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

export default async function (MONGO_URI, collection, db = 'rest-api', deps = {}) {
  const logger = createLogger();
  // the checkTimeOut "no progress" window used to be a hardcoded
  // 1 minute, which is too short for large bulk imports (README benchmark:
  // ~9248 records can take ~10 minutes). Now configurable via the
  // MONGO_TIMEOUT_MINUTES env var (default: 1 minute). Each importer chunk
  // that writes (pushMessages / pushIds / setImportJobState / addBlobSize /
  // setBlobSize / setState ...) refreshes modificationTime, so the timeout
  // only triggers when there is genuinely no progress.
  const timeoutMinutes = Number.parseInt(process.env.MONGO_TIMEOUT_MINUTES, 10) || 1;
  logger.debug(`checkTimeOut window: ${timeoutMinutes} minute(s) (override with MONGO_TIMEOUT_MINUTES)`);
  const debug = createDebugLogger('@natlibfi/melinda-rest-api-commons/mongo');
  const debugDev = debug.extend(':dev');

  // Connect to mongo (MONGO), unless operator and gridFSBucket are both
  // injected via deps (used by unit tests to avoid a real connection)
  const stubbed = Boolean(deps.operator) && Boolean(deps.gridFSBucket);
  let gridFSBucket = deps.gridFSBucket;
  let operator = deps.operator;
  if (!stubbed) {
    const client = await MongoClient.connect(MONGO_URI);
    const realDb = client.db(db);
    gridFSBucket = gridFSBucket ?? new GridFSBucket(realDb, {bucketName: collection});
    operator = operator ?? realDb.collection(collection);
  }
  debugDev(`mongo: ${MONGO_URI}, db: ${db}, collection: ${collection}`);

  return {createPrio, createBulk, checkAndSetState, checkAndSetImportJobState, query, createProjection, queryById, checkTimeOut, remove, readContent, removeContent, getOne, getStream, setState, setImportJobState, pushIds, pushMessages, setOperation, setOperations, addBlobSize, setBlobSize};

  async function createPrio({correlationId, cataloger, oCatalogerIn, operation, operationSettings}) {
    debugDev('createPrio');
    const time = new Date();
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
      // TEST-COVERAGE: this error is not (currently) tested
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR);
    } catch (error) {
      // TEST-COVERAGE: this error is not (currently) tested
      const errorMessage = error.payload || error.message || '';
      logError(error);
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Mongo errored: ${errorMessage}`);
    }
  }

  async function createBulk({correlationId, cataloger, oCatalogerIn, operation, contentType, recordLoadParams, stream, operationSettings}) {
    const time = new Date();
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

    if (stream) {
      debug(`Creating streamBulk`);
      try {
        // NOTE: on success this returns the SAME normalized shape as
        // the no-stream path below: {correlationId, acknowledged, queueItemState}
        await new Promise((resolve, reject) => {
          const outputStream = gridFSBucket.openUploadStream(correlationId);

          // an upload stream error used to hang the promise forever
          // (no error handler on outputStream) -> wire it to reject
          outputStream.on('error', (error) => {
            outputStream.destroy();
            reject(error);
          });

          stream
            .on('error', (error) => {
              // input failed mid-upload -> abort, do not leave the
              // partial GridFS upload stream running
              outputStream.destroy();
              reject(error);
            })
            .on('data', chunk => outputStream.write(chunk))
            .on('end', () => outputStream.end(undefined, undefined, () => {
              resolve(correlationId);
            }));
        });
        logger.info(`New BULK queue item for ${operation} ${correlationId} has been made in ${collection}!`);
        debug(`New BULK queue item for ${operation} ${correlationId} has been made in ${collection}!`);
        const result = await operator.insertOne(newQueueItem);
        if (!result.acknowledged) {
          // TEST-COVERAGE: this error is not (currently) tested
          throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR);
        }
        // normalize the return shape to the same one the no-stream
        // path returns - do not leak the driver InsertOneResult
        return {correlationId, acknowledged: result.acknowledged, queueItemState: newQueueItem.queueItemState};
      } catch (error) {
        const errorMessage = error.payload || error.message || '';
        logError(error);
        // best-effort cleanup of a partial GridFS file
        await removePartialContent(correlationId);
        throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Mongo errored: ${errorMessage}`);
      }
    }

    async function removePartialContent(correlationId) {
      try {
        const files = await gridFSBucket.find({filename: correlationId}).toArray();
        for (const file of files) {
          await gridFSBucket.delete(file._id);
          logger.debug(`mongo/createBulk: removed partial GridFS file for ${correlationId}`);
        }
      } catch (cleanupError) {
        logger.debug(`mongo/createBulk: partial GridFS cleanup failed for ${correlationId}: ${cleanupError.message}`);
      }
    }

    logger.debug(`No stream`);
    debug(`Creating noStreamBulk`);
    if (!stream) {
      try {
        const result = await operator.insertOne(newQueueItem);
        if (result.acknowledged) {
          logger.info(`New noStream BULK queue item for ${operation} ${correlationId} has been made in ${collection}`);
          debug(`New noStream BULK queue item for ${operation} ${correlationId} has been made in ${collection}`);
          // same normalized shape as the stream path above
          return {correlationId, acknowledged: result.acknowledged, queueItemState: QUEUE_ITEM_STATE.VALIDATOR.WAITING_FOR_RECORDS};
        }
        // TEST-COVERAGE: this error is not (currently) tested
        throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR);
      } catch (error) {
        // TEST-COVERAGE: this error is not (currently) tested
        const errorMessage = error.payload || error.message || '';
        logError(error);
        throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Mongo errored: ${errorMessage}`);
      }
    }
  }

  // Check state that the queueItem has not waited too long and set state
  // Optionally set also queueItems errorStatus & errorMessage
  //
  // returns a discriminated result instead of a bare boolean so
  // callers can tell the three outcomes apart:
  //   {status: 'updated',   queueItem}  - state was set
  //   {status: 'timeout',   queueItem}  - item was aborted by checkTimeOut
  //   {status: 'unchanged', queueItem}  - state was ABORT/ERROR/DONE already,
  //                                       or the item no longer exists
  async function checkAndSetState({correlationId, state, errorMessage = undefined, errorStatus = undefined}) {
    assertString(correlationId, 'correlationId');
    // checkTimeOut returns true, if queueItem is fresher than the configured
    // timeout window and it's state is not ABORT/ERROR/DONE
    // otherwise it sets queueItem and importJobStates to state ABORT and add errorStatus and errorMessage (408, 'Timeout')
    const timeOut = await checkTimeOut({correlationId});
    if (timeOut) {
      const queueItem = await setState({correlationId, state, errorMessage, errorStatus});
      return {status: 'updated', queueItem};
    }
    // Read the current item so the caller can tell "aborted by timeout"
    // apart from "unchanged" and see the resulting document
    const queueItem = await operator.findOne({correlationId}, {projection: {_id: 0}});
    const status = queueItem && queueItem.queueItemState === QUEUE_ITEM_STATE.ABORT ? 'timeout' : 'unchanged';
    return {status, queueItem};
  }

  // Check state that the queueItem has not waited too long and set importJobState
  // Note: checkAndSetImportJobState cannot be used to set queueItems errorStatus & errorMessage (expect in case of a TimeOut)
  //
  // returns a discriminated result, see checkAndSetState
  async function checkAndSetImportJobState({correlationId, operation, importJobState}) {
    assertString(correlationId, 'correlationId');
    // checkTimeOut returns true, if queueItem is fresher than the configured
    // timeout window and it's state is not ABORT/ERROR/DONE
    // otherwise it sets queueItem and importJobStates to state ABORT and errorStatue and errorMessage (408, 'Timeout')
    logger.debug(`${correlationId}, ${importJobState}, ${operation}`);
    const timeOut = await checkTimeOut({correlationId, operation, importJobState});
    if (timeOut) {
      const queueItem = await setImportJobState({correlationId, operation, importJobState});
      return {status: 'updated', queueItem};
    }
    const queueItem = await operator.findOne({correlationId}, {projection: {_id: 0}});
    const status = queueItem && queueItem.queueItemState === QUEUE_ITEM_STATE.ABORT ? 'timeout' : 'unchanged';
    return {status, queueItem};
  }

  async function query(params, showParams = {}) {
    logger.debug(`Querying: ${JSON.stringify(params)}, ${JSON.stringify(showParams)}`);
    debug(`Querying: ${JSON.stringify(params)}, ${JSON.stringify(showParams)}`);
    const {limit = 1000, skip = 0, ...rest} = params;

    // rest is an internal, trusted query object built by the calling service:
    // callers must not splice raw user input into it. Its keys may legitimately
    // use dot notation and $-operators, which is why rest is not
    // field-sanitized here.
    const result = await operator.find(rest, {projection: createProjection(showParams)})
      .limit(parseInt(limit, 10))
      .skip(parseInt(skip, 10))
      .toArray();
    logger.debug(`Query result: ${result.length > 0 ? 'Found!' : 'Not found!'}`);
    logger.silly(`${JSON.stringify(result)}`);
    debug(`${JSON.stringify(result)}`);
    return result;
  }

  // We default to NOT showing operations, operationSettings, recordLoadParams and importJobState when a queueItem is queried
  // These can all be shown with showAll
  // Single fields can be shown by showOperation, showOperationSettings, showRecordLoadParams and showImportJobState

  function createProjection(showParams = {}) {
    logger.silly(`Creating projection for query: ${JSON.stringify(showParams)}`);
    debug(`Creating projection for query: ${JSON.stringify(showParams)}`);
    const {showAll = 0, showOperations = 0, showOperationSettings = 0, showRecordLoadParams = 0, showImportJobState = 0} = showParams;
    const combinedShowParams = {
      showAll,
      showOperations,
      showOperationSettings,
      showRecordLoadParams,
      showImportJobState
    };
    logger.debug(`showAll: ${showAll}, showOperations: ${showOperations}, showOperationSettings: ${showOperationSettings}, showRecordLoadParams: ${showRecordLoadParams}, showImportJobState: ${showImportJobState}`);
    debug(`showAll: ${showAll}, showOperations: ${showOperations}, showOperationSettings: ${showOperationSettings}, showRecordLoadParams: ${showRecordLoadParams}, showImportJobState: ${showImportJobState}`);
    debug(`${JSON.stringify(combinedShowParams)}`);

    // NOTE: the show-* params are parsed with the shared parseBoolean, whose
    // semantics are: undefined -> false, numeric strings via Boolean(Number(v))
    // ('0' -> false, '1' -> true), other non-empty non-'false' strings -> true.
    if (parseBoolean(showAll)) {
      //if (showAll === true || showAll === '1' || showAll === 1) {
      debug(`ShowAll: ${showAll}`);
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

    const result = Object.keys(combinedShowParams)
      //.filter(param => param !== 'showAll' && combinedShowParams[param] !== true && combinedShowParams[param] !== 1 && combinedShowParams[param] !== '1')
      .filter(param => param !== 'showAll' && !parseBoolean(combinedShowParams[param]))
      .filter(param => showParamToField[param])
      .map((param) => showParamToField[param]);
    logger.silly(`We want to exclude from projection: ${JSON.stringify(result)}`);
    debug(`We want to exclude from projection: ${JSON.stringify(result)}`);


    const excludeObject = Object.fromEntries(result.map(param => [param, 0]));
    logger.silly(`We want to exclude from projection: ${JSON.stringify(excludeObject)}`);
    debug(`We want to exclude from projection: ${JSON.stringify(excludeObject)}`);


    return {
      _id: 0,
      ...excludeObject
    };
  }

  // Note: edited in v4.2.4 to return queueItem *after* possible timout has aborted it
  // Note: previous versions returned queueItem *before* its state/queueItemState is timeOuted
  async function queryById({correlationId, checkModTime = false}) {
    assertString(correlationId, 'correlationId');
    if (checkModTime) {
      debug(`queryById checkModTime: ${checkModTime}`);
      await checkTimeOut({correlationId});
      return queryById({correlationId});
    }
    const result = await operator.findOne({correlationId}, {projection: {_id: 0}});
    return result;
  }

  // Check that if the item has waited too long
  // If the last modification time for the queueItem is older than the
  // configured window (MONGO_TIMEOUT_MINUTES, default 1 minute)
  // set state to ABORT and return false, otherwise return true
  // If the state is already ABORT or ERROR or DONE return false
  // if the item does not exist (deleted concurrently) return false
  // instead of crashing on destructuring of null

  async function checkTimeOut({correlationId}) {
    assertString(correlationId, 'correlationId');
    const queueItem = await operator.findOne({correlationId});
    if (!queueItem) {
      logger.silly(`${correlationId} not found in ${collection} - not a timeout`);
      return false;
    }
    // coalesce a missing importJobState (legacy rows written before the
    // importJobState shape existed) to all-EMPTY so .CREATE/.UPDATE/.FIX never
    // read off undefined and crash the pipeline.
    const {modificationTime, queueItemState: oldState, importJobState = {CREATE: IMPORT_JOB_STATE.EMPTY, UPDATE: IMPORT_JOB_STATE.EMPTY, FIX: IMPORT_JOB_STATE.EMPTY}} = queueItem;
    //debug(`${modificationTime} - oldState: ${oldState}`);
    // should we check for DONE too?
    if ([QUEUE_ITEM_STATE.ABORT, QUEUE_ITEM_STATE.ERROR, QUEUE_ITEM_STATE.DONE].includes(oldState)) {
      logger.silly(`${correlationId} has already state: ${oldState}`);
      return false;
    }

    // configurable "no progress" window (default 1 minute)
    const timeoutTime = new Date(new Date(modificationTime).getTime() + timeoutMinutes * 60000);
    logger.silly(`${correlationId} timeOut @ ${timeoutTime}`);

    if (timeoutTime < new Date()) {
      const finalImportJobStates = [IMPORT_JOB_STATE.ABORT, IMPORT_JOB_STATE.DONE, IMPORT_JOB_STATE.EMPTY, IMPORT_JOB_STATE.ERROR];
      if (!finalImportJobStates.includes(importJobState.CREATE)) {
        await setImportJobState({correlationId, operation: 'CREATE', importJobState: IMPORT_JOB_STATE.ABORT});
      }

      if (!finalImportJobStates.includes(importJobState.UPDATE)) {
        await setImportJobState({correlationId, operation: 'UPDATE', importJobState: IMPORT_JOB_STATE.ABORT});
      }

      if (!finalImportJobStates.includes(importJobState.FIX)) {
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
    debug(`${JSON.stringify(params)}`);
    debug(`Removing from Mongo (${collection}) id: ${params.correlationId}`);
    assertString(params.correlationId, 'correlationId');


    try {
      // true only when a GridFS file was actually deleted, false when there
      // was no content to delete
      const removedContent = await removeContent({correlationId: params.correlationId});
      debug(`removedContent (removeContent result): ${JSON.stringify(removedContent)}`);
      const deleteResult = await operator.deleteOne({correlationId: params.correlationId});
      debug(`deleteResult: ${JSON.stringify(deleteResult)}`);
      // callers need to tell "nothing was there" apart from "a queueItem was
      // deleted" (the old bare `true` said both)
      return {removed: deleteResult.deletedCount > 0, deletedContent: removedContent};
    } catch (err) {
      // TEST-COVERAGE: this error is not (currently) tested
      if (err instanceof MongoDriverError) {
        debug(err);
        if (err.message.indexOf('File not found for id') !== -1) {
          logger.silly(`mongo/remove: File not found, removing queueItem ${JSON.stringify(params.correlationId)} from ${collection}`);
          debug(`mongo/remove: File not found, removing queueItem ${JSON.stringify(params.correlationId)} from ${collection}`);
          const deleteResult = await operator.deleteOne({correlationId: params.correlationId});
          return {removed: deleteResult.deletedCount > 0, deletedContent: false};
        }
        logger.error(err.message);
        throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, err.message);
      }
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, err.message);
    }
  }

  async function readContent(correlationId) {
    logger.info(`Reading content from mongo for id: ${correlationId} in ${collection}`);
    debug(`Reading content from mongo for id: ${correlationId} in ${collection}`);
    assertString(correlationId, 'correlationId');

    const result = await operator.findOne({correlationId}); // njsscan-ignore: node_nosqli_injection
    debug(result);
    if (result) {
      const {operationSettings} = result;
      // createBulk never sets operationSettings.noStream (phantom flag,
      // always undefined). Derive the condition from the GridFS file instead:
      // bulk content is available only when a file was actually uploaded.
      let files = [];
      if (operationSettings.prio === false) {
        files = await gridFSBucket.find({filename: correlationId}).toArray();
      }
      const hasContent = files.length > 0;
      if (hasContent) {
        return {
          contentType: result.contentType,
          // the file existence was verified by the find() above; a
          // 'error' event on the returned stream (e.g. file deleted
          // concurrently) is an unhandled event for the caller -> the
          // contract is: the caller MUST attach an 'error' handler.
          readStream: gridFSBucket.openDownloadStreamByName(correlationId)
        };
      }
      logger.debug(`OperationSettings for ${correlationId}: ${JSON.stringify(operationSettings)}`);
      debug(`OperationSettings for ${correlationId}: ${JSON.stringify(operationSettings)}`);
      debug(`Content is only available for streamBulk jobs. ${correlationId} is not a streamBulk job.`);
      throw new ApiError(httpStatus.BAD_REQUEST, {message: `Content is only available for streamBulk jobs. ${correlationId} is not a streamBulk job.`});
    }

    throw new ApiError(httpStatus.NOT_FOUND, {message: `Job ${correlationId} not found.`});
  }

  async function removeContent(params) {
    logger.info(`Removing content from mongo for id: ${params.correlationId} in ${collection}`);
    debug(`Removing content from mongo for id: ${params.correlationId} in ${collection}`);
    assertString(params.correlationId, 'correlationId');

    const result = await gridFSBucket.find({filename: params.correlationId}).toArray();
    debug(`mongo/removeContent: find bucket result ${JSON.stringify(result)}`);


    if (result.length > 0) {
      // Note: we assume and handle just one file for filename!
      const [firstBucketResult] = result;
      const fileId = firstBucketResult._id;

      await gridFSBucket.delete(fileId);
      return true;
    }

    logger.debug(`No files for ${params.correlationId} to delete`);
    // false: there was no content to delete (the old `true` here made callers
    // unable to tell "file deleted" apart from "no file existed")
    return false;
  }

  // async so the entry-point guard below rejects (400) instead of throwing
  // synchronously before any promise is returned
  async function getOne({queueItemState, importJobState = undefined}) {
    //params example: "queueItemState": "IMPORTER.IN_QUEUE", "importJobState":{"importJobState.UPDATE": "IN_QUEUE"}
    logger.silly(`queueItemState: ${queueItemState}, importJobState: ${JSON.stringify(importJobState)}`);
    //debug(`queueItemState: ${queueItemState}, importJobState: ${JSON.stringify(importJobState)}`);
    // guard is outside the try so the 400 is not re-wrapped as a 500
    if (queueItemState) {
      assertString(queueItemState, 'queueItemState');
    }
    if (importJobState) {
      assertImportJobStateFilter(importJobState, 'importJobState');
    }
    const cleanQueueItemState = queueItemState ? {queueItemState} : undefined;
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

  // a missing GridFS file is reported by openDownloadStreamByName as an
  // async 'error' event, which would be an unhandled error event (a process
  // crash) if the caller never attaches a handler. Pre-check the file
  // existence here and throw NOT_FOUND synchronously instead. Note: this
  // makes getStream async (callers must await it). The contract for the
  // returned stream is the same as readContent: the caller MUST attach an
  // 'error' handler.
  async function getStream(correlationId) {
    logger.info(`Forming stream from mongo for ${correlationId} in ${collection}`);
    assertString(correlationId, 'correlationId');
    try {
      const files = await gridFSBucket.find({filename: correlationId}).toArray();
      if (files.length === 0) {
        logger.info(`getStream: file ${correlationId} not found in ${collection}`);
        throw new ApiError(httpStatus.NOT_FOUND, {message: `File ${correlationId} not found in ${collection}`});
      }
      // Return content stream
      return gridFSBucket.openDownloadStreamByName(correlationId);
    } catch (error) {
      // TEST-COVERAGE: this error is not (currently) tested
      if (error instanceof ApiError) {
        throw error;
      }
      const errorMessage = error.payload || error.message || '';
      logError(error);
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Mongo errored: ${errorMessage}`);
    }
  }

  async function pushIds({correlationId, handledIds, rejectedIds}) {
    // validate array inputs before dereferencing .length (guard is
    // outside the try so the 400 is not re-wrapped as a 500)
    if (!Array.isArray(handledIds) || !Array.isArray(rejectedIds)) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'pushIds: handledIds and rejectedIds must be arrays');
    }
    assertString(correlationId, 'correlationId');
    logger.verbose(`Push ids (${handledIds.length}) and rejectedIds (${rejectedIds.length}) ${correlationId} to ${collection}`);
    logger.debug(`ids (${handledIds.length}): ${JSON.stringify(handledIds)}, rejectedIds ${rejectedIds.length}: ${JSON.stringify(rejectedIds)}`);
    try {
      await operator.updateOne({
        correlationId
      }, {
        $set: {
          modificationTime: new Date()
        },
        $push: {
          handledIds: {$each: handledIds},
          rejectedIds: {$each: rejectedIds}
        }
      });
    } catch (error) {
      const errorMessage = error.payload || error.message || '';
      logError(error);
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Mongo errored: ${errorMessage}`);
    }
  }

  async function pushMessages({correlationId, messages, messageField = 'messages'}) {
    // validate array input before dereferencing .length (guard is
    // outside the try so the 400 is not re-wrapped as a 500)
    if (!Array.isArray(messages)) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'pushMessages: messages must be an array');
    }
    assertString(correlationId, 'correlationId');
    assertString(messageField, 'messageField');
    logger.verbose(`Push messages (${messages.length}) to ${messageField} ${correlationId} to ${collection}`);
    logger.silly(`Messages (${messages.length}): ${JSON.stringify(messages)}`);
    try {
      await operator.updateOne({
        correlationId
      }, {
        $set: {
          modificationTime: new Date()
        },
        $push: {
          [messageField]: {$each: messages}
        }
      });
    } catch (error) {
      const errorMessage = error.payload || error.message || '';
      logError(error);
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Mongo errored: ${errorMessage}`);
    }
  }

  function setState({correlationId, state, errorMessage = undefined, errorStatus = undefined}) {
    assertString(correlationId, 'correlationId');
    const errorString = errorMessage || errorStatus ? `, Error message: '${JSON.stringify(errorMessage) || ''}', Error status: '${errorStatus || ''}'` : '';
    logger.info(`Setting queue-item state ${state} for ${correlationId}${errorString} to ${collection}`);

    const stateInQueueItemStates = Object.values(QUEUE_ITEM_STATE).indexOf(state) > -1;
    const stateInQueueItemStatesValidator = Object.values(QUEUE_ITEM_STATE.VALIDATOR).indexOf(state) > -1;
    const stateInQueueItemStatesImporter = Object.values(QUEUE_ITEM_STATE.IMPORTER).indexOf(state) > -1;
    if (!stateInQueueItemStates && !stateInQueueItemStatesValidator && !stateInQueueItemStatesImporter) {
      debug(`Trying to set invalid state ${state}`);
      throw new ApiError(httpStatus.BAD_REQUEST, 'Trying to set invalid state');
    }

    const updateValues = {
      queueItemState: state,
      modificationTime: new Date(),
      errorMessage,
      errorStatus
    };

    // errorMessage/errorStatus are sticky: transitions that do not set them
    // (undefined) drop the keys from the $set instead of clearing the fields,
    // so a later state change intentionally keeps the previous values and the
    // last error stays visible on the queueItem.
    // Do not update value that are undefined
    Object.keys(updateValues).forEach(key => updateValues[key] === undefined && delete updateValues[key]);

    return operator
      .findOneAndUpdate(
        {correlationId},
        {$set: updateValues},
        {projection: {_id: 0}, returnDocument: 'after'}
      );
  }

  function setImportJobState({correlationId, operation, importJobState}) {

    // should this also get importJobState as previously created object? {}
    assertString(correlationId, 'correlationId');
    logger.info(`Setting queue-item importJobState: {${operation}: ${importJobState}} for ${correlationId}`);
    debug(`Setting queue-item importJobState: {${operation}: ${importJobState}} for ${correlationId}`);

    if (!(operation in OPERATIONS)) {
      debug(`Error: ${operation} is not in ${JSON.stringify(OPERATIONS)}`);
      throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid operation for import job state');
    }

    if (!(importJobState in IMPORT_JOB_STATE)) {
      debug(`Error: ${importJobState} is not in ${JSON.stringify(IMPORT_JOB_STATE)}`);
      throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid import job state');
    }

    const newJobState = getNewJobState(operation, importJobState);


    function getNewJobState(operation, importJobState) {
      if (operation === OPERATIONS.CREATE) {
        return {'importJobState.CREATE': importJobState};
      }
      if (operation === OPERATIONS.UPDATE) {
        return {'importJobState.UPDATE': importJobState};
      }
      if (operation === OPERATIONS.FIX) {
        return {'importJobState.FIX': importJobState};
      }
      // Unreachable in practice: setImportJobState validates operation
      // against OPERATIONS before calling; kept defensively.
      throw new ApiError('400', 'Invalid operation for import job state');
    }

    return operator.findOneAndUpdate({
      correlationId
    }, {
      $set: {
        ...newJobState,
        modificationTime: new Date()
      }
    }, {projection: {_id: 0}, returnDocument: 'after'});
  }

  // `findOneAndUpdate` (mongodb v6) returns the resulting document
  // directly, or `null` when nothing matched. The old `result.ok || result`
  // was v3 debris: a non-matching correlationId came back as a silent `null`
  // and callers could not tell "no match" from success. Now a `null` result
  // is mapped to an ApiError 404, and the document itself is returned on
  // success (no more `{ok, value}` shape to worry about).
  function unwrapAndUpdateResult(result, correlationId) {
    if (result === null || result === undefined) {
      logger.info(`Queue item ${correlationId} not found in ${collection}`);
      throw new ApiError(httpStatus.NOT_FOUND, {message: `Job ${correlationId} not found.`});
    }
    return result;
  }

  async function setOperation({correlationId, operation}) {
    assertString(correlationId, 'correlationId');
    const newOperation = operation;
    const existing = await operator.findOne({correlationId});
    if (!existing) {
      logger.info(`Setting queue-item operation: queue item ${correlationId} not found in ${collection}`);
      throw new ApiError(httpStatus.NOT_FOUND, {message: `Job ${correlationId} not found.`});
    }
    const {operation: oldOperation} = existing;
    logger.info(`Setting queue-item operation from ${oldOperation} to ${newOperation} for ${correlationId} to ${collection}`);

    const result = await operator.findOneAndUpdate({
      correlationId
    }, {
      $set: {
        operation: newOperation,
        modificationTime: new Date()
      }
    }, {projection: {_id: 0}, returnDocument: 'after'});
    debugDev(`${JSON.stringify(result)}`);
    return unwrapAndUpdateResult(result, correlationId);
    // logger.debug(JSON.stringify(result));
  }

  async function setOperations({correlationId, addOperation, removeOperation = undefined}) {
    assertString(correlationId, 'correlationId');

    const queueItem = await operator.findOne({correlationId});
    logger.silly(`We found a queueItem: ${JSON.stringify(queueItem)}`);
    if (!queueItem) {
      logger.info(`Setting queue-item operations: queue item ${correlationId} not found in ${collection}`);
      throw new ApiError(httpStatus.NOT_FOUND, {message: `Job ${correlationId} not found.`});
    }

    const oldOperations = queueItem.operations;

    logger.info(`Setting queue-item operations from ${JSON.stringify(oldOperations)} by adding ${addOperation} and removing ${removeOperation} for ${correlationId} to ${collection}`);

    const operationsAfterRemove = oldOperations.filter(operation => operation !== removeOperation);
    const operationsAfterRemoveAndAdd = operationsAfterRemove.includes(addOperation) ? operationsAfterRemove : [...operationsAfterRemove, addOperation];

    logger.silly(`operationsAfterRemove: ${operationsAfterRemove}`);
    logger.silly(`operationAfterRemoveAndAdd: ${operationsAfterRemoveAndAdd}`);

    const result = await operator.findOneAndUpdate({
      correlationId
    }, {
      $set: {
        operations: operationsAfterRemoveAndAdd,
        modificationTime: new Date()
      }
    }, {projection: {_id: 0}, returnDocument: 'after'});
    debugDev(`${JSON.stringify(result)}`);
    return unwrapAndUpdateResult(result, correlationId);
    // logger.debug(JSON.stringify(result));
  }

  async function addBlobSize({correlationId}) {
    assertString(correlationId, 'correlationId');

    const result = await operator.findOneAndUpdate({
      correlationId,
      queueItemState: QUEUE_ITEM_STATE.VALIDATOR.WAITING_FOR_RECORDS
    }, {
      $inc: {
        blobSize: 1
      },
      $set: {
        modificationTime: new Date()
      }
    }, {projection: {_id: 0}, returnDocument: 'after'});

    logger.verbose(`AddBlobSizeResult in mongo: ${JSON.stringify(result)}`);
    debugDev(`${JSON.stringify(result)}`);
    return result;
  }

  async function setBlobSize({correlationId, blobSize}) {
    assertString(correlationId, 'correlationId');
    assertNumber(blobSize, 'blobSize');

    const result = await operator.findOneAndUpdate({
      correlationId
    }, {
      $set: {
        blobSize,
        modificationTime: new Date()
      }
    }, {projection: {_id: 0}, returnDocument: 'after'});

    logger.verbose(`SetBlobSizeResult in mongo: ${JSON.stringify(result)}`);
    debugDev(`${JSON.stringify(result)}`);
    return result;
  }

}
