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
  return {addLogItem, query, queryById, remove};

  async function addLogItem(logItem) {
    const time = moment().toDate();
    const newLogItem = {
      ...logItem,
      creationTime: time
    };
    try {
      const result = await db.collection(collection).insertOne(newLogItem);
      if (result.acknowledged) {
        logger.info(`New log item added.`);
        return;
      }
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR);
    } catch (error) {
      logError(error);
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR);
    }
  }


  async function query(params) {
    const result = await db.collection(collection).find({params});
    logger.debug(`Query result: ${result.length > 0 ? 'Found!' : 'Not found!'}`);
    return result;
  }

  async function queryById(correlationId) {
    const result = await db.collection(collection).find({correlationId});
    return result;
  }

  async function remove(params) {
    logger.silly(`${JSON.stringify(params)}`);
    logger.info(`Removing from Mongo (${collection}) correlationId: ${params.correlationId}`);
    const clean = sanitize(params.correlationId);
    logger.silly(`mongo/remove: clean: ${JSON.stringify(clean)}`);

    try {
      await db.collection(collection).deleteMany({correlationId: clean});
      return true;
    } catch (err) {
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, err.message);
    }
  }
}
