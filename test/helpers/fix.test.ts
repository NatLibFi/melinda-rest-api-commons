import assert from 'node:assert';
import createDebugLogger from 'debug';
import {MarcRecord} from '@natlibfi/marc-record';
import type {MarcRecordObject} from '@natlibfi/marc-record';
import {READERS} from '@natlibfi/fixura';
import generateTests, {type CallbackArgs} from '@natlibfi/fixugen';
import {fixRecord} from '../../src/helpers/fix.ts';
import * as fixSettings from '../../src/helpers/fix-constants.ts';
import type {FixSettings} from '../../src/helpers/fix-constants.ts';
// import inspect from 'util';

const debug = createDebugLogger('@natlibfi/melinda-rest-api-commons:fix:test');
const debugData = debug.extend('data');

// the settings names usable via metadata.json
type SettingsKey = 'BIB_FORMAT_SETTINGS' | 'BIB_PREVALIDATION_FIX_SETTINGS' | 'BIB_POSTMERGE_FIX_SETTINGS' | 'BIB_PREIMPORT_FIX_SETTINGS' | 'AUTNAME_PREIMPORT_FIX_SETTINGS' | 'BIB_HANDLE_TEMP_URNS_SETTINGS' | 'BIB_STRIP_F884S_SETTINGS' | 'BIB_STRIP_F984S_SETTINGS' | 'BIB_STRIP_MELINDA_TEMP_SUBFIELDS_SETTINGS';

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

function callback(callbackParams: CallbackArgs) {
  const {getFixture, settings = undefined} = callbackParams;
  if (
    settings !== undefined
    && typeof settings !== 'object'
    && (fixSettings[settings as SettingsKey]) === undefined
  ) {
    throw new Error(`There are no settings ${settings} defined!`);
  }
  let runSettings: FixSettings | undefined = (fixSettings[settings as SettingsKey]) || (settings as FixSettings);
  // metadata.json is plain JSON, so f035Filters may contain string
  // patterns which fix.js cannot use as-is; convert them to RegExp
  if (runSettings && runSettings.generateMissingSIDs) {
    runSettings = {
      ...runSettings,
      generateMissingSIDs: {
        ...runSettings.generateMissingSIDs,
        f035Filters: (runSettings.generateMissingSIDs.f035Filters || []).map(
          (filter): RegExp => (typeof filter === 'string' ? new RegExp(filter) : filter)
        ),
        fSIDFilters: runSettings.generateMissingSIDs.fSIDFilters
      }
    };
  }

  const record = new MarcRecord(getFixture('record.json') as MarcRecordObject, {subfieldValues: false});
  const expectedRecord = getFixture('expectedRecord.json');

  debug(`Running fixer with settings ${settings}.`);
  debugData(JSON.stringify(runSettings, null, 2));

  const resultRecord = fixRecord(record, runSettings);
  debugData(`Result:   ${JSON.stringify(resultRecord)}`);
  debugData(`Expected: ${JSON.stringify(expectedRecord)}`);
  assert.deepStrictEqual(resultRecord, expectedRecord);

}
