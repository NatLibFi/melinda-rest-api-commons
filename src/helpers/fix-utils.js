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

export function removeSubfield(field, code) {

  // Handle non-numeric fields, and fields with a numeric tag of 010 and greater
  // Aleph's FMT as a controlfield might be a problem
  if (!isNaN(field.tag) && parseInt(field.tag, 10) >= 10) {

    const filteredSubfields = field.subfields.filter(sf => sf.code !== code);

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


// sort fields by value of each fields first subfield with subfielCode
export function sortFieldsBySubfieldValue(fields, subfieldCode) {
  return [...fields].sort((a, b) => {
    const a1value = getFirstSubfieldValue(a, subfieldCode);
    const b1value = getFirstSubfieldValue(b, subfieldCode);
    if (a1value && !b1value) {
      return -1;
    }
    if (!a1value && b1value) {
      return 1;
    }
    if (a1value > b1value) {
      return 1;
    }
    if (b1value > a1value) {
      return -1;
    }
    return 0;
  });
  // get value for the for instance of subfield with subfieldCode
  function getFirstSubfieldValue(field, subfieldCode) {
    const subs = field.subfields ? field.subfields.filter(subf => subf.code === subfieldCode) : [];
    return subs.length > 0 ? subs[0].value : '';
  }
}
