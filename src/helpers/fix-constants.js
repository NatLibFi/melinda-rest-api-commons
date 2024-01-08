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
// BIB_FORMAT_SETTINGS is outdated, use other settings instead


export const BIB_FORMAT_SETTINGS = {
  replacePrefixes: REPLACE_PREFIXES,
  generateMissingSIDs: BIB_F035_TO_SID
};

export const BIB_PREVALIDATION_FIX_SETTINGS = {
  generateMissingSIDs: BIB_F035_TO_SID
};

export const BIB_POSTMERGE_FIX_SETTINGS = {
  handleTempUrns: true,
  stripF884s: true
};

export const BIB_PREIMPORT_FIX_SETTINGS = {
  replacePrefixes: REPLACE_PREFIXES,
  removeF984AFields: true
};

export const AUTNAME_PREIMPORT_FIX_SETTINGS = {
  replacePrefixes: REPLACE_PREFIXES
};

export const BIB_HANDLE_TEMP_URNS_SETTINGS = {
  handleTempUrns: true
};

export const BIB_STRIP_F884S_SETTINGS = {
  stripF884s: true
};
