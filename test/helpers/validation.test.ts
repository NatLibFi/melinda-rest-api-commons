import assert from 'node:assert';
import {describe, it} from 'node:test';
import fixtureFactory, {READERS} from '@natlibfi/fixura';
import {MarcRecord} from '@natlibfi/marc-record';
import type {MarcRecordObject} from '@natlibfi/marc-record';

import createValidator from '../../src/helpers/validation.ts';

describe('services/validate', () => {
  const FIXTURES_PATH = [
    import.meta.dirname,
    '..',
    '..',
    'test-fixtures',
    'validation'
  ];
  const {getFixture} = fixtureFactory({root: FIXTURES_PATH, reader: READERS.JSON});

  describe('f003-fi-melinda', () => {
    it('Should have failed: false', async () => {
      const validator = await createValidator();
      const record = new MarcRecord(getFixture({
        components: [
          'in',
          'f003-fi-melinda.json'
        ]
      }) as MarcRecordObject);
      const result = await validator(record.toObject());
      const {record: expectedRecord, ...rest} = getFixture({
        components: [
          'out',
          'f003-fi-melinda.json'
        ]
      }) as Record<string, any>;
      const {_validationOptions, ...expectedRecordData} = expectedRecord;
      const {record: actualRecord, ...actualRest} = result;
      assert.deepStrictEqual(actualRest, rest);
      assert.deepStrictEqual(actualRecord.toObject(), new MarcRecord(expectedRecordData, _validationOptions).toObject());
      assert.equal(result.failed, false);
    });
  });

  describe('f003-not-fi-melinda', () => {
    it('Should have failed: true', async () => {
      const validator = await createValidator();
      const record = new MarcRecord(getFixture({
        components: [
          'in',
          'f003-not-fi-melinda.json'
        ]
      }) as MarcRecordObject);
      const result = await validator(record.toObject());
      const {record: expectedRecord, ...rest} = getFixture({
        components: [
          'out',
          'f003-not-fi-melinda.json'
        ]
      }) as Record<string, any>;
      const {_validationOptions, ...expectedRecordData} = expectedRecord;
      const {record: actualRecord, ...actualRest} = result;
      assert.deepStrictEqual(actualRest, rest);
      assert.deepStrictEqual(actualRecord.toObject(), new MarcRecord(expectedRecordData, _validationOptions).toObject());
      assert.equal(result.failed, true);
    });
  });
});
