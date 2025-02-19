import {expect} from 'chai';
import {MarcRecord} from '@natlibfi/marc-record';
import {READERS} from '@natlibfi/fixura';
import generateTests from '@natlibfi/fixugen';
import {fixRecord} from '../../src/helpers/fix';
import * as fixSettings from '../../src/helpers/fix-constants';
import createDebugLogger from 'debug';
// import inspect from 'util';

const debug = createDebugLogger('@natlibfi/melinda-rest-api-commons:fix:test');
const debugData = debug.extend('data');

generateTests({
  callback,
  path: [__dirname, '..', '..', 'test-fixtures', 'fix'],
  recurse: true,
  useMetadataFile: true,
  fixura: {
    failWhenNotFound: false,
    reader: READERS.JSON
  }
});

function callback({getFixture, settings = undefined}) {
  if (settings !== undefined && fixSettings[settings] === undefined) {
    throw new Error(`There are no settings ${settings} defined!`);
  }
  const runSettings = fixSettings[settings] || settings;

  const record = new MarcRecord(getFixture('record.json'), {subfieldValues: false});
  const expectedRecord = getFixture('expectedRecord.json');

  debug(`Running fixer with settings ${settings}.`);
  debugData(JSON.stringify(runSettings, null, 2));

  const resultRecord = fixRecord(record, runSettings);
  debugData(`Result:   ${JSON.stringify(resultRecord)}`);
  debugData(`Expected: ${JSON.stringify(expectedRecord)}`);
  expect(resultRecord).to.eql(expectedRecord);

}
