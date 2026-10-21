import assert from 'node:assert';
import createDebugLogger from 'debug';
import createMongoOperator from '../src/mongo.js';


const debug = createDebugLogger('@natlibfi/melinda-rest-api-commons/mongo:test');

/**
 * @param {*} mongoFixtures fixura-mongo fixtures
 * @returns {Promise<*>} the Mongo operator
 */
export async function getMongoOperator(mongoFixtures) {
  const mongoUri = await mongoFixtures.getUri();
  const mongoOperator = await createMongoOperator(mongoUri, 'foobar', '');
  return mongoOperator;
}

/**
 * @param {*} params mongoFixtures, expectedResult, expectModificationTime (false), formatDates (true), expectedFileCount (undefined)
 * @returns {Promise<*>}
 */
export async function compareToFirstDbEntry(params) {
  const {mongoFixtures, expectedResult, expectModificationTime = false, formatDates = true, expectedFileCount = undefined} = params;
  const result = await compareToDbEntry({mongoFixtures, expectedResult, resultIndex: 0, expectModificationTime, formatDates, expectedFileCount});
  return result;
}

/**
 * @param {*} params mongoFixtures, expectedResult, resultIndex (0), expectModificationTime (false), formatDates (true), expectedFileCount (undefined)
 * @returns {Promise<*>}
 */
export async function compareToDbEntry(params) {
  const {mongoFixtures, expectedResult, resultIndex = 0, expectModificationTime = false, formatDates = true, expectedFileCount = undefined} = params;
  const dump = await mongoFixtures.dump();
  debug(`--- We have ${dump.foobar.length} documents in db`);
  debug(dump.foobar);
  const result = await dump.foobar[resultIndex];
  debug(`db result (document ${resultIndex}): ${JSON.stringify(result)}`);
  const dump2 = await mongoFixtures.dump();
  debug(`--- We have ${dump2.foobar.length} documents in db now`);

  checkFileCount({dump, expectedFileCount});

  checkModificationTime({result, expectModificationTime});

  if (formatDates && expectedResult !== undefined) {
    const formattedResult = formatQueueItem(result);
    assert.deepStrictEqual(formattedResult, expectedResult);
    return;
  }
  assert.deepStrictEqual(result, expectedResult);
  return;
}

/**
 * @param {*} params dump, expectedFileCount
 * @returns {undefined}
 */
function checkFileCount(params) {
  const {dump, expectedFileCount} = params;
  if (expectedFileCount !== undefined) {
    const fileCount = dump['foobar.files']?.length;
    debug(`--- We have ${fileCount} files in db`);
    assert.equal(fileCount, expectedFileCount);
    return;
  }
  return;

}

/**
 * @param {*} params result, expectModificationTime
 * @returns {undefined}
 */
function checkModificationTime(params) {
  const {result, expectModificationTime} = params;
  if (expectModificationTime) {
    debug('Check if modificationTime was edited');
    const isNotEmpty = result.modificationTime !== '';
    assert.equal(isNotEmpty, true);
    debug(`OK. We have modified modificationTime`);
    return;
  }
  return;
}


/**
 * @param {*} queueItem
 * @returns {*}
 */
export function formatQueueItem(queueItem) {
  const filteredQueueItem = {
    ...queueItem,
    creationTime: '',
    modificationTime: ''
  };
  debug(`Formatted result: ${JSON.stringify(filteredQueueItem)}`);
  return filteredQueueItem;
}

/**
 * @param {*} params error, expectedToThrow, expectedErrorMessage, expectedErrorStatus
 * @returns {undefined}
 */
export function handleError(params) {
  const {error, expectedToThrow, expectedErrorMessage, expectedErrorStatus} = params;
  debug(error);
  if (expectedToThrow) {
    debug('OK. Expected to throw');
    debug(JSON.stringify(error));
    if (expectedErrorMessage !== '' || expectedErrorStatus !== '') {
      const errorMessage = error.message || error.payload.message || error.payload || '';
      debug(errorMessage);
      assert.equal(errorMessage, expectedErrorMessage);
      const errorStatus = error.status || '';
      assert.equal(errorStatus, expectedErrorStatus);
      return;
    }
    return;
  }
  debug('NOT OK. Not expexted to throw');
  throw error;
}

/**
 * @param {*} stream
 * @returns {Promise<string>}
 */
export function streamToString(stream) {
  /** @type {any[]} */
  const chunks = [];
  return new Promise((resolve, reject) => {
    stream.on('data', /** @param {Buffer} chunk */ (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on('error', /** @param {unknown} err */ (err) => reject(err));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}
