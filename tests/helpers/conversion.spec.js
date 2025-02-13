

import {expect} from 'chai';
import fixtureFactory from '@natlibfi/fixura';
import {MarcRecord} from '@natlibfi/marc-record';
import {Error as ConversionError} from '@natlibfi/melinda-commons';
import createConversionService from '../../src/helpers/conversion';
import {CONVERSION_FORMATS} from '../../src/constants';

describe('services/conversion', () => {
  const {getFixture} = fixtureFactory({root: [
    __dirname,
    '..',
    '..',
    'test-fixtures',
    'conversion'
  ]});
  const conversionService = createConversionService();

  const marcRecord = new MarcRecord(JSON.parse(getFixture({components: ['json1']})), {subfieldValues: false});
  const marcXml = getFixture({components: ['marcxml1']});
  const iso2709 = getFixture({components: ['iso2709_1']});
  const json = getFixture({components: ['json1']});
  const alephSeq = getFixture({components: ['aleph_sequential']});


  describe('factory', () => {
    it('Should create the expected object', () => {
      const service = createConversionService();
      expect(service).to.be.an('object').and
        .respondTo('serialize')
        .respondTo('unserialize');
    });
  });

  describe('#serialize', () => {
    it('Should throw because of unsupported format', () => {
      expect(conversionService.serialize).to.throw();
    });

    it('Should serialize to MARCXML', () => {
      const data = conversionService.serialize(marcRecord, CONVERSION_FORMATS.MARCXML);
      expect(data).to.equal(marcXml);
    });

    it('Should serialize to ISO2709', () => {
      const data = conversionService.serialize(marcRecord, CONVERSION_FORMATS.ISO2709);
      expect(data).to.equal(iso2709);
    });

    it('Should serialize to JSON', () => {
      const data = conversionService.serialize(marcRecord, CONVERSION_FORMATS.JSON);
      expect(data).to.equal(json);
    });

    it('Should serialize to aleph sequential', () => {
      const data = conversionService.serialize(marcRecord, CONVERSION_FORMATS.ALEPHSEQ);
      expect(data).to.equal(alephSeq);
    });

  });

  describe('#unserialize', () => {
    it('Should throw because of unsupported format', () => {
      expect(conversionService.unserialize).to.throw();
    });

    it('Should unserialize from MARCXML', async () => {
      const record = await conversionService.unserialize(marcXml, CONVERSION_FORMATS.MARCXML);
      expect(record.equalsTo(marcRecord)).to.equal(true);
    });

    it('Should unserialize from ISO2709', () => {
      const record = conversionService.unserialize(iso2709, CONVERSION_FORMATS.ISO2709);
      expect(record.equalsTo(marcRecord)).to.equal(true);
    });

    it('Should unserialize from JSON', () => {
      const record = conversionService.unserialize(json, CONVERSION_FORMATS.JSON);
      expect(record.equalsTo(marcRecord)).to.equal(true);
    });

    it('Should unserialize from Aleph sequential', () => {
      const record = conversionService.unserialize(alephSeq, CONVERSION_FORMATS.ALEPHSEQ);
      expect(record.equalsTo(marcRecord)).to.equal(true);
    });


    it('Should throw because the record could not be unserialized', () => {
      expect(() => {
        conversionService.unserialize('', CONVERSION_FORMATS.JSON);
      }).to.throw(ConversionError);
    });
  });
});
