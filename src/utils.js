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
  const recordResponseStatusAndMessage = getRecordResponseStatusAndMessage(responseStatus, responsePayload);
  const recordResponseItem = {
    databaseId: id || '000000000',
    recordMetadata: responsePayload.recordMetadata || recordMetadata || undefined,
    ...recordResponseStatusAndMessage
  };
  return recordResponseItem;
}

function getRecordResponseStatusAndMessage(responseStatus, responsePayload) {

  logger.debug(`Response status: ${responseStatus} responsePayload: ${JSON.stringify(responsePayload)}`);
  const responseStatusName = httpStatus[`${responseStatus}_NAME`];
  logger.debug(`Response status name: ${responseStatusName}`);

  const message = getMessageFromResponsePayload(responsePayload);

  logger.debug(`Response message: ${message}`);

  // Non-http statuses
  if (['UPDATED', 'CREATED', 'INVALID', 'ERROR'].includes(responseStatus)) {
    return {status: responseStatus, message};
  }

  if (['UNKNOWN'].includes(responseStatus)) {
    const possibleIds = responsePayload.ids || [];
    return {status: responseStatus, message, possibleIds};
  }

  // Duplicates and other CONFLICT statuses
  if ([httpStatus.CONFLICT, 'CONFLICT'].includes(responseStatus)) {
    if ((/^Duplicates in database/u).test(message)) {
      const duplicateIds = responsePayload.ids || [];
      return {status: 'DUPLICATE', message, duplicateIds};
    }
    return {status: 'CONFLICT', message};
  }

  if ([httpStatus.UNPROCESSABLE_ENTITY, 'UNPROCESSABLE_ENTITY'].includes(responseStatus)) {
    return {status: 'UNPROCESSABLE_ENTITY', message};
  }

  if ([httpStatus.NOT_FOUND, 'NOT_FOUND'].includes(responseStatus)) {
    return {status: 'NOT_FOUND', message};
  }

  // Otherwise
  return {status: 'ERROR', message};
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

