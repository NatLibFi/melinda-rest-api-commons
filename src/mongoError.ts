import {MongoDriverError} from 'mongodb';
import httpStatus from 'http-status';
import {Error as ApiError} from '@natlibfi/melinda-commons';
import {logError} from './utils.ts';

/**
 * Wrap a public Mongo operator method body so Mongo driver failures
 * reject with the shared ApiError convention instead of raw driver
 * errors: the driver error is logged and rethrown as
 * ApiError(500, 'Mongo errored: <message>') — the exact message shape
 * the pre-existing inline catch blocks in mongo.ts / mongoLog.ts used.
 * Every other error (validation ApiErrors like 400, not-found errors
 * like 404, plain Errors) is rethrown unchanged.
 * @param fn the method body, returning the method's promise
 * @returns the method's result
 */
export async function withMongoError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (!(error instanceof MongoDriverError)) {
      throw error;
    }
    const apiError = error as unknown as ApiError;
    const errorMessage = apiError.payload || apiError.message || '';
    logError(error);
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Mongo errored: ${errorMessage}`);
  }
}
