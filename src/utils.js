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

import Error, {Utils} from '@natlibfi/melinda-commons';
import moment from 'moment';

const {createLogger} = Utils;
const logger = createLogger();

export function logError(err) {
	if (err instanceof Error) {
		logger.log('error', err);
		return;
	}

	if (err === 'SIGINT') {
		logger.log('error', err);
		return;
	}

	logger.log('error', err.stack === undefined ? err : err.stack);
}

export function checkIfOfflineHours(OFFLINE_BEGIN, OFFLINE_DURATION) {
	const now = moment();
	const start = moment(now).startOf('day').add(OFFLINE_BEGIN, 'hours');
	const end = moment(start).add(OFFLINE_DURATION, 'hours');
	if (now.hours() < OFFLINE_BEGIN && start.format('DDD') < end.format('DDD')) { // Offline hours pass midnight (DDD = day of the year)
		start.subtract(1, 'days');
		end.subtract(1, 'days');
	}

	if (now.isBetween(start, end)) {
		return true;
	}

	return false;
}
