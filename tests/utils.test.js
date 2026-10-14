
import assert from 'node:assert';
import {test} from 'node:test';
import httpStatus from 'http-status';
import {Error as ApiError} from '@natlibfi/melinda-commons';
import {
  logError,
  createImportJobState,
  createRecordResponseItem,
  addRecordResponseItem,
  addRecordResponseItems
} from '../src/utils.js';

test('createImportJobState should return state object for valid operation and state', () => {
  const result = createImportJobState('CREATE', 'EMPTY');
  assert.deepStrictEqual(result, {CREATE: 'EMPTY'});
});

test('createImportJobState should return query object when queryImportJobState is true', () => {
  const result = createImportJobState('CREATE', 'EMPTY', true);
  assert.deepStrictEqual(result, {'importJobState.CREATE': 'EMPTY'});
});

test('createImportJobState should throw for invalid state', () => {
  assert.throws(() => {
    createImportJobState('CREATE', 'INVALID_STATE');
  }, new Error('Invalid IMPORT_JOB_STATE'));
});

test('createImportJobState should throw for invalid operation', () => {
  assert.throws(() => {
    createImportJobState('INVALID_OPERATION', 'EMPTY');
  }, new Error('Invalid operation'));
});

test('createRecordResponseItem should use message from responsePayload.message', () => {
  const result = createRecordResponseItem({
    responsePayload: {message: 'payload message'},
    responseStatus: 'UPDATED'
  });
  assert.equal(result.message, 'payload message');
});

test('createRecordResponseItem should use string responsePayload as message', () => {
  const result = createRecordResponseItem({
    responsePayload: 'string payload',
    responseStatus: 'UPDATED'
  });
  assert.equal(result.message, 'string payload');
});

test('createRecordResponseItem should use empty message when payload has no message', () => {
  const result = createRecordResponseItem({
    responsePayload: {ids: ['123']},
    responseStatus: 'UPDATED'
  });
  assert.equal(result.message, '');
});

test('createRecordResponseItem should default databaseId when id is omitted', () => {
  const result = createRecordResponseItem({
    responsePayload: {message: 'ok'},
    responseStatus: 'UPDATED'
  });
  assert.equal(result.databaseId, '000000000');
});

test('createRecordResponseItem should set databaseId from id when provided', () => {
  const result = createRecordResponseItem({
    responsePayload: {message: 'ok'},
    responseStatus: 'UPDATED',
    id: '12345'
  });
  assert.equal(result.databaseId, '12345');
});

test('createRecordResponseItem should map UPDATED, CREATED and INVALID statuses', () => {
  for (const responseStatus of ['UPDATED', 'CREATED', 'INVALID']) {
    const result = createRecordResponseItem({
      responsePayload: {message: 'msg'},
      responseStatus
    });
    assert.equal(result.recordStatus, responseStatus);
    assert.equal(result.detailedRecordStatus, responseStatus);
    assert.equal(result.message, 'msg');
  }
});

test('createRecordResponseItem should map SKIPPED status', () => {
  const result = createRecordResponseItem({
    responsePayload: {message: 'skipped'},
    responseStatus: 'SKIPPED'
  });
  assert.equal(result.recordStatus, 'SKIPPED');
  assert.equal(result.detailedRecordStatus, 'SKIPPED');
});

test('createRecordResponseItem should map SKIPPED_UPDATE to recordStatus SKIPPED', () => {
  const result = createRecordResponseItem({
    responsePayload: {message: 'skipped update'},
    responseStatus: 'SKIPPED_UPDATE'
  });
  assert.equal(result.recordStatus, 'SKIPPED');
  assert.equal(result.detailedRecordStatus, 'SKIPPED_UPDATE');
});

test('createRecordResponseItem should map CONFLICT duplicate message to DUPLICATE', () => {
  const result = createRecordResponseItem({
    responsePayload: {
      message: 'Duplicates in database: 123',
      ids: ['123', '456']
    },
    responseStatus: httpStatus.CONFLICT,
    id: '123'
  });
  assert.equal(result.recordStatus, 'DUPLICATE');
  assert.equal(result.detailedRecordStatus, 'DUPLICATE');
  assert.deepStrictEqual(result.ids, ['123', '456']);
});

test('createRecordResponseItem should map CONFLICT MatchValidation message to ERROR', () => {
  const result = createRecordResponseItem({
    responsePayload: {
      message: 'MatchValidation for all: something',
      ids: ['123']
    },
    responseStatus: 'CONFLICT',
    id: '123'
  });
  assert.equal(result.recordStatus, 'ERROR');
  assert.equal(result.detailedRecordStatus, 'CONFLICT');
});

test('createRecordResponseItem should attach ids to CONFLICT when id does not match', () => {
  const result = createRecordResponseItem({
    responsePayload: {
      message: 'conflict',
      ids: ['789']
    },
    responseStatus: httpStatus.CONFLICT,
    id: '123'
  });
  assert.equal(result.recordStatus, 'ERROR');
  assert.equal(result.detailedRecordStatus, 'CONFLICT');
  assert.deepStrictEqual(result.ids, ['789']);
});

test('createRecordResponseItem should omit ids from CONFLICT when ids matches id', () => {
  const result = createRecordResponseItem({
    responsePayload: {
      message: 'conflict',
      ids: ['123']
    },
    responseStatus: httpStatus.CONFLICT,
    id: '123'
  });
  assert.equal(result.recordStatus, 'ERROR');
  assert.equal(result.detailedRecordStatus, 'CONFLICT');
  assert.equal(Object.hasOwn(result, 'ids'), false);
});

// documents current behaviour — an undefined responsePayload throws a
// TypeError (dereferencing recordMetadata / message). The later fix should
// make createRecordResponseItem tolerate a missing payload.
test('createRecordResponseItem should throw with undefined responsePayload', () => {
  assert.throws(() => {
    createRecordResponseItem({
      responsePayload: undefined,
      responseStatus: 'UPDATED'
    });
  }, TypeError);
});

// for CONFLICT with an empty ids array, no `ids` field is
// attached to the response item (previously the empty array was attached
// because `ids[0] !== id` was true for an empty array).
test('createRecordResponseItem should omit ids on CONFLICT when ids is empty', () => {
  const result = createRecordResponseItem({
    responsePayload: {
      message: 'conflict',
      ids: []
    },
    responseStatus: httpStatus.CONFLICT,
    id: '123'
  });
  assert.equal(result.recordStatus, 'ERROR');
  assert.equal(result.detailedRecordStatus, 'CONFLICT');
  assert.equal(Object.hasOwn(result, 'ids'), false);
});

test('createRecordResponseItem should map UNPROCESSABLE_ENTITY to INVALID', () => {
  const result = createRecordResponseItem({
    responsePayload: {
      message: 'unprocessable',
      ids: ['456']
    },
    responseStatus: httpStatus.UNPROCESSABLE_ENTITY,
    id: '123'
  });
  assert.equal(result.recordStatus, 'INVALID');
  assert.equal(result.detailedRecordStatus, 'UNPROCESSABLE_ENTITY');
  assert.deepStrictEqual(result.ids, ['456']);
});

test('createRecordResponseItem should map UNPROCESSABLE_ENTITY without ids when matching', () => {
  const result = createRecordResponseItem({
    responsePayload: {
      message: 'unprocessable',
      ids: ['123']
    },
    responseStatus: 'UNPROCESSABLE_ENTITY',
    id: '123'
  });
  assert.equal(result.recordStatus, 'INVALID');
  assert.equal(result.detailedRecordStatus, 'UNPROCESSABLE_ENTITY');
  assert.equal(Object.hasOwn(result, 'ids'), false);
});

test('createRecordResponseItem should map NOT_FOUND to ERROR', () => {
  const result = createRecordResponseItem({
    responsePayload: {message: 'not found'},
    responseStatus: httpStatus.NOT_FOUND
  });
  assert.equal(result.recordStatus, 'ERROR');
  assert.equal(result.detailedRecordStatus, 'NOT_FOUND');
  assert.equal(result.message, 'not found');
});

test('createRecordResponseItem should map FORBIDDEN to ERROR', () => {
  const result = createRecordResponseItem({
    responsePayload: {message: 'forbidden'},
    responseStatus: httpStatus.FORBIDDEN
  });
  assert.equal(result.recordStatus, 'ERROR');
  assert.equal(result.detailedRecordStatus, 'FORBIDDEN');
  assert.equal(result.message, 'forbidden');
});

test('createRecordResponseItem should map unknown status to ERROR with appended message', () => {
  const result = createRecordResponseItem({
    responsePayload: {message: 'some message'},
    responseStatus: 'SOMETHING_ELSE'
  });
  assert.equal(result.recordStatus, 'ERROR');
  assert.equal(result.detailedRecordStatus, 'SOMETHING_ELSE');
  assert.equal(result.message, 'some message - Unknown recordStatus: SOMETHING_ELSE');
});

test('createRecordResponseItem should map UNKNOWN status to ERROR with ids', () => {
  const result = createRecordResponseItem({
    responsePayload: {
      message: 'unknown',
      ids: ['42']
    },
    responseStatus: 'UNKNOWN'
  });
  assert.equal(result.recordStatus, 'ERROR');
  assert.equal(result.detailedRecordStatus, 'UNKNOWN');
  assert.deepStrictEqual(result.ids, ['42']);
});

test('addRecordResponseItem should push the recordResponseItem via mongoOperator', async () => {
  let captured;
  const mongoOperator = {
    pushMessages: async (args) => {
      captured = args;
    }
  };
  const recordResponseItem = {databaseId: '000000000'};
  const result = await addRecordResponseItem({
    recordResponseItem,
    correlationId: 'corr-1',
    mongoOperator
  });
  assert.equal(result, true);
  assert.deepStrictEqual(captured, {
    correlationId: 'corr-1',
    messages: [recordResponseItem],
    messageField: 'records'
  });
});

test('addRecordResponseItem should throw for non-object input', async () => {
  const mongoOperator = {
    pushMessages: async () => {}
  };
  for (const badInput of [undefined, null, 'not-an-object', 42, [{databaseId: '1'}]]) {
    await assert.rejects(
      addRecordResponseItem({
        recordResponseItem: badInput,
        correlationId: 'corr-42',
        mongoOperator
      }),
      new Error('RecordResponseItem is not an object!')
    );
  }
});

test('addRecordResponseItems should push all items in one call', async () => {
  let captured;
  let callCount = 0;
  const mongoOperator = {
    pushMessages: async (args) => {
      callCount += 1;
      captured = args;
    }
  };
  const items = [
    {databaseId: '1'},
    {databaseId: '2'}
  ];
  const result = await addRecordResponseItems({
    recordResponseItems: items,
    correlationId: 'corr-2',
    mongoOperator
  });
  assert.equal(result, true);
  assert.equal(callCount, 1);
  assert.deepStrictEqual(captured, {
    correlationId: 'corr-2',
    messages: items,
    messageField: 'records'
  });
});

test('addRecordResponseItems should throw for non-array input', async () => {
  const mongoOperator = {
    pushMessages: async () => {}
  };
  await assert.rejects(
    addRecordResponseItems({
      recordResponseItems: 'not-an-array',
      correlationId: 'corr-3',
      mongoOperator
    }),
    new Error('RecordResponseItems is not an array!')
  );
});

test('logError should not throw for ApiError, SIGINT and regular errors', () => {
  assert.doesNotThrow(() => {
    logError(new ApiError(404, 'Not found'));
  });
  assert.doesNotThrow(() => {
    logError('SIGINT');
  });
  assert.doesNotThrow(() => {
    logError(new Error('some error'));
  });
  assert.doesNotThrow(() => {
    logError('plain string without stack');
  });
});
