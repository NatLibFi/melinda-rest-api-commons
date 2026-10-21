import validateFactory from '@natlibfi/marc-record-validate';
import {
  FieldStructure as fieldStructure
} from '@natlibfi/marc-record-validators-melinda';
import {createLogger} from '@natlibfi/melinda-commons';

export default async () => {
  const logger = createLogger();

  logger.verbose('Running inbuilt record validations');
  const validate = validateFactory([await fieldStructure([{tag: /^003$/u, valuePattern: /^FI-MELINDA$/u}])]);

  /**
   * Validate a record
   * @param {*} unvalidRecord the record to validate
   * @returns {Promise<{record: *, failed: boolean, messages: *}>} the (fixed) record, whether validation failed and the report
   */
  return async unvalidRecord => {
    const {record, valid, report} = await validate(unvalidRecord, {fix: false, validateFixes: false}, {subfieldValues: false});

    return {
      record,
      failed: valid === false,
      messages: report
    };
  };
};
