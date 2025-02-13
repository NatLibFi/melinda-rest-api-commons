//import {expect} from 'chai';
import {READERS} from '@natlibfi/fixura';
import mongoFixturesFactory from '@natlibfi/fixura-mongo';
import generateTests from '@natlibfi/fixugen';
import createMongoOperator from '../src/mongo';
import createDebugLogger from 'debug';
//import {handleError, compareToFirstDbEntry, compareToDbEntry, formatQueueItem, streamToString} from './testUtils';
import {handleError, compareToFirstDbEntry} from '../tests/testUtils';


let mongoFixtures; // eslint-disable-line functional/no-let
const debug = createDebugLogger('@natlibfi/melinda-rest-api-commons/mongo:set-state:test');

generateTests({
  callback,
  path: [__dirname, '..', 'test-fixtures', 'mongo', 'set-state'],
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
    rootPath: [__dirname, '..', 'test-fixtures', 'mongo', 'set-state'],
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
  expectedErrorStatus = ''
//   contentStream = false,
//   expectedOpResult = undefined,
//   updateStateBeforeTest = undefined,
//   resultIndex = undefined,
//   createBulkParams = undefined,
//   expectedFileCount = undefined,
//   expectUndefined = undefined
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


  if (functionName === 'setState') {
    try {
      debug(`setState`);
      debug(JSON.stringify(params));
      //{correlationId, state, errorMessage = undefined, errorStatus = undefined}
      const opResult = await mongoOperator.setState(params);
      debug(`setState result: ${JSON.stringify(opResult)}`);
      await compareToFirstDbEntry({mongoFixtures, expectedResult, expectModificationTime, formatDates: true});

    } catch (error) {
      handleError({error, expectedToThrow, expectedErrorMessage, expectedErrorStatus});
      return;
    }
    return;
  }
  throw new Error(`Unknown functionName: ${functionName}`);
}
