import assert from 'node:assert';
import {test, before, after} from 'node:test';
import mongoFixturesFactory from '@natlibfi/fixura-mongo';
import {Error as ApiError} from '@natlibfi/melinda-commons';
import createMongoLogOperator from '../src/mongoLog.js';

/** @type {*} */
let mongoFixtures;
/** @type {*} */
let mongoLogOperator;

async function initMongofixtures() {
  mongoFixtures = await mongoFixturesFactory(/** @type {*} */ ({
    rootPath: [import.meta.dirname, '..', 'test-fixtures', 'mongoLog'],
    gridFS: {bucketName: 'blobs'},
    useObjectId: true,
    format: {
      logs: {
        creationTime: /** @param {*} v */ v => new Date(v),
        modificationTime: /** @param {*} v */ v => new Date(v)
      }
    }
  }));
  const mongoUri = await mongoFixtures.getUri();
  mongoLogOperator = await createMongoLogOperator(mongoUri, '');
}

async function cleanup() {
  await mongoFixtures.clear();
  await mongoFixtures.close();
}

before(async () => {
  await initMongofixtures();
});

after(async () => {
  await cleanup();
});

test('protect is idempotent: protecting an already protected log keeps it protected', async () => {
  const logItem = {
    logItemType: 'MERGE_LOG',
    cataloger: 'IMP_TEST1',
    correlationId: '22222222-2222-4222-8222-222222222222',
    blobSequence: 1
  };
  await mongoLogOperator.addLogItem(logItem);

  await mongoLogOperator.protect(logItem.correlationId, logItem.blobSequence);

  // a second call must not toggle the log back to unprotected
  await mongoLogOperator.protect(logItem.correlationId, logItem.blobSequence);

  const {logs} = await mongoFixtures.dump();
  const own = logs.filter(/** @param {*} doc */ doc => doc.correlationId === logItem.correlationId);
  assert.equal(own.length, 1);
  assert.equal(own[0].protected, true);
});

test('unprotect sets protected to false after protect', async () => {
  const logItem = {
    logItemType: 'MERGE_LOG',
    cataloger: 'IMP_TEST1',
    correlationId: '33333333-3333-4333-8333-333333333333',
    blobSequence: 2
  };
  await mongoLogOperator.addLogItem(logItem);

  await mongoLogOperator.protect(logItem.correlationId, logItem.blobSequence);
  const result = await mongoLogOperator.unprotect(logItem.correlationId, logItem.blobSequence);
  assert.equal(result.modifiedCount, 1);

  const {logs} = await mongoFixtures.dump();
  const own = logs.filter(/** @param {*} doc */ doc => doc.correlationId === logItem.correlationId);
  assert.equal(own.length, 1);
  assert.equal(own[0].protected, false);
});

test('unprotect without blobSequence unprotects all logs of the correlationId', async () => {
  const correlationId = '44444444-4444-4444-8444-444444444444';
  await mongoLogOperator.addLogItem({logItemType: 'MERGE_LOG', cataloger: 'IMP_TEST1', correlationId, blobSequence: 1});
  await mongoLogOperator.addLogItem({logItemType: 'MATCH_LOG', cataloger: 'IMP_TEST1', correlationId, blobSequence: 2});

  await mongoLogOperator.protect(correlationId);
  const result = await mongoLogOperator.unprotect(correlationId);
  assert.equal(result.modifiedCount, 2);

  const {logs} = await mongoFixtures.dump();
  const own = logs.filter(/** @param {*} doc */ doc => doc.correlationId === correlationId);
  assert.equal(own.length, 2);
  assert.ok(own.every(/** @param {*} doc */ doc => doc.protected === false));
});

test('getExpandedListOfLogs throws ApiError when logItemTypes is provided but is not an array', async () => {
  await assert.rejects(
    () => mongoLogOperator.getExpandedListOfLogs({logItemTypes: 'MERGE_LOG'}),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.strictEqual(error.status, 400);
      assert.ok((/** @type {*} */ (error.payload)).includes('logItemTypes must be an array'));
      return true;
    }
  );
});

test('getExpandedListOfLogs throws ApiError when logItemTypes contains an unknown element', async () => {
  await assert.rejects(
    () => mongoLogOperator.getExpandedListOfLogs({logItemTypes: ['MERGE_LOG', 'BOGUS_LOG']}),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.strictEqual(error.status, 400);
      assert.ok((/** @type {*} */ (error.payload)).includes('Unknown logItemType'));
      return true;
    }
  );
});

test('getExpandedListOfLogs uses Date instances for dateBefore and dateAfter as-is', async () => {
  const logItem = {
    logItemType: 'MERGE_LOG',
    cataloger: 'IMP_TEST1',
    correlationId: '66666666-6666-4666-8666-666666666666',
    blobSequence: 1
  };
  await mongoLogOperator.addLogItem(logItem);
  // both bounds as Date instances: the match must use them as-is (no UTC
  // midnight anchoring), so the freshly created log is inside the window
  const result = await mongoLogOperator.getExpandedListOfLogs({
    logItemTypes: ['MERGE_LOG'],
    catalogers: ['IMP_TEST1'],
    dateBefore: new Date(Date.now() + 60 * 60 * 1000),
    dateAfter: new Date(Date.now() - 60 * 60 * 1000)
  });
  const own = result.filter(/** @param {*} entry */ entry => entry.correlationId === logItem.correlationId);
  assert.equal(own.length, 1);
  assert.equal(own[0].logCount, 1);
});

test('getListOfLogs throws ApiError 500 for an unknown logItemType', async () => {
  await assert.rejects(
    () => mongoLogOperator.getListOfLogs('BOGUS_LOG'),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.strictEqual(error.status, 500);
      assert.ok((/** @type {*} */ (error.payload)).includes('Unknown logItemType'));
      return true;
    }
  );
});

test('addLogItem with an unknown logItemType does not throw (warn path)', async () => {
  const logItem = {
    logItemType: 'BOGUS_LOG',
    cataloger: 'IMP_TEST1',
    correlationId: '77777777-7777-4777-8777-777777777777',
    blobSequence: 1
  };
  // checkLogItemType is called with errorUnknown=false for addLogItem, so an
  // unknown type must only warn, not throw, and the log must be stored
  await mongoLogOperator.addLogItem(logItem);

  const {logs} = await mongoFixtures.dump();
  const own = logs.filter(/** @param {*} doc */ doc => doc.correlationId === logItem.correlationId);
  assert.equal(own.length, 1);
  assert.equal(own[0].logItemType, 'BOGUS_LOG');
});

test('getExpandedListOfLogs with a valid logItemTypes array still works', async () => {
  const logItem = {
    logItemType: 'MERGE_LOG',
    cataloger: 'IMP_TEST1',
    correlationId: '55555555-5555-4555-8555-555555555555',
    blobSequence: 1
  };
  await mongoLogOperator.addLogItem(logItem);
  const result = await mongoLogOperator.getExpandedListOfLogs({logItemTypes: ['MERGE_LOG'], catalogers: ['IMP_TEST1'], dateBefore: new Date(Date.now() + 60 * 60 * 1000)});
  const own = result.filter(/** @param {*} entry */ entry => entry.correlationId === logItem.correlationId);
  assert.equal(own.length, 1);
  assert.equal(own[0].logItemType, 'MERGE_LOG');
  assert.equal(own[0].cataloger, 'IMP_TEST1');
  assert.equal(own[0].logCount, 1);
});
