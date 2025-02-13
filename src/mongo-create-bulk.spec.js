import {READERS} from '@natlibfi/fixura';
import mongoFixturesFactory from '@natlibfi/fixura-mongo';
import generateTests from '@natlibfi/fixugen';
import createMongoOperator from '../src/mongo';
import createDebugLogger from 'debug';
//import {handleError, compareToFirstDbEntry, compareToDbEntry, formatQueueItem, streamToString} from './testUtils';
import {handleError, compareToFirstDbEntry} from '../tests/testUtils';

let mongoFixtures; // eslint-disable-line functional/no-let
const debug = createDebugLogger('@natlibfi/melinda-rest-api-commons/mongo:test:create-bulk');

generateTests({
  callback,
  path: [__dirname, '..', 'test-fixtures', 'mongo', 'create-bulk'],
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
    rootPath: [__dirname, '..', 'test-fixtures', 'mongo', 'create-bulk'],
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
  contentStream = false,
  //expectedOpResult = undefined,
  //updateStateBeforeTest = undefined,
  //resultIndex = undefined,
  //createBulkParams = undefined,
  expectedFileCount = undefined
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


  if (functionName === 'createBulk') {
    try {
      debug(`CreateBulk`);
      debug(JSON.stringify(params));
      //{correlationId, cataloger, oCatalogerIn, operation, contentType, recordLoadParams, stream, operationSettings}
      const stream = contentStream ? await getFixture({components: ['contentStream'], reader: READERS.STREAM}) : params.stream;
      const params2 = {...params, stream};
      const opResult = await mongoOperator.createBulk(params2);
      debug(`createBulkResult: ${JSON.stringify(opResult)}`);
      await compareToFirstDbEntry({mongoFixtures, expectedResult, formatDates: true, expectedFileCount});
    } catch (error) {
      handleError({error, expectedToThrow, expectedErrorMessage, expectedErrorStatus});
      return;
    }
    return;
  }

  throw new Error(`Unknown functionName: ${functionName}`);
}
