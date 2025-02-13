//import {expect} from 'chai';
import {READERS} from '@natlibfi/fixura';
import mongoFixturesFactory from '@natlibfi/fixura-mongo';
import generateTests from '@natlibfi/fixugen';
import createMongoOperator from '../src/mongo';
import createDebugLogger from 'debug';
//import {handleError, compareToFirstDbEntry, compareToDbEntry, formatQueueItem, streamToString} from './testUtils';
import {handleError, compareToFirstDbEntry} from './testUtils';


let mongoFixtures; // eslint-disable-line functional/no-let
const debug = createDebugLogger('@natlibfi/melinda-rest-api-commons/mongo:remove:test');

generateTests({
  callback,
  path: [__dirname, '..', 'test-fixtures', 'mongo', 'remove'],
  recurse: false,
  useMetadataFile: true,
  fixura: {
    failWhenNotFound: true,
    reader: READERS.JSON
  },
  mocha: {
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
  mongoFixtures = await mongoFixturesFactory({
    recurse: false,
    rootPath: [__dirname, '..', 'test-fixtures', 'mongo', 'remove'],
    gridFS: {bucketName: 'foobar'},
    useObjectId: true
  });
}

// eslint-disable-next-line max-statements, complexity
async function callback({
  getFixture,
  functionName,
  params,
  expectModificationTime = false,
  preFillDb = false,
  expectedToThrow = false,
  expectedErrorMessage = '',
  expectedErrorStatus = '',
  contentStream = false,
  //expectedOpResult = undefined,
  //updateStateBeforeTest = undefined,
  //resultIndex = undefined,
  createBulkParams = undefined,
  expectedFileCount = undefined,
  expectUndefined = undefined
}) {

  const mongoUri = await mongoFixtures.getUri();
  const mongoOperator = await createMongoOperator(mongoUri, 'foobar', '');
  const expectedResult = await getFixture('expectedResult.json');

  await doPreFillDb(preFillDb);

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

      // eslint-disable-next-line functional/no-conditional-statements
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
