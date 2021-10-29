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

import validateFactory from '@natlibfi/marc-record-validate';
import {
  FieldStructure as fieldStructure
} from '@natlibfi/marc-record-validators-melinda';
import {createLogger} from '@natlibfi/melinda-backend-commons';

export default async () => {
  const logger = createLogger();

  logger.verbose('Running inbuilt record validations');
  const validate = validateFactory([await fieldStructure([{tag: /^003$/u, valuePattern: /^FI-MELINDA$/u}])]);

  return async unvalidRecord => {
    const {record, valid, report} = await validate(unvalidRecord, {fix: false, validateFixes: false}, {subfieldValues: false});

    return {
      record,
      failed: valid === false,
      messages: report
    };
  };
};
