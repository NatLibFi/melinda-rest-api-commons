
import assert from 'node:assert';
import {test} from 'node:test';
import {Readable, PassThrough} from 'node:stream';
import httpStatus from 'http-status';
import {MongoDriverError} from 'mongodb';
import {Error as ApiError} from '@natlibfi/melinda-commons';
import createMongo from '../src/mongo.js';

const DUMMY_URI = 'mongodb://stub:27017/rest-api';
const COLLECTION = 'foobar';

function makeOperator(overrides = {}) {
  return {
    insertOne: async () => ({acknowledged: true, insertedId: 1}),
    deleteOne: async () => ({acknowledged: true, deletedCount: 1}),
    ...overrides
  };
}

function makeGridFSBucket(overrides = {}) {
  return {
    find: () => ({toArray: async () => []}),
    openDownloadStreamByName: () => {
      throw new Error('not implemented in stub');
    },
    ...overrides
  };
}

async function makeMongo(deps) {
  return createMongo(DUMMY_URI, COLLECTION, 'rest-api', deps);
}

test('createPrio: insertOne with acknowledged=false throws ApiError 500', async () => {
  const mongo = await makeMongo({
    operator: makeOperator({insertOne: async () => ({acknowledged: false})}),
    gridFSBucket: makeGridFSBucket()
  });
  await assert.rejects(
    () => mongo.createPrio({correlationId: 'FOO', cataloger: 'xxx', oCatalogerIn: 'xxx', operation: 'CREATE'}),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, httpStatus.INTERNAL_SERVER_ERROR);
      return true;
    }
  );
});

test('createPrio: insertOne rejecting throws ApiError 500 with "Mongo errored" message', async () => {
  const mongo = await makeMongo({
    operator: makeOperator({insertOne: async () => {
      throw new Error('boom');
    }}),
    gridFSBucket: makeGridFSBucket()
  });
  await assert.rejects(
    () => mongo.createPrio({correlationId: 'FOO', cataloger: 'xxx', oCatalogerIn: 'xxx', operation: 'CREATE'}),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, httpStatus.INTERNAL_SERVER_ERROR);
      assert.ok(error.payload.includes('Mongo errored'));
      return true;
    }
  );
});

test('createBulk (no stream): insertOne with acknowledged=false throws ApiError 500', async () => {
  const mongo = await makeMongo({
    operator: makeOperator({insertOne: async () => ({acknowledged: false})}),
    gridFSBucket: makeGridFSBucket()
  });
  await assert.rejects(
    () => mongo.createBulk({
      correlationId: 'FOO',
      cataloger: 'xxx',
      oCatalogerIn: 'xxx',
      operation: 'CREATE',
      contentType: 'application/json',
      recordLoadParams: {}
    }),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, httpStatus.INTERNAL_SERVER_ERROR);
      return true;
    }
  );
});

test('remove: MongoDriverError "File not found" deletes queueItem and returns true', async () => {
  const deleteOne = async () => ({acknowledged: true, deletedCount: 1});
  const mongo = await makeMongo({
    operator: makeOperator({deleteOne}),
    gridFSBucket: makeGridFSBucket({
      find: () => ({
        toArray: async () => {
          throw new MongoDriverError('File not found for id (ObjectId("abc"))');
        }
      })
    })
  });
  const result = await mongo.remove({correlationId: 'FOO'});
  assert.equal(result, true);
});

test('remove: MongoDriverError with other message throws ApiError 500', async () => {
  const mongo = await makeMongo({
    operator: makeOperator(),
    gridFSBucket: makeGridFSBucket({
      find: () => ({
        toArray: async () => {
          throw new MongoDriverError('some other driver error');
        }
      })
    })
  });
  await assert.rejects(
    () => mongo.remove({correlationId: 'FOO'}),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, httpStatus.INTERNAL_SERVER_ERROR);
      assert.ok(error.payload.includes('some other driver error'));
      return true;
    }
  );
});

test('getStream: openDownloadStreamByName throwing synchronously throws ApiError 500', async () => {
  const mongo = await makeMongo({
    operator: makeOperator(),
    gridFSBucket: makeGridFSBucket({
      openDownloadStreamByName: () => {
        throw new Error('sync bucket failure');
      }
    })
  });
  // getStream is not async: a synchronous throw must be caught with assert.throws
  assert.throws(
    () => mongo.getStream('FOO'),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, httpStatus.INTERNAL_SERVER_ERROR);
      assert.ok(error.payload.includes('Mongo errored'));
      return true;
    }
  );
});

// B-9: createBulk stream path used to have no error handling on the GridFS
// upload stream (hangs forever) and never aborted it on input errors
// (orphan partial chunks). Both are now wired to reject + cleanup.

test('B-9: createBulk rejects with ApiError 500 when input stream errors mid-upload, and cleans up the partial file', async () => {
  const deletedFiles = [];
  // errors itself once flowing mode starts
  const input = new Readable({
    read() {
      setImmediate(() => this.emit('error', new Error('input stream boom')));
    }
  });
  const mongo = await makeMongo({
    operator: makeOperator(),
    gridFSBucket: makeGridFSBucket({
      openUploadStream: () => new PassThrough(),
      find: () => ({toArray: async () => [{_id: 'partial-1', filename: 'FOO'}]}),
      delete: async (id) => {
        // eslint-disable-next-line functional/immutable-data
        deletedFiles.push(id);
        return true;
      }
    })
  });
  await assert.rejects(
    () => mongo.createBulk({
      correlationId: 'FOO',
      cataloger: 'xxx',
      oCatalogerIn: 'xxx',
      operation: 'CREATE',
      contentType: 'application/json',
      recordLoadParams: {},
      stream: input
    }),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, httpStatus.INTERNAL_SERVER_ERROR);
      assert.ok(error.payload.includes('input stream boom'));
      return true;
    }
  );
  assert.deepStrictEqual(deletedFiles, ['partial-1']);
});

test('B-9: createBulk rejects with ApiError 500 when the GridFS output stream errors (used to hang forever)', async () => {
  const input = new Readable({read() {}});
  const mongo = await makeMongo({
    operator: makeOperator(),
    gridFSBucket: makeGridFSBucket({
      openUploadStream: () => {
        const output = new PassThrough();
        setImmediate(() => output.emit('error', new Error('disk on fire')));
        return output;
      }
    })
  });
  await assert.rejects(
    () => mongo.createBulk({
      correlationId: 'FOO',
      cataloger: 'xxx',
      oCatalogerIn: 'xxx',
      operation: 'CREATE',
      contentType: 'application/json',
      recordLoadParams: {},
      stream: input
    }),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, httpStatus.INTERNAL_SERVER_ERROR);
      assert.ok(error.payload.includes('disk on fire'));
      return true;
    }
  );
});
