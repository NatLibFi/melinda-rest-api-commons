import {expect} from 'chai';
import {READERS} from '@natlibfi/fixura';
import mongoFixturesFactory from '@natlibfi/fixura-mongo';
import generateTests from '@natlibfi/fixugen';
import createDebugLogger from 'debug';
//import {handleError, compareToFirstDbEntry, compareToDbEntry, formatQueueItem, streamToString} from './testUtils';
import {getMongoOperator, handleError, compareToFirstDbEntry} from './testUtils';


let mongoFixtures; // eslint-disable-line functional/no-let
const debug = createDebugLogger('@natlibfi/melinda-rest-api-commons/mongo:test');

generateTests({
  callback,
  path: [__dirname, '..', 'test-fixtures', 'mongo', 'check-and-set-state'],
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
    rootPath: [__dirname, '..', 'test-fixtures', 'mongo', 'check-and-set-state'],
    gridFS: {bucketName: 'foobar'},
    useObjectId: true
  });
}

async function callback({
  getFixture,
  functionName,
  params,
  expectModificationTime = false,
  preFillDb = false,
  expectedToThrow = false,
  expectedErrorMessage = '',
  expectedErrorStatus = '',
  expectedOpResult = undefined,
  updateStateBeforeTest = undefined
}) {

  const mongoOperator = await getMongoOperator(mongoFixtures);
  const expectedResult = await getFixture('expectedResult.json');

  await doPreFillDb(preFillDb);

  async function doPreFillDb(preFillDb) {
    if (preFillDb) {
      await mongoFixtures.populate(getFixture('dbContents.json'));
      return;
    }
    return;
  }

  if (functionName === 'checkAndSetState') {
    try {
      debug(`checkAndSetState`);
      debug(JSON.stringify(params));
      //{correlationId, state, errorMessage = undefined, errorStatus = undefined})
      // timeout

      // eslint-disable-next-line functional/no-conditional-statements
      if (updateStateBeforeTest && params.correlationId) {
        debug(`setState to reset modificationTime`);
        await mongoOperator.setState({correlationId: params.correlationId, state: updateStateBeforeTest});
      }
      const opResult = await mongoOperator.checkAndSetState(params);
      debug(`checkAndSetState result: ${JSON.stringify(opResult)} (it should be: ${JSON.stringify(expectedOpResult)})}`);

      // eslint-disable-next-line functional/no-conditional-statements
      if (expectedOpResult !== undefined) {
        expect(opResult).to.eql(expectedOpResult);
      }
      await compareToFirstDbEntry({mongoFixtures, expectedResult, expectModificationTime, formatDates: true});

    } catch (error) {
      handleError({error, expectedToThrow, expectedErrorMessage, expectedErrorStatus});
    }
    return;
  }

  throw new Error(`Unknown functionName: ${functionName}`);
}
