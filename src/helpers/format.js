/**
*
* @licstart  The following is the entire license notice for the JavaScript code in this file.
*
* Shared modules for microservices of Melinda rest api batch import system
*
* Copyright (C) 2020 University Of Helsinki (The National Library Of Finland)
*
* This file is part of melinda-rest-api-commons
*
* melinda-rest-api-commons program is free software: you can redistribute it and/or modify
* it under the terms of the GNU Affero General Public License as
* published by the Free Software Foundation, either version 3 of the
* License, or (at your option) any later version.
*
* melinda-rest-api-commons is distributed in the hope that it will be useful,
* but WITHOUT ANY WARRANTY; without even the implied warranty of
* MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
* GNU Affero General Public License for more details.
*
* You should have received a copy of the GNU Affero General Public License
* along with this program.  If not, see <http://www.gnu.org/licenses/>.
*
* @licend  The above is the entire license notice
* for the JavaScript code in this file.
*
*/

import {MarcRecord} from '@natlibfi/marc-record';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import createDebugLogger from 'debug';

export function formatRecord(record, settings = {}) {
  const logger = createLogger();
  const debug = createDebugLogger('@natlibfi/melinda-rest-api-commons:format');
  const debugData = debug.extend('data');

  logger.verbose(`We will apply formatting to the record according to settings: ${JSON.stringify(settings)}`);
  const newRecord = MarcRecord.clone(record, {subfieldValues: false});
  debugData(`settings: ${JSON.stringify(settings)}`);

  const generateMissingSIDsOptions = settings.generateMissingSIDs || undefined;
  generateMissingSIDs(generateMissingSIDsOptions);

  const replacePrefixesOptions = settings.replacePrefixes || [];
  debugData(`replacePrefixesOptions: ${JSON.stringify(replacePrefixesOptions)}`);

  replacePrefixesOptions.forEach(options => {
    replacePrefixes(options);
  });

  handleTempUrns(settings.handleTempUrns);

  return newRecord.toObject();

  // Replace prefix in all specified subfields
  function replacePrefixes(options) {
    const {oldPrefix, newPrefix, prefixReplaceCodes} = options;
    debug(`Replacing ${oldPrefix} with ${newPrefix} in subfields ${prefixReplaceCodes}`);
    const pattern = `(${oldPrefix})`;
    const replacement = `(${newPrefix})`;
    newRecord.getDatafields()
      .forEach(field => {
        field.subfields
          .filter(({code}) => prefixReplaceCodes.includes(code))
          .forEach(subfield => {
            subfield.value = subfield.value.replace(pattern, replacement); // eslint-disable-line functional/immutable-data
          });
      });
  }


  function generateMissingSIDs(options) {
    debugData(`generateMissingSIDs options: ${JSON.stringify(options)}`);

    const f035Filters = options && options.f035Filters ? options.f035Filters : [];
    const fSIDFilters = options && options.fSIDFilters ? options.fSIDFilters : [];

    if (f035Filters.length !== fSIDFilters.length || f035Filters.length < 1 || fSIDFilters.length < 1) {
      debug(`No sane options for generating missing SIDs`);
      return;
    }

    const f035s = f035ToSidInfo(newRecord.get(/^035$/u));
    const fSIDs = sidsToSidInfo(newRecord.get(/^SID$/u));

    const sidsToBeAdded = genNewSids(fSIDs.length === 0
      ? f035s
      // test that SIDs are not there yet
      : f035s.filter(f035SidInfo => fSIDs.some(fSIDInfo => f035SidInfo.SID !== fSIDInfo.SID && f035SidInfo.value !== fSIDInfo.value)));

    // Add new SIDs
    return sidsToBeAdded.forEach(sidField => newRecord.insertField(sidField));

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


  // eslint-disable-next-line max-statements
  function handleTempUrns(options) {
    debugData(JSON.stringify(options));

    if (options !== true) {
      return;
    }

    // If we have an non-temp URN, we can delete tempURNs, otherwise we should delete the temp subfield from URN

    const hasURN = f => f.tag === '856' && f.subfields.some(({code, value}) => code === 'u' && (/urn.fi/u).test(value));

    const hasTempSubfield = f => f.subfields.some(({code, value}) => code === '9' && (/^MELINDA<TEMP>$/u).test(value));
    const hasNoTempSubfield = f => !f.subfields.some(({code, value}) => code === '9' && (/^MELINDA<TEMP>$/u).test(value));

    const f856sUrn = newRecord.fields.filter(hasURN);
    const f856sUrnsWithTempSubfields = f856sUrn.filter(hasTempSubfield);
    const f856sUrnsWithNoTempSubfields = f856sUrn.filter(hasNoTempSubfield);

    debugData(`URN f856s: ${JSON.stringify(f856sUrn)}`);
    debugData(`URN f856s with temp subfield: ${JSON.stringify(f856sUrnsWithTempSubfields)}`);

    // None of the URNs has temp subfields, we don't need to do anything
    if (f856sUrnsWithTempSubfields.length < 1) {
      debug(`No Urns with temp subfield`);
      return;
    }

    // Do we have an existing URN with legal deposit subfields, if we have, we can remove the temp URN field(s)
    const existingLegalDepositURN = validateLD(f856sUrnsWithNoTempSubfields);
    debug(`existingLegalDepositURN: ${existingLegalDepositURN}`);

    if (existingLegalDepositURN) {
      debug(`We have an existing LD URN, we can delete temp fields (${f856sUrnsWithTempSubfields.length})`);
      newRecord.removeFields(f856sUrnsWithTempSubfields);
      return;
    }

    // We do not have an existing legalDepositURN, we should use the tempURN and remove the temp subfields from it
    if (!existingLegalDepositURN && f856sUrnsWithTempSubfields.length > 0) {
      //debug(`All Urns (${f856sUrn.length}) have a temp subfield`);
      debugData(`Original temp URNs: (${JSON.stringify(f856sUrnsWithTempSubfields)})`);
      const fixedFields = f856sUrnsWithTempSubfields.map(removeTempSubfield).filter(field => field);
      debug(`We removed temp subfields: (${JSON.stringify(fixedFields)})`);
      newRecord.removeFields(f856sUrnsWithTempSubfields);
      newRecord.insertFields(fixedFields);
      return;
    }

    // Should we check that the non-temp URN has 2nd ind '0' - meaning that the URN handles the actual resource itself?
  }

  // ---- LD-functions below are same as in https://github.com/NatLibFi/marc-record-validators-melinda/blob/feature-updates-to-urn/src/urn.js
  // we propably should develop the urn/legaldeposit -validator to use also here

  function createLDSubfields() {
    return [
      {
        code: 'z',
        value: 'Käytettävissä vapaakappalekirjastoissa'
      },
      {
        code: '5',
        value: 'FI-Vapaa'
      }
    ];
  }

  function validateLD(f856sUrn) {
    debug(`Validating the existence of legal deposit subfields`);
    const ldSubfields = createLDSubfields();
    const f856sUrnWithLdSubfields = f856sUrn.filter(field => fieldHasLDSubfields(field, ldSubfields));
    if (f856sUrnWithLdSubfields.length > 0) {
      debug(`Record has ${f856sUrnWithLdSubfields.length} URN fields with all necessary legal deposit subfields`);
      debugData(`f856sUrnWithLdSubfields: ${JSON.stringify(f856sUrnWithLdSubfields)}`);
      return true;
    }
    return false;
  }

  function fieldHasLDSubfields(field, ldSubfields) {
    if (ldSubfields.every(ldsf => field.subfields.some(sf => sf.code === ldsf.code && sf.value === ldsf.value))) {
      return true;
    }
  }

  // ---

  function removeTempSubfield(field) {

    // Handle non-numeric fields, and fields with a numeric tag of 010 and greater
    // Aleph's FMT as a controlfield might be a problem
    if (!isNaN(field.tag) && parseInt(field.tag, 10) >= 10) {

      const filteredSubfields = field.subfields.filter(sf => sf.code !== '9' && !(/^MELINDA<TEMP>$/u).test(sf.value));

      // Remove whole field if there are no subfields left
      if (filteredSubfields.length < 1) {
        return false;
      }

      return {
        tag: field.tag,
        ind1: field.ind1,
        ind2: field.ind2,
        subfields: filteredSubfields
      };
    }
    // return controlFields as is
    return field;
  }
}

// This could be formatted so that 035-prefix and SID contents would be better connected than by just an array index
export const BIB_F035_TO_SID = {
  f035Filters: [/^\(FI-BTJ\)/u, /^\(FI-TATI\)/u],
  fSIDFilters: ['FI-BTJ', 'tati']
};

// There is somewhere other implementations of this same standardPrefixes to alephInternalPrefixes normalization
export const REPLACE_PREFIXES = [
  {
    oldPrefix: 'FI-MELINDA',
    newPrefix: 'FIN01',
    prefixReplaceCodes: ['w']
  },
  {
    oldPrefix: 'FI-ASTERI-S',
    newPrefix: 'FIN10',
    prefixReplaceCodes: ['0']
  },
  {
    oldPrefix: 'FI-ASTERI-N',
    newPrefix: 'FIN11',
    prefixReplaceCodes: ['0']
  },
  {
    oldPrefix: 'FI-ASTERI-A',
    newPrefix: 'FIN12',
    prefixReplaceCodes: ['0']
  },
  {
    oldPrefix: 'FI-ASTERI-W',
    newPrefix: 'FIN13',
    prefixReplaceCodes: ['0']
  }
];

// If placed in config.js testing needs envs
export const BIB_FORMAT_SETTINGS = {
  replacePrefixes: REPLACE_PREFIXES,
  generateMissingSIDs: BIB_F035_TO_SID
};

export const BIB_PREVALIDATION_FIX_SETTINGS = {
  generateMissingSIDs: BIB_F035_TO_SID
};

export const BIB_POSTVALIDATION_FIX_SETTINGS = {
  replacePrefixes: REPLACE_PREFIXES
};

export const BIB_HANDLE_TEMP_URNS_SETTINGS = {
  handleTempUrns: true
};
