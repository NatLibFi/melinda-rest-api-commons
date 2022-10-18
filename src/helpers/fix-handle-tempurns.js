
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

//import {MarcRecord} from '@natlibfi/marc-record';
import createDebugLogger from 'debug';

const debug = createDebugLogger('@natlibfi/melinda-rest-api-commons:fixRecord:handleTempUrns');
const debugData = debug.extend('data');

// eslint-disable-next-line max-statements
export function handleTempUrns(newRecord, options) {

  if (options !== true) {
    debug(`NOT running handleTempUrns fixer, no options`);
    return newRecord;
  }

  debug(`Running handleTempUrns fixer`);
  debugData(`Options for handleTempUrns: ${JSON.stringify(options)}`);

  const {f856sUrnsWithTempSubfields, f856sUrnsWithNoTempSubfields} = getf856sUrns(newRecord);

  // None of the URNs has temp subfields, we don't need to do anything
  if (f856sUrnsWithTempSubfields.length < 1) {
    debug(`No Urns with temp subfield`);
    return newRecord;
  }

  // Do we have an existing URN with legal deposit subfields, if we have, we can remove the temp URN field(s)
  const existingLegalDepositURN = validateLD(f856sUrnsWithNoTempSubfields);
  debug(`existingLegalDepositURN: ${existingLegalDepositURN}`);

  if (existingLegalDepositURN) {
    debug(`We have an existing LD URN, we can delete temp fields (${f856sUrnsWithTempSubfields.length})`);
    newRecord.removeFields(f856sUrnsWithTempSubfields);
    return newRecord;
  }

  // We do not have an existing legalDepositURN, we should use the tempURN and remove the temp subfields from it
  if (!existingLegalDepositURN && f856sUrnsWithTempSubfields.length > 0) {
    //debug(`All Urns (${f856sUrn.length}) have a temp subfield`);
    debugData(`Original temp URNs: (${JSON.stringify(f856sUrnsWithTempSubfields)})`);
    const fixedFields = f856sUrnsWithTempSubfields.map(removeTempSubfield).filter(field => field);
    debug(`We removed temp subfields: (${JSON.stringify(fixedFields)})`);
    newRecord.removeFields(f856sUrnsWithTempSubfields);
    newRecord.insertFields(fixedFields);
    return newRecord;
  }
  // Should we check that the non-temp URN has 2nd ind '0' - meaning that the URN handles the actual resource itself?
}

function getf856sUrns(newRecord) {
  const hasURN = f => f.tag === '856' && f.subfields.some(({code, value}) => code === 'u' && (/urn.fi/u).test(value));

  const hasTempSubfield = f => f.subfields.some(({code, value}) => code === '9' && (/^MELINDA<TEMP>$/u).test(value));
  const hasNoTempSubfield = f => !f.subfields.some(({code, value}) => code === '9' && (/^MELINDA<TEMP>$/u).test(value));

  const f856sUrn = newRecord.fields.filter(hasURN);
  const f856sUrnsWithTempSubfields = f856sUrn.filter(hasTempSubfield);
  const f856sUrnsWithNoTempSubfields = f856sUrn.filter(hasNoTempSubfield);

  debugData(`URN f856s: ${JSON.stringify(f856sUrn)}`);
  debugData(`URN f856s with temp subfield: ${JSON.stringify(f856sUrnsWithTempSubfields)}`);
  return {f856sUrn, f856sUrnsWithTempSubfields, f856sUrnsWithNoTempSubfields};
}


// ---- LD-functions below are same as in https://github.com/NatLibFi/marc-record-validators-melinda/blob/feature-updates-to-urn/src/urn.js
// we propably should develop the urn/legaldeposit -validator to use also here

function validateLD(f856sUrn) {
  debug(`Validating the existence of legal deposit subfields`);

  const LD_SUBFIELDS = [
    {code: 'z', value: 'Käytettävissä vapaakappalekirjastoissa'},
    {code: '5', value: 'FI-Vapaa'}
  ];

  const f856sUrnWithLdSubfields = f856sUrn.filter(field => fieldHasLDSubfields(field, LD_SUBFIELDS));
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


