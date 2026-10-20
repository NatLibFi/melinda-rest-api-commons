import {MongoClient} from 'mongodb';
import httpStatus from 'http-status';
import {createLogger, Error as ApiError} from '@natlibfi/melinda-commons';
import {logError, assertString} from './utils.js';
import {LOG_ITEM_TYPE} from './constants.js';

/**
 * Create log operator
 * @param {String} MONGO_URI connnection address to mongo
 * @param {String} dbName Mongo DB name, defaults 'rest-api'
 * @returns {Object} containing all log handling functions
 */
export default async function (MONGO_URI, dbName = 'rest-api') {
  const logger = createLogger();

  // blobSequence filters: falsy/undefined keeps the legacy behaviour (no
  // blobSequence in the filter). Otherwise a number or a string parseable
  // to an integer (existing parseInt behaviour) is accepted, anything else
  // is rejected with 400.
  function buildBlobSequenceFilter(correlationId, blobSequence) {
    if (!blobSequence) {
      return {correlationId};
    }
    if (typeof blobSequence === 'number') {
      return {correlationId, blobSequence: parseInt(blobSequence, 10)};
    }
    if (typeof blobSequence === 'string') {
      const parsed = parseInt(blobSequence, 10);
      if (!Number.isNaN(parsed)) {
        return {correlationId, blobSequence: parsed};
      }
    }
    throw new ApiError(httpStatus.BAD_REQUEST, 'blobSequence must be a number or a numeric string');
  }

  // Connect to mongo (MONGO)
  const client = await MongoClient.connect(MONGO_URI);
  const db = client.db(dbName);
  const collection = 'logs';
  return {addLogItem, query, queryById, getListOfLogs, getListOfCatalogers, getListOfCorrelationIds, getExpandedListOfLogs, protect, unprotect, remove, removeBySequences};

  /**
   * Add log item to collection
   * @param {Object} logItem contains log item data
   * @returns void
   */
  async function addLogItem(logItem) {
    const time = new Date();
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
   * Query log items
   * @param {Integer} limit defaults 5
   * @param {Integer} skip defaults 0
   * @param {Object} rest query params
   * @returns result array
   */
  async function query({limit = 5, skip = 0, ...rest}) {
    logger.debug(`Query params: ${JSON.stringify(rest)}`);
    logger.debug(`Limit and skip params: ${limit} | ${skip}`);
    checkLogItemType(rest.logItemType, false);
    // rest is an internal, trusted query object built by the calling service:
    // callers must not splice raw user input into it. Its keys may legitimately
    // use dot notation and $-operators, which is why rest is not
    // field-sanitized here.
    const result = await db.collection(collection)
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
   * @param {String} logItemType constant LOG_ITEM_TYPE defaults LOG_ITEM_TYPE.MERGE_LOG
   * @param {Integer} skip defaults 0
   * @param {Integer} limit defaults 1
   * @returns query result array
   */
  async function queryById(correlationId, logItemType = LOG_ITEM_TYPE.MERGE_LOG, skip = 0, limit = 1) {
    assertString(correlationId, 'correlationId');
    logger.debug(`QueryById: ${correlationId}, logItemType: ${logItemType}, skip: ${skip}, limit: ${limit}`);
    const result = await db.collection(collection)
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
   * Get list of correlationIds of logs filtered by logItemType
   * @param {String} logItemType constant LOG_ITEM_TYPE defaults LOG_ITEM_TYPE.MERGE_LOG
   * @returns Array of query results
   */
  async function getListOfLogs(logItemType = LOG_ITEM_TYPE.MERGE_LOG) {
    checkLogItemType(logItemType, true);
    //logger.debug(logItemType);
    // console.log(`${JSON.stringify(logItemType)}`);
    const result = await db.collection(collection)
      .distinct('correlationId', {logItemType: logItemType});
    logger.debug(`Query result for getListOfLogs: ${result.length > 0 ? `Found ${result.length} correlationIds for ${logItemType}!` : 'Not found!'}`);
    return result;
  }

  /**
   * Get list of catalogers from all available logs
   * @returns Array of query results
   */
  async function getListOfCatalogers() {
    logger.debug(`Getting list of Catalogers`);

    const result = await db.collection(collection)
      .distinct('cataloger');

    return result;
  }

  /**
   * Get list of correlationIds from all available logs
   * @returns Array of query results
   */
  async function getListOfCorrelationIds() {
    logger.debug(`Getting list of CorrelationIds`);

    const result = await db.collection(collection)
      .distinct('correlationId');

    return result;
  }


  /**
   * Get filtered list of logs with extra info. Give params in Object
   * @param {[String]} logItemTypes: String array of logItemTypes. Defaults [LOG_ITEM_TYPE.MERGE_LOG, LOG_ITEM_TYPE.MATCH_LOG]. When provided, must be an array and every element is validated (unknown types throw)
   * @param {[String]} catalogers: String array of wanted catalogers. Defaults []
   * @param {String|Date} dateBefore: upper bound, the day itself is EXCLUDED. 'YYYY-MM-DD' or Date, anchored to UTC. Defaults new Date()
   * @param {String|Date} dateAfter: lower bound, the day itself is INCLUDED. 'YYYY-MM-DD' or Date, anchored to UTC. Defaults '1970-01-01' (no lower bound)
   * @param {Boolean} test: kept for backwards compatibility only; no longer changes the match
   * @returns Parsed Object {'correlationId', 'logItemType', 'creationTime', 'cataloger', 'logCount'}
   */
  // test no longer changes the match behaviour (kept in the
  // signature for backwards compatibility only)
  // eslint-disable-next-line no-unused-vars
  async function getExpandedListOfLogs({logItemTypes, catalogers = [], dateBefore = new Date(), dateAfter = '1970-01-01', test = false}) {
    // An explicitly provided logItemTypes is validated per element (unknown
    // types throw); when it is omitted, the trusted default pair is used so
    // legacy callers that never pass it keep working unchanged
    const wantedLogItemTypes = logItemTypes === undefined
      ? [LOG_ITEM_TYPE.MERGE_LOG, LOG_ITEM_TYPE.MATCH_LOG]
      : logItemTypes;
    if (!Array.isArray(wantedLogItemTypes)) {
      throw new ApiError(httpStatus.BAD_REQUEST, `logItemTypes must be an array: ${logItemTypes}`);
    }
    if (logItemTypes !== undefined) {
      logItemTypes.forEach(logItemType => {
        if (Object.values(LOG_ITEM_TYPE).includes(logItemType)) {
          return;
        }
        throw new ApiError(httpStatus.BAD_REQUEST, `Unknown logItemType: ${logItemType}`);
      });
    }
    logger.debug(`commons/getExpandedListOfLogs: logItemTypes: ${JSON.stringify(wantedLogItemTypes)}, dateAfter: ${dateAfter}, dateBefore: ${dateBefore}}, catalogers: ${JSON.stringify(catalogers)}`);
    logger.silly(JSON.stringify(generateMatchObject({logItemTypes: wantedLogItemTypes, catalogers, dateBefore, dateAfter})));
    //logger.debug(`Getting expanded list of logs`);
    const pipeline = [
      // currently return only MERGE_LOG and MATCH_LOG
      generateMatchObject({logItemTypes: wantedLogItemTypes, catalogers, dateBefore, dateAfter}),
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
      // after $group the output has no top-level correlationId /
      // logItemType, so the sort must address them via _id
      {
        '$sort':
          {'_id.correlationId': 1, '_id.logItemType': 1, 'creationTime': 1}
      }
    ];

    const result = await db.collection(collection)
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
     * @param {String|Date} dateBefore: upper bound. Date strings are anchored at UTC midnight of the day after; Date instances are used as-is
     * @param {String|Date} dateAfter: lower bound. Date strings are anchored at UTC midnight of that day (inclusive); Date instances are used as-is
     * @returns Match Object
     */
      function generateMatchObject({logItemTypes, catalogers, dateBefore, dateAfter}) {
       const matchOptions = {
         '$match': {
           'logItemType': logItemTypes.length > 0 ? {'$in': logItemTypes} : /.*/ui,
           'cataloger': catalogers.length > 0 ? {'$in': catalogers} : /.*/ui,
           // creationTime is stored as a Date, so the bounds must be
           // Dates too (the old test=true branch compared against ISO strings
           // and never matched; the old non-test branch relied on
           // local-timezone parsing of new Date('YYYY-MM-DD')). Date strings
           // are anchored at UTC midnight so the result is deterministic
           // regardless of the server timezone.
           'creationTime': {
             '$gte': dateToUtcStartOfDay(dateAfter),
             '$lt': dateToUtcExclusiveUpperBound(dateBefore)
           }
         }
       };

       return matchOptions;

       // Date string 'YYYY-MM-DD' -> UTC midnight of that day (inclusive
       // lower bound). Date instance or any other string format -> parsed
       // with Date (a timestamp, not a day).
       function dateToUtcStartOfDay(value) {
         if (value instanceof Date) {
           return value;
         }
         const parts = String(value).slice(0, 10).split('-');
         if (parts.length === 3) {
           return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
         }
         return new Date(value);
       }

       // Date string 'YYYY-MM-DD' -> UTC midnight of the NEXT day (exclusive
       // upper bound). Date instance or any other string format -> parsed
       // with Date (a timestamp, not a day).
       function dateToUtcExclusiveUpperBound(value) {
         if (value instanceof Date) {
           return value;
         }
         const parts = String(value).slice(0, 10).split('-');
         if (parts.length === 3) {
           return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]) + 86400000);
         }
         return new Date(value);
       }
     }
  }

  /**
   * Protect logs from cleaning. Idempotent: always sets protected to true
   * (a second call leaves the logs protected, unlike the old toggle).
   * Forced cleaning defaults 30days
   * @param {String} correlationId
   * @param {Integer} blobSequence
   * @returns result
   */
  async function protect(correlationId, blobSequence) {
    logger.info(`Protecting in Mongo (${collection}) correlationId: ${correlationId}, blobSequence: ${blobSequence}`);
    assertString(correlationId, 'correlationId');
    const filter = buildBlobSequenceFilter(correlationId, blobSequence);

    try {
      const result = await db.collection(collection).updateMany(
        filter,
        [
          {
            $set: {
              modificationTime: new Date(),
              // plain true, not a $not toggle: protect must be idempotent
              protected: true
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
   * Unprotect logs so regular (non-forced) cleaning can remove them.
   * Same signature and behavior as protect, but sets protected to false.
   * @param {String} correlationId
   * @param {Integer} blobSequence
   * @returns result
   */
  async function unprotect(correlationId, blobSequence) {
    logger.info(`Unprotecting in Mongo (${collection}) correlationId: ${correlationId}, blobSequence: ${blobSequence}`);
    assertString(correlationId, 'correlationId');
    const filter = buildBlobSequenceFilter(correlationId, blobSequence);

    try {
      const result = await db.collection(collection).updateMany(
        filter,
        [
          {
            $set: {
              modificationTime: new Date(),
              protected: false
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
    assertString(correlationId, 'correlationId');
    const filter = force ? {correlationId} : {correlationId, protected: {$ne: true}};

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
    assertString(correlationId, 'correlationId');
    // NOTE: this matches only single-sequence items (blobSequence), NOT bulk
    // range items (blobSequenceStart/blobSequenceEnd); a requested sequence
    // inside a bulk range will not match and its logs are kept
    // blobSequences are integers that start from 1
    // we accept also strings that are convertilble to integers greated than 0
    // validate consistently via Number() and store the
    // converted numbers, since blobSequence is stored as a number in Mongo
    const cleanSequences = sequences
      .map(sequence => Number(sequence))
      .filter(sequence => Number.isInteger(sequence) && sequence > 0);

    if (sequences.length !== cleanSequences.length) {
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Invalid sequences in removeBySequences. Sequences should be positive integers`);
    }

    // use the numeric cleanSequences in BOTH branches (the non-forced
    // branch used to pass raw `sequences`, so string inputs like '1' would
    // never match the stored numeric blobSequence)
    const filter = force
      ? {correlationId, blobSequence: {$in: cleanSequences}}
      : {correlationId, blobSequence: {$in: cleanSequences}, protected: {$ne: true}};

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
   * Checks existence and validity of logItemType
   * @param {String} logItemType constant LOG_ITEM_TYPE
   * @param {Boolean} errorUnknown defaults false
   * @returns void
   */
  function checkLogItemType(logItemType, errorUnknown = false) {
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

    return logger.debug(`No logItemType: ${logItemType}`);
  }
}
