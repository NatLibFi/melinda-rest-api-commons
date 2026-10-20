
import assert from 'node:assert';
import {test} from 'node:test';
import {Readable, PassThrough} from 'node:stream';
import httpStatus from 'http-status';
import {MongoDriverError} from 'mongodb';
import {Error as ApiError} from '@natlibfi/melinda-commons';
import createMongo from '../src/mongo.js';
import createMongoLog from '../src/mongoLog.js';

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

test('remove: MongoDriverError "File not found" deletes queueItem and reports what was removed', async () => {
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
  assert.deepStrictEqual(result, {removed: true, deletedContent: false});
});

test('remove: returns {removed: true, deletedContent: true} when the queueItem and its GridFS file both exist', async () => {
  const deletedFiles = [];
  const mongo = await makeMongo({
    operator: makeOperator({deleteOne: async () => ({acknowledged: true, deletedCount: 1})}),
    gridFSBucket: makeGridFSBucket({
      find: () => ({toArray: async () => [{_id: 'file-1', filename: 'FOO'}]}),
      delete: async (id) => {
        // eslint-disable-next-line functional/immutable-data
        deletedFiles.push(id);
        return true;
      }
    })
  });
  const result = await mongo.remove({correlationId: 'FOO'});
  assert.deepStrictEqual(result, {removed: true, deletedContent: true});
  assert.deepStrictEqual(deletedFiles, ['file-1']);
});

test('remove: returns removed: false when the queueItem no longer exists in the collection', async () => {
  const mongo = await makeMongo({
    operator: makeOperator({deleteOne: async () => ({acknowledged: true, deletedCount: 0})}),
    gridFSBucket: makeGridFSBucket()
  });
  const result = await mongo.remove({correlationId: 'FOO'});
  assert.deepStrictEqual(result, {removed: false, deletedContent: false});
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

// getStream is now async - it pre-checks file existence (throws 404
// for a missing file) and wraps bucket errors into ApiError 500 rejections.
// (Previously it was synchronous and a missing file surfaced as an unhandled
// 'error' event on the returned stream.)

test('getStream rejects with ApiError 404 when the GridFS file does not exist', async () => {
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

test('getStream rejects with ApiError 500 when openDownloadStreamByName throws', async () => {
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

test('checkTimeOut returns false (no crash) when the queueItem does not exist', async () => {
  const mongo = await makeMongo({
    operator: makeOperator({findOne: async () => null}),
    gridFSBucket: makeGridFSBucket()
  });
  const result = await mongo.checkTimeOut({correlationId: 'NOPE'});
  assert.equal(result, false);
});

test('setOperation rejects with ApiError 404 for a non-matching correlationId', async () => {
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

test('setOperations rejects with ApiError 404 for a non-matching correlationId', async () => {
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

test('setOperation returns the resulting document (v6 driver shape, no {ok, value})', async () => {
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

test('createBulk (stream) returns the normalized {correlationId, acknowledged, queueItemState} shape', async () => {
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

test('checkTimeOut honours MONGO_TIMEOUT_MINUTES (older item than the window is aborted)', async () => {
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

// createBulk stream path used to have no error handling on the GridFS
// upload stream (hangs forever) and never aborted it on input errors
// (orphan partial chunks). Both are now wired to reject + cleanup.

test('createBulk rejects with ApiError 500 when input stream errors mid-upload, and cleans up the partial file', async () => {
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

test('createBulk rejects with ApiError 500 when the GridFS output stream errors (used to hang forever)', async () => {
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

// Entry-point type guards: a non-scalar (e.g. object) correlationId must be
// rejected with 400 before it can be spliced into a query as a $-operator.

test('checkAndSetState rejects with ApiError 400 when correlationId is not a string', async () => {
  const mongo = await makeMongo({operator: makeOperator(), gridFSBucket: makeGridFSBucket()});
  await assert.rejects(
    () => mongo.checkAndSetState({correlationId: {'$ne': ''}, state: 'VALIDATING'}),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, httpStatus.BAD_REQUEST);
      return true;
    }
  );
});

test('getOne rejects with ApiError 400 when queueItemState is not a string', async () => {
  const mongo = await makeMongo({operator: makeOperator({findOne: async () => null}), gridFSBucket: makeGridFSBucket()});
  await assert.rejects(
    () => mongo.getOne({queueItemState: {'$ne': ''}}),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, httpStatus.BAD_REQUEST);
      return true;
    }
  );
});

test('getOne rejects with ApiError 400 when importJobState is not an object', async () => {
  const mongo = await makeMongo({operator: makeOperator({findOne: async () => null}), gridFSBucket: makeGridFSBucket()});
  await assert.rejects(
    () => mongo.getOne({importJobState: 'IN_QUEUE'}),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, httpStatus.BAD_REQUEST);
      return true;
    }
  );
});

test('getOne rejects with ApiError 400 when importJobState has a $-operator key', async () => {
  const mongo = await makeMongo({operator: makeOperator({findOne: async () => null}), gridFSBucket: makeGridFSBucket()});
  await assert.rejects(
    () => mongo.getOne({importJobState: {'$ne': ''}}),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, httpStatus.BAD_REQUEST);
      return true;
    }
  );
});

test('getOne rejects with ApiError 400 when an importJobState value is not a string', async () => {
  const mongo = await makeMongo({operator: makeOperator({findOne: async () => null}), gridFSBucket: makeGridFSBucket()});
  await assert.rejects(
    () => mongo.getOne({importJobState: {'importJobState.UPDATE': {'$gt': ''}}}),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, httpStatus.BAD_REQUEST);
      return true;
    }
  );
});

test('getOne queries findOne with a valid importJobState filter', async () => {
  const filters = [];
  const mongo = await makeMongo({
    operator: makeOperator({findOne: async (filter) => {
      // eslint-disable-next-line functional/immutable-data
      filters.push(filter);
      return null;
    }}),
    gridFSBucket: makeGridFSBucket()
  });
  const result = await mongo.getOne({importJobState: {'importJobState.UPDATE': 'IN_QUEUE'}});
  assert.strictEqual(result, null);
  assert.deepStrictEqual(filters, [{'importJobState.UPDATE': 'IN_QUEUE'}]);
});

test('setBlobSize rejects with ApiError 400 when blobSize is not a number', async () => {
  const mongo = await makeMongo({operator: makeOperator(), gridFSBucket: makeGridFSBucket()});
  await assert.rejects(
    () => mongo.setBlobSize({correlationId: 'FOO', blobSize: '7'}),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, httpStatus.BAD_REQUEST);
      return true;
    }
  );
});

test('setBlobSize stores a real number when blobSize is a number', async () => {
  const updates = [];
  const mongo = await makeMongo({
    operator: makeOperator({findOneAndUpdate: async (filter, update) => {
      // eslint-disable-next-line functional/immutable-data
      updates.push({filter, update});
      return {correlationId: 'FOO', blobSize: 7};
    }}),
    gridFSBucket: makeGridFSBucket()
  });
  await mongo.setBlobSize({correlationId: 'FOO', blobSize: 7});
  assert.strictEqual(updates.length, 1);
  assert.strictEqual(updates[0].update.$set.blobSize, 7);
  assert.strictEqual(typeof updates[0].update.$set.blobSize, 'number');
});

test('pushMessages rejects with ApiError 400 when messageField is not a string', async () => {
  const mongo = await makeMongo({operator: makeOperator(), gridFSBucket: makeGridFSBucket()});
  await assert.rejects(
    () => mongo.pushMessages({correlationId: 'FOO', messages: ['m1'], messageField: 42}),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, httpStatus.BAD_REQUEST);
      return true;
    }
  );
});

test('createBulk (stream): insertOne with acknowledged=false throws ApiError 500', async () => {
  const input = new Readable({
    read() {
      this.push(Buffer.from('chunk'));
      this.push(null);
    }
  });
  const mongo = await makeMongo({
    operator: makeOperator({insertOne: async () => ({acknowledged: false})}),
    gridFSBucket: makeGridFSBucket({openUploadStream: () => new PassThrough()})
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
      assert.ok(error.payload.includes('Mongo errored'));
      return true;
    }
  );
});

test('createBulk (stream): a failing GridFS cleanup does not mask the original upload error', async () => {
  // input errors mid-upload AND the partial-file cleanup (gridFSBucket.find)
  // throws too: the cleanup error is only logged, the original error must
  // still propagate
  const input = new Readable({
    read() {
      setImmediate(() => this.emit('error', new Error('input stream boom')));
    }
  });
  const mongo = await makeMongo({
    operator: makeOperator(),
    gridFSBucket: makeGridFSBucket({
      openUploadStream: () => new PassThrough(),
      find: () => {
        throw new Error('gridfs cleanup boom');
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
      assert.ok(!error.payload.includes('gridfs cleanup boom'));
      return true;
    }
  );
});

test('remove: non-MongoDriverError from deleteOne throws ApiError 500 with the error message', async () => {
  const mongo = await makeMongo({
    operator: makeOperator({deleteOne: async () => {
      throw new Error('plain delete boom');
    }}),
    gridFSBucket: makeGridFSBucket()
  });
  await assert.rejects(
    () => mongo.remove({correlationId: 'FOO'}),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, httpStatus.INTERNAL_SERVER_ERROR);
      assert.ok(error.payload.includes('plain delete boom'));
      return true;
    }
  );
});

test('setOperation rejects with ApiError 404 when findOneAndUpdate returns null', async () => {
  const mongo = await makeMongo({
    operator: makeOperator({
      findOne: async () => ({correlationId: 'FOO', operation: 'CREATE'}),
      findOneAndUpdate: async () => null
    }),
    gridFSBucket: makeGridFSBucket()
  });
  await assert.rejects(
    () => mongo.setOperation({correlationId: 'FOO', operation: 'UPDATE'}),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, httpStatus.NOT_FOUND);
      assert.ok(error.payload.message.includes('not found'));
      return true;
    }
  );
});

// mongoLog: same deps-seam convention as mongo (factory last param). When
// deps.collection is provided no real connection is made and every
// db.collection('logs') call routes to the injected object. These tests
// cover the catch blocks that re-wrap driver failures as ApiError 500.

function makeLogCollection(overrides = {}) {
  return {
    insertOne: async () => ({acknowledged: true, insertedId: 1}),
    updateMany: async () => ({acknowledged: true, matchedCount: 0, modifiedCount: 0}),
    deleteMany: async () => ({acknowledged: true, deletedCount: 0}),
    ...overrides
  };
}

async function makeMongoLog(deps) {
  return createMongoLog(DUMMY_URI, 'rest-api', deps);
}

function mongoErrored500(text) {
  return (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, httpStatus.INTERNAL_SERVER_ERROR);
    assert.ok(error.payload.includes('Mongo errored'));
    assert.ok(error.payload.includes(text));
    return true;
  };
}

test('mongoLog addLogItem: insertOne with acknowledged=false throws ApiError 500', async () => {
  const mongoLog = await makeMongoLog({
    collection: makeLogCollection({insertOne: async () => ({acknowledged: false})})
  });
  await assert.rejects(
    () => mongoLog.addLogItem({correlationId: 'FOO', logItemType: 'MERGE_LOG', blobSequence: 1}),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, httpStatus.INTERNAL_SERVER_ERROR);
      return true;
    }
  );
});

test('mongoLog addLogItem: insertOne rejecting throws ApiError 500 with "Mongo errored" message', async () => {
  const mongoLog = await makeMongoLog({
    collection: makeLogCollection({insertOne: async () => {
      throw new Error('addLogItem boom');
    }})
  });
  await assert.rejects(
    () => mongoLog.addLogItem({correlationId: 'FOO', logItemType: 'MERGE_LOG', blobSequence: 1}),
    mongoErrored500('addLogItem boom')
  );
});

test('mongoLog protect: updateMany rejecting throws ApiError 500 with "Mongo errored" message', async () => {
  const mongoLog = await makeMongoLog({
    collection: makeLogCollection({updateMany: async () => {
      throw new Error('protect boom');
    }})
  });
  await assert.rejects(
    () => mongoLog.protect('FOO'),
    mongoErrored500('protect boom')
  );
});

test('mongoLog unprotect: updateMany rejecting throws ApiError 500 with "Mongo errored" message', async () => {
  const mongoLog = await makeMongoLog({
    collection: makeLogCollection({updateMany: async () => {
      throw new Error('unprotect boom');
    }})
  });
  await assert.rejects(
    () => mongoLog.unprotect('FOO'),
    mongoErrored500('unprotect boom')
  );
});

test('mongoLog remove: deleteMany rejecting throws ApiError 500 with "Mongo errored" message', async () => {
  const mongoLog = await makeMongoLog({
    collection: makeLogCollection({deleteMany: async () => {
      throw new Error('remove boom');
    }})
  });
  await assert.rejects(
    () => mongoLog.remove('FOO'),
    mongoErrored500('remove boom')
  );
});

test('mongoLog removeBySequences: deleteMany rejecting throws ApiError 500 with "Mongo errored" message', async () => {
  const mongoLog = await makeMongoLog({
    collection: makeLogCollection({deleteMany: async () => {
      throw new Error('removeBySequences boom');
    }})
  });
  await assert.rejects(
    () => mongoLog.removeBySequences('FOO', [1, 2]),
    mongoErrored500('removeBySequences boom')
  );
});

test('mongoLog protect: injected collection routes the update and returns its result', async () => {
  const filters = [];
  const result = {acknowledged: true, matchedCount: 1, modifiedCount: 1};
  const mongoLog = await makeMongoLog({
    collection: makeLogCollection({updateMany: async (filter) => {
      // eslint-disable-next-line functional/immutable-data
      filters.push(filter);
      return result;
    }})
  });
  const mongoLogResult = await mongoLog.protect('FOO');
  assert.deepStrictEqual(mongoLogResult, result);
  assert.deepStrictEqual(filters, [{correlationId: 'FOO'}]);
});
