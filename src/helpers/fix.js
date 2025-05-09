import {MarcRecord} from '@natlibfi/marc-record';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import createDebugLogger from 'debug';

import {handleTempUrns} from './fix-handle-tempurns';
import {stripF884s} from './fix-strip-f884s';

import {FieldExclusion, SubfieldExclusion} from '@natlibfi/marc-record-validators-melinda';

export * from './fix-constants';

const logger = createLogger();
const debug = createDebugLogger('@natlibfi/melinda-rest-api-commons:fixRecord');
const debugData = debug.extend('data');

export function fixRecord(record, settings = {}) {

  logger.verbose(`We will apply formatting to the record according to settings: ${JSON.stringify(settings)}`);
  const newRecord = MarcRecord.clone(record, {subfieldValues: false});
  debugData(`settings: ${JSON.stringify(settings)}`);

  // We should handle these in some prettier way ...

  // Fix 1, generate SIDs
  const generateMissingSIDsOptions = settings.generateMissingSIDs || undefined;
  const newRecord1 = generateMissingSIDs(newRecord, generateMissingSIDsOptions);

  // Fix 2, replace identifier prefixes
  const replacePrefixesOptions = settings.replacePrefixes || [];
  const newRecord2 = replaceAllPrefixes(newRecord1, replacePrefixesOptions);

  // Fix 3, handle temporary URNs from legal deposit record import
  const newRecord3 = handleTempUrns(newRecord2, settings.handleTempUrns);

  // Fix 4, strip extra field 884s
  const newRecord4 = stripF884s(newRecord3, settings.stripF884s);

  // Fix 5, strip extra field 984s
  const newRecord5 = stripF984s(newRecord4, settings.stripF984s || false);

  // Fix 6, strip $9 MELINDA<TEMP> subfields
  const newRecord6 = stripMelindaTempSubfields(newRecord5, settings.stripMelindaTempSubfields || false);

  debugData(newRecord6);

  return newRecord6.toObject();

}


function replaceAllPrefixes(record, replacePrefixesOptions) {
  if (replacePrefixesOptions.length < 1) {
    debug(`NOT running replacePrefixes, no options`);
    return record;
  }

  debug(`Running replacePrefixes fixer`);
  debugData(`replacePrefixesOptions: ${JSON.stringify(replacePrefixesOptions)}`);

  replacePrefixesOptions.forEach(options => {
    replacePrefix(record, options);
  });
  return record;
}


// Replace prefix in all specified subfields
function replacePrefix(record, options) {
  const {oldPrefix, newPrefix, prefixReplaceCodes} = options;
  debug(`Replacing ${oldPrefix} with ${newPrefix} in subfields ${prefixReplaceCodes}`);
  const pattern = `(${oldPrefix})`;
  const replacement = `(${newPrefix})`;
  record.getDatafields()
    .forEach(field => {
      field.subfields
        .filter(({code}) => prefixReplaceCodes.includes(code))
        .forEach(subfield => {
          subfield.value = subfield.value.replace(pattern, replacement); // eslint-disable-line functional/immutable-data
        });
    });
  return record;
}


function generateMissingSIDs(record, options) {

  const f035Filters = options && options.f035Filters ? options.f035Filters : [];
  const fSIDFilters = options && options.fSIDFilters ? options.fSIDFilters : [];

  if (f035Filters.length !== fSIDFilters.length || f035Filters.length < 1 || fSIDFilters.length < 1) {
    debug(`NOT running generateMissingsSIDs, no options`);
    return record;
  }

  debug(`Running generateMissingSIDs fixer`);
  debugData(`generateMissingSIDs options: ${JSON.stringify(options)}`);

  const f035s = f035ToSidInfo(record.get(/^035$/u));
  const fSIDs = sidsToSidInfo(record.get(/^SID$/u));

  const sidsToBeAdded = genNewSids(fSIDs.length === 0
    ? f035s
  // test that SIDs are not there yet
    : f035s.filter(f035SidInfo => !fSIDs.some(fSIDInfo => f035SidInfo.SID === fSIDInfo.SID && f035SidInfo.value === fSIDInfo.value)));

  debugData(`Adding (${sidsToBeAdded.length}) SIDs: ${JSON.stringify(sidsToBeAdded)}`);

  // Add new SIDs
  sidsToBeAdded.forEach(sidField => record.insertField(sidField));
  return record;

  function genNewSids(sidsToBeAdded) {
    return sidsToBeAdded.map(sidInfo => ({tag: 'SID', ind1: ' ', ind2: ' ', subfields: [{code: 'c', value: sidInfo.value}, {code: 'b', value: sidInfo.SID}]}));
  }

  function sidsToSidInfo(SIDs) {
    return SIDs.flatMap(({subfields}) => {
      const [SID] = subfields.filter(sub => sub.code === 'b' && fSIDFilters.includes(sub.value)).map(sub => sub.value);
      const [value] = subfields.filter(sub => sub.code === 'c' && sub.value !== undefined).map(sub => sub.value);

      if (SID && value) {
        return {
          SID,
          value
        };
      }

      return undefined;
    }).filter(value => value !== undefined);
  }

  function f035ToSidInfo(f035s) {
    return f035s.flatMap(({subfields}) => {
      const [wantedSub] = subfields.filter(sub => sub.code === 'a' && f035Filters.some(regexp => regexp.test(sub.value)));

      if (wantedSub) {
        return {
          SID: fSIDFilters[f035Filters.findIndex(regexp => regexp.test(wantedSub.value))],
          value: wantedSub.value.slice(wantedSub.value.indexOf(')') + 1)
        };
      }

      return undefined;
    }).filter(value => value !== undefined);
  }
}


function stripF984s(record, stripF984sSettings) {
  const F984A_PATTERN = /^(?:ALWAYS|NEVER)-PREFER-IN-MERGE$/u;
  const config = [
    {
      tag: /^984$/u,
      subfields: [
        {
          code: /a/u,
          value: F984A_PATTERN
        }
      ]
    }
  ];

  debug(`Running removeF984AFields`);
  debugData(`removeF984AFieldsSettings: ${JSON.stringify(stripF984sSettings)}`);

  if (!stripF984sSettings || !F984A_PATTERN || record.get('984').length < 1) {
    debug(`No settings or pattern for removeF984AFields or f984 in record`);
    return record;
  }

  debug(`Removing f984 fields with subfield $a consisting values ${F984A_PATTERN.toString()}`);
  // eslint-disable-next-line new-cap
  const validator = FieldExclusion(config);
  validator.fix(record);
  return record;

}

function stripMelindaTempSubfields(record, stripMelindaTempSubfieldsSettings) {
  if (!stripMelindaTempSubfieldsSettings) {
    debug(`No settings for stripMelindaTempSubfields`);
    return record;
  }
  // NOTE: we remove $9 MELINDA<TEMP> subfields only from f856
  const tagPattern = /856/u;
  const subfieldCodePattern = /9/u;
  const subfieldValuePattern = /^MELINDA<TEMP>$/u;
  const config = [
    {
      tag: tagPattern,
      subfields: [
        {
          code: subfieldCodePattern,
          value: subfieldValuePattern
        }
      ]
    }
  ];

  debug(`Running stripMelindaTempSubfields`);

  // eslint-disable-next-line new-cap
  const validator = SubfieldExclusion(config);
  validator.fix(record);
  return record;
}
