/* eslint-disable no-console */
import {expect} from 'chai';
import {READERS} from '@natlibfi/fixura';
import mongoFixturesFactory from '@natlibfi/fixura-mongo';
import generateTests from '@natlibfi/fixugen';
import createMongoOperator from './mongo';
import createDebugLogger from 'debug';

let mongoFixtures; // eslint-disable-line functional/no-let
const debug = createDebugLogger('@natlibfi/melinda-rest-api-commons/mongo:test');

generateTests({
  callback,
  path: [__dirname, '..', 'test-fixtures', 'mongo'],
  recurse: false,
  useMetadataFile: true,
  fixura: {
    failWhenNotFound: true,
    reader: READERS.JSON
  },
  mocha: {
    before: async () => {
      //debug(`<< Before`);
      await initMongofixtures();
    },
    beforeEach: async () => {
      //debug(`<< BeforeEach`);
      await mongoFixtures.clear();
    },
    afterEach: async () => {
      //debug(`<< AfterEach`);
      await mongoFixtures.clear();
    },
    after: async () => {
      //debug(`<< After`);
      await mongoFixtures.close();
    }
  }
});

async function initMongofixtures() {
  mongoFixtures = await mongoFixturesFactory({
    recurse: false,
    rootPath: [__dirname, '..', 'test-fixtures', 'mongo'],
    gridFS: {bucketName: 'foobar'},
    useObjectId: true
  });
}

// eslint-disable-next-line max-statements, complexity
async function callback({
  getFixture,
  functionName,
  params,
  expectModificationTime = false,
  preFillDb = false,
  expectedToThrow = false,
  expectedErrorMessage = '',
  expectedErrorStatus = '',
  contentStream = false,
  expectedOpResult = undefined,
  updateStateBeforeTest = undefined
}) {

  const mongoUri = await mongoFixtures.getUri();
  const mongoOperator = await createMongoOperator(mongoUri, 'foobar', '', true);
  const expectedResult = await getFixture('expectedResult.json');
  // DEVELOP: we could test also opResults!
  // DEVELOP: we could use sama function for most of tests?
  // debug(typeof mongoUri); // eslint-disable-line

  if (preFillDb) { // eslint-disable-line functional/no-conditional-statements
    await mongoFixtures.populate(getFixture('dbContents.json'));
  }

  //return {createPrio, createBulk, checkAndSetState, checkAndSetImportJobState, query, queryById, remove, readContent, removeContent, getOne, getStream, setState, setImportJobState, pushIds, pushMessages, setOperation, setOperations, addBlobSize, setBlobSize};

  if (functionName === 'createPrio') {
    try {
      debug(`CreatePrio`);
      debug(JSON.stringify(params));
      const opResult = await mongoOperator.createPrio(params);
      debug(`createPrio result: ${JSON.stringify(opResult)}`);
      await compareToFirstDbEntry({expectedResult, formatDates: true});
    } catch (error) {
      handleError({error, expectedToThrow, expectedErrorMessage, expectedErrorStatus});
      return;
    }
    return;
  }

  if (functionName === 'createBulk') {
    try {
      debug(`CreateBulk`);
      debug(JSON.stringify(params));
      //{correlationId, cataloger, oCatalogerIn, operation, contentType, recordLoadParams, stream, operationSettings}
      const stream = contentStream ? await getFixture({components: ['contentStream'], reader: READERS.STREAM}) : params.stream;
      const params2 = {...params, stream};
      const opResult = await mongoOperator.createBulk(params2);
      debug(`createBulkResult: ${JSON.stringify(opResult)}`);
      await compareToFirstDbEntry({expectedResult, formatDates: true});
    } catch (error) {
      handleError({error, expectedToThrow, expectedErrorMessage, expectedErrorStatus});
      return;
    }
    return;
  }

  if (functionName === 'checkAndSetState') {
    try {
      debug(`checkAndSetState`);
      debug(JSON.stringify(params));
      //{correlationId, state, errorMessage = undefined, errorStatus = undefined})
      // timeout

      // eslint-disable-next-line functional/no-conditional-statements
      if (updateStateBeforeTest && params.correlationId) {
        debug(`setState to reset modificationTime`);
        await mongoOperator.setState({correlationId: params.correlationId, state: updateStateBeforeTest});
      }
      const opResult = await mongoOperator.checkAndSetState(params);
      debug(`checkAndSetState result: ${JSON.stringify(opResult)} (it should be: ${JSON.stringify(expectedOpResult)})}`);

      // eslint-disable-next-line functional/no-conditional-statements
      if (expectedOpResult !== undefined) {
        expect(opResult).to.eql(expectedOpResult);
      }
      await compareToFirstDbEntry({expectedResult, expectModificationTime, formatDates: true});

    } catch (error) {
      handleError({error, expectedToThrow, expectedErrorMessage, expectedErrorStatus});
    }
    return;
  }


  if (functionName === 'checkAndSetImportJobState') {
    try {
      debug(`checkAndSetImportJobState`);
      debug(JSON.stringify(params));
      //{correlationId, operation, importJobState, errorMessage = '', errorStatus = ''}
      // timeout
      // eslint-disable-next-line functional/no-conditional-statements
      if (updateStateBeforeTest && params.correlationId) {
        debug(`setState to reset modificationTime`);
        await mongoOperator.setState({correlationId: params.correlationId, state: updateStateBeforeTest});
      }
      const opResult = await mongoOperator.checkAndSetImportJobState(params);
      debug(`checkAndSetImportJobState result: ${JSON.stringify(opResult)} (it should be: ${JSON.stringify(expectedOpResult)})}`);

      // eslint-disable-next-line functional/no-conditional-statements
      if (expectedOpResult !== undefined) {
        expect(opResult).to.eql(expectedOpResult);
      }
      await compareToFirstDbEntry({expectedResult, expectModificationTime, formatDates: true});
    } catch (error) {
      handleError({error, expectedToThrow, expectedErrorMessage, expectedErrorStatus});
      return;
    }
    return;
  }


  if (functionName === 'query') {
    try {
      debug(`query`);
      debug(JSON.stringify(params));
      //params, showParams = {}
      //params: skip, limit, rest (rest: actual mongo queryParams)
      //showParams: {showAll = 0, showOperations = 0, showOperationSettings = 0, showRecordLoadParams = 0, showImportJobState = 0} = showParams;
      debug(`${JSON.stringify(params.params)}`);
      debug(`${JSON.stringify(params.showParams)}`);
      const opResult = await mongoOperator.query(params.params, params.showParams);
      debug(`query result: ${JSON.stringify(opResult)} (it should be: ${JSON.stringify(expectedOpResult)})}`);
      // eslint-disable-next-line functional/no-conditional-statements
      if (expectedOpResult !== undefined) {
        expect(opResult).to.eql(expectedOpResult);
      }
    } catch (error) {
      handleError({error, expectedToThrow, expectedErrorMessage, expectedErrorStatus});
      return;
    }
    return;
  }

  /*

  // NOT EXPORTED
  if (functionName === 'createProjection') {
    try {
      debug(`createProjection`);
      debug(JSON.stringify(params));
      //showParams = {}
      //no db

    } catch (error) {
      handleError({error, expectedToThrow, expectedErrorMessage, expectedErrorStatus});
      return;
    }
    return;
  }
*/

  if (functionName === 'queryById') {
    try {
      debug(`queryById`);
      debug(JSON.stringify(params));
      //{correlationId, checkModTime = false}
      const opResult = await mongoOperator.queryById(params);
      debug(`queryById result: ${JSON.stringify(opResult)} (it should be: ${JSON.stringify(expectedOpResult)})}`);
      // eslint-disable-next-line functional/no-conditional-statements
      if (expectedOpResult !== undefined) {
        expect(opResult).to.eql(expectedOpResult);
      }
      await compareToDbEntry({expectedResult, resultIndex: 3, expectModificationTime, formatDates: true});
    } catch (error) {
      handleError({error, expectedToThrow, expectedErrorMessage, expectedErrorStatus});
      return;
    }
    return;
  }


  // only returned for test
  if (functionName === 'checkTimeOut') {
    try {
      debug(`checkTimeOut`);
      debug(JSON.stringify(params));
      //{correlationId}
      // timeout
      // eslint-disable-next-line functional/no-conditional-statements
      if (updateStateBeforeTest && params.correlationId) {
        debug(`setState to reset modificationTime`);
        await mongoOperator.setState({correlationId: params.correlationId, state: updateStateBeforeTest});
      }
      const opResult = await mongoOperator.checkTimeOut(params);
      debug(`checkTimeOut result: ${JSON.stringify(opResult)} (it should be: ${JSON.stringify(expectedOpResult)})}`);

      // eslint-disable-next-line functional/no-conditional-statements
      if (expectedOpResult !== undefined) {
        expect(opResult).to.eql(expectedOpResult);
      }
      await compareToFirstDbEntry({expectedResult, expectModificationTime, formatDates: true});
    } catch (error) {
      handleError({error, expectedToThrow, expectedErrorMessage, expectedErrorStatus});
      return;
    }
    return;
  }

  /*

  if (functionName === 'remove') {
    try {
      debug(`checkTimeOut`);
      debug(JSON.stringify(params));
      //params

    } catch (error) {
      handleError({error, expectedToThrow, expectedErrorMessage, expectedErrorStatus});
      return;
    }
    return;
  }

  if (functionName === 'readContent') {
    try {
      debug(`readContent`);
      debug(JSON.stringify(params));
      //correlationId

    } catch (error) {
      handleError({error, expectedToThrow, expectedErrorMessage, expectedErrorStatus});
      return;
    }
    return;
  }

  if (functionName === 'removeContent') {
    try {
      debug(`removeContent`);
      debug(JSON.stringify(params));
      //correlationId

    } catch (error) {
      handleError({error, expectedToThrow, expectedErrorMessage, expectedErrorStatus});
      return;
    }
    return;
  }

  */

  if (functionName === 'getOne') {
    try {
      debug(`getOne`);
      debug(JSON.stringify(params));
      //{queueItemState, importJobState = undefined}
      const opResult = await mongoOperator.getOne(params);
      debug(`getOne result: ${JSON.stringify(opResult)} (it should be: ${JSON.stringify(expectedOpResult)})}`);

      expect(opResult).to.eql(expectedOpResult);

    } catch (error) {
      handleError({error, expectedToThrow, expectedErrorMessage, expectedErrorStatus});
      return;
    }
    return;
  }

  /*
  if (functionName === 'getStream') {
    try {
      debug(`getStream`);
      debug(JSON.stringify(params));
      //correlationId

    } catch (error) {
      handleError({error, expectedToThrow, expectedErrorMessage, expectedErrorStatus});
      return;
    }
    return;
  }

  */

  if (functionName === 'pushIds') {
    try {
      debug(`pushIds`);
      debug(JSON.stringify(params));
      //{correlationId, handledIds, rejectedIds}
      const opResult = await mongoOperator.pushIds(params);
      debug(`pushIds result: ${JSON.stringify(opResult)}`);
      await compareToFirstDbEntry({expectedResult, expectModificationTime, formatDates: true});

    } catch (error) {
      handleError({error, expectedToThrow, expectedErrorMessage, expectedErrorStatus});
      return;
    }
    return;
  }

  if (functionName === 'pushMessages') {
    try {
      debug(`pushMessages`);
      debug(JSON.stringify(params));
      //{correlationId, messages, messageField = 'messages'}
      const opResult = await mongoOperator.pushMessages(params);
      debug(`pushMessages result: ${JSON.stringify(opResult)}`);
      await compareToFirstDbEntry({expectedResult, expectModificationTime, formatDates: true});
    } catch (error) {
      handleError({error, expectedToThrow, expectedErrorMessage, expectedErrorStatus});
      return;
    }
    return;
  }


  if (functionName === 'setState') {
    try {
      debug(`setState`);
      debug(JSON.stringify(params));
      //{correlationId, state, errorMessage = undefined, errorStatus = undefined}
      const opResult = await mongoOperator.setState(params);
      debug(`setState result: ${JSON.stringify(opResult)}`);
      await compareToFirstDbEntry({expectedResult, expectModificationTime, formatDates: true});

    } catch (error) {
      handleError({error, expectedToThrow, expectedErrorMessage, expectedErrorStatus});
      return;
    }
    return;
  }

  if (functionName === 'setImportJobState') {
    try {
      debug(`setImportJobState`);
      debug(JSON.stringify(params));
      //{correlationId, operation, importJobState}
      const opResult = await mongoOperator.setImportJobState(params);
      debug(`setImportJobState result: ${JSON.stringify(opResult)}`);
      await compareToFirstDbEntry({expectedResult, expectModificationTime, formatDates: true});
    } catch (error) {
      handleError({error, expectedToThrow, expectedErrorMessage, expectedErrorStatus});
      return;
    }
    return;
  }


  if (functionName === 'setOperation') {
    try {
      debug(`setOperation`);
      debug(JSON.stringify(params));
      //{correlationId, operation}
      const opResult = await mongoOperator.setOperation(params);
      debug(`setOperation result: ${JSON.stringify(opResult)}`);
      await compareToFirstDbEntry({expectedResult, expectModificationTime, formatDates: true});

    } catch (error) {
      handleError({error, expectedToThrow, expectedErrorMessage, expectedErrorStatus});
      return;
    }
    return;
  }

  if (functionName === 'setOperations') {
    try {
      debug(`setOperations`);
      debug(JSON.stringify(params));
      //{correlationId, addOperation, removeOperation = undefined}
      const opResult = await mongoOperator.setOperations(params);
      debug(`setOperations result: ${JSON.stringify(opResult)}`);
      await compareToFirstDbEntry({expectedResult, expectModificationTime, formatDates: true});
    } catch (error) {
      handleError({error, expectedToThrow, expectedErrorMessage, expectedErrorStatus});
      return;
    }
    return;
  }

  if (functionName === 'addBlobSize') {
    try {
      debug(`addBlobSize`);
      debug(JSON.stringify(params));
      //{correlationId}
      const opResult = await mongoOperator.addBlobSize(params);
      debug(`addBlobSize result: ${JSON.stringify(opResult)}`);
      await compareToFirstDbEntry({expectedResult, expectModificationTime, formatDates: true});
    } catch (error) {
      handleError({error, expectedToThrow, expectedErrorMessage, expectedErrorStatus});
      return;
    }
    return;
  }

  if (functionName === 'setBlobSize') {
    try {
      debug(`setBlobSize`);
      debug(JSON.stringify(params));
      //{correlationId,  blobSize}
      const opResult = await mongoOperator.setBlobSize(params);
      debug(`setBlobSize result: ${JSON.stringify(opResult)}`);
      await compareToFirstDbEntry({expectedResult, expectModificationTime, formatDates: true});
    } catch (error) {
      handleError({error, expectedToThrow, expectedErrorMessage, expectedErrorStatus});
      return;
    }
    return;
  }

  throw new Error(`Unknown functionName: ${functionName}`);
}


async function compareToFirstDbEntry({expectedResult, expectModificationTime = false, formatDates = true}) {
  const result = await compareToDbEntry({expectedResult, resultIndex: 0, expectModificationTime, formatDates});
  return result;
}

async function compareToDbEntry({expectedResult, resultIndex = 0, expectModificationTime = false, formatDates = true}) {
  const dump = await mongoFixtures.dump();
  debug(`--- We have ${dump.foobar.length} documents in db`);
  debug(dump.foobar);
  const result = dump.foobar[resultIndex];
  debug(`db result: ${JSON.stringify(result)}`);
  const dump2 = await mongoFixtures.dump();
  debug(`--- We have ${dump2.foobar.length} documents in db now`);

  checkModificationTime({result, expectModificationTime});
  if (formatDates) {
    const formattedResult = formatQueueItem(result);
    expect(formattedResult).to.eql(expectedResult);
    return;
  }
  expect(result).to.eql(expectedResult);
  return;
}


function checkModificationTime({result, expectModificationTime}) {
  if (expectModificationTime) {
    expect(result.modificationTime).to.not.eql('');
    debug(`OK. We have modified modificationTime`);
    return;
  }
  return;
}


function formatQueueItem(queueItem) {
  const filteredQueueItem = {
    ...queueItem,
    creationTime: '',
    modificationTime: ''
  };
  debug(`Formatted result: ${JSON.stringify(filteredQueueItem)}`);
  return filteredQueueItem;
}

function handleError({error, expectedToThrow, expectedErrorMessage, expectedErrorStatus}) {
  debug(error);
  if (expectedToThrow) {
    debug('OK. Expected to throw');
    if (expectedErrorMessage !== '' || expectedErrorStatus !== '') {
      const errorMessage = error.message || error.payload || '';
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
