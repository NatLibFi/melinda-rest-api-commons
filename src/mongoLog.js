/**
*
* @licstart  The following is the entire license notice for the JavaScript code in this file.
*
* Shared modules for microservices of Melinda rest api batch import system
*
* Copyright (C) 2020-2022 University Of Helsinki (The National Library Of Finland)
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

import {MongoClient} from 'mongodb';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {Error as ApiError} from '@natlibfi/melinda-commons';
import {logError} from './utils.js';
import moment from 'moment';
import httpStatus from 'http-status';
import sanitize from 'mongo-sanitize';

export default async function (MONGO_URI) {
  const logger = createLogger();

  // Connect to mongo (MONGO)
  const client = await MongoClient.connect(MONGO_URI, {useNewUrlParser: true, useUnifiedTopology: true});
  const db = client.db('rest-api');
  const collection = 'logs';
  return {addLogItem, query, queryById, getListOfLogs, protect, remove};

  async function addLogItem(logItem) {
    const time = moment().toDate();
    const newLogItem = {
      ...logItem,
      creationTime: time,
      protected: false
    };
    try {
      const result = await db.collection(collection).insertOne(newLogItem);
      if (result.acknowledged) {
        logger.info(`*** New ${logItem.logItemType} added for ${logItem.correlationId} items ${logItem.blobSequenceStart}-${logItem.blobSequenceEnd}. ***`);
        return;
      }
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR);
    } catch (error) {
      logError(error);
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  async function query(params) {
    logger.debug(`Query params: ${JSON.stringify(params)}`);
    const {limit = 5, skip = 0, ...rest} = params;
    const result = await db.collection(collection) // eslint-disable-line functional/immutable-data
      .find(rest)
      .sort({blobSequence: 1})
      .skip(parseInt(skip, 10))
      .limit(parseInt(limit, 10))
      .toArray();
    logger.debug(result);
    logger.debug(`Query result: ${result.length > 0 ? `Found ${result.length} log items! (skip: ${skip} limit: ${limit})` : 'Not found!'}`);
    return result;
  }

  async function queryById(correlationIdString, skip = 0, limit = 1) {
    logger.debug(`QueryById: ${correlationIdString}`);
    const result = await db.collection(collection) // eslint-disable-line functional/immutable-data
      .find({correlationId: correlationIdString})
      .sort({blobSequence: 1})
      .skip(parseInt(skip, 10))
      .limit(parseInt(limit, 10))
      .toArray();
    logger.debug(`Query result: ${result.length > 0 ? `Found ${result.length} log items!` : 'Not found!'}`);
    return result;
  }

  async function getListOfLogs(logItemType = 'MERGE_LOG') {
    const result = await db.collection(collection) // eslint-disable-line functional/immutable-data
      .distinct('correlationId', {logItemType})
      logger.debug(`Query result: ${result.length > 0 ? `Found ${result.length} log items!` : 'Not found!'}`);
      return {status: result.length > 0 ? httpStatus.OK : httpStatus.NOT_FOUND, payload: result.length > 0 ? result : 'No logs found'};
  }

  async function protect(correlationId, blobSequence) {
    logger.info(`Removing from Mongo (${collection}) correlationId: ${correlationId}, blobSequence: ${blobSequence}`);
    const cleanCorrelationId = sanitize(correlationId);
    const cleanBlobSequence = sanitize(blobSequence);
    const filter = blobSequence ? {correlationId: cleanCorrelationId, blobSequence: cleanBlobSequence} : {correlationId: cleanCorrelationId};

    try {
      const result = await db.collection(collection).updateMany(
        filter,
        {
          $set: {
            modificationTime: moment().toDate(),
            protect: {$not: "$protect"}
          }
        });
      return {status: result.modifiedCount > 0 ? httpStatus.OK : httpStatus.NOT_FOUND, payload: result.modifiedCount > 0 ? result : 'No logs found'};
    } catch (err) {
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, err.message);
    }
  }

  async function remove(correlationId, force = false) {
    logger.info(`Removing from Mongo (${collection}) correlationId: ${correlationId}`);
    const clean = sanitize(correlationId);
    const filter = force ? {correlationId: clean} : {correlationId: clean, protected: {$ne: true}};

    try {
      const result = await db.collection(collection).deleteMany(filter);
      return {status: result.deletedCount > 0 ? httpStatus.OK : httpStatus.NOT_FOUND, payload: result.deletedCount > 0 ? result : 'No logs found'};
    } catch (err) {
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, err.message);
    }
  }
}
