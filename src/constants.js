// Rest-import-queue-constants
// Flow: UPLOADING -> PENDING_QUEUING -> QUEUING_IN_PROGRESS -> IN_QUEUE -> IN_PROCESS -> DONE or ERROR
export const QUEUE_ITEM_STATE = {
	DONE: 'DONE',
	ERROR: 'ERROR',
	IN_PROCESS: 'IN_PROCESS',
	IN_QUEUE: 'IN_QUEUE',
	PENDING_QUEUING: 'PENDING_QUEUING',
	QUEUING_IN_PROGRESS: 'QUEUING_IN_PROGRESS',
	UPLOADING: 'UPLOADING'
};

export const PRIO_IMPORT_QUEUES = {
	CREATE: 'CREATE',
	REQUESTS: 'REQUESTS',
	UPDATE: 'UPDATE'
};

export const OPERATIONS = [
	'create',
	'update'
];

export const CHUNK_SIZE = 50;

export const conversionFormats = {
	MARCXML: 1,
	ISO2709: 2,
	JSON: 3
};
