import assert from 'node:assert';
import createDebugLogger from 'debug';
import {MarcRecord} from '@natlibfi/marc-record';
import {READERS} from '@natlibfi/fixura';
import generateTests from '@natlibfi/fixugen';
import {fixRecord} from '../../src/helpers/fix.js';
import * as fixSettings from '../../src/helpers/fix-constants.js';
// import inspect from 'util';

const debug = createDebugLogger('@natlibfi/melinda-rest-api-commons:fix:test');
const debugData = debug.extend('data');

generateTests({
  callback,
  path: [import.meta.dirname, '..', '..', 'test-fixtures', 'fix'],
  recurse: true,
  useMetadataFile: true,
  fixura: {
    failWhenNotFound: false,
    reader: READERS.JSON
  }
});

function callback({getFixture, settings = undefined}) {
  if (
    settings !== undefined
    && typeof settings !== 'object'
    && fixSettings[settings] === undefined
  ) {
    throw new Error(`There are no settings ${settings} defined!`);
  }
  let runSettings = fixSettings[settings] || settings;
  // metadata.json is plain JSON, so f035Filters may contain string
  // patterns which fix.js cannot use as-is; convert them to RegExp
  if (runSettings && runSettings.generateMissingSIDs) {
    runSettings = {
      ...runSettings,
      generateMissingSIDs: {
        ...runSettings.generateMissingSIDs,
        f035Filters: (runSettings.generateMissingSIDs.f035Filters || []).map(
          filter => (typeof filter === 'string' ? new RegExp(filter) : filter)
        ),
        fSIDFilters: runSettings.generateMissingSIDs.fSIDFilters
      }
    };
  }

  const record = new MarcRecord(getFixture('record.json'), {subfieldValues: false});
  const expectedRecord = getFixture('expectedRecord.json');

  debug(`Running fixer with settings ${settings}.`);
  debugData(JSON.stringify(runSettings, null, 2));

  const resultRecord = fixRecord(record, runSettings);
  debugData(`Result:   ${JSON.stringify(resultRecord)}`);
  debugData(`Expected: ${JSON.stringify(expectedRecord)}`);
  assert.deepStrictEqual(resultRecord, expectedRecord);

}
