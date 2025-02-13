import {expect} from 'chai';
import {READERS} from '@natlibfi/fixura';
import mongoFixturesFactory from '@natlibfi/fixura-mongo';
import generateTests from '@natlibfi/fixugen';
import createMongoOperator from '../src/mongo';
import createDebugLogger from 'debug';
//import {handleError, compareToFirstDbEntry, compareToDbEntry, formatQueueItem, streamToString} from './testUtils';
import {handleError} from '../tests/testUtils';

let mongoFixtures; // eslint-disable-line functional/no-let
const debug = createDebugLogger('@natlibfi/melinda-rest-api-commons/mongo:test');

generateTests({
  callback,
  path: [__dirname, '..', 'test-fixtures', 'mongo', 'query'],
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
    rootPath: [__dirname, '..', 'test-fixtures', 'mongo', 'query'],
    gridFS: {bucketName: 'foobar'},
    useObjectId: true
  });
}

// eslint-disable-next-line max-statements, complexity
async function callback({
  getFixture,
  functionName,
  params,
  //expectModificationTime = false,
  preFillDb = false,
  expectedToThrow = false,
  expectedErrorMessage = '',
  expectedErrorStatus = '',
  //contentStream = false,
  expectedOpResult = undefined
  //updateStateBeforeTest = undefined,
  //resultIndex = undefined,
  //createBulkParams = undefined,
  //expectedFileCount = undefined,
  //expectUndefined = undefined
}) {

  const mongoUri = await mongoFixtures.getUri();
  const mongoOperator = await createMongoOperator(mongoUri, 'foobar', '');
  //const expectedResult = await getFixture('expectedResult.json');

  await doPreFillDb(preFillDb);

  async function doPreFillDb(preFillDb) {
    if (preFillDb) {
      await mongoFixtures.populate(getFixture('dbContents.json'));
      return;
    }
    return;
  }


  if (functionName === 'query') {
    try {
      debug(`query`);
      debug(JSON.stringify(params));
      //params, showParams = {}
      //params: skip, limit, rest (rest: actual mongo queryParams)
      //showParams: {showAll = 0, showOperations = 0, showOperationSettings = 0, showRecordLoadParams = 0, showImportJobState = 0} = showParams;
      debug(`${JSON.stringify(params.params)}`);
      debug(`${JSON.stringify(params.showParams)}`);
      const opResult = await mongoOperator.query(params.params, params.showParams);
      debug(`query result: ${JSON.stringify(opResult)} (it should be: ${JSON.stringify(expectedOpResult)})}`);
      // eslint-disable-next-line functional/no-conditional-statements
      if (expectedOpResult !== undefined) {
        expect(opResult).to.eql(expectedOpResult);
      }
    } catch (error) {
      handleError({error, expectedToThrow, expectedErrorMessage, expectedErrorStatus});
      return;
    }
    return;
  }

  throw new Error(`Unknown functionName: ${functionName}`);
}
