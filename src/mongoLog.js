import {MongoClient} from 'mongodb';
import httpStatus from 'http-status';
import {createLogger, Error as ApiError} from '@natlibfi/melinda-commons';
import {logError, assertString} from './utils.ts';
import {LOG_ITEM_TYPE} from './constants.ts';

/**
 * Create log operator
 * @param {String} MONGO_URI connnection address to mongo
 * @param {String} dbName Mongo DB name, defaults 'rest-api'
 * @param {{collection?: unknown}} deps optional dependencies, defaults {}. When deps.collection (a Mongo collection object) is provided, no real Mongo connection is made (used by unit tests)
 * @returns {Promise<*>} containing all log handling functions
 */
export default async function (MONGO_URI, dbName = 'rest-api', deps = {}) {
  const logger = createLogger();

  // blobSequence filters: falsy/undefined keeps the legacy behaviour (no
  // blobSequence in the filter). Otherwise a number or a string parseable
  // to an integer (existing parseInt behaviour) is accepted, anything else
  // is rejected with 400.
  /**
   * Build the blobSequence filter part: falsy keeps the legacy no-blobSequence behaviour
   * @param {string} correlationId
   * @param {number|string|undefined} blobSequence
   * @returns {{correlationId: string, blobSequence?: number}}
   * @throws {Error}
   */
  function buildBlobSequenceFilter(correlationId, blobSequence) {
    if (!blobSequence) {
      return {correlationId};
    }
    if (typeof blobSequence === 'number') {
      return {correlationId, blobSequence: parseInt(/** @type {*} */ (blobSequence), 10)};
    }
    if (typeof blobSequence === 'string') {
      const parsed = parseInt(blobSequence, 10);
      if (!Number.isNaN(parsed)) {
        return {correlationId, blobSequence: parsed};
      }
    }
    throw new ApiError(httpStatus.BAD_REQUEST, 'blobSequence must be a number or a numeric string');
  }

  // Connect to mongo (MONGO), unless the logs collection is injected via
  // deps (used by unit tests to avoid a real connection)
  const collection = 'logs';
  /** @type {*} */
  let db;
  if (deps.collection) {
    db = {collection: () => deps.collection};
  } else {
    const client = await MongoClient.connect(MONGO_URI);
    db = client.db(dbName);
  }
  return {addLogItem, query, queryById, getListOfLogs, getListOfCatalogers, getListOfCorrelationIds, getExpandedListOfLogs, protect, unprotect, remove, removeBySequences};

  // the free-form logItemType strings (caller input / Mongo docs) are
  // matched against the as-const LOG_ITEM_TYPE (literal-typed values), so
  // the values are widened to string[] for the membership checks
  /**
   * Check whether a value is a known LOG_ITEM_TYPE
   * @param {string} value
   * @returns {boolean}
   */
  function isKnownLogItemType(value) {
    return /** @type {string[]} */ (Object.values(LOG_ITEM_TYPE)).includes(value);
  }

  /**
   * Add log item to collection
   * @param {{logItemType: string, correlationId: string, cataloger?: string, blobSequence?: number, blobSequenceStart?: number, blobSequenceEnd?: number}} logItem contains log item data
   * @returns {Promise<void>}
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
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, undefined);
    } catch (/** @type {unknown} */ error) {
      const apiError = /** @type {ApiError} */ (error);
      const errorMessage = apiError.payload || apiError.message || '';
      logError(error);
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Mongo errored: ${errorMessage}`);
    }
  }

  /**
   * Query log items
   * @param {{limit?: number, skip?: number, logItemType?: string, correlationId?: string, cataloger?: string, protected?: boolean, blobSequence?: number}} params query params
   * @returns {Promise<*>} result array
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
      .skip(parseInt(/** @type {*} */ (skip), 10))
      .limit(parseInt(/** @type {*} */ (limit), 10))
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
   * @param {number} skip defaults 0
   * @param {number} limit defaults 1
   * @returns {Promise<*>} query result array
   */
  async function queryById(correlationId, logItemType = LOG_ITEM_TYPE.MERGE_LOG, skip = 0, limit = 1) {
    assertString(correlationId, 'correlationId');
    logger.debug(`QueryById: ${correlationId}, logItemType: ${logItemType}, skip: ${skip}, limit: ${limit}`);
    const result = await db.collection(collection)
      .find({correlationId, logItemType})
      .sort({blobSequence: 1})
      .skip(parseInt(/** @type {*} */ (skip), 10))
      .limit(parseInt(/** @type {*} */ (limit), 10))
      .toArray();
    logger.debug(`Query result: ${result.length > 0 ? `Found ${result.length} log items!` : 'Not found!'}`);
    return result;
  }

  // getListOfLogs returns list of correlationIds that have logs of given logItemType
  // if logItemType is not given, getListOfLogs returns list of correlationIds that have MERGE_LOG
  /**
   * Get list of correlationIds of logs filtered by logItemType
   * @param {String} logItemType constant LOG_ITEM_TYPE defaults LOG_ITEM_TYPE.MERGE_LOG
   * @returns {Promise<*>} Array of query results
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
   * @returns {Promise<*>} Array of query results
   */
  async function getListOfCatalogers() {
    logger.debug(`Getting list of Catalogers`);

    const result = await db.collection(collection)
      .distinct('cataloger');

    return result;
  }

  /**
   * Get list of correlationIds from all available logs
   * @returns {Promise<*>} Array of query results
   */
  async function getListOfCorrelationIds() {
    logger.debug(`Getting list of CorrelationIds`);

    const result = await db.collection(collection)
      .distinct('correlationId');

    return result;
  }


  /**
   * Get filtered list of logs with extra info. Give params in Object
   * @param {{logItemTypes?: string[], catalogers?: string[], dateBefore?: string|Date, dateAfter?: string|Date, test?: boolean}} params
   *   logItemTypes: String array of logItemTypes. Defaults [LOG_ITEM_TYPE.MERGE_LOG, LOG_ITEM_TYPE.MATCH_LOG]. When provided, must be an array and every element is validated (unknown types throw).
   *   catalogers: String array of wanted catalogers. Defaults [].
   *   dateBefore: upper bound, the day itself is EXCLUDED. 'YYYY-MM-DD' or Date, anchored to UTC. Defaults new Date().
   *   dateAfter: lower bound, the day itself is INCLUDED. 'YYYY-MM-DD' or Date, anchored to UTC. Defaults '1970-01-01' (no lower bound).
   *   test: kept for backwards compatibility only; no longer changes the match.
   * @returns {Promise<{correlationId: string, logItemType: string, cataloger: string, creationTime: string, logCount: number}[]>} Parsed list of {'correlationId', 'logItemType', 'creationTime', 'cataloger', 'logCount'}
   */
  // test no longer changes the match behaviour (kept in the
  // signature for backwards compatibility only)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async function getExpandedListOfLogs({logItemTypes, catalogers = [], dateBefore = new Date(), dateAfter = '1970-01-01', test: _test = false}) {
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
        if (isKnownLogItemType(logItemType)) {
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

    const fixedResult = result.map(
      /**
       * @param {*} logListing
       */
      (logListing) => {
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
     * @param {{logItemTypes: string[], catalogers: string[], dateBefore: string|Date, dateAfter: string|Date}} params
     * @returns {{'$match': {logItemType: RegExp|{$in: string[]}, cataloger: RegExp|{$in: string[]}, creationTime: {$gte: Date, $lt: Date}}}} Match Object
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
       /**
        * @param {string|Date} value
        * @returns {Date}
        */
       function dateToUtcStartOfDay(value) {
         if (value instanceof Date) {
           return value;
         }
         const parts = String(value).slice(0, 10).split('-');
         if (parts.length === 3) {
           return new Date(Date.UTC(/** @type {*} */ (parts[0]), /** @type {*} */ (parts[1]) - 1, /** @type {*} */ (parts[2])));
         }
         return new Date(value);
       }

       // Date string 'YYYY-MM-DD' -> UTC midnight of the NEXT day (exclusive
       // upper bound). Date instance or any other string format -> parsed
       // with Date (a timestamp, not a day).
       /**
        * @param {string|Date} value
        * @returns {Date}
        */
       function dateToUtcExclusiveUpperBound(value) {
         if (value instanceof Date) {
           return value;
         }
         const parts = String(value).slice(0, 10).split('-');
         if (parts.length === 3) {
           return new Date(Date.UTC(/** @type {*} */ (parts[0]), /** @type {*} */ (parts[1]) - 1, /** @type {*} */ (parts[2])) + 86400000);
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
   * @param {number|string|undefined} blobSequence
   * @returns {Promise<*>} result
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
    } catch (/** @type {unknown} */ error) {
      const apiError = /** @type {ApiError} */ (error);
      const errorMessage = apiError.payload || apiError.message || '';
      logError(error);
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Mongo errored: ${errorMessage}`);
    }
  }

  /**
   * Unprotect logs so regular (non-forced) cleaning can remove them.
   * Same signature and behavior as protect, but sets protected to false.
   * @param {String} correlationId
   * @param {number|string|undefined} blobSequence
   * @returns {Promise<*>} result
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
    } catch (/** @type {unknown} */ error) {
      const apiError = /** @type {ApiError} */ (error);
      const errorMessage = apiError.payload || apiError.message || '';
      logError(error);
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Mongo errored: ${errorMessage}`);
    }
  }

  /**
   * Remove logs
   * @param {String} correlationId
   * @param {Boolean} force defaults false
   * @returns {Promise<*>} result
   */
  async function remove(correlationId, force = false) {
    logger.info(`Removing from Mongo (${collection}) correlationId: ${correlationId}`);
    assertString(correlationId, 'correlationId');
    const filter = force ? {correlationId} : {correlationId, protected: {$ne: true}};

    try {
      const result = await db.collection(collection).deleteMany(filter);
      return result;
    } catch (/** @type {unknown} */ error) {
      const apiError = /** @type {ApiError} */ (error);
      const errorMessage = apiError.payload || apiError.message || '';
      logError(error);
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Mongo errored: ${errorMessage}`);
    }
  }

  /**
   * Remove logs by sequences
   * @param {String} correlationId
   * @param {(number|string)[]} sequences
   * @param {Boolean} force defaults false
   * @returns {Promise<*>} result
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
    } catch (/** @type {unknown} */ error) {
      const apiError = /** @type {ApiError} */ (error);
      const errorMessage = apiError.payload || apiError.message || '';
      logError(error);
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Mongo errored: ${errorMessage}`);
    }
  }

  /**
   * Checks existence and validity of logItemType
   * @param {string|undefined} logItemType constant LOG_ITEM_TYPE
   * @param {Boolean} errorUnknown defaults false
   * @returns {*} void
   */
  function checkLogItemType(logItemType, errorUnknown = false) {
    if (logItemType) {
      const typeInLogItemTypes = isKnownLogItemType(logItemType);
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
