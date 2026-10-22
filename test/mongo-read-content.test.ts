import assert from 'node:assert';
import {READERS} from '@natlibfi/fixura';
import mongoFixturesFactory from '@natlibfi/fixura-mongo';
import generateTests from '@natlibfi/fixugen';
import createDebugLogger from 'debug';
//import {handleError, compareToFirstDbEntry, compareToDbEntry, formatQueueItem, streamToString} from './testUtils.js';
import {getMongoOperator, handleError, streamToString} from './testUtils.ts';


let mongoFixtures: any;
const debug = createDebugLogger('@natlibfi/melinda-rest-api-commons/mongo:read-content:test');

generateTests({
  callback,
  path: [import.meta.dirname, '..', 'test-fixtures', 'mongo', 'read-content'],
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
    rootPath: [import.meta.dirname, '..', 'test-fixtures', 'mongo', 'read-content'],
    gridFS: {bucketName: 'foobar'},
    useObjectId: true
  });
}

async function callback(callbackParams: Record<string, any>) {
  const {
  getFixture,
  functionName,
  params,
  preFillDb = false,
  expectedToThrow = false,
  expectedErrorMessage = '',
  expectedErrorStatus = '',
  contentStream = false,
  createBulkParams = undefined
  } = callbackParams;

  const mongoOperator = await getMongoOperator(mongoFixtures);
  //const expectedResult = await getFixture('expectedResult.json');

  await doPreFillDb(preFillDb);

  async function doPreFillDb(preFillDb: boolean) {
    if (preFillDb) {
      await mongoFixtures.populate(getFixture('dbContents.json'));
      // optional gridFSFiles.json uploads GridFS files (filename -> content)
      let gridFSFiles = undefined;
      try {
        gridFSFiles = getFixture('gridFSFiles.json');
      } catch {
        // no GridFS files for this fixture
      }
      if (gridFSFiles) {
        await mongoFixtures.populateFiles(gridFSFiles);
      }
      return;
    }
    return;
  }


  if (functionName === 'readContent') {
    try {
      debug(`readContent`);
      debug(JSON.stringify(params));
      //correlationId

      if (createBulkParams) {
        const stream = contentStream ? await getFixture({components: ['contentStream'], reader: READERS.STREAM}) : createBulkParams.stream;
        //debug(stream);
        const params2 = {...createBulkParams, stream};
        const createBulkResult = await mongoOperator.createBulk(params2);
        debug(`createBulkResult: ${JSON.stringify(createBulkResult)}`);
      }

      const opResult = await mongoOperator.readContent(params);
      const opResultString = await streamToString(opResult.readStream);

      if (createBulkParams && createBulkParams.contentType) {
        assert.equal(opResult.contentType, createBulkParams.contentType);
      }

      if (contentStream) {
        const contentStreamString = await getFixture({components: ['contentStream'], reader: READERS.TEXT});
        //debug(contentStreamString);
        assert.equal(opResultString, contentStreamString);
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
