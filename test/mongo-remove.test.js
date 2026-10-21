//import assert from 'node:assert';
import {READERS} from '@natlibfi/fixura';
import mongoFixturesFactory from '@natlibfi/fixura-mongo';
import generateTests from '@natlibfi/fixugen';
import createDebugLogger from 'debug';
//import {handleError, compareToFirstDbEntry, compareToDbEntry, formatQueueItem, streamToString} from './testUtils.js';
import {getMongoOperator, handleError, compareToFirstDbEntry} from './testUtils.js';


/** @type {*} */
let mongoFixtures;
const debug = createDebugLogger('@natlibfi/melinda-rest-api-commons/mongo:remove:test');

generateTests({
  callback,
  path: [import.meta.dirname, '..', 'test-fixtures', 'mongo', 'remove'],
  recurse: false,
  useMetadataFile: true,
  fixura: {
    failWhenNotFound: true,
    reader: READERS.JSON
  },
  hooks: {
    before: async () => {
      //debug(`<< Before`);
      await initMongofixtures();
    },
    beforeEach: async () => {
      //debug(`<< BeforeEach`);
      await mongoFixtures.clear();
    },
    afterEach: async () => {
      //debug(`<< AfterEach`);
      await mongoFixtures.clear();
    },
    after: async () => {
      //debug(`<< After`);
      await mongoFixtures.close();
    }
  }
});

async function initMongofixtures() {
  mongoFixtures = await mongoFixturesFactory(/** @type {*} */ ({
    recurse: false,
    rootPath: [import.meta.dirname, '..', 'test-fixtures', 'mongo', 'remove'],
    gridFS: {bucketName: 'foobar'},
    useObjectId: true
  }));
}

/**
 * @param {*} callbackParams
 */
async function callback(callbackParams) {
  const {
  getFixture,
  functionName,
  params,
  expectModificationTime = false,
  preFillDb = false,
  expectedToThrow = false,
  expectedErrorMessage = '',
  expectedErrorStatus = '',
  contentStream = false,
  createBulkParams = undefined,
  expectedFileCount = undefined,
  expectUndefined = undefined
  } = callbackParams;

  const mongoOperator = await getMongoOperator(mongoFixtures);
  const expectedResult = await getFixture('expectedResult.json');

  await doPreFillDb(preFillDb);

  /** @param {boolean} preFillDb */
  async function doPreFillDb(preFillDb) {
    if (preFillDb) {
      await mongoFixtures.populate(getFixture('dbContents.json'));
      return;
    }
    return;
  }


  if (functionName === 'remove') {

    try {
      debug(`remove`);
      debug(JSON.stringify(params));
      //params: {correlationId}

      if (createBulkParams) {
        const stream = contentStream ? await getFixture({components: ['contentStream'], reader: READERS.STREAM}) : createBulkParams.stream;
        //debug(stream);
        const params2 = {...createBulkParams, stream};
        const createBulkResult = await mongoOperator.createBulk(params2);
        debug(`createBulkResult: ${JSON.stringify(createBulkResult)}`);
      }

      const opResult = await mongoOperator.remove(params);
      debug(`remove result: ${JSON.stringify(opResult)}`);
      debug(`expectUndefined: ${expectUndefined}`);

      await compareToFirstDbEntry({mongoFixtures, expectedResult: expectUndefined ? undefined : expectedResult, expectModificationTime, formatDates: true, expectedFileCount});

    } catch (error) {
      handleError({error, expectedToThrow, expectedErrorMessage, expectedErrorStatus});
      return;
    }
    return;
  }
  throw new Error(`Unknown functionName: ${functionName}`);
}
