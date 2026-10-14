
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

// B-38: getStream is now async - it pre-checks file existence (throws 404
// for a missing file) and wraps bucket errors into ApiError 500 rejections.
// (Previously it was synchronous and a missing file surfaced as an unhandled
// 'error' event on the returned stream.)

test('B-38: getStream rejects with ApiError 404 when the GridFS file does not exist', async () => {
  const mongo = await makeMongo({
    operator: makeOperator(),
    gridFSBucket: makeGridFSBucket({
      find: () => ({toArray: async () => []})
    })
  });
  await assert.rejects(
    () => mongo.getStream('FOO'),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, httpStatus.NOT_FOUND);
      return true;
    }
  );
});

test('B-38: getStream rejects with ApiError 500 when openDownloadStreamByName throws', async () => {
  const mongo = await makeMongo({
    operator: makeOperator(),
    gridFSBucket: makeGridFSBucket({
      find: () => ({toArray: async () => [{_id: '1', filename: 'FOO'}]}),
      openDownloadStreamByName: () => {
        throw new Error('sync bucket failure');
      }
    })
  });
  await assert.rejects(
    () => mongo.getStream('FOO'),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, httpStatus.INTERNAL_SERVER_ERROR);
      assert.ok(error.payload.includes('Mongo errored'));
      return true;
    }
  );
});

test('B-37: checkTimeOut returns false (no crash) when the queueItem does not exist', async () => {
  const mongo = await makeMongo({
    operator: makeOperator({findOne: async () => null}),
    gridFSBucket: makeGridFSBucket()
  });
  const result = await mongo.checkTimeOut({correlationId: 'NOPE'});
  assert.equal(result, false);
});

test('B-11: setOperation rejects with ApiError 404 for a non-matching correlationId', async () => {
  const mongo = await makeMongo({
    operator: makeOperator({findOne: async () => null}),
    gridFSBucket: makeGridFSBucket()
  });
  await assert.rejects(
    () => mongo.setOperation({correlationId: 'NOPE', operation: 'UPDATE'}),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, httpStatus.NOT_FOUND);
      return true;
    }
  );
});

test('B-11: setOperations rejects with ApiError 404 for a non-matching correlationId', async () => {
  const mongo = await makeMongo({
    operator: makeOperator({findOne: async () => null}),
    gridFSBucket: makeGridFSBucket()
  });
  await assert.rejects(
    () => mongo.setOperations({correlationId: 'NOPE', addOperation: 'UPDATE'}),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, httpStatus.NOT_FOUND);
      return true;
    }
  );
});

test('B-11: setOperation returns the resulting document (v6 driver shape, no {ok, value})', async () => {
  const doc = {correlationId: 'FOO', operation: 'UPDATE'};
  const mongo = await makeMongo({
    operator: makeOperator({
      findOne: async () => ({correlationId: 'FOO', operation: 'CREATE'}),
      findOneAndUpdate: async () => doc
    }),
    gridFSBucket: makeGridFSBucket()
  });
  const result = await mongo.setOperation({correlationId: 'FOO', operation: 'UPDATE'});
  assert.deepStrictEqual(result, doc);
});

test('B-8: createBulk (stream) returns the normalized {correlationId, acknowledged, queueItemState} shape', async () => {
  const input = new Readable({
    read() {
      this.push(Buffer.from('chunk'));
      this.push(null);
    }
  });
  const mongo = await makeMongo({
    operator: makeOperator({insertOne: async () => ({acknowledged: true, insertedId: 1})}),
    gridFSBucket: makeGridFSBucket({openUploadStream: () => new PassThrough()})
  });
  const result = await mongo.createBulk({
    correlationId: 'FOO',
    cataloger: 'xxx',
    oCatalogerIn: 'xxx',
    operation: 'CREATE',
    contentType: 'application/json',
    recordLoadParams: {},
    stream: input
  });
  assert.deepStrictEqual(result, {
    correlationId: 'FOO',
    acknowledged: true,
    queueItemState: 'UPLOADING'
  });
});

test('B-12: checkTimeOut honours MONGO_TIMEOUT_MINUTES (older item than the window is aborted)', async () => {
  process.env.MONGO_TIMEOUT_MINUTES = '5';
  const oldDate = new Date(Date.now() - 4 * 60 * 1000); // 4 min old: fine at 5m, not at 1m
  const mongo = await makeMongo({
    operator: makeOperator({
      findOne: async () => ({
        correlationId: 'FOO',
        queueItemState: 'VALIDATING',
        modificationTime: oldDate,
        importJobState: {CREATE: 'DONE', UPDATE: 'DONE', FIX: 'DONE'}
      })
    }),
    gridFSBucket: makeGridFSBucket()
  });
  const result = await mongo.checkTimeOut({correlationId: 'FOO'});
  delete process.env.MONGO_TIMEOUT_MINUTES;
  assert.equal(result, true);
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

// pushIds / pushMessages validate their array inputs (400, outside the
// try so the 400 is not re-wrapped) and wrap driver errors in ApiError 500.

test('pushIds rejects with ApiError 400 when handledIds is not an array', async () => {
  const mongo = await makeMongo({operator: makeOperator(), gridFSBucket: makeGridFSBucket()});
  await assert.rejects(
    () => mongo.pushIds({correlationId: 'FOO', handledIds: 'nope', rejectedIds: []}),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, httpStatus.BAD_REQUEST);
      return true;
    }
  );
});

test('pushIds rejects with ApiError 400 when rejectedIds is not an array', async () => {
  const mongo = await makeMongo({operator: makeOperator(), gridFSBucket: makeGridFSBucket()});
  await assert.rejects(
    () => mongo.pushIds({correlationId: 'FOO', handledIds: [], rejectedIds: undefined}),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, httpStatus.BAD_REQUEST);
      return true;
    }
  );
});

test('pushIds rejects with ApiError 500 "Mongo errored" when updateOne throws', async () => {
  const mongo = await makeMongo({
    operator: makeOperator({updateOne: async () => {
      throw new Error('pushIds boom');
    }}),
    gridFSBucket: makeGridFSBucket()
  });
  await assert.rejects(
    () => mongo.pushIds({correlationId: 'FOO', handledIds: ['1'], rejectedIds: []}),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, httpStatus.INTERNAL_SERVER_ERROR);
      assert.ok(error.payload.includes('Mongo errored'));
      assert.ok(error.payload.includes('pushIds boom'));
      return true;
    }
  );
});

test('pushMessages rejects with ApiError 400 when messages is not an array', async () => {
  const mongo = await makeMongo({operator: makeOperator(), gridFSBucket: makeGridFSBucket()});
  await assert.rejects(
    () => mongo.pushMessages({correlationId: 'FOO', messages: 'nope'}),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, httpStatus.BAD_REQUEST);
      return true;
    }
  );
});

test('pushMessages rejects with ApiError 500 "Mongo errored" when updateOne throws', async () => {
  const mongo = await makeMongo({
    operator: makeOperator({updateOne: async () => {
      throw new Error('pushMessages boom');
    }}),
    gridFSBucket: makeGridFSBucket()
  });
  await assert.rejects(
    () => mongo.pushMessages({correlationId: 'FOO', messages: ['m1']}),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, httpStatus.INTERNAL_SERVER_ERROR);
      assert.ok(error.payload.includes('Mongo errored'));
      assert.ok(error.payload.includes('pushMessages boom'));
      return true;
    }
  );
});
