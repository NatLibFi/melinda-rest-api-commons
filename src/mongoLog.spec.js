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
      blobmetadatas: {
        creationTime: v => new Date(v),
        modificationTime: v => new Date(v)
      }
    }
  });
}

async function callback({
  getFixture,
  functionName,
  params
}) {
  const mongoUri = await mongoFixtures.getUri();
  await mongoFixtures.populate(getFixture('dbContents.json'));
  const mongoLogOperator = await createMongoLogOperator({mongoUri});
  if (functionName === 'addLogItem') { // eslint-disable-line functional/no-conditional-statements
    mongoLogOperator.addLogItem(params);
  }

  const dump = await mongoFixtures.dump();
  const expectedResult = await getFixture('expectedResult.json');
  expect(dump).to.eql(expectedResult);
}
