//import {expect} from 'chai';
import {READERS} from '@natlibfi/fixura';
import mongoFixturesFactory from '@natlibfi/fixura-mongo';
import generateTests from '@natlibfi/fixugen';
import createMongoOperator from '../src/mongo';
import createDebugLogger from 'debug';
import {handleError, compareToFirstDbEntry} from './testUtils';
// import {handleError, compareToFirstDbEntry, compareToDbEntry, formatQueueItem, streamToString} from './testUtils';

let mongoFixtures; // eslint-disable-line functional/no-let
const debug = createDebugLogger('@natlibfi/melinda-rest-api-commons/mongo:create-prio-test');

generateTests({
  callback,
  path: [__dirname, '..', 'test-fixtures', 'mongo', 'create-prio'],
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
    rootPath: [__dirname, '..', 'test-fixtures', 'mongo', 'create-prio'],
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
  expectedErrorStatus = ''
  //contentStream = false,
  //expectedOpResult = undefined,
  //updateStateBeforeTest = undefined,
  //resultIndex = undefined,
  //createBulkParams = undefined,
  //expectedFileCount = undefined,
  //expectUndefined = undefined
}) {

  const mongoUri = await mongoFixtures.getUri();
  const mongoOperator = await createMongoOperator(mongoUri, 'foobar', '');
  const expectedResult = await getFixture('expectedResult.json');
  // DEVELOP: we could use sama function for most of tests?
  // debug(typeof mongoUri); // eslint-disable-line

  if (preFillDb) { // eslint-disable-line functional/no-conditional-statements
    await mongoFixtures.populate(getFixture('dbContents.json'));
  }

  //return {createPrio, createBulk, checkAndSetState, checkAndSetImportJobState, query, queryById, remove, readContent, removeContent, getOne, getStream, setState, setImportJobState, pushIds, pushMessages, setOperation, setOperations, addBlobSize, setBlobSize};

  if (functionName === 'createPrio') {
    try {
      debug(`CreatePrio`);
      debug(JSON.stringify(params));
      const opResult = await mongoOperator.createPrio(params);
      debug(`createPrio result: ${JSON.stringify(opResult)}`);
      await compareToFirstDbEntry({mongoFixtures, expectedResult, formatDates: true});
    } catch (error) {
      handleError({error, expectedToThrow, expectedErrorMessage, expectedErrorStatus});
      return;
    }
    return;
  }

  throw new Error(`Unknown functionName: ${functionName}`);
}

