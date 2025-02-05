// import {expect} from 'chai';
import {READERS} from '@natlibfi/fixura';
import generateTests from '@natlibfi/fixugen';
import mongoFixturesFactory from '@natlibfi/fixura-mongo';
import {expect} from 'chai';
import createMongoLogOperator from './mongoLog';

let mongoFixtures; // eslint-disable-line functional/no-let

generateTests({
  callback,
  path: [__dirname, '..', 'test-fixtures', 'mongoLog'],
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
    beforeEach: () => mongoFixtures.clear(),
    afterEach: () => mongoFixtures.clear(),
    after: async () => {
      await mongoFixtures.close();
    }
  }
});

async function initMongofixtures() {
  mongoFixtures = await mongoFixturesFactory({
    rootPath: [__dirname, '..', 'test-fixtures', 'mongoLog'],
    gridFS: {bucketName: 'blobs'},
    useObjectId: true,
    format: {
      creationTime: v => new Date(v),
      modificationTime: v => new Date(v)
    }
  });
}

async function callback({
  getFixture,
  functionName,
  params,
  preFillDb = false
}) {
  const mongoUri = await mongoFixtures.getUri();
  const mongoLogOperator = await createMongoLogOperator(mongoUri, '');
  const expectedResult = await getFixture('expectedResult.json');
  // console.log(typeof mongoUri); // eslint-disable-line

  if (preFillDb) { // eslint-disable-line functional/no-conditional-statements
    await mongoFixtures.populate(getFixture('dbContents.json'));
  }

  if (functionName === 'addLogItem') {
    await mongoLogOperator.addLogItem(params);
    const dump = await mongoFixtures.dump();
    return expect(dump.logs[0]['0']).to.eql(expectedResult);
  }

  if (functionName === 'getListOfCatalogers') {
    const result = await mongoLogOperator.getListOfCatalogers();
    // console.log(result); // eslint-disable-line

    return expect(result).to.eql(expectedResult);
  }

  if (functionName === 'getExpandedListOfLogs') {
    const result = await mongoLogOperator.getExpandedListOfLogs(params);
    // console.log(result); // eslint-disable-line

    return expect(result).to.eql(expectedResult);
  }

  if (functionName === 'getListOfLogs') {
    const result = await mongoLogOperator.getListOfLogs(params);
    // console.log(result); // eslint-disable-line
    return expect(result).to.eql(expectedResult);
  }
  throw new Error(`Unknown functionName: ${functionName}`);
}

