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

export function formatRecord(record, settings = []) {
  const logger = createLogger();

  logger.verbose('Applying formating');
  const newRecord = MarcRecord.clone(record, {subfieldValues: false});

  generateMissingSIDs();

  settings.forEach(options => {
    replacePrefixes(options);
  });

  return newRecord.toObject();

  // Replace prefix in all specified subfields
  function replacePrefixes(options) {
    const {oldPrefix, newPrefix, prefixReplaceCodes} = options;
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


  function generateMissingSIDs() {
    const f035Filters = [/^\(FI-BTJ\)/u, /^\(FI-TATI\)/u];
    const fSIDFilters = ['FI-BTJ', 'tati'];
    const f035s = f035ToSidInfo(newRecord.get(/^035$/u));
    const fSIDs = sidsToSidInfo(newRecord.get(/^SID$/u));

    const sidsToBeAdded = genNewSids(fSIDs.length === 0
      ? f035s
      // test that SIDs are not there yet
      : f035s.filter(f035SidInfo => fSIDs.some(fSIDInfo => f035SidInfo.SID !== fSIDInfo.SID && f035SidInfo.value !== fSIDInfo.value)));

    // Add new SIDs
    return sidsToBeAdded.forEach(sidField => newRecord.insertField(sidField));

    function genNewSids(sidsToBeAdded) {
      return sidsToBeAdded.map(sidInfo => ({tag: 'SID', ind1: ' ', ind2: ' ', subfields: [{code: 'b', value: sidInfo.SID}, {code: 'c', value: sidInfo.value}]}));
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

// If placed in config.js testing needs envs
export const BIB_FORMAT_SETTINGS = [
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
  }
];
