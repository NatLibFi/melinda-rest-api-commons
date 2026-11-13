import assert from 'node:assert';
import {Error as ApiError} from '@natlibfi/melinda-commons';
import createDebugLogger from 'debug';
import type {Readable} from 'node:stream';
import createMongoOperator from '../src/mongo.ts';


const debug = createDebugLogger('@natlibfi/melinda-rest-api-commons/mongo:test');

/**
 * The ApiError payload is `unknown` in @natlibfi/melinda-commons. These
 * check the shape the test actually relies on, so a producer changing the
 * payload shape fails with a clear assertion instead of a TypeError at the
 * call site.
 */
export function payloadText(error: unknown): string {
  assert.ok(error instanceof ApiError, `expected an ApiError, got: ${String(error)}`);
  assert.equal(typeof error.payload, 'string');
  return error.payload as string;
}

export function payloadObject<T>(error: unknown): T {
  assert.ok(error instanceof ApiError, `expected an ApiError, got: ${String(error)}`);
  assert.equal(typeof error.payload, 'object');
  assert.ok(error.payload !== null);
  return error.payload as T;
}

// the fixura-mongo fixtures object is intentionally untyped in tests
// (fixture-driven scaffolding, see the eslint house rules for test/)
export async function getMongoOperator(mongoFixtures: any) {
  const mongoUri = await mongoFixtures.getUri();
  const mongoOperator = await createMongoOperator(mongoUri, 'foobar', '');
  return mongoOperator;
}

interface DbEntryCompareParams {
  mongoFixtures: any;
  expectedResult: unknown;
  expectModificationTime?: boolean;
  formatDates?: boolean;
  expectedFileCount?: number;
}

export async function compareToFirstDbEntry(params: DbEntryCompareParams) {
  const {mongoFixtures, expectedResult, expectModificationTime = false, formatDates = true, expectedFileCount = undefined} = params;
  const result = await compareToDbEntry({mongoFixtures, expectedResult, resultIndex: 0, expectModificationTime, formatDates, expectedFileCount});
  return result;
}

interface DbEntryParams extends DbEntryCompareParams {
  resultIndex?: number;
}

export async function compareToDbEntry(params: DbEntryParams) {
  const {mongoFixtures, expectedResult, resultIndex = 0, expectModificationTime = false, formatDates = true, expectedFileCount = undefined} = params;
  const dump = await mongoFixtures.dump();
  debug(`--- We have ${dump.foobar.length} documents in db`);
  debug(dump.foobar);
  const result = await dump.foobar[resultIndex];
  debug(`db result (document ${resultIndex}): ${JSON.stringify(result)}`);
  const dump2 = await mongoFixtures.dump();
  debug(`--- We have ${dump2.foobar.length} documents in db now`);

  checkFileCount({dump, expectedFileCount});

  checkModificationTime({result, expectModificationTime});

  if (formatDates && expectedResult !== undefined) {
    const formattedResult = formatQueueItem(result);
    assert.deepStrictEqual(formattedResult, expectedResult);
    return;
  }
  assert.deepStrictEqual(result, expectedResult);
  return;
}

interface CheckFileCountParams {
  dump: any;
  expectedFileCount: number | undefined;
}

function checkFileCount(params: CheckFileCountParams) {
  const {dump, expectedFileCount} = params;
  if (expectedFileCount !== undefined) {
    const fileCount = dump['foobar.files']?.length;
    debug(`--- We have ${fileCount} files in db`);
    assert.equal(fileCount, expectedFileCount);
    return;
  }
  return;

}

interface CheckModificationTimeParams {
  result: any;
  expectModificationTime: boolean;
}

function checkModificationTime(params: CheckModificationTimeParams) {
  const {result, expectModificationTime} = params;
  if (expectModificationTime) {
    debug('Check if modificationTime was edited');
    const isNotEmpty = result.modificationTime !== '';
    assert.equal(isNotEmpty, true);
    debug(`OK. We have modified modificationTime`);
    return;
  }
  return;
}


export function formatQueueItem(queueItem: any): any {
  const filteredQueueItem = {
    ...queueItem,
    creationTime: '',
    modificationTime: ''
  };
  debug(`Formatted result: ${JSON.stringify(filteredQueueItem)}`);
  return filteredQueueItem;
}

interface HandleErrorParams {
  error: any;
  expectedToThrow: boolean;
  expectedErrorMessage: string;
  expectedErrorStatus: string;
}

export function handleError(params: HandleErrorParams) {
  const {error, expectedToThrow, expectedErrorMessage, expectedErrorStatus} = params;
  debug(error);
  if (expectedToThrow) {
    debug('OK. Expected to throw');
    debug(JSON.stringify(error));
    if (expectedErrorMessage !== '' || expectedErrorStatus !== '') {
      const errorMessage = error.message || error.payload.message || error.payload || '';
      debug(errorMessage);
      assert.equal(errorMessage, expectedErrorMessage);
      const errorStatus = error.status || '';
      assert.equal(errorStatus, expectedErrorStatus);
      return;
    }
    return;
  }
  debug('NOT OK. Not expexted to throw');
  throw error;
}

export function streamToString(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    stream.on('error', (err: unknown) => reject(err));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}
