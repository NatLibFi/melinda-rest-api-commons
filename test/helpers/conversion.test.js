

import assert from 'node:assert';
import {describe, it} from 'node:test';
import fixtureFactory from '@natlibfi/fixura';
import {MarcRecord} from '@natlibfi/marc-record';
import {Error as ConversionError} from '@natlibfi/melinda-commons';
import createConversionService from '../../src/helpers/conversion.js';
import {CONVERSION_FORMATS} from '../../src/constants.js';

describe('services/conversion', () => {
  const {getFixture} = fixtureFactory({
    root: [
      import.meta.dirname,
      '..',
      '..',
      'test-fixtures',
      'conversion'
    ]
  });
  const conversionService = createConversionService();

  const marcRecord = new MarcRecord(JSON.parse(/** @type {*} */ (getFixture({components: ['json1']}))), {subfieldValues: false});
  const marcXml = getFixture({components: ['marcxml1']});
  const iso2709 = getFixture({components: ['iso2709_1']});
  const json = getFixture({components: ['json1']});
  const alephSeq = getFixture({components: ['aleph_sequential']});


  describe('factory', () => {
    it('Should create the expected object', () => {
      const service = createConversionService();
      assert.equal(typeof service, 'object');
      assert.equal(Object.hasOwn(service, 'serialize'), true);
      assert.equal(Object.hasOwn(service, 'unserialize'), true);
    });
  });

  describe('#serialize', () => {
    it('Should throw because of unsupported format', () => {
      try {
        conversionService.serialize(/** @type {*} */ (undefined), /** @type {*} */ (undefined));
      } catch (error) {
        assert(error instanceof ConversionError);
      }
    });

    it('Should serialize to MARCXML', () => {
      const data = conversionService.serialize(marcRecord, CONVERSION_FORMATS.MARCXML);
      assert.equal(data, marcXml);
    });

    it('Should serialize to ISO2709', () => {
      const data = conversionService.serialize(marcRecord, CONVERSION_FORMATS.ISO2709);
      assert.equal(data, iso2709);
    });

    it('Should serialize to JSON', () => {
      const data = conversionService.serialize(marcRecord, CONVERSION_FORMATS.JSON);
      assert.equal(data, json);
    });

    it('Should serialize to aleph sequential', () => {
      const data = conversionService.serialize(marcRecord, CONVERSION_FORMATS.ALEPHSEQ);
      assert.equal(data, alephSeq);
    });

    it('Should rewrap a plain (non-ConversionError) serializer error into a ConversionError with 400', () => {
      // a plain {} makes MARCXML.to throw a TypeError, which serialize must
      // rewrap into a ConversionError 400 (not propagate the raw TypeError)
      let threw = false;
      try {
        conversionService.serialize({}, CONVERSION_FORMATS.MARCXML);
      } catch (error) {
        threw = true;
        assert(error instanceof ConversionError);
        assert.equal(error.status, 400);
        assert.ok((/** @type {*} */ (error.payload)).includes('Error while serializing record.'));
      }
      assert.equal(threw, true);
    });

  });

  describe('#unserialize', () => {
    it('Should throw because of unsupported format', () => {
      try {
        conversionService.unserialize(/** @type {*} */ (undefined), /** @type {*} */ (undefined));
      } catch (error) {
        assert(error instanceof ConversionError);
      }
    });

    it('Should unserialize from MARCXML', async () => {
      const record = await conversionService.unserialize(marcXml, CONVERSION_FORMATS.MARCXML);
      assert.equal(record.equalsTo(marcRecord), true);
    });

    it('Should unserialize from ISO2709', () => {
      const record = conversionService.unserialize(iso2709, CONVERSION_FORMATS.ISO2709);
      assert.equal(record.equalsTo(marcRecord), true);
    });

    it('Should unserialize from JSON', () => {
      const record = conversionService.unserialize(json, CONVERSION_FORMATS.JSON);
      assert.equal(record.equalsTo(marcRecord), true);
    });

    it('Should unserialize from Aleph sequential', () => {
      const record = conversionService.unserialize(alephSeq, CONVERSION_FORMATS.ALEPHSEQ);
      assert.equal(record.equalsTo(marcRecord), true);
    });


    it('Should throw because the record could not be unserialized', () => {
      try {
        conversionService.unserialize('', CONVERSION_FORMATS.JSON);
      } catch (error) {
        assert(error instanceof ConversionError);
      }
    });
  });
});
