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
import {LOG_ITEM_TYPE} from './constants';
import {DateTime} from 'luxon';

export default async function (MONGO_URI, dbName = 'rest-api') {
  const logger = createLogger();

  // Connect to mongo (MONGO)
  const client = await MongoClient.connect(MONGO_URI, {useNewUrlParser: true, useUnifiedTopology: true});
  const db = client.db(dbName);
  const collection = 'logs';
  return {addLogItem, query, queryById, getListOfLogs, getListOfCatalogers, getExpandedListOfLogs, protect, remove, removeBySequences};

  async function addLogItem(logItem) {
    const time = moment().toDate();
    const newLogItem = {
      ...logItem,
      creationTime: time,
      protected: false
    };
    try {
      // console.log(newLogItem); // eslint-disable-line
      checkLogItemType(logItem.logItemType, false);
      const result = await db.collection(collection).insertOne(newLogItem);
      if (result.acknowledged) {
        const {blobSequence, blobSequenceStart, blobSequenceEnd} = logItem;
        const itemString = blobSequenceStart && blobSequenceEnd ? `${blobSequenceStart} - ${blobSequenceEnd}` : `${blobSequence}`;
        logger.info(`*** New ${logItem.logItemType} added for ${logItem.correlationId}, blobSequence(s): ${itemString}. ***`);
        // console.log('addLogItem done', result); // eslint-disable-line
        return;
      }
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR);
    } catch (error) {
      const errorMessage = error.payload || error.message || '';
      logError(error);
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Mongo errored: ${errorMessage}`);
    }
  }

  async function query(params) {
    logger.debug(`Query params: ${JSON.stringify(params)}`);
    checkLogItemType(params.logItemType, false, false);
    const {limit = 5, skip = 0, ...rest} = params;
    logger.debug(`Actual query params: ${JSON.stringify(rest)}`);
    const result = await db.collection(collection) // eslint-disable-line functional/immutable-data
      .find(rest)
      .sort({creationTime: 1})
      .skip(parseInt(skip, 10))
      .limit(parseInt(limit, 10))
      .toArray();
    //logger.debug(`Query result: ${result}`);
    logger.debug(`Query result: ${result.length > 0 ? `Found ${result.length} log items! (skip: ${skip} limit: ${limit})` : 'Not found!'}`);
    return result;
  }

  // DEVELOP: queryById returns jsut one (randomish) log! is this useful?
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

  // getListOfLogs returns list of correlationIds that have logs of given logItemType
  // if logItemType is not given, getListOfLogs returns list of correlationIds that have MERGE_LOG
  async function getListOfLogs(logItemType = LOG_ITEM_TYPE.MERGE_LOG) {
    // checkLogItemType(logItemType, false, false);
    const result = await db.collection(collection) // eslint-disable-line functional/immutable-data
      .distinct('correlationId', {logItemType});
    logger.debug(`Query result: ${result.length > 0 ? `Found ${result.length} log items!` : 'Not found!'}`);
    return result;
  }

  async function getListOfCatalogers() {
    logger.debug(`Getting list of Catalogers`);

    const result = await db.collection(collection) // eslint-disable-line functional/immutable-data
      .distinct('cataloger');

    return result;
  }

  // getExpandedListOfLogs returns groped MERGE_LOGs and MATCH_LOGs
  async function getExpandedListOfLogs({logItemTypes = [LOG_ITEM_TYPE.MERGE_LOG, LOG_ITEM_TYPE.MATCH_LOG], catalogers = [], dateBefore = new Date(), dateAfter = '2000-01-01', test = false}) {
    logger.debug(`commons: logItemTypes: ${JSON.stringify(logItemTypes)}, dateAfter: ${dateAfter}, dateBefore: ${dateBefore}}, catalogers: ${JSON.stringify(catalogers)}`);
    logger.debug(JSON.stringify(generateMatchObject(logItemTypes, catalogers, dateBefore, dateAfter))); // eslint-disable-line
    //checkLogItemType(logItemType, false, false);
    logger.debug(`Getting expanded list of logs`);
    const pipeline = [
      // currently return only MERGE_LOG and MATCH_LOG
      generateMatchObject(logItemTypes, catalogers, dateBefore, dateAfter, test),
      {
        '$sort':
          {'correlationId': 1, 'logItemType': 1, 'creationTime': 1}
      },
      {
        '$group':
        {
          '_id': {'correlationId': '$correlationId', 'logItemType': '$logItemType'},
          'creationTime': {'$first': '$creationTime'},
          'cataloger': {'$first': '$cataloger'},
          'logCount': {'$sum': 1}
        }
      },
      {
        '$sort':
          {'correlationId': 1, 'logItemType': 1, 'creationTime': 1}
      }
    ];

    const result = await db.collection(collection) // eslint-disable-line functional/immutable-data
      .aggregate(pipeline)
      .toArray();

    const fixedResult = result.map((logListing) => {
      const {correlationId, logItemType} = logListing._id;
      const {cataloger, creationTime, logCount} = logListing;
      return {correlationId, logItemType, cataloger, creationTime, logCount};
    });

    logger.silly(`Query result: ${JSON.stringify(result)}`);
    logger.silly(`Query result: ${JSON.stringify(fixedResult)}`);

    logger.debug(`Query result: ${fixedResult.length > 0 ? `Found ${fixedResult.length} log items!` : 'Not found!'}`);
    return fixedResult;

    function generateMatchObject(logItemTypes, catalogers, dateBefore, dateAfter, test = false) {
      const matchOptions = {
        '$match': {
          'logItemType': logItemTypes.length > 0 ? {'$in': logItemTypes} : /.*/ui,
          'cataloger': catalogers.length > 0 ? {'$in': catalogers} : /.*/ui,
          'creationTime': {
            '$gte': !test ? new Date(dateAfter) : DateTime.fromJSDate(new Date(dateAfter)).startOf('day').toISODate(),
            '$lte': !test ? new Date(dateBefore) : DateTime.fromJSDate(new Date(dateBefore)).endOf('day').toISODate()
          }
        }
      };

      return matchOptions;
    }
  }

  async function protect(correlationId, blobSequence) {
    logger.info(`Protecting in Mongo (${collection}) correlationId: ${correlationId}, blobSequence: ${blobSequence}`);
    const cleanCorrelationId = sanitize(correlationId);
    const cleanBlobSequence = sanitize(blobSequence);
    const filter = blobSequence ? {correlationId: cleanCorrelationId, blobSequence: parseInt(cleanBlobSequence, 10)} : {correlationId: cleanCorrelationId};

    try {
      const result = await db.collection(collection).updateMany(
        filter,
        [
          {
            $set: {
              modificationTime: moment().toDate(),
              protected: {$not: '$protected'}
            }
          }
        ]
      );
      return result;
    } catch (error) {
      const errorMessage = error.payload || error.message || '';
      logError(error);
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Mongo errored: ${errorMessage}`);
    }
  }

  async function remove(correlationId, force = false) {
    logger.info(`Removing from Mongo (${collection}) correlationId: ${correlationId}`);
    const clean = sanitize(correlationId);
    const filter = force ? {correlationId: clean} : {correlationId: clean, protected: {$ne: true}};

    try {
      const result = await db.collection(collection).deleteMany(filter);
      return result;
    } catch (error) {
      const errorMessage = error.payload || error.message || '';
      logError(error);
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Mongo errored: ${errorMessage}`);
    }
  }

  async function removeBySequences(correlationId, sequences = [], force = false) {
    logger.info(`Removing from Mongo (${collection}) correlationId: ${correlationId}, sequences: ${sequences.length}`);
    const clean = sanitize(correlationId);
    // blobSequences are integers that start from 1
    // we accept also strings that are convertilble to integers greated than 0
    const cleanSequences = sequences.filter(sequence => Number.isInteger(Number(sequence)) && sequence > 0);

    if (sequences.length !== cleanSequences.length) {
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Invalid sequences in removeBySequences. Sequences should be positive integers`);
    }

    const filter = force ? {correlationId: clean, blobSequence: {$in: cleanSequences}} : {correlationId: clean, blobSequence: {$in: sequences}, protected: {$ne: true}};

    try {
      const result = await db.collection(collection).deleteMany(filter);
      return result;
    } catch (error) {
      const errorMessage = error.payload || error.message || '';
      logError(error);
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Mongo errored: ${errorMessage}`);
    }
  }

  function checkLogItemType(logItemType, errorUnknown = false, errorNotExisting = false) {
    if (logItemType) {
      const typeInLogItemTypes = Object.values(LOG_ITEM_TYPE).indexOf(logItemType) > -1;
      if (typeInLogItemTypes) {
        return logger.debug(`Valid logItemType: ${logItemType}`);
      }
      if (errorUnknown) {
        throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Unknown logItemType: ${logItemType}`);
      }
      return logger.debug(`WARN: We have unknown logType: ${logItemType}`);
    }

    if (errorNotExisting) {
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `No logItemType: ${logItemType}`);
    }
    return logger.debug(`No logItemType: ${logItemType}`);
  }
}
