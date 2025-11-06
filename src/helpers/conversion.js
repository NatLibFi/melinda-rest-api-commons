

import httpStatus from 'http-status';
import {MARCXML, ISO2709, Json, AlephSequential} from '@natlibfi/marc-record-serializers';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {Error as ConversionError} from '@natlibfi/melinda-commons';
import {CONVERSION_FORMATS} from '../constants.js';
import {logError} from '../utils.js';

export default function () {
  const logger = createLogger();

  return {serialize, unserialize};

  // This uses format as a number form contants CONVERSION_FORMATS
  function serialize(record, format) {
    logger.verbose(`Serializing record to ${format}`);
    try {
      if (format === CONVERSION_FORMATS.MARCXML) {
        return MARCXML.to(record);
      }

      if (format === CONVERSION_FORMATS.ISO2709) {
        return ISO2709.to(record);
      }

      if (format === CONVERSION_FORMATS.JSON) {
        return Json.to(record);
      }

      if (format === CONVERSION_FORMATS.ALEPHSEQ) {
        return AlephSequential.to(record);
      }

      throw new ConversionError(httpStatus.UNSUPPORTED_MEDIA_TYPE);
    } catch (err) {
      logError(err);
      const message = err.message || err.payload?.message || err.payload;
      logger.debug(`${message}`);
      if (err instanceof ConversionError) {
        throw err;
      }
      throw new ConversionError(httpStatus.BAD_REQUEST, `Error while serializing record. ${message}`);
    }
  }

  function unserialize(data, format, validationOptions = {subfieldValues: false}) {
    logger.verbose(`Unserializing record from ${format}`);
    logger.silly(`Format: ${format}`);
    logger.debug(`Validation options: ${JSON.stringify(validationOptions)}`);
    logger.silly(`Data: ${JSON.stringify(data)}`);
    try {
      if (format === CONVERSION_FORMATS.MARCXML) {
        logger.silly('Unserialize format marcxml');
        return MARCXML.from(data, validationOptions);
      }

      if (format === CONVERSION_FORMATS.ISO2709) {
        logger.silly('Unserialize format iso2709');
        return ISO2709.from(data, validationOptions);
      }

      if (format === CONVERSION_FORMATS.JSON) {
        logger.silly('Unserialize format json');
        return Json.from(data, validationOptions);
      }

      if (format === CONVERSION_FORMATS.ALEPHSEQ) {
        logger.silly('Unserialize format aleph sequential');
        return AlephSequential.from(data, validationOptions);
      }

      throw new ConversionError(httpStatus.UNSUPPORTED_MEDIA_TYPE);
    } catch (err) {
      logError(err);
      const message = err.message || err.payload?.message || err.payload;
      logger.debug(`${message}`);
      if (err instanceof ConversionError) {
        throw err;
      }
      throw new ConversionError(httpStatus.BAD_REQUEST, `Error while unserializing record. ${message}`);
    }
  }
}
