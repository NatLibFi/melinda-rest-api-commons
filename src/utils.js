import {Utils} from '@natlibfi/melinda-commons';
import moment from 'moment';

import {OFFLINE_BEGIN, OFFLINE_DURATION} from './config';

const {createLogger} = Utils;
const logger = createLogger();

export function logError(err) {
	if (err === 'SIGINT') {
		logger.log('error', err);
	} else {
		logger.log('error', 'stack' in err ? err.stack : err);
	}
}

export function checkIfOfflineHours() {
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
