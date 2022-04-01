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
  const recordResponseStatus = getRecordResponseStatus(responseStatus, responsePayload);
  const recordResponseItem = {
    melindaId: id || '000000000',
    recordMetadata: recordMetadata || undefined,
    ...recordResponseStatus
  };
  return recordResponseItem;
}

export function getRecordResponseStatus(responseStatus, responsePayload) {

  logger.verbose(`Response status: ${responseStatus} responsePayload: ${JSON.stringify(responsePayload)}`);
  const responseStatusName = httpStatus[`${responseStatus}_NAME`];
  logger.verbose(`Response status name: ${responseStatusName}`);

  // Non-http statuses
  if (['UPDATED', 'CREATED', 'INVALID', 'ERROR', 'UNKNOWN'].includes(responseStatus)) {
    return {status: responseStatus, message: responsePayload};
  }

  // Duplicates and other conflicts
  if ([httpStatus.CONFLICT, 'CONFLICT'].includes(responseStatus)) {
    if ((/^Duplicates in database/u).test(responsePayload.message)) {
      return {status: 'DUPLICATE', message: responsePayload.message, duplicateIds: responsePayload.ids};
    }
    return {status: 'CONFLICT', message: responsePayload.message};
  }

  if ([httpStatus.UNPROCESSABLE_ENTITY, 'UNPROCESSABLE_ENTITY'].includes(responseStatus)) {
    return {status: 'UNPROCESSABLE_ENTITY', message: responsePayload};
  }

  if ([httpStatus.NOT_FOUND, 'NOT_FOUND'].includes(responseStatus)) {
    return {status: 'NOT_FOUND', message: responsePayload};
  }

  return {status: 'ERROR', message: responsePayload};
}

export async function addRecordResponseItem({recordResponseItem, correlationId, mongoOperator}) {
  await mongoOperator.pushMessages({correlationId, messages: [recordResponseItem], messageField: 'records'});
  return true;
}

