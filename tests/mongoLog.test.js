import assert from 'node:assert';
import {READERS} from '@natlibfi/fixura';
import {Error as ApiError} from '@natlibfi/melinda-commons';
import generateTests from '@natlibfi/fixugen';
import mongoFixturesFactory from '@natlibfi/fixura-mongo';
import createMongoLogOperator from '../src/mongoLog.js';

let mongoFixtures;

generateTests({
  callback,
  path: [import.meta.dirname, '..', 'test-fixtures', 'mongoLog'],
  recurse: false,
  useMetadataFile: true,
  fixura: {
    failWhenNotFound: true,
    reader: READERS.JSON
  },
  hooks: {
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
    rootPath: [import.meta.dirname, '..', 'test-fixtures', 'mongoLog'],
    gridFS: {bucketName: 'blobs'},
    useObjectId: true,
    // fixura-mongo format is keyed by COLLECTION name, so the old
    // {creationTime, modificationTime} form never applied and the fixtures
    // stored creationTime as an ISO string (production addLogItem stores a
    // Date). Format under the 'logs' collection so tests see the real
    // production shape.
    format: {
      logs: {
        creationTime: v => new Date(v),
        modificationTime: v => new Date(v)
      }
    }
  });
}

async function callback({
  getFixture,
  functionName,
  params,
  preFillDb = false,
  expectError = false
}) {
  const mongoUri = await mongoFixtures.getUri();
  const mongoLogOperator = await createMongoLogOperator(mongoUri, '');
  const expectedResult = expectError ? undefined : await getFixture('expectedResult.json');
  // console.log(typeof mongoUri); // eslint-disable-line

  if (preFillDb) {
    await mongoFixtures.populate(getFixture('dbContents.json'));
  }

  if (functionName === 'addLogItem') {
    await mongoLogOperator.addLogItem(params);
    const dump = await mongoFixtures.dump();
    return assert.deepStrictEqual(dump.logs[0]['0'], expectedResult);
  }

  if (functionName === 'getListOfCatalogers') {
    const result = await mongoLogOperator.getListOfCatalogers();
    // console.log(result); // eslint-disable-line

    return assert.deepEqual(result, expectedResult);
  }

  if (functionName === 'getExpandedListOfLogs') {
    const result = await mongoLogOperator.getExpandedListOfLogs(params);
    // console.log(result); // eslint-disable-line

    return assert.deepEqual(normalizeDates(result), expectedResult);
  }

  if (functionName === 'getListOfLogs') {
    const result = await mongoLogOperator.getListOfLogs(params);
    // console.log(result); // eslint-disable-line
    return assert.deepEqual(result, expectedResult);
  }

  if (functionName === 'query') {
    const result = normalizeDates(await mongoLogOperator.query(params));
    // console.log(result); // eslint-disable-line
    return assert.deepEqual(result, expectedResult);
  }

  if (functionName === 'queryById') {
    const [correlationId, logItemType, skip, limit] = params;
    const result = normalizeDates(await mongoLogOperator.queryById(correlationId, logItemType, skip, limit));
    // console.log(result); // eslint-disable-line
    return assert.deepEqual(result, expectedResult);
  }

  if (functionName === 'getListOfCorrelationIds') {
    const result = await mongoLogOperator.getListOfCorrelationIds();
    // console.log(result); // eslint-disable-line
    return assert.deepEqual(result, expectedResult);
  }

  if (functionName === 'protect') {
    const [correlationId, blobSequence] = params;
    const result = await mongoLogOperator.protect(correlationId, blobSequence);
    assert.deepEqual(result, expectedResult);
    const remaining = (await dumpRemaining()).map(doc => {
      // protect() sets modificationTime to the current time, so it can't be
      // compared against a static fixture
      const fixed = {...doc};
      delete fixed.modificationTime;
      return fixed;
    });
    return assert.deepEqual(remaining, getFixture('expectedRemaining.json'));
  }

  if (functionName === 'remove') {
    const [correlationId, force] = params;
    const result = await mongoLogOperator.remove(correlationId, force);
    assert.deepEqual(result, expectedResult);
    return assert.deepEqual(await dumpRemaining(), getFixture('expectedRemaining.json'));
  }

  if (functionName === 'removeBySequences') {
    const [correlationId, sequences, force] = params;
    if (expectError) {
      // assert the throw, like in tests/utils.test.js
      return assert.rejects(
        async () => mongoLogOperator.removeBySequences(correlationId, sequences, force),
        error => error instanceof ApiError && error.status === 500
      );
    }
    const result = await mongoLogOperator.removeBySequences(correlationId, sequences, force);
    assert.deepEqual(result, expectedResult);
    return assert.deepEqual(await dumpRemaining(), getFixture('expectedRemaining.json'));
  }

  throw new Error(`Unknown functionName: ${functionName}`);
}

// Dump the surviving logs, normalized for comparison against a fixture
async function dumpRemaining() {
  return normalizeDates((await mongoFixtures.dump()).logs);
}

// Convert BSON Dates in the result to ISO strings and drop _id, so the result
// can be compared with the plain strings in expectedResult.json /
// expectedRemaining.json (fixura-mongo dump also strips _id)
function normalizeDates(docs) {
  return docs.map(doc => {
    const fixed = {...doc};
    delete fixed._id;
    if (fixed.creationTime instanceof Date) {
      fixed.creationTime = fixed.creationTime.toISOString();
    }
    if (fixed.modificationTime instanceof Date) {
      fixed.modificationTime = fixed.modificationTime.toISOString();
    }
    return fixed;
  });
}

