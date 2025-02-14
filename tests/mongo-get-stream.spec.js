import {expect} from 'chai';
import {READERS} from '@natlibfi/fixura';
import mongoFixturesFactory from '@natlibfi/fixura-mongo';
import generateTests from '@natlibfi/fixugen';
import createDebugLogger from 'debug';
//import {handleError, compareToFirstDbEntry, compareToDbEntry, formatQueueItem, streamToString} from './testUtils';
import {getMongoOperator, handleError, streamToString} from './testUtils';

let mongoFixtures; // eslint-disable-line functional/no-let
const debug = createDebugLogger('@natlibfi/melinda-rest-api-commons/mongo:get-stream:test');

generateTests({
  callback,
  path: [__dirname, '..', 'test-fixtures', 'mongo', 'get-stream'],
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
    rootPath: [__dirname, '..', 'test-fixtures', 'mongo', 'get-stream'],
    gridFS: {bucketName: 'foobar'},
    useObjectId: true
  });
}

// eslint-disable-next-line max-statements
async function callback({
  getFixture,
  functionName,
  params,
  preFillDb = false,
  expectedToThrow = false,
  expectedErrorMessage = '',
  expectedErrorStatus = '',
  contentStream = false,
  createBulkParams = undefined
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


  if (functionName === 'getStream') {
    try {
      debug(`getStream`);
      debug(JSON.stringify(params));
      //correlationId

      // eslint-disable-next-line functional/no-conditional-statements
      if (createBulkParams) {
        const stream = contentStream ? await getFixture({components: ['contentStream'], reader: READERS.STREAM}) : createBulkParams.stream;
        //debug(stream);
        const params2 = {...createBulkParams, stream};
        const createBulkResult = await mongoOperator.createBulk(params2);
        debug(`createBulkResult: ${JSON.stringify(createBulkResult)}`);
      }
      //const {correlationId} = params;

      const opResult = mongoOperator.getStream(params);
      const opResultString = await streamToString(opResult);

      if (contentStream) {
        const contentStreamString = await getFixture({components: ['contentStream'], reader: READERS.TEXT});
        //debug(contentStreamString);
        expect(opResultString).to.eql(contentStreamString);
        return;
      }


    } catch (error) {
      handleError({error, expectedToThrow, expectedErrorMessage, expectedErrorStatus});
      return;
    }
    return;
  }
  throw new Error(`Unknown functionName: ${functionName}`);
}

