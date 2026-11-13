import httpStatus from 'http-status';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {Error as ApiError} from '@natlibfi/melinda-commons';
import {IMPORT_JOB_STATE, OPERATIONS} from './constants.js';

const logger = createLogger();

export function logError(err) {
  if (err instanceof ApiError) {
    logger.error(JSON.stringify(err));
    return;
  }

  if (err === 'SIGINT') {
    logger.error(err);
    return;
  }

  logger.error(err.stack === undefined ? err : err.stack);
}

export function createImportJobState(operation, state, queryImportJobState = false) {
  if (!(state in IMPORT_JOB_STATE)) {
    throw new Error('Invalid IMPORT_JOB_STATE');
  }

  if (!(operation in OPERATIONS)) {
    throw new Error('Invalid operation');
  }

  if (queryImportJobState) {
    const importJobStateWithOperation = `importJobState.${operation}`;
    const importJobStateForQuery = {[importJobStateWithOperation]: state};

    return importJobStateForQuery;
  }

  return {[operation]: state};
}

export function createRecordResponseItem({responsePayload, responseStatus, recordMetadata, id}) {
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

function getRecordResponseStatusAndMessage(responseStatus, responsePayload, id) {

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

function getMessageFromResponsePayload(responsePayload) {
  if (responsePayload.message) {
    return responsePayload.message;
  }
  if (typeof responsePayload === 'string' || responsePayload instanceof String) {
    return responsePayload;
  }
  return '';
}

export async function addRecordResponseItem({recordResponseItem, correlationId, mongoOperator}) {
  // symmetric with addRecordResponseItems — reject non-object input
  // (including arrays) before it gets pushed into the records field
  if (!recordResponseItem || typeof recordResponseItem !== 'object' || Array.isArray(recordResponseItem)) {
    throw new Error('RecordResponseItem is not an object!');
  }
  await mongoOperator.pushMessages({correlationId, messages: [recordResponseItem], messageField: 'records'});
  return true;
}

// Use addRecordResponseItems to add several recordResponseItems in one mongo operation to avoid writeconflicts
export async function addRecordResponseItems({recordResponseItems, correlationId, mongoOperator}) {
  if (!Array.isArray(recordResponseItems)) {
    throw new Error('RecordResponseItems is not an array!');
  }
  await mongoOperator.pushMessages({correlationId, messages: recordResponseItems, messageField: 'records'});
  return true;
}

