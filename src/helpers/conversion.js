/**
*
* @licstart  The following is the entire license notice for the JavaScript code in this file.
*
* Shared modules for microservices of Melinda rest api batch import system
*
* Copyright (C) 2020-2021 University Of Helsinki (The National Library Of Finland)
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

import httpStatus from 'http-status';
import {MARCXML, ISO2709, Json, AlephSequential} from '@natlibfi/marc-record-serializers';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {Error as ConversionError} from '@natlibfi/melinda-commons';
import {conversionFormats} from '../constants';
import {logError} from '../utils';

export default function () {
  const logger = createLogger();

  return {serialize, unserialize};

  function serialize(record, format) {
    logger.verbose(`Serializing record to ${format}`);
    try {
      if (format === conversionFormats.MARCXML) {
        return MARCXML.to(record);
      }

      if (format === conversionFormats.ISO2709) {
        return ISO2709.to(record);
      }

      if (format === conversionFormats.JSON) {
        return Json.to(record);
      }

      if (format === conversionFormats.ALEPHSEQ) {
        return AlephSequential.to(record);
      }

      throw new ConversionError(httpStatus.UNSUPPORTED_MEDIA_TYPE);
    } catch (err) {
      logError(err);
      if (err instanceof ConversionError) { // eslint-disable-line functional/no-conditional-statement
        throw err;
      }
      throw new ConversionError(httpStatus.BAD_REQUEST, 'Error while serializing record');
    }
  }

  // eslint-disable-next-line max-statements
  function unserialize(data, format, validationOptions = {subfieldValues: false}) {
    logger.verbose(`Unserializing record from ${format}`);
    logger.silly(`Format: ${format}`);
    logger.debug(`Validation options: ${JSON.stringify(validationOptions)}`);
    logger.silly(`Data: ${JSON.stringify(data)}`);
    try {
      if (format === conversionFormats.MARCXML) {
        logger.silly('Unserialize format marcxml');
        return MARCXML.from(data, validationOptions);
      }

      if (format === conversionFormats.ISO2709) {
        logger.silly('Unserialize format iso2709');
        return ISO2709.from(data, validationOptions);
      }

      if (format === conversionFormats.JSON) {
        logger.silly('Unserialize format json');
        return Json.from(data, validationOptions);
      }

      if (format === conversionFormats.ALEPHSEQ) {
        logger.silly('Unserialize format aleph sequential');
        return AlephSequential.from(data, validationOptions);
      }

      throw new ConversionError(httpStatus.UNSUPPORTED_MEDIA_TYPE);
    } catch (err) {
      logError(err);
      if (err instanceof ConversionError) { // eslint-disable-line functional/no-conditional-statement
        throw err;
      }
      throw new ConversionError(httpStatus.BAD_REQUEST, 'Error while unserializing record');
    }
  }
}
