/**
*
* @licstart  The following is the entire license notice for the JavaScript code in this file.
*
* Shared modules for microservices of Melinda rest api batch import system
*
* Copyright (C) 2020-2022 University Of Helsinki (The National Library Of Finland)
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

import {handleTempUrns} from './fix-handle-tempurns';
import {stripF884s} from './fix-strip-f884s';

export * from './fix-constants';

export function fixRecord(record, settings = {}) {
  const logger = createLogger();
  const debug = createDebugLogger('@natlibfi/melinda-rest-api-commons:fixRecord');
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

  // Imported fixers need the record as input and return the fixed record
  // This should be handled as a reducer or something nicer
  const newRecord2 = handleTempUrns(newRecord, settings.handleTempUrns);
  const newRecord3 = stripF884s(newRecord2, settings.stripF884s);

  return newRecord3.toObject();

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


}
