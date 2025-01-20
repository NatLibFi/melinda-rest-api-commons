/* eslint-disable no-console */
import {expect} from 'chai';
import {READERS} from '@natlibfi/fixura';
import mongoFixturesFactory from '@natlibfi/fixura-mongo';
import generateTests from '@natlibfi/fixugen';
import createMongoOperator from './mongo';

let mongoFixtures; // eslint-disable-line functional/no-let

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

async function callback({
  getFixture,
  functionName,
  params,
  preFillDb = false
}) {

  const mongoUri = await mongoFixtures.getUri();
  const mongoOperator = await createMongoOperator(mongoUri, 'foobar', '');
  const expectedResult = await getFixture('expectedResult.json');
  // console.log(typeof mongoUri); // eslint-disable-line

  if (preFillDb) { // eslint-disable-line functional/no-conditional-statements
    await mongoFixtures.populate(getFixture('dbContents.json'));
  }

  //return {createPrio, createBulk, checkAndSetState, checkAndSetImportJobState, query, queryById, remove, readContent, removeContent, getOne, getStream, setState, setImportJobState, pushIds, pushMessages, setOperation, setOperations, addBlobSize, setBlobSize};

  if (functionName === 'createPrio') {
    try {
      console.log(`CreatePrio`);
      console.log(JSON.stringify(params));
      await mongoOperator.createPrio(params);
      const testFromDb = await mongoOperator.getOne({queueItemState: 'PENDING_VALIDATION'});
      console.log(`getOne: ${JSON.stringify(testFromDb)}`);
      //console.log(`Result: ${result}`);
      const dump = await mongoFixtures.dump();
      console.log(dump);
      expect(testFromDb).to.eql(expectedResult);
    } catch (error) {
      console.log(error); // eslint-disable-line
      throw error;
    }
    return;
  }

  throw new Error(`Unknown functionName: ${functionName}`);
}
