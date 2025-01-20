/* eslint-disable no-console */
import {expect} from 'chai';
import {READERS} from '@natlibfi/fixura';
import mongoFixturesFactory from '@natlibfi/fixura-mongo';
import generateTests from '@natlibfi/fixugen';
import createMongoOperator from './mongo';
import createDebugLogger from 'debug';

let mongoFixtures; // eslint-disable-line functional/no-let
const debug = createDebugLogger('@natlibfi/melinda-rest-api-commons/mongo:test');

generateTests({
  callback,
  path: [__dirname, '..', 'test-fixtures', 'mongo'],
  recurse: false,
  useMetadataFile: true,
  fixura: {
    failWhenNotFound: true,
    reader: READERS.JSON
  },
  mocha: {
    before: async () => {
      await initMongofixtures();
    },
    beforeEach: async () => {
      await mongoFixtures.clear();
    },
    afterEach: async () => {
      await mongoFixtures.clear();
    },
    after: async () => {
      await mongoFixtures.close();
    }
  }
});

async function initMongofixtures() {
  mongoFixtures = await mongoFixturesFactory({
    rootPath: [__dirname, '..', 'test-fixtures', 'mongo'],
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
  expectedError = ''
}) {

  const mongoUri = await mongoFixtures.getUri();
  const mongoOperator = await createMongoOperator(mongoUri, 'foobar', '');
  const expectedResult = await getFixture('expectedResult.json');
  // debug(typeof mongoUri); // eslint-disable-line

  if (preFillDb) { // eslint-disable-line functional/no-conditional-statements
    await mongoFixtures.populate(getFixture('dbContents.json'));
  }

  //return {createPrio, createBulk, checkAndSetState, checkAndSetImportJobState, query, queryById, remove, readContent, removeContent, getOne, getStream, setState, setImportJobState, pushIds, pushMessages, setOperation, setOperations, addBlobSize, setBlobSize};

  if (functionName === 'createPrio') {
    try {
      debug(`CreatePrio`);
      debug(JSON.stringify(params));
      await mongoOperator.createPrio(params);
      const dump = await mongoFixtures.dump();
      const [result] = dump.foobar;
      debug(result);
      const formattedResult = formatQueueItem(result);
      expect(formattedResult).to.eql(expectedResult);
    } catch (error) {
      debug(error);
      if (expectedToThrow) {
        debug('Expected to throw');
        if (expectedError !== '') {
          expect(error).to.eql(expectedError);
          return;
        }
        return;
      }
      debug('Not expexted to throw');
      throw error;
    }
    return;
  }

  throw new Error(`Unknown functionName: ${functionName}`);
}

function formatQueueItem(queueItem) {
  const filteredQueueItem = {
    ...queueItem,
    creationTime: '',
    modificationTime: ''
  };
  debug(JSON.stringify(filteredQueueItem));
  return filteredQueueItem;
}
