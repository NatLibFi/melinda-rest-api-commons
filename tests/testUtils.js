
import {expect} from 'chai';
import createDebugLogger from 'debug';
import createMongoOperator from '../src/mongo';


const debug = createDebugLogger('@natlibfi/melinda-rest-api-commons/mongo:test');

export async function getMongoOperator(mongoFixtures) {
  const mongoUri = await mongoFixtures.getUri();
  const mongoOperator = await createMongoOperator(mongoUri, 'foobar', '');
  return mongoOperator;
}

export async function compareToFirstDbEntry({mongoFixtures, expectedResult, expectModificationTime = false, formatDates = true, expectedFileCount = undefined}) {
  const result = await compareToDbEntry({mongoFixtures, expectedResult, resultIndex: 0, expectModificationTime, formatDates, expectedFileCount});
  return result;
}

export async function compareToDbEntry({mongoFixtures, expectedResult, resultIndex = 0, expectModificationTime = false, formatDates = true, expectedFileCount = undefined}) {
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
    expect(formattedResult).to.eql(expectedResult);
    return;
  }
  expect(result).to.eql(expectedResult);
  return;
}

function checkFileCount({dump, expectedFileCount}) {
  if (expectedFileCount !== undefined) {
    const fileCount = dump['foobar.files']?.length;
    debug(`--- We have ${fileCount} files in db`);
    expect(fileCount).to.eql(expectedFileCount);
    return;
  }
  return;

}

function checkModificationTime({result, expectModificationTime}) {
  if (expectModificationTime) {
    debug('Check if modificationTime was edited');
    expect(result.modificationTime).to.not.eql('');
    debug(`OK. We have modified modificationTime`);
    return;
  }
  return;
}


export function formatQueueItem(queueItem) {
  const filteredQueueItem = {
    ...queueItem,
    creationTime: '',
    modificationTime: ''
  };
  debug(`Formatted result: ${JSON.stringify(filteredQueueItem)}`);
  return filteredQueueItem;
}

export function handleError({error, expectedToThrow, expectedErrorMessage, expectedErrorStatus}) {
  debug(error);
  if (expectedToThrow) {
    debug('OK. Expected to throw');
    debug(JSON.stringify(error));
    // eslint-disable-next-line max-lines
    if (expectedErrorMessage !== '' || expectedErrorStatus !== '') {
      const errorMessage = error.message || error.payload.message || error.payload || '';
      debug(errorMessage);
      expect(errorMessage).to.eql(expectedErrorMessage);
      const errorStatus = error.status || '';
      expect(errorStatus).to.eql(expectedErrorStatus);
      return;
    }
    return;
  }
  debug('NOT OK. Not expexted to throw');
  throw error;
}

export function streamToString(stream) {
  const chunks = [];
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line functional/immutable-data
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on('error', (err) => reject(err));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}
