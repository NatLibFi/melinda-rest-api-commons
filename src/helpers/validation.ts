import validateFactory from '@natlibfi/marc-record-validate';
import {
  FieldStructure as fieldStructure
} from '@natlibfi/marc-record-validators-melinda';
import {createLogger} from '@natlibfi/melinda-commons';
import type {MarcRecord, MarcRecordObject} from '@natlibfi/marc-record';

// The validate factory and its result come from the untyped
// @natlibfi/marc-record-validate shim, so record/messages flow through as
// untyped; tighten when the package ships types
export interface ValidationResult {
  record: MarcRecord;
  failed: boolean;
  messages: unknown;
}

export default async (): Promise<(unvalidRecord: MarcRecord | MarcRecordObject) => Promise<ValidationResult>> => {
  const logger = createLogger();

  logger.verbose('Running inbuilt record validations');
  const validate = validateFactory([await fieldStructure([{tag: /^003$/u, valuePattern: /^FI-MELINDA$/u}])]);

  // Validate a record: the (fixed) record, whether validation failed and the report
  return async (unvalidRecord: MarcRecord | MarcRecordObject) => {
    const {record, valid, report} = await validate(unvalidRecord, {fix: false, validateFixes: false}, {subfieldValues: false});

    return {
      record,
      failed: valid === false,
      messages: report
    };
  };
};
