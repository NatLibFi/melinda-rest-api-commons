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

// Flow prio: PENDING_VALIDATION -> VALIDATING -> IN_QUEUE, ERROR -> IMPORTING -> IN_PROCESS -> DONE, ERROR
// Flow bulk: UPLOADING -> PENDING_QUEUING -> QUEUING_IN_PROGRESS -> IN_QUEUE -> IMPORTING -> IN_PROCESS -> DONE, ERROR
// Request timeout sets ABORTED
export const QUEUE_ITEM_STATE = {
  VALIDATOR: {
    IN_QUEUE: 'IN_QUEUE',
    PENDING_QUEUING: 'PENDING_QUEUING',
    PENDING_VALIDATION: 'PENDING_VALIDATION',
    QUEUING_IN_PROGRESS: 'QUEUING_IN_PROGRESS',
    VALIDATING: 'VALIDATING',
    UPLOADING: 'UPLOADING'
  },
  IMPORTER: {
    IMPORTING: 'IMPORTING',
    IN_PROCESS: 'IN_PROCESS'
  },
  DONE: 'DONE',
  ERROR: 'ERROR',
  ABORT: 'ABORT'
};

export const OPERATIONS = {
  CREATE: 'CREATE',
  UPDATE: 'UPDATE'
};

export const CHUNK_SIZE = 100;

export const conversionFormats = {
  MARCXML: 1,
  ISO2709: 2,
  JSON: 3
};
