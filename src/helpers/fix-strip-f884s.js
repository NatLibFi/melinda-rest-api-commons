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
import createDebugLogger from 'debug';
import {sortFieldsBySubfieldValue, removeSubfield} from './fix-utils';


export function stripF884s(newRecord, options) {
  const debug = createDebugLogger('@natlibfi/melinda-rest-api-commons:fixRecord:stripF884s');
  const debugData = debug.extend('data');

  if (options !== true) {
    debug(`NOT running stripF884s fixer, no options`);
    return newRecord;
  }

  debug(`Running stripF884s fixer`);
  debugData(`Options for stripF884s: ${JSON.stringify(options)}`);

  // Handle only f884 with $5 MELINDA - let's no remove random f884s
  const isMelindaf884 = f => f.tag === '884' && f.subfields.some(({code, value}) => code === '5' && value === 'MELINDA');

  const f884Melindas = newRecord.fields.filter(isMelindaf884);
  debugData(`Melinda's f884s (${f884Melindas.length}) \n ${JSON.stringify(f884Melindas)}`);

  if (f884Melindas.length < 2) {
    debug(`Not enough Melinda's f884.s to filter (${f884Melindas.length})`);
    return newRecord;
  }

  // Sort fields by date subfield $g, so we'll keep the oldest one
  const sortedFields = sortFieldsBySubfieldValue(f884Melindas, 'g');
  debugData(`Melinda's f884s sorted by 'g' - oldest first: (${sortedFields.length}) \n ${JSON.stringify(sortedFields)}`);

  // Drop fields that are similar without date subfield $g
  const uniqFields = uniqWithOutSubfield(sortedFields, 'g');
  debugData(`Melindas f884s uniqued without sf $g (${uniqFields.length}) \n ${JSON.stringify(uniqFields)}`);

  // Replace original Melinda-f884s with remaining Melinda-f884s
  // NOTE: this sorts MELINDA-f884s after possible other f884s
  newRecord.removeFields(f884Melindas);
  newRecord.insertFields(uniqFields);
  return newRecord;

  // Keep just first instance of each similar field, compare without subfield with subfieldCode
  function uniqWithOutSubfield(fields, subfieldCode) {
    return fields.reduce((uniq, field) => {
      if (!uniq.some(f => MarcRecord.isEqual(removeSubfield(f, subfieldCode), removeSubfield(field, subfieldCode)))) { // eslint-disable-line functional/no-conditional-statement
        uniq.push(field); // eslint-disable-line functional/immutable-data
      }

      return uniq;
    }, []);
  }
}
