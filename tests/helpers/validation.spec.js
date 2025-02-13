import {expect} from 'chai';
import fixtureFactory, {READERS} from '@natlibfi/fixura';
import {MarcRecord} from '@natlibfi/marc-record';
import createValidator from '../../src/helpers/validation';

describe('services/validate', () => {
  const FIXTURES_PATH = [
    __dirname,
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
      }));
      const result = await validator(record.toObject());
      const expected = getFixture({
        components: [
          'out',
          'f003-fi-melinda.json'
        ]
      });
      expect(result).to.eql(expected);
      expect(result.failed).to.equal(false);
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
      }));
      const result = await validator(record.toObject());
      const expected = getFixture({
        components: [
          'out',
          'f003-not-fi-melinda.json'
        ]
      });
      expect(result).to.eql(expected);
      expect(result.failed).to.equal(true);
    });
  });
});

