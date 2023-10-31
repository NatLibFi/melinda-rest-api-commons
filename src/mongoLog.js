/**
*
* @licstart  The following is the entire license notice for the JavaScript code in this file.
*
* Shared modules for microservices of Melinda rest api batch import system
*
* Copyright (C) 2020-2023 University Of Helsinki (The National Library Of Finland)
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

/**
 * Create log operator
 * @param {String} MONGO_URI connnection address to mongo
 * @param {String} dbName Mongo DB name, defaults 'rest-api
 * @returns {Object} containing all log handling functions
 */
export default async function (MONGO_URI, dbName = 'rest-api') {
  const logger = createLogger();

  // Connect to mongo (MONGO)
  const client = await MongoClient.connect(MONGO_URI, {useNewUrlParser: true, useUnifiedTopology: true});
  const db = client.db(dbName);
  const collection = 'logs';
  return {addLogItem, query, queryById, getListOfLogs, getListOfCatalogers, getExpandedListOfLogs, protect, remove, removeBySequences};

  /**
   * Add log item to collection
   * @param {Object}} logItem contains log item data
   * @returns void
   */
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

  /**
   * Querry log items
   * @param {Integer} limit defaults 5
   * @param {Integer} skip defaults 0
   * @param {Object} rest query params
   * @returns result array
   */
  async function query({limit = 5, skip = 0, ...rest}) {
    logger.debug(`Query params: ${JSON.stringify(rest)}`);
    logger.debug(`Limit and skip params: ${limit} | ${skip}`);
    checkLogItemType(rest.logItemType, false, false);
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
  /**
   * Get single log item by correlationId
   * @param {String} correlationId
   * @param {String} logItemType contant LOG_ITEM_TYPE defaults LOG_ITEM_TYPE.MERGE_LOG
   * @param {Integer} skip defaults 0
   * @param {Integer} limit defaults 1
   * @returns query result array
   */
  async function queryById(correlationId, logItemType = LOG_ITEM_TYPE.MERGE_LOG, skip = 0, limit = 1) {
    logger.debug(`QueryById: ${correlationId}`);
    const result = await db.collection(collection) // eslint-disable-line functional/immutable-data
      .find({correlationId, logItemType})
      .sort({blobSequence: 1})
      .skip(parseInt(skip, 10))
      .limit(parseInt(limit, 10))
      .toArray();
    logger.debug(`Query result: ${result.length > 0 ? `Found ${result.length} log items!` : 'Not found!'}`);
    return result;
  }

  // getListOfLogs returns list of correlationIds that have logs of given logItemType
  // if logItemType is not given, getListOfLogs returns list of correlationIds that have MERGE_LOG
  /**
   * Get list correlationId of logs filtered by logItemType
   * @param {String} logItemType contant LOG_ITEM_TYPE defaults LOG_ITEM_TYPE.MERGE_LOG
   * @returns Array of query results
   */
  async function getListOfLogs(logItemType = LOG_ITEM_TYPE.MERGE_LOG) {
    // checkLogItemType(logItemType, false, false);
    const result = await db.collection(collection) // eslint-disable-line functional/immutable-data
      .distinct('correlationId', {logItemType});
    logger.debug(`Query result: ${result.length > 0 ? `Found ${result.length} log items!` : 'Not found!'}`);
    return result;
  }

  /**
   * Get list of catalogers from logs
   * @returns Array of query results
   */
  async function getListOfCatalogers() {
    logger.debug(`Getting list of Catalogers`);

    const result = await db.collection(collection) // eslint-disable-line functional/immutable-data
      .distinct('cataloger');

    return result;
  }

  /**
   * Get filtered list of logs with extra info. Give params in Object
   * @param {[String]} logItemTypes: String array of logItemTypes. Defaults [LOG_ITEM_TYPE.MERGE_LOG, LOG_ITEM_TYPE.MATCH_LOG]
   * @param {[String]} catalogers: String array of wanted catalogers. Defaults []
   * @param {String} dateBefore: String date schema 'YYYY-MM-DD'. Defaults new Date()
   * @param {String} dateAfter: String date schema 'YYYY-MM-DD'. Defaults '2000-01-01'
   * @param {Boolean} test: Boolean is this test run. Defaults false
   * @returns Parsed Object {'correlationId', 'logItemType', 'creationTime', 'cataloger', 'logCount'}
   */
  async function getExpandedListOfLogs({logItemTypes = [LOG_ITEM_TYPE.MERGE_LOG, LOG_ITEM_TYPE.MATCH_LOG], catalogers = [], dateBefore = new Date(), dateAfter = '2000-01-01', test = false}) {
    logger.debug(`commons: logItemTypes: ${JSON.stringify(logItemTypes)}, dateAfter: ${dateAfter}, dateBefore: ${dateBefore}}, catalogers: ${JSON.stringify(catalogers)}`);
    logger.debug(JSON.stringify(generateMatchObject({logItemTypes, catalogers, dateBefore, dateAfter}))); // eslint-disable-line
    //checkLogItemType(logItemType, false, false);
    logger.debug(`Getting expanded list of logs`);
    const pipeline = [
      // currently return only MERGE_LOG and MATCH_LOG
      generateMatchObject({logItemTypes, catalogers, dateBefore, dateAfter, test}),
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

    /**
     * Generate match object for aggregation pipeline
     * @param {[String]} logItemTypes: String array of logItemTypes.
     * @param {[String]} catalogers: String array of wanted catalogers
     * @param {String} dateBefore: String date schema 'YYYY-MM-DD'
     * @param {String} dateAfter: String date schema 'YYYY-MM-DD'
     * @param {Boolean} test: Boolean is this test run. Defaults false
     * @returns Match Object
     */
    function generateMatchObject({logItemTypes, catalogers, dateBefore, dateAfter, test = false}) {
      const matchOptions = {
        '$match': {
          'logItemType': logItemTypes.length > 0 ? {'$in': logItemTypes} : /.*/ui,
          'cataloger': catalogers.length > 0 ? {'$in': catalogers} : /.*/ui,
          'creationTime': {
            '$gte': test ? new Date(dateAfter).toISOString() : new Date(dateAfter),
            '$lte': test ? new Date(dateBefore).toISOString() : new Date(dateBefore)
          }
        }
      };

      return matchOptions;
    }
  }

  /**
   * Protect logs from cleaning. Forced cleaning defaults 30days
   * @param {String} correlationId
   * @param {Integer} blobSequence
   * @returns result
   */
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

  /**
   * Remove logs
   * @param {String} correlationId
   * @param {Boolean} force defaults false
   * @returns result
   */
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

  /**
   * Remove logs by sequences
   * @param {String} correlationId
   * @param {[Integer]} sequences
   * @param {Boolean} force defaults false
   * @returns result
   */
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

  /**
   * Checks validy of logItemType
   * @param {String} logItemType
   * @param {Boolean} errorUnknown
   * @param {Boolean} errorNotExisting
   * @returns void
   */
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
