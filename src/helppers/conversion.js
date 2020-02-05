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

import {MARCXML, ISO2709, Json} from '@natlibfi/marc-record-serializers';
import ConversionError from '@natlibfi/melinda-commons';
import {conversionFormats} from '../constants';
import {logError} from '../utils';

export {ConversionError};

export default function () {
	return {serialize, unserialize};

	function serialize(record, format) {
		switch (format) {
			case conversionFormats.MARCXML:
				return MARCXML.to(record);
			case conversionFormats.ISO2709:
				return ISO2709.to(record);
			case conversionFormats.JSON:
				return Json.to(record);
			default:
				throw new Error();
		}
	}

	function unserialize(data, format) {
		try {
			switch (format) {
				case conversionFormats.MARCXML:
					return MARCXML.from(data);
				case conversionFormats.ISO2709:
					return ISO2709.from(data);
				case conversionFormats.JSON:
					return Json.from(data);
				default:
					break;
			}
		} catch (error) {
			// Internal server error
			logError(error);
			throw new ConversionError(500);
		}

		// No supported format found (415 Unsupported Media Type)
		throw new ConversionError(415);
	}
}
