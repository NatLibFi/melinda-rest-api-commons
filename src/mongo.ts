/* eslint-disable max-lines */

import {MongoClient, GridFSBucket, MongoDriverError} from 'mongodb';
import type {Collection, Filter, GridFSFile, UpdateFilter, WithId} from 'mongodb';
import type {Readable} from 'stream';
import httpStatus from 'http-status';
import createDebugLogger from 'debug';
import {createLogger, Error as ApiError, parseBoolean} from '@natlibfi/melinda-commons';
import {QUEUE_ITEM_STATE, IMPORT_JOB_STATE, OPERATIONS} from './constants.ts';
import {logError, assertString, assertNumber, assertImportJobStateFilter} from './utils.ts';
import {withMongoError} from './mongoError.ts';

//import isDeepStrictEqual from 'util';

// The persisted importJobState values always come from the as-const
// IMPORT_JOB_STATE object (setImportJobState rejects any other string), so
// the field uses the constant's literal value types instead of free-form
// string
export type ImportJobStateValue = (typeof IMPORT_JOB_STATE)[keyof typeof IMPORT_JOB_STATE];

/**
 * A queueItem document in the queue collection.
 *
 * Free-form string fields (queueItemState, operation, operations,
 * cataloger, ...) stay plain string: callers may pass any of the
 * as-const constant values, and legacy documents may hold values that
 * no longer exist in the constants. The persisted `records` and
 * `messages` arrays are unknown[] on purpose: they store heterogeneous
 * persisted data (recordResponseItems, message payloads), not the
 * in-flight AMQP payload shapes (amqp.ts QueueItemRecordPayload /
 * QueueItemMessagePayload wrap amqplib Message objects that are never
 * persisted). `errorStatus` is string | number: the timeout path stores
 * an httpStatus number (408), other paths store strings.
 */
export interface QueueItem {
  correlationId: string;
  cataloger?: string;
  oCatalogerIn?: string;
  operation?: string;
  operations: string[];
  contentType?: string;
  recordLoadParams?: unknown;
  operationSettings: {prio?: boolean, noStream?: boolean};
  queueItemState: string;
  importJobState: {
    CREATE: ImportJobStateValue;
    UPDATE: ImportJobStateValue;
    FIX: ImportJobStateValue;
  };
  blobSize?: number;
  records?: unknown[];
  handledIds?: string[];
  rejectedIds?: string[];
  messages?: unknown[];
  errorMessage?: string;
  errorStatus?: string | number;
  creationTime?: Date;
  modificationTime?: Date;
}

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

export interface CreatePrioParams {
  correlationId: string;
  cataloger: string;
  oCatalogerIn: string;
  operation: string;
  operationSettings?: Record<string, unknown>;
}

export interface CreateBulkParams {
  correlationId: string;
  cataloger: string;
  oCatalogerIn: string;
  operation: string;
  contentType: string;
  recordLoadParams: unknown;
  stream?: Readable;
  operationSettings?: Record<string, unknown>;
}

/**
 * The normalized return shape of createBulk (both the stream and the
 * no-stream paths return the same shape)
 */
export interface CreateBulkResult {
  correlationId: string;
  acknowledged: boolean;
  queueItemState: string;
}

export interface CheckAndSetStateParams {
  correlationId: string;
  state: string;
  errorMessage?: unknown;
  errorStatus?: unknown;
}

export interface CheckAndSetImportJobStateParams {
  correlationId: string;
  operation: string;
  importJobState: string;
}

/**
 * Discriminated result of checkAndSetState / checkAndSetImportJobState:
 * 'updated' - state was set, 'timeout' - item was aborted by
 * checkTimeOut, 'unchanged' - state was ABORT/ERROR/DONE already or the
 * item no longer exists
 */
export interface CheckAndSetResult {
  status: 'updated' | 'timeout' | 'unchanged';
  queueItem: WithId<QueueItem> | null;
}

/**
 * Trusted internal query object built by the calling service (limit, skip
 * and Mongo query operators). Callers must not splice raw user input into
 * it: its keys may legitimately use dot notation and $-operators.
 */
export interface QueryParams {
  limit?: number | string;
  skip?: number | string;
  [key: string]: unknown;
}

export interface ShowParams {
  showAll?: boolean | 0;
  showOperations?: boolean | 0;
  showOperationSettings?: boolean | 0;
  showRecordLoadParams?: boolean | 0;
  showImportJobState?: boolean | 0;
}

export interface QueryByIdParams {
  correlationId: string;
  checkModTime?: boolean;
}

export interface CheckTimeOutParams {
  correlationId: string;
  operation?: string;
  importJobState?: string;
}

export interface GetOneParams {
  queueItemState?: string;
  importJobState?: Record<string, unknown>;
}

export interface SetStateParams {
  correlationId: string;
  state: string;
  errorMessage?: unknown;
  errorStatus?: unknown;
}

export interface SetImportJobStateParams {
  correlationId: string;
  operation: string;
  importJobState: string;
}

export interface PushIdsParams {
  correlationId: string;
  handledIds: string[];
  rejectedIds: string[];
}

export interface PushMessagesParams {
  correlationId: string;
  messages: unknown[];
  messageField?: string;
}

/**
 * The Mongo operator object returned by the factory
 */
export interface MongoOperator {
  createPrio: (params: CreatePrioParams) => Promise<void>;
  createBulk: (params: CreateBulkParams) => Promise<CreateBulkResult | undefined>;
  checkAndSetState: (params: CheckAndSetStateParams) => Promise<CheckAndSetResult>;
  checkAndSetImportJobState: (params: CheckAndSetImportJobStateParams) => Promise<CheckAndSetResult>;
  query: (params: QueryParams, showParams?: ShowParams) => Promise<WithId<QueueItem>[]>;
  createProjection: (showParams?: ShowParams) => Record<string, number>;
  queryById: (params: QueryByIdParams) => Promise<WithId<QueueItem> | null>;
  checkTimeOut: (params: CheckTimeOutParams) => Promise<boolean>;
  remove: (params: {correlationId: string}) => Promise<{removed: boolean, deletedContent: boolean}>;
  readContent: (correlationId: string) => Promise<{contentType: string | undefined, readStream: Readable}>;
  removeContent: (params: {correlationId: string}) => Promise<boolean>;
  getOne: (params: GetOneParams) => Promise<WithId<QueueItem> | null>;
  getStream: (correlationId: string) => Promise<Readable>;
  setState: (params: SetStateParams) => Promise<WithId<QueueItem> | null>;
  setImportJobState: (params: SetImportJobStateParams) => Promise<WithId<QueueItem> | null>;
  pushIds: (params: PushIdsParams) => Promise<void>;
  pushMessages: (params: PushMessagesParams) => Promise<void>;
  setOperation: (params: {correlationId: string, operation: string}) => Promise<WithId<QueueItem>>;
  setOperations: (params: {correlationId: string, addOperation: string, removeOperation?: string}) => Promise<WithId<QueueItem>>;
  addBlobSize: (params: {correlationId: string}) => Promise<WithId<QueueItem> | null>;
  setBlobSize: (params: {correlationId: string, blobSize: number}) => Promise<WithId<QueueItem> | null>;
}

/**
 * Create Mongo operator
 * @param MONGO_URI mongo connection string
 * @param collection queue collection name
 * @param db mongo db name, defaults 'rest-api'
 * @param deps optional dependencies, defaults {}. deps.operator (a Mongo collection) and deps.gridFSBucket may be injected by unit tests
 * @returns the Mongo operator object
 */
export default async function (MONGO_URI: string, collection: string, db = 'rest-api', deps: {operator?: unknown, gridFSBucket?: unknown} = {}): Promise<MongoOperator> {
  const logger = createLogger();
  // the checkTimeOut "no progress" window used to be a hardcoded
  // 1 minute, which is too short for large bulk imports (README benchmark:
  // ~9248 records can take ~10 minutes). Now configurable via the
  // MONGO_TIMEOUT_MINUTES env var (default: 1 minute). Each importer chunk
  // that writes (pushMessages / pushIds / setImportJobState / addBlobSize /
  // setBlobSize / setState ...) refreshes modificationTime, so the timeout
  // only triggers when there is genuinely no progress.
  const timeoutMinutes = Number.parseInt(process.env['MONGO_TIMEOUT_MINUTES'] as string, 10) || 1;
  logger.debug(`checkTimeOut window: ${timeoutMinutes} minute(s) (override with MONGO_TIMEOUT_MINUTES)`);
  const debug = createDebugLogger('@natlibfi/melinda-rest-api-commons/mongo');
  const debugDev = debug.extend(':dev');

  // Connect to mongo (MONGO), unless operator and gridFSBucket are both
  // injected via deps (used by unit tests to avoid a real connection).
  // The deps values are cast non-nullable (the runtime values may be
  // undefined until the connect branch assigns them), which also keeps
  // the closure-typed functions below from seeing possibly-undefined.
  const stubbed = Boolean(deps.operator) && Boolean(deps.gridFSBucket);
  let gridFSBucket: GridFSBucket = deps.gridFSBucket as GridFSBucket;
  let operator: Collection<QueueItem> = deps.operator as Collection<QueueItem>;
  if (!stubbed) {
    const client = await MongoClient.connect(MONGO_URI);
    const realDb = client.db(db);
    gridFSBucket = gridFSBucket ?? new GridFSBucket(realDb, {bucketName: collection});
    operator = operator ?? realDb.collection<QueueItem>(collection);
  }
  debugDev(`mongo: ${MONGO_URI}, db: ${db}, collection: ${collection}`);

  // The previously-unwrapped public methods are wrapped with the shared
  // withMongoError helper so a Mongo driver failure rejects with
  // ApiError 500 ('Mongo errored: ...') instead of a raw driver error;
  // validation (400) and not-found (404) errors pass through unchanged.
  // The pre-wrapped methods (createPrio, createBulk, remove, getOne,
  // getStream, pushIds, pushMessages) keep their inline handling.
  return {
    createPrio,
    createBulk,
    checkAndSetState: (params: CheckAndSetStateParams) => withMongoError(() => checkAndSetState(params)),
    checkAndSetImportJobState: (params: CheckAndSetImportJobStateParams) => withMongoError(() => checkAndSetImportJobState(params)),
    query: (params: QueryParams, showParams?: ShowParams) => withMongoError(() => query(params, showParams)),
    createProjection,
    queryById: (params: QueryByIdParams) => withMongoError(() => queryById(params)),
    checkTimeOut: (params: CheckTimeOutParams) => withMongoError(() => checkTimeOut(params)),
    remove,
    readContent: (correlationId: string) => withMongoError(() => readContent(correlationId)),
    removeContent: (params: {correlationId: string}) => withMongoError(() => removeContent(params)),
    getOne,
    getStream,
    setState: (params: SetStateParams) => withMongoError(() => setState(params)),
    setImportJobState: (params: SetImportJobStateParams) => withMongoError(() => setImportJobState(params)),
    pushIds,
    pushMessages,
    setOperation: (params: {correlationId: string, operation: string}) => withMongoError(() => setOperation(params)),
    setOperations: (params: {correlationId: string, addOperation: string, removeOperation?: string}) => withMongoError(() => setOperations(params)),
    addBlobSize: (params: {correlationId: string}) => withMongoError(() => addBlobSize(params)),
    setBlobSize: (params: {correlationId: string, blobSize: number}) => withMongoError(() => setBlobSize(params))
  };

  /**
   * Create a prio queueItem
   * @param params
   */
  async function createPrio({correlationId, cataloger, oCatalogerIn, operation, operationSettings}: CreatePrioParams) {
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
      } as QueueItem['operationSettings'],
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
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, undefined);
    } catch (error) {
      const apiError = error as ApiError;
      const errorMessage = apiError.payload || apiError.message || '';
      logError(error);
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Mongo errored: ${errorMessage}`);
    }
  }

  /**
   * Create a bulk queueItem, with or without an input content stream
   * @param params
   * @returns {correlationId, acknowledged, queueItemState} on success
   */
  async function createBulk({correlationId, cataloger, oCatalogerIn, operation, contentType, recordLoadParams, stream, operationSettings}: CreateBulkParams) {
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
      } as QueueItem['operationSettings'],
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
            .on('end', () => outputStream.end(undefined, () => {
              resolve(correlationId);
            }));
        });
        logger.info(`New BULK queue item for ${operation} ${correlationId} has been made in ${collection}!`);
        debug(`New BULK queue item for ${operation} ${correlationId} has been made in ${collection}!`);
        const result = await operator.insertOne(newQueueItem);
        if (!result.acknowledged) {
          throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, undefined);
        }
        // normalize the return shape to the same one the no-stream
        // path returns - do not leak the driver InsertOneResult
        return {correlationId, acknowledged: result.acknowledged, queueItemState: newQueueItem.queueItemState};
      } catch (error) {
        const apiError = error as ApiError;
        const errorMessage = apiError.payload || apiError.message || '';
        logError(error);
        // best-effort cleanup of a partial GridFS file
        await removePartialContent(correlationId);
        throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Mongo errored: ${errorMessage}`);
      }
    }

    /**
     * Remove a partial GridFS upload file if the stream upload failed
     * @param correlationId
     */
    async function removePartialContent(correlationId: string) {
      try {
        const files = await gridFSBucket.find({filename: correlationId}).toArray();
        for (const file of files) {
          await gridFSBucket.delete(file._id);
          logger.debug(`mongo/createBulk: removed partial GridFS file for ${correlationId}`);
        }
      } catch (cleanupError) {
        const apiError = cleanupError as ApiError;
        logger.debug(`mongo/createBulk: partial GridFS cleanup failed for ${correlationId}: ${apiError.message}`);
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
        throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, undefined);
      } catch (error) {
        const apiError = error as ApiError;
        const errorMessage = apiError.payload || apiError.message || '';
        logError(error);
        throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Mongo errored: ${errorMessage}`);
      }
    }

    // both branches above always return or throw; the fallthrough is
    // unreachable (stream truthy -> first branch, falsy -> second)
    return undefined;
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
  /**
   * Check the queueItem has not waited too long and set its state
   * @param params
   * @returns discriminated result: status 'updated' | 'timeout' | 'unchanged'
   */
  async function checkAndSetState({correlationId, state, errorMessage = undefined, errorStatus = undefined}: CheckAndSetStateParams): Promise<CheckAndSetResult> {
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
  /**
   * Check the queueItem has not waited too long and set its importJobState
   * @param params
   * @returns discriminated result, see checkAndSetState
   */
  async function checkAndSetImportJobState({correlationId, operation, importJobState}: CheckAndSetImportJobStateParams): Promise<CheckAndSetResult> {
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

  /**
   * Query queueItems with a trusted internal query object
   * @param params trusted query object built by the calling service (limit, skip and Mongo query operators)
   * @param showParams which internal fields to include in the projection
   * @returns query result documents
   */
  async function query(params: QueryParams, showParams: ShowParams = {}) {
    logger.debug(`Querying: ${JSON.stringify(params)}, ${JSON.stringify(showParams)}`);
    debug(`Querying: ${JSON.stringify(params)}, ${JSON.stringify(showParams)}`);
    const {limit = 1000, skip = 0, ...rest} = params;

    // rest is an internal, trusted query object built by the calling service:
    // callers must not splice raw user input into it. Its keys may legitimately
    // use dot notation and $-operators, which is why rest is not
    // field-sanitized here.
    const result = await operator.find(rest as Filter<WithId<QueueItem>>, {projection: createProjection(showParams)})
      .limit(parseInt(String(limit), 10))
      .skip(parseInt(String(skip), 10))
      .toArray();
    logger.debug(`Query result: ${result.length > 0 ? 'Found!' : 'Not found!'}`);
    logger.silly(`${JSON.stringify(result)}`);
    debug(`${JSON.stringify(result)}`);
    return result;
  }

  // We default to NOT showing operations, operationSettings, recordLoadParams and importJobState when a queueItem is queried
  // These can all be shown with showAll
  // Single fields can be shown by showOperation, showOperationSettings, showRecordLoadParams and showImportJobState

  /**
   * Build the Mongo projection for query (internal fields hidden unless shown)
   * @param showParams
   * @returns the projection object
   */
  function createProjection(showParams: ShowParams = {}) {
    logger.silly(`Creating projection for query: ${JSON.stringify(showParams)}`);
    debug(`Creating projection for query: ${JSON.stringify(showParams)}`);
    const {showAll = 0, showOperations = 0, showOperationSettings = 0, showRecordLoadParams = 0, showImportJobState = 0} = showParams;
    const combinedShowParams: Record<string, boolean | 0> = {
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
    // The runtime values (boolean | 0) are outside parseBoolean's declared
    // string|undefined input type - cast at the boundary, runtime behaviour
    // is unchanged.
    if (parseBoolean(showAll as unknown as string | undefined)) {
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
    } as const;

    const result: string[] = Object.keys(combinedShowParams)
      //.filter(param => param !== 'showAll' && combinedShowParams[param] !== true && combinedShowParams[param] !== 1 && combinedShowParams[param] !== '1')
      .filter(param => param !== 'showAll' && !parseBoolean(combinedShowParams[param] as unknown as string | undefined))
      .filter((param): param is keyof typeof showParamToField => param in showParamToField)
      .map(param => showParamToField[param]);
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
  /**
   * Get a queueItem by correlationId
   * @param params
   * @returns the queueItem or null
   */
  async function queryById({correlationId, checkModTime = false}: QueryByIdParams) {
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

  /**
   * Check that the queueItem has not waited too long; abort it when it has
   * @param params
   * @returns true when the item is fresh, false when aborted/terminal/not found
   */
  async function checkTimeOut({correlationId}: CheckTimeOutParams) {
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
    if (oldState === QUEUE_ITEM_STATE.ABORT || oldState === QUEUE_ITEM_STATE.ERROR || oldState === QUEUE_ITEM_STATE.DONE) {
      logger.silly(`${correlationId} has already state: ${oldState}`);
      return false;
    }

    // configurable "no progress" window (default 1 minute)
    const timeoutTime = new Date(new Date(modificationTime as Date).getTime() + timeoutMinutes * 60000);
    logger.silly(`${correlationId} timeOut @ ${timeoutTime}`);

    if (timeoutTime < new Date()) {
      // the as-const constants yield literal-typed values, so the terminal
      // states are widened to string[] to compare against the free-form
      // importJobState strings read from Mongo documents
      const finalImportJobStates: string[] = [IMPORT_JOB_STATE.ABORT, IMPORT_JOB_STATE.DONE, IMPORT_JOB_STATE.EMPTY, IMPORT_JOB_STATE.ERROR];
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

  /**
   * Remove a queueItem and its GridFS content
   * @param params
   * @returns what was actually removed
   */
  async function remove(params: {correlationId: string}) {
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
      const driverError = err as Error;
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, driverError.message);
    }
  }

  /**
   * Read the GridFS content of a queueItem
   * @param correlationId
   * @returns content type + download stream
   */
  async function readContent(correlationId: string) {
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
      let files: GridFSFile[] = [];
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

  /**
   * Remove the GridFS content of a queueItem
   * @param params
   * @returns true when a file was deleted, false when there was no content
   */
  async function removeContent(params: {correlationId: string}) {
    logger.info(`Removing content from mongo for id: ${params.correlationId} in ${collection}`);
    debug(`Removing content from mongo for id: ${params.correlationId} in ${collection}`);
    assertString(params.correlationId, 'correlationId');

    const result = await gridFSBucket.find({filename: params.correlationId}).toArray();
    debug(`mongo/removeContent: find bucket result ${JSON.stringify(result)}`);


    if (result.length > 0) {
      // Note: we assume and handle just one file for filename!
      // the length check above guarantees result[0] exists
      const [firstBucketResult] = result;
      const fileId = (firstBucketResult as GridFSFile)._id;

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
  /**
   * Get one queueItem filtered by queueItemState and/or importJobState
   * @param params
   * @returns the queueItem or null
   */
  async function getOne({queueItemState, importJobState = undefined}: GetOneParams) {
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
        logger.silly(`Checking DB ${collection} for just ${JSON.stringify(queueItemState)}`);
        //debug(`Checking DB ${collection} for just ${JSON.stringify(queueItemState)}`);
        return operator.findOne({queueItemState}, options);
      }

      // importJobState
      if (importJobState && queueItemState === undefined) {
        logger.silly(`Checking DB ${collection} for ${JSON.stringify(importJobState)}`);
        //debug(`Checking DB ${collection} for ${JSON.stringify(importJobState)}`);
        return operator.findOne({...importJobState} as Filter<WithId<QueueItem>>, options);
      }

      // importJobState and queueItemState
      if (importJobState && queueItemState) {
        logger.silly(`Checking DB ${collection} for ${queueItemState} and ${JSON.stringify(importJobState)}`);
        //debug(`Checking DB ${collection} for ${queueItemState} and ${JSON.stringify(importJobState)}`);
        return operator.findOne({...cleanQueueItemState, ...importJobState} as Filter<WithId<QueueItem>>, options);
      }

      logger.debug(`getOne not working!`);
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Missing parameters, cannot get queueItem');

    } catch (error) {
      const apiError = error as ApiError;
      const errorMessage = apiError.payload || apiError.message || '';
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
  /**
   * Get a download stream of the GridFS content of a queueItem
   * @param correlationId
   * @returns the content download stream (caller MUST attach an 'error' handler)
   */
  async function getStream(correlationId: string) {
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
      if (error instanceof ApiError) {
        throw error;
      }
      const apiError = error as ApiError;
      const errorMessage = apiError.payload || apiError.message || '';
      logError(error);
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Mongo errored: ${errorMessage}`);
    }
  }

  /**
   * Push handled and rejected ids to a queueItem
   * @param params
   */
  async function pushIds({correlationId, handledIds, rejectedIds}: PushIdsParams) {
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
      const apiError = error as ApiError;
      const errorMessage = apiError.payload || apiError.message || '';
      logError(error);
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Mongo errored: ${errorMessage}`);
    }
  }

  /**
   * Push message records to a queueItem field
   * @param params
   */
  async function pushMessages({correlationId, messages, messageField = 'messages'}: PushMessagesParams) {
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
      const apiError = error as ApiError;
      const errorMessage = apiError.payload || apiError.message || '';
      logError(error);
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Mongo errored: ${errorMessage}`);
    }
  }

  /**
   * Set the queueItem state (drops undefined errorMessage/errorStatus keys from the update)
   * @param params
   * @returns the updated queueItem or null
   */
  function setState({correlationId, state, errorMessage = undefined, errorStatus = undefined}: SetStateParams) {
    assertString(correlationId, 'correlationId');
    const errorString = errorMessage || errorStatus ? `, Error message: '${JSON.stringify(errorMessage) || ''}', Error status: '${errorStatus || ''}'` : '';
    logger.info(`Setting queue-item state ${state} for ${correlationId}${errorString} to ${collection}`);

    // the state comes in as a free-form string (caller input), so the
    // as-const values are collected as string for the membership check
    // (the nested VALIDATOR/IMPORTER objects are never equal to a state
    // string, so only the top-level terminal states are enumerated)
    const allQueueItemStates: string[] = [
      QUEUE_ITEM_STATE.DONE,
      QUEUE_ITEM_STATE.ERROR,
      QUEUE_ITEM_STATE.ABORT,
      ...Object.values(QUEUE_ITEM_STATE.VALIDATOR),
      ...Object.values(QUEUE_ITEM_STATE.IMPORTER)
    ];
    if (!allQueueItemStates.includes(state)) {
      debug(`Trying to set invalid state ${state}`);
      throw new ApiError(httpStatus.BAD_REQUEST, 'Trying to set invalid state');
    }

    const updateValues: Record<string, unknown> = {
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
        {$set: updateValues} as UpdateFilter<WithId<QueueItem>>,
        {projection: {_id: 0}, returnDocument: 'after'}
      );
  }

  /**
   * Set the importJobState of an operation on a queueItem
   * @param params
   * @returns the updated queueItem or null
   */
  function setImportJobState({correlationId, operation, importJobState}: SetImportJobStateParams) {

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

    return operator.findOneAndUpdate({
      correlationId
    }, {
      $set: {
        ...newJobState,
        modificationTime: new Date()
      }
    }, {projection: {_id: 0}, returnDocument: 'after'});
  }

  /**
   * Build the dotted importJobState update for one operation
   * @param operation
   * @param importJobState
   * @returns the dotted-key importJobState update
   */
  function getNewJobState(operation: string, importJobState: string): {
    'importJobState.CREATE'?: string,
    'importJobState.UPDATE'?: string,
    'importJobState.FIX'?: string
  } {
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
    // the baseline passed the string '400'; the ApiError status is typed
    // number, so the same value goes in as the constant
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid operation for import job state');
  }

  // `findOneAndUpdate` (mongodb v6) returns the resulting document
  // directly, or `null` when nothing matched. The old `result.ok || result`
  // was v3 debris: a non-matching correlationId came back as a silent `null`
  // and callers could not tell "no match" from success. Now a `null` result
  // is mapped to an ApiError 404, and the document itself is returned on
  // success (no more `{ok, value}` shape to worry about).
  /**
   * Map a null findOneAndUpdate result to a 404 ApiError
   * @param result
   * @param correlationId
   * @returns the updated document
   */
  function unwrapAndUpdateResult(result: WithId<QueueItem> | null, correlationId: string): WithId<QueueItem> {
    if (result === null || result === undefined) {
      logger.info(`Queue item ${correlationId} not found in ${collection}`);
      throw new ApiError(httpStatus.NOT_FOUND, {message: `Job ${correlationId} not found.`});
    }
    return result;
  }

  /**
   * Set the operation of a queueItem
   * @param params
   * @returns the updated queueItem
   */
  async function setOperation({correlationId, operation}: {correlationId: string, operation: string}) {
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

  /**
   * Add and/or remove an operation on a queueItem
   * @param params
   * @returns the updated queueItem
   */
  async function setOperations({correlationId, addOperation, removeOperation = undefined}: {correlationId: string, addOperation: string, removeOperation?: string}) {
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

  /**
   * Increment the blobSize of a queueItem waiting for records
   * @param params
   * @returns the updated queueItem or null
   */
  async function addBlobSize({correlationId}: {correlationId: string}) {
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

  /**
   * Set the blobSize of a queueItem
   * @param params
   * @returns the updated queueItem or null
   */
  async function setBlobSize({correlationId, blobSize}: {correlationId: string, blobSize: number}) {
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
