import {MongoClient} from 'mongodb';
import type {Collection, DeleteResult, Document, Filter, UpdateResult, WithId} from 'mongodb';
import httpStatus from 'http-status';
import {createLogger, Error as ApiError} from '@natlibfi/melinda-commons';
import {logError, assertString} from './utils.ts';
import {LOG_ITEM_TYPE} from './constants.ts';

// The persisted logItemType values always come from the as-const
// LOG_ITEM_TYPE object, so the union type uses the constant's literal
// value types (mirrors ImportJobStateValue in mongo.ts)
export type LogItemType = (typeof LOG_ITEM_TYPE)[keyof typeof LOG_ITEM_TYPE];

/**
 * A log item document in the logs collection.
 *
 * `logItemType` stays plain string (like the free-form fields of QueueItem
 * in mongo.ts): callers may pass any of the as-const LOG_ITEM_TYPE values,
 * legacy documents may hold values that no longer exist in the constants,
 * and addLogItem stores unknown types with only a warning (see the
 * "warn path" tests in mongoLog-protect.test).
 *
 * The blob-sequence fields are modelled flat, NOT as a per-logItemType
 * discriminated union: addLogItem / protect / removeBySequences accept
 * and use any combination of blobSequence / blobSequenceStart /
 * blobSequenceEnd regardless of logItemType (single-sequence items use
 * blobSequence, bulk range items use the Start/End pair).
 */
export interface LogItem {
  logItemType: string;
  correlationId: string;
  cataloger?: string;
  blobSequence?: number;
  blobSequenceStart?: number;
  blobSequenceEnd?: number;
  protected?: boolean;
  creationTime?: Date;
  modificationTime?: Date;
}

/**
 * Trusted internal query object for query (same convention as QueryParams
 * in mongo.ts): built by the calling service, limit, skip and Mongo query
 * operators. Callers must not splice raw user input into it: its keys may
 * legitimately use dot notation and $-operators.
 */
export interface LogQueryParams {
  limit?: number | string;
  skip?: number | string;
  [key: string]: unknown;
}

export interface ExpandedLogListParams {
  // validated at runtime: a non-array throws ApiError 400 and every
  // element is checked against LOG_ITEM_TYPE, so the param stays unknown
  // rather than string[]
  logItemTypes?: unknown;
  catalogers?: string[];
  dateBefore?: string | Date;
  dateAfter?: string | Date;
  // kept for backwards compatibility only; no longer changes the match
  test?: boolean;
}

/**
 * One row of the getExpandedListOfLogs result. creationTime is a BSON
 * Date (addLogItem stores a Date), surfaced as Date | string to match
 * the JSDoc baseline and the ISO-string form callers commonly expect.
 */
export interface ExpandedLogListItem {
  correlationId: string;
  logItemType: string;
  cataloger: string;
  creationTime: string | Date;
  logCount: number;
}

/**
 * The Mongo log operator object returned by the factory
 */
export interface MongoLogOperator {
  addLogItem: (logItem: LogItem) => Promise<void>;
  query: (params: LogQueryParams) => Promise<WithId<LogItem>[]>;
  queryById: (correlationId: string, logItemType?: string, skip?: number, limit?: number) => Promise<WithId<LogItem>[]>;
  getListOfLogs: (logItemType?: string) => Promise<string[]>;
  getListOfCatalogers: () => Promise<string[]>;
  getListOfCorrelationIds: () => Promise<string[]>;
  getExpandedListOfLogs: (params: ExpandedLogListParams) => Promise<ExpandedLogListItem[]>;
  protect: (correlationId: string, blobSequence?: number | string) => Promise<UpdateResult>;
  unprotect: (correlationId: string, blobSequence?: number | string) => Promise<UpdateResult>;
  remove: (correlationId: string, force?: boolean) => Promise<DeleteResult>;
  removeBySequences: (correlationId: string, sequences?: (number | string)[], force?: boolean) => Promise<DeleteResult>;
}

/**
 * Create log operator
 * @param MONGO_URI connnection address to mongo
 * @param dbName Mongo DB name, defaults 'rest-api'
 * @param deps optional dependencies, defaults {}. When deps.collection (a Mongo collection object) is provided, no real Mongo connection is made (used by unit tests)
 * @returns the Mongo log operator object
 */
export default async function (MONGO_URI: string, dbName = 'rest-api', deps: {collection?: unknown} = {}): Promise<MongoLogOperator> {
  const logger = createLogger();
  const collection = 'logs';

  // blobSequence filters: falsy/undefined keeps the legacy behaviour (no
  // blobSequence in the filter). Otherwise a number or a string parseable
  // to an integer (existing parseInt behaviour) is accepted, anything else
  // is rejected with 400.
  // Build the blobSequence filter part: falsy keeps the legacy no-blobSequence behaviour
  function buildBlobSequenceFilter(correlationId: string, blobSequence?: number | string): Filter<LogItem> {
    if (!blobSequence) {
      return {correlationId};
    }
    if (typeof blobSequence === 'number') {
      return {correlationId, blobSequence: parseInt(String(blobSequence), 10)};
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
  // deps (used by unit tests to avoid a real connection). The deps value
  // is cast (the runtime value may be undefined until the connect branch
  // assigns), mirroring the operator seam in mongo.ts.
  let logCollection: Collection<LogItem> = deps.collection as Collection<LogItem>;
  if (!deps.collection) {
    const client = await MongoClient.connect(MONGO_URI);
    logCollection = client.db(dbName).collection<LogItem>(collection);
  }
  return {addLogItem, query, queryById, getListOfLogs, getListOfCatalogers, getListOfCorrelationIds, getExpandedListOfLogs, protect, unprotect, remove, removeBySequences};

  // the free-form logItemType strings (caller input / Mongo docs) are
  // matched against the as-const LOG_ITEM_TYPE (literal-typed values), so
  // the values are widened to string[] for the membership checks. A type
  // guard (`value is LogItemType`) would not help: every call site only
  // uses the boolean result, and unknown values must stay valid strings
  // (the "warn" paths in addLogItem / query store them).
  // Check whether a value is a known LOG_ITEM_TYPE
  function isKnownLogItemType(value: string): boolean {
    const knownLogItemTypes: string[] = Object.values(LOG_ITEM_TYPE);
    return knownLogItemTypes.includes(value);
  }

  // Add log item to collection
  // @param logItem contains log item data
  async function addLogItem(logItem: LogItem): Promise<void> {
    const time = new Date();
    const newLogItem = {
      ...logItem,
      creationTime: time,
      protected: false
    };
    try {
      // console.log(newLogItem); // eslint-disable-line
      checkLogItemType(logItem.logItemType, false);
      const result = await logCollection.insertOne(newLogItem);
      if (result.acknowledged) {
        const {blobSequence, blobSequenceStart, blobSequenceEnd} = logItem;
        const itemString = blobSequenceStart && blobSequenceEnd ? `${blobSequenceStart} - ${blobSequenceEnd}` : `${blobSequence}`;
        logger.info(`*** New ${logItem.logItemType} added for ${logItem.correlationId}, blobSequence(s): ${itemString}. ***`);
        // console.log('addLogItem done', result); // eslint-disable-line
        return;
      }
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, undefined);
    } catch (error) {
      const apiError = error as ApiError;
      const errorMessage = apiError.payload || apiError.message || '';
      logError(error);
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Mongo errored: ${errorMessage}`);
    }
  }

  // Query log items
  // @param params query params
  async function query({limit = 5, skip = 0, ...rest}: LogQueryParams): Promise<WithId<LogItem>[]> {
    logger.debug(`Query params: ${JSON.stringify(rest)}`);
    logger.debug(`Limit and skip params: ${limit} | ${skip}`);
    // rest is a trusted query object (see LogQueryParams); the logItemType
    // filter value is a string at runtime when present
    checkLogItemType(rest['logItemType'] as string | undefined, false);
    // rest is an internal, trusted query object built by the calling service:
    // callers must not splice raw user input into it. Its keys may legitimately
    // use dot notation and $-operators, which is why rest is not
    // field-sanitized here.
    const result = await logCollection
      .find(rest as Filter<WithId<LogItem>>)
      .sort({creationTime: 1})
      .skip(parseInt(String(skip), 10))
      .limit(parseInt(String(limit), 10))
      .toArray();
    //logger.debug(`Query result: ${result}`);
    logger.debug(`Query result: ${result.length > 0 ? `Found ${result.length} log items! (skip: ${skip} limit: ${limit})` : 'Not found!'}`);
    return result;
  }

  // DEVELOP: queryById returns jsut one (randomish) log! is this useful?
  // Get single log item by correlationId
  // @param correlationId
  // @param logItemType constant LOG_ITEM_TYPE defaults LOG_ITEM_TYPE.MERGE_LOG
  // @param skip defaults 0
  // @param limit defaults 1
  async function queryById(correlationId: string, logItemType: string = LOG_ITEM_TYPE.MERGE_LOG, skip = 0, limit = 1): Promise<WithId<LogItem>[]> {
    assertString(correlationId, 'correlationId');
    logger.debug(`QueryById: ${correlationId}, logItemType: ${logItemType}, skip: ${skip}, limit: ${limit}`);
    const result = await logCollection
      .find({correlationId, logItemType})
      .sort({blobSequence: 1})
      .skip(parseInt(String(skip), 10))
      .limit(parseInt(String(limit), 10))
      .toArray();
    logger.debug(`Query result: ${result.length > 0 ? `Found ${result.length} log items!` : 'Not found!'}`);
    return result;
  }

  // getListOfLogs returns list of correlationIds that have logs of given logItemType
  // if logItemType is not given, getListOfLogs returns list of correlationIds that have MERGE_LOG
  // Get list of correlationIds of logs filtered by logItemType
  // @param logItemType constant LOG_ITEM_TYPE defaults LOG_ITEM_TYPE.MERGE_LOG
  async function getListOfLogs(logItemType: string = LOG_ITEM_TYPE.MERGE_LOG): Promise<string[]> {
    checkLogItemType(logItemType, true);
    //logger.debug(logItemType);
    // console.log(`${JSON.stringify(logItemType)}`);
    const result = await logCollection
      .distinct('correlationId', {logItemType: logItemType});
    logger.debug(`Query result for getListOfLogs: ${result.length > 0 ? `Found ${result.length} correlationIds for ${logItemType}!` : 'Not found!'}`);
    return result;
  }

  // Get list of catalogers from all available logs
  async function getListOfCatalogers(): Promise<string[]> {
    logger.debug(`Getting list of Catalogers`);

    const result = await logCollection
      .distinct('cataloger');
    // distinct omits documents without the field, so no undefineds at
    // runtime (cataloger is optional on LogItem for legacy docs only)
    return result as string[];
  }

  // Get list of correlationIds from all available logs
  async function getListOfCorrelationIds(): Promise<string[]> {
    logger.debug(`Getting list of CorrelationIds`);

    const result = await logCollection
      .distinct('correlationId');

    return result;
  }


  // Get filtered list of logs with extra info. Give params in Object
  // @param params
  //   logItemTypes: String array of logItemTypes. Defaults [LOG_ITEM_TYPE.MERGE_LOG, LOG_ITEM_TYPE.MATCH_LOG]. When provided, must be an array and every element is validated (unknown types throw).
  //   catalogers: String array of wanted catalogers. Defaults [].
  //   dateBefore: upper bound, the day itself is EXCLUDED. 'YYYY-MM-DD' or Date, anchored to UTC. Defaults new Date().
  //   dateAfter: lower bound, the day itself is INCLUDED. 'YYYY-MM-DD' or Date, anchored to UTC. Defaults '1970-01-01' (no lower bound).
  //   test: kept for backwards compatibility only; no longer changes the match.
  // test no longer changes the match behaviour (kept in the
  // signature for backwards compatibility only)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async function getExpandedListOfLogs({logItemTypes, catalogers = [], dateBefore = new Date(), dateAfter = '1970-01-01', test: _test = false}: ExpandedLogListParams): Promise<ExpandedLogListItem[]> {
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
      // when logItemTypes was provided, wantedLogItemTypes IS the caller
      // array, so this iterates exactly the provided elements
      wantedLogItemTypes.forEach(logItemType => {
        if (isKnownLogItemType(logItemType)) {
          return;
        }
        throw new ApiError(httpStatus.BAD_REQUEST, `Unknown logItemType: ${logItemType}`);
      });
    }
    logger.debug(`commons/getExpandedListOfLogs: logItemTypes: ${JSON.stringify(wantedLogItemTypes)}, dateAfter: ${dateAfter}, dateBefore: ${dateBefore}}, catalogers: ${JSON.stringify(catalogers)}`);
    logger.silly(JSON.stringify(generateMatchObject({logItemTypes: wantedLogItemTypes, catalogers, dateBefore, dateAfter})));
    //logger.debug(`Getting expanded list of logs`);
    const pipeline: Document[] = [
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

    const result = await logCollection
      .aggregate(pipeline)
      .toArray();

    const fixedResult: ExpandedLogListItem[] = result.map(
      logListing => {
        const {correlationId, logItemType} = logListing['_id'];
      const {cataloger, creationTime, logCount} = logListing;
      return {correlationId, logItemType, cataloger, creationTime, logCount};
    });

    logger.silly(`Query result: ${JSON.stringify(result)}`);
    logger.silly(`Query result: ${JSON.stringify(fixedResult)}`);

    logger.debug(`Query result: ${fixedResult.length > 0 ? `Found ${fixedResult.length} log items!` : 'Not found!'}`);
    return fixedResult;

    // Generate match object for aggregation pipeline
    // @param params
    function generateMatchObject({logItemTypes, catalogers, dateBefore, dateAfter}: {logItemTypes: string[], catalogers: string[], dateBefore: string | Date, dateAfter: string | Date}) {
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
       function dateToUtcStartOfDay(value: string | Date): Date {
         if (value instanceof Date) {
           return value;
         }
         const parts = String(value).slice(0, 10).split('-');
         if (parts.length === 3) {
           return new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
         }
         return new Date(value);
       }

       // Date string 'YYYY-MM-DD' -> UTC midnight of the NEXT day (exclusive
       // upper bound). Date instance or any other string format -> parsed
       // with Date (a timestamp, not a day).
       function dateToUtcExclusiveUpperBound(value: string | Date): Date {
         if (value instanceof Date) {
           return value;
         }
         const parts = String(value).slice(0, 10).split('-');
         if (parts.length === 3) {
           return new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])) + 86400000);
         }
         return new Date(value);
       }
     }
  }

  // Protect logs from cleaning. Idempotent: always sets protected to true
  // (a second call leaves the logs protected, unlike the old toggle).
  // Forced cleaning defaults 30days
  // @param correlationId
  // @param blobSequence
  async function protect(correlationId: string, blobSequence?: number | string): Promise<UpdateResult> {
    logger.info(`Protecting in Mongo (${collection}) correlationId: ${correlationId}, blobSequence: ${blobSequence}`);
    assertString(correlationId, 'correlationId');
    const filter = buildBlobSequenceFilter(correlationId, blobSequence);

    try {
      const result = await logCollection.updateMany(
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
      const apiError = error as ApiError;
      const errorMessage = apiError.payload || apiError.message || '';
      logError(error);
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Mongo errored: ${errorMessage}`);
    }
  }

  // Unprotect logs so regular (non-forced) cleaning can remove them.
  // Same signature and behavior as protect, but sets protected to false.
  // @param correlationId
  // @param blobSequence
  async function unprotect(correlationId: string, blobSequence?: number | string): Promise<UpdateResult> {
    logger.info(`Unprotecting in Mongo (${collection}) correlationId: ${correlationId}, blobSequence: ${blobSequence}`);
    assertString(correlationId, 'correlationId');
    const filter = buildBlobSequenceFilter(correlationId, blobSequence);

    try {
      const result = await logCollection.updateMany(
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
      const apiError = error as ApiError;
      const errorMessage = apiError.payload || apiError.message || '';
      logError(error);
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Mongo errored: ${errorMessage}`);
    }
  }

  // Remove logs
  // @param correlationId
  // @param force defaults false
  async function remove(correlationId: string, force = false): Promise<DeleteResult> {
    logger.info(`Removing from Mongo (${collection}) correlationId: ${correlationId}`);
    assertString(correlationId, 'correlationId');
    const filter = force ? {correlationId} : {correlationId, protected: {$ne: true}};

    try {
      const result = await logCollection.deleteMany(filter);
      return result;
    } catch (error) {
      const apiError = error as ApiError;
      const errorMessage = apiError.payload || apiError.message || '';
      logError(error);
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Mongo errored: ${errorMessage}`);
    }
  }

  // Remove logs by sequences
  // @param correlationId
  // @param sequences
  // @param force defaults false
  async function removeBySequences(correlationId: string, sequences: (number | string)[] = [], force = false): Promise<DeleteResult> {
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
      const result = await logCollection.deleteMany(filter);
      return result;
    } catch (error) {
      const apiError = error as ApiError;
      const errorMessage = apiError.payload || apiError.message || '';
      logError(error);
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Mongo errored: ${errorMessage}`);
    }
  }

  // Checks existence and validity of logItemType
  // @param logItemType constant LOG_ITEM_TYPE
  // @param errorUnknown defaults false
  function checkLogItemType(logItemType: string | undefined, errorUnknown = false): void {
    if (logItemType) {
      const typeInLogItemTypes = isKnownLogItemType(logItemType);
      if (typeInLogItemTypes) {
        logger.debug(`Valid logItemType: ${logItemType}`);
        return;
      }
      if (errorUnknown) {
        throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Unknown logItemType: ${logItemType}`);
      }
      logger.debug(`WARN: We have unknown logType: ${logItemType}`);
      return;
    }

    logger.debug(`No logItemType: ${logItemType}`);
  }
}
