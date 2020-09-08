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

import {expect} from 'chai';
import fixtureFactory from '@natlibfi/fixura';
import {MarcRecord} from '@natlibfi/marc-record';
import {Error as ConversionError} from '@natlibfi/melinda-commons';
import createConversionService from './conversion';
import {conversionFormats} from '../constants';

describe('services/conversion', () => {
  const {getFixture} = fixtureFactory({root: [
    __dirname,
    '..',
    '..',
    'test-fixtures',
    'conversion'
  ]});
  const conversionService = createConversionService();

  const marcRecord = new MarcRecord(JSON.parse(getFixture({components: ['json1']})));
  const marcXml = getFixture({components: ['marcxml1']});
  const iso2709 = getFixture({components: ['iso2709_1']});
  const json = getFixture({components: ['json1']});

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
      const data = conversionService.serialize(marcRecord, conversionFormats.MARCXML);
      expect(data).to.equal(marcXml);
    });

    it('Should serialize to ISO2709', () => {
      const data = conversionService.serialize(marcRecord, conversionFormats.ISO2709);
      expect(data).to.equal(iso2709);
    });

    it('Should serialize to JSON', () => {
      const data = conversionService.serialize(marcRecord, conversionFormats.JSON);
      expect(data).to.equal(json);
    });
  });

  describe('#unserialize', () => {
    it('Should throw because of unsupported format', () => {
      expect(conversionService.unserialize).to.throw();
    });

    it('Should unserialize from MARCXML', async () => {
      const record = await conversionService.unserialize(marcXml, conversionFormats.MARCXML);
      expect(record.equalsTo(marcRecord)).to.equal(true);
    });

    it('Should unserialize from ISO2709', () => {
      const record = conversionService.unserialize(iso2709, conversionFormats.ISO2709);

      expect(record.equalsTo(marcRecord)).to.equal(true);
    });

    it('Should unserialize from JSON', () => {
      const record = conversionService.unserialize(json, conversionFormats.JSON);

      expect(record.equalsTo(marcRecord)).to.equal(true);
    });

    it('Should throw because the record could not be unserialized', () => {
      expect(() => {
        conversionService.unserialize('', conversionFormats.JSON);
      }).to.throw(ConversionError);
    });
  });
});
