import {Utils} from '@natlibfi/melinda-commons';

const {readEnvironmentVariable, parseBoolean} = Utils; // eslint-disable-line no-unused-vars

// Rabbit variables
export const AMQP_URL = readEnvironmentVariable('AMQP_URL', {format: v => JSON.parse(v)});

// Mongo variables
export const MONGO_URI = readEnvironmentVariable('MONGO_URI', {defaultValue: 'mongodb://localhost:27017/db'});

// SRU variables
export const SRU_URL_BIB = readEnvironmentVariable('SRU_URL_BIB');
export const SRU_URL_BIBPRV = readEnvironmentVariable('SRU_URL_BIBPRV');

export const [OFFLINE_BEGIN, OFFLINE_DURATION] = readEnvironmentVariable('OFFLINE_PERIOD', {defaultValue: '0,0', format: v => v.split(',')});
