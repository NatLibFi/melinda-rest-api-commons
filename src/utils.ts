import httpStatus from 'http-status';
import {createLogger, Error as ApiError} from '@natlibfi/melinda-commons';
import {IMPORT_JOB_STATE, OPERATIONS} from './constants.ts';

const logger = createLogger();

/**
 * Log an error: ApiErrors are stringified, the SIGINT marker is logged as-is,
 * everything else is logged with its stack when it has one
 */
export function logError(err: unknown) {
  if (err instanceof ApiError) {
    logger.error(JSON.stringify(err));
    return;
  }

  if (err === 'SIGINT') {
    logger.error(err);
    return;
  }

  const maybeError = err as Error;
  logger.error(maybeError.stack === undefined ? err : maybeError.stack);
}

// Entry-point type guards: correlationIds and scalar params are expected as
// plain strings/numbers. A non-scalar (e.g. an object) would be spliced into
// the query as a MongoDB operator, so reject it with 400 before any query.
export function assertString(value: unknown, name: string) {
  if (typeof value !== 'string') {
    throw new ApiError(httpStatus.BAD_REQUEST, `${name} must be a string`);
  }
}

export function assertNumber(value: unknown, name: string) {
  if (typeof value !== 'number') {
    throw new ApiError(httpStatus.BAD_REQUEST, `${name} must be a number`);
  }
}

// getOne may filter on import job state subfields (importJobState.CREATE /
// .UPDATE / .FIX), which are spliced straight into the Mongo filter, so a
// $-operator key or an object value would inject operators: restrict the keys
// to the known operations and the values to plain state strings.
export function assertImportJobStateFilter(value: Record<string, unknown>, name: string) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(httpStatus.BAD_REQUEST, `${name} must be an object`);
  }
  const validKeys = Object.values(OPERATIONS).map(operation => `importJobState.${operation}`);
  for (const [key, state] of Object.entries(value)) {
    if (!validKeys.includes(key)) {
      throw new ApiError(httpStatus.BAD_REQUEST, `${name} key ${key} must be one of ${validKeys.join(', ')}`);
    }
    if (typeof state !== 'string') {
      throw new ApiError(httpStatus.BAD_REQUEST, `${name}.${key} must be a string`);
    }
  }
}

/**
 * Create an importJobState object, optionally keyed by the dotted query form
 */
export function createImportJobState(operation: string, state: string, queryImportJobState = false): Record<string, string> {
  if (!(state in IMPORT_JOB_STATE)) {
    throw new Error('Invalid IMPORT_JOB_STATE');
  }

  if (!(operation in OPERATIONS)) {
    throw new Error('Invalid operation');
  }

  if (queryImportJobState) {
    const importJobStateWithOperation = `importJobState.${operation}`;
    const importJobStateForQuery: Record<string, string> = {[importJobStateWithOperation]: state};

    return importJobStateForQuery;
  }

  return {[operation]: state};
}

// responsePayload, responseStatus and the mongoOperator are dynamic shapes
// (any) on purpose, matching the JSDoc baseline; tighten when the calling
// services and mongo.js are converted
export function createRecordResponseItem(params: {
  responsePayload?: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  responseStatus: number | string;
  recordMetadata?: unknown;
  id?: string;
}) {
  const {responsePayload, responseStatus, recordMetadata, id} = params;
  // symmetric with addRecordResponseItem — reject a missing payload up
  // front with a clear message instead of a raw TypeError further down.
  // Strings are a valid payload form (see getMessageFromResponsePayload),
  // so only undefined/null are rejected.
  if (responsePayload === undefined || responsePayload === null) {
    throw new Error('responsePayload must be an object or a string!');
  }

  const recordResponseStatusAndMessage = getRecordResponseStatusAndMessage(responseStatus, responsePayload, id);
  const recordResponseItem = {
    databaseId: id || '000000000',
    recordMetadata: responsePayload.recordMetadata || recordMetadata || undefined,
    ...recordResponseStatusAndMessage
  };
  return recordResponseItem;
}

function getRecordResponseStatusAndMessage(responseStatus: any, responsePayload: any, id: string | undefined) { // eslint-disable-line @typescript-eslint/no-explicit-any

  logger.debug(`Response status: ${responseStatus} responsePayload: ${JSON.stringify(responsePayload)}`);
  //const responseStatusName = httpStatus[`${responseStatus}_NAME`];
  //logger.debug(`Response status name: ${responseStatusName}`);

  const message = getMessageFromResponsePayload(responsePayload);
  const ids = responsePayload.ids || [];

  logger.debug(`Response message: ${message}`);

  // We map responseStatus here for a wider recordStatus and more detailed detailedRecordStatus
  // recordStatus corresponds to RECORD_IMPORT_STATEs used in https://github.com/NatLibFi/melinda-record-import-commons-js

  // Non-http statuses
  if (['UPDATED', 'CREATED', 'INVALID', 'ERROR', 'SKIPPED', 'FIXED'].includes(responseStatus)) {
    return {recordStatus: responseStatus, detailedRecordStatus: responseStatus, message};
  }

  // More detailed SKIPPED statuses
  if (['SKIPPED_CHANGE', 'SKIPPED_UPDATE'].includes(responseStatus)) {
    return {recordStatus: 'SKIPPED', detailedRecordStatus: responseStatus, message};
  }

  if (['UNKNOWN'].includes(responseStatus)) {
    return {recordStatus: 'ERROR', detailedRecordStatus: responseStatus, message, ids};
  }

  // Duplicates and other CONFLICT statuses
  if ([httpStatus.CONFLICT, 'CONFLICT'].includes(responseStatus)) {
    if ((/^Duplicates in database/u).test(message)) {
      return {recordStatus: 'DUPLICATE', detailedRecordStatus: 'DUPLICATE', message, ids};
    }
    if ((/^MatchValidation for all/u).test(message)) {
      return {recordStatus: 'ERROR', detailedRecordStatus: 'CONFLICT', message, ids};
    }

    // Use ids only if there are more than one id or the id in payload does not match databaseId
    // only compare ids[0] when there is at least one id
    if (ids.length > 1 || (ids.length > 0 && ids[0] !== id)) {
      return {recordStatus: 'ERROR', detailedRecordStatus: 'CONFLICT', message, ids};
    }
    return {recordStatus: 'ERROR', detailedRecordStatus: 'CONFLICT', message};
  }

  if ([httpStatus.UNPROCESSABLE_ENTITY, 'UNPROCESSABLE_ENTITY'].includes(responseStatus)) {
    // only compare ids[0] when there is at least one id
    if (ids.length > 1 || (ids.length > 0 && ids[0] !== id)) {
      return {recordStatus: 'INVALID', detailedRecordStatus: 'UNPROCESSABLE_ENTITY', message, ids};
    }
    return {recordStatus: 'INVALID', detailedRecordStatus: 'UNPROCESSABLE_ENTITY', message};
  }

  if ([httpStatus.NOT_FOUND, 'NOT_FOUND'].includes(responseStatus)) {
    return {recordStatus: 'ERROR', detailedRecordStatus: 'NOT_FOUND', message};
  }

  if ([httpStatus.FORBIDDEN, 'FORBIDDEN'].includes(responseStatus)) {
    return {recordStatus: 'ERROR', detailedRecordStatus: 'FORBIDDEN', message};
  }

  // Otherwise
  logger.debug(`Unknown responseStatus: ${responseStatus}`);
  const newMessage = `${message} - Unknown recordStatus: ${responseStatus}`;
  return {recordStatus: 'ERROR', detailedRecordStatus: responseStatus, message: newMessage};
}

function getMessageFromResponsePayload(responsePayload: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (responsePayload.message) {
    return responsePayload.message;
  }
  if (typeof responsePayload === 'string' || responsePayload instanceof String) {
    return responsePayload;
  }
  return '';
}

/**
 * Add one recordResponseItem to the records field of a queueItem
 */
export async function addRecordResponseItem({
  recordResponseItem,
  correlationId,
  mongoOperator
}: {
  recordResponseItem: unknown;
  correlationId: string;
  mongoOperator: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}): Promise<boolean> {
  // symmetric with addRecordResponseItems — reject non-object input
  // (including arrays) before it gets pushed into the records field
  if (!recordResponseItem || typeof recordResponseItem !== 'object' || Array.isArray(recordResponseItem)) {
    throw new Error('RecordResponseItem is not an object!');
  }
  await mongoOperator.pushMessages({correlationId, messages: [recordResponseItem], messageField: 'records'});
  return true;
}

// Use addRecordResponseItems to add several recordResponseItems in one mongo operation to avoid writeconflicts
/**
 * Add several recordResponseItems to the records field of a queueItem in one mongo operation
 */
export async function addRecordResponseItems({
  recordResponseItems,
  correlationId,
  mongoOperator
}: {
  recordResponseItems: unknown;
  correlationId: string;
  mongoOperator: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}): Promise<boolean> {
  if (!Array.isArray(recordResponseItems)) {
    throw new Error('RecordResponseItems is not an array!');
  }
  await mongoOperator.pushMessages({correlationId, messages: recordResponseItems, messageField: 'records'});
  return true;
}
