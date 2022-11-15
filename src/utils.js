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

import {createLogger} from '@natlibfi/melinda-backend-commons';
import {Error as ApiError} from '@natlibfi/melinda-commons';
import {IMPORT_JOB_STATE, OPERATIONS} from './constants';
import httpStatus from 'http-status';

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
  const recordResponseStatusAndMessage = getRecordResponseStatusAndMessage(responseStatus, responsePayload, id);
  const recordResponseItem = {
    databaseId: id || '000000000',
    recordMetadata: responsePayload.recordMetadata || recordMetadata || undefined,
    ...recordResponseStatusAndMessage
  };
  return recordResponseItem;
}

// eslint-disable-next-line max-statements
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
  if (['UPDATED', 'CREATED', 'INVALID', 'ERROR', 'SKIPPED'].includes(responseStatus)) {
    return {recordStatus: responseStatus, detailedRecordStatus: responseStatus, message};
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
    if (ids.length > 1 || ids[0] !== id) {
      return {recordStatus: 'ERROR', detailedRecordStatus: 'CONFLICT', message, ids};
    }
    return {recordStatus: 'ERROR', detailedRecordStatus: 'CONFLICT', message};
  }

  if ([httpStatus.UNPROCESSABLE_ENTITY, 'UNPROCESSABLE_ENTITY'].includes(responseStatus)) {
    if (ids.length > 1 || ids[0] !== id) {
      return {recordStatus: 'INVALID', detailedRecordStatus: 'UNPROCESSABLE_ENTITY', message, ids};
    }
    return {recordStatus: 'INVALID', detailedRecordStatus: 'UNPROCESSABLE_ENTITY', message};
  }

  if ([httpStatus.NOT_FOUND, 'NOT_FOUND'].includes(responseStatus)) {
    return {recordStatus: 'ERROR', detailedRecordStatus: 'NOT_FOUND', message};
  }

  // Otherwise
  return {recordStatus: 'ERROR', detailedRecordStatus: responseStatus, message};
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

