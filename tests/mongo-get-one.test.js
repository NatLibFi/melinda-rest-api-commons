import assert from 'node:assert';
import {READERS} from '@natlibfi/fixura';
import mongoFixturesFactory from '@natlibfi/fixura-mongo';
import generateTests from '@natlibfi/fixugen';
import createDebugLogger from 'debug';
//import {handleError, compareToFirstDbEntry, compareToDbEntry, formatQueueItem, streamToString} from './testUtils.js';
import {getMongoOperator, handleError} from './testUtils.js';


let mongoFixtures; // eslint-disable-line functional/no-let
const debug = createDebugLogger('@natlibfi/melinda-rest-api-commons/mongo:get-one:test');

generateTests({
  callback,
  path: [import.meta.dirname, '..', 'test-fixtures', 'mongo', 'get-one'],
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
  mongoFixtures = await mongoFixturesFactory({
    recurse: false,
    rootPath: [import.meta.dirname, '..', 'test-fixtures', 'mongo', 'get-one'],
    gridFS: {bucketName: 'foobar'},
    useObjectId: true
  });
}

async function callback({
  getFixture,
  functionName,
  params,
  preFillDb = false,
  expectedToThrow = false,
  expectedErrorMessage = '',
  expectedErrorStatus = '',
  expectedOpResult = undefined
}) {

  const mongoOperator = await getMongoOperator(mongoFixtures);
  //const expectedResult = await getFixture('expectedResult.json');

  await doPreFillDb(preFillDb);

  async function doPreFillDb(preFillDb) {
    if (preFillDb) {
      await mongoFixtures.populate(getFixture('dbContents.json'));
      return;
    }
    return;
  }


  if (functionName === 'getOne') {
    try {
      debug(`getOne`);
      debug(JSON.stringify(params));
      //{queueItemState, importJobState = undefined}
      const opResult = await mongoOperator.getOne(params);
      debug(`getOne result: ${JSON.stringify(opResult)} (it should be: ${JSON.stringify(expectedOpResult)})}`);

      assert.deepStrictEqual(opResult, expectedOpResult);

    } catch (error) {
      handleError({error, expectedToThrow, expectedErrorMessage, expectedErrorStatus});
      return;
    }
    return;
  }
  throw new Error(`Unknown functionName: ${functionName}`);
}
