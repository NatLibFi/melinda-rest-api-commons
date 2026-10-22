# Shared modules for microservices of Melinda rest api import system
[![NPM Version](https://img.shields.io/npm/v/@natlibfi/melinda-rest-api-commons.svg)](https://npmjs.org/package/@natlibfi/melinda-rest-api-commons)
![Node Version](https://img.shields.io/node/v/@natlibfi/melinda-rest-api-commons.svg)

Shared modules for microservices of Melinda rest api import system

## API

Everything is exported from the package root (`@natlibfi/melinda-rest-api-commons`):

- three **operator factories** (async, `await` them to get the operator object):
  `mongoFactory`, `mongoLogFactory`, `amqpFactory`
- **MARC helpers**: `conversions()`, `validations()`, and the `fixes` namespace
  (`fixRecord` + fix settings/constants)
- **utility functions**: `logError`, `createImportJobState`,
  `createRecordResponseItem`, `addRecordResponseItem`, `addRecordResponseItems`
- **constants**: `QUEUE_ITEM_STATE`, `IMPORT_JOB_STATE`, `OPERATIONS`,
  `CHUNK_SIZE`, `LOG_ITEM_TYPE`, `CONVERSION_FORMATS` (see
  [Constants](#constants) below)
- **types** (TypeScript consumers): `MongoOperator`, `QueueItem`,
  `ImportJobStateValue`, `MongoLogOperator`, `LogItem`, `LogItemType`,
  `AmqpOperator`, `QueueItemRecordPayload`, `QueueItemMessagePayload`

Invalid input is rejected with an `ApiError` 400; a Mongo failure rejects
with an `ApiError` 500. Both `ApiError`s carry an HTTP status you can map to
a response.

### `mongoFactory(MONGO_URI, collection, db?)`

Creates the queue-item operator on a Mongo collection. `db` defaults to
`'rest-api'`.

| Method | Description | Returns |
|--------|-------------|---------|
| `createPrio(params)` | Create a prio (single-record) queue item | `void` |
| `createBulk(params)` | Create a bulk queue item, with or without an input content stream | `{correlationId, acknowledged, queueItemState}` |
| `checkAndSetState(params)` | Check the queue item has not timed out, then set its state | `CheckAndSetResult` |
| `checkAndSetImportJobState(params)` | Same, for one operation's `importJobState` | `CheckAndSetResult` |
| `query(params, showParams?)` | Query queue items with a trusted internal query object (limit, skip, Mongo operators) | `QueueItem[]` |
| `createProjection(showParams?)` | Build the Mongo projection used by `query` (internal fields hidden unless shown) | `Record<string, number>` |
| `queryById({correlationId, checkModTime?})` | Get a queue item by `correlationId` | `QueueItem \| null` |
| `checkTimeOut(params)` | Abort the queue item when it has not made progress within the [timeout window](#timeout-abort-contract) (sets `ABORT`, `errorStatus` 408) | `boolean` (true when it aborted) |
| `remove({correlationId})` | Remove a queue item and its GridFS content | `{removed, deletedContent}` |
| `readContent(correlationId)` | Read the GridFS content of a queue item | `{contentType, readStream}` |
| `removeContent({correlationId})` | Remove the GridFS content of a queue item | `boolean` |
| `getOne({queueItemState?, importJobState?})` | Get one queue item filtered by `queueItemState` and/or `importJobState` | `QueueItem \| null` |
| `getStream(correlationId)` | Download stream of the GridFS content; rejects with 404 when the file is missing | `Readable` (async) |
| `setState(params)` | Set the queue item state (plus optional `errorMessage` / `errorStatus`) | `QueueItem \| null` |
| `setImportJobState(params)` | Set the `importJobState` of one operation | `QueueItem \| null` |
| `pushIds({correlationId, handledIds, rejectedIds})` | Push handled and rejected ids to the queue item | `void` |
| `pushMessages({correlationId, messages, messageField?})` | Push message records to a queue item field (`messageField` defaults to `messages`) | `void` |
| `setOperation({correlationId, operation})` | Set the operation of a queue item; rejects with 404 when the item does not exist | `QueueItem` |
| `setOperations({correlationId, addOperation, removeOperation?})` | Add and/or remove operations on a queue item | `QueueItem` |
| `addBlobSize({correlationId})` | Increment the `blobSize` of a queue item waiting for records | `QueueItem \| null` |
| `setBlobSize({correlationId, blobSize})` | Set the `blobSize` of a queue item | `QueueItem \| null` |

**`CheckAndSetResult`** — the discriminated result of
`checkAndSetState` / `checkAndSetImportJobState` (branch on `status`, read
the item from `queueItem`):

| `status` | Meaning |
|----------|---------|
| `updated` | the state was set; `queueItem` is the resulting document |
| `timeout` | the item was aborted by `checkTimeOut`; `queueItem` is the resulting document |
| `unchanged` | the item was already `ABORT` / `ERROR` / `DONE`, or no longer exists; `queueItem` is `null` when the item is gone |

**`createBulk` result** — `{correlationId, acknowledged, queueItemState}` on
both the stream and no-stream paths (`queueItemState` is `UPLOADING` for the
stream path, `WAITING_FOR_RECORDS` for the no-stream path).

### `mongoLogFactory(MONGO_URI, dbName?)`

Creates the log operator on the `logs` collection of a Mongo db. `dbName`
defaults to `'rest-api'`.

| Method | Description | Returns |
|--------|-------------|---------|
| `addLogItem(logItem)` | Add a log item | `void` |
| `query(params)` | Query log items with a trusted internal query object (defaults: limit 5, skip 0) | `LogItem[]` |
| `queryById(correlationId, logItemType?, skip?, limit?)` | Get log items for one `correlationId` (defaults: `logItemType` `MERGE_LOG`, limit 1) | `LogItem[]` |
| `getListOfLogs(logItemType?)` | Get the list of `correlationId`s that have logs of a given type (default `MERGE_LOG`) | `string[]` |
| `getListOfCatalogers()` | Get the list of catalogers over all logs | `string[]` |
| `getListOfCorrelationIds()` | Get the list of `correlationId`s over all logs | `string[]` |
| `getExpandedListOfLogs(params)` | Aggregated log list per `correlationId` + `logItemType` with cataloger, creation time and record count; optional filters `logItemTypes`, `catalogers`, `dateBefore`, `dateAfter` (a provided `logItemTypes` is validated element-wise, unknown element rejects with 400) | `ExpandedLogListItem[]` |
| `protect(correlationId, blobSequence?)` | Mark matching log items as protected (idempotent) | `UpdateResult` |
| `unprotect(correlationId, blobSequence?)` | Mark matching log items as unprotected, so regular cleaning can remove them | `UpdateResult` |
| `remove(correlationId, force?)` | Remove log items for a `correlationId`; protected items are kept unless `force` | `DeleteResult` |
| `removeBySequences(correlationId, sequences?, force?)` | Remove log items for a `correlationId` matching blob sequences; protected items are kept unless `force` | `DeleteResult` |

### `amqpFactory(AMQP_URL, runHealthCheck?)`

Creates the AMQP operator on a RabbitMQ broker. With `runHealthCheck: true`,
a background loop asserts a temporary `HEALTHCHECK` queue about every 200 ms.
This is a deliberate fast-fail: when the broker is unreachable the error
escapes as an unhandled rejection — the operator does not catch, retry or
reconnect. Deploy the process with `unhandledRejection` /
`uncaughtException` handlers that log and exit, so the orchestrator restarts
it.

| Method | Description | Returns |
|--------|-------------|---------|
| `checkQueue({queue, style?, toRecord?, purge?})` | Check a queue: consume one message or a chunk, return the message count, or purge (defaults: `style` `basic`, `toRecord` true) | `false` (empty) \| message count (`style` `messages`) \| message / records / chunk object (`style` `one` / `basic`) |
| `consumeChunk(queue, toRecord)` | Consume a chunk (up to `CHUNK_SIZE` messages) from a queue | `false` \| `{headers, [records,] messages}` |
| `consumeOne(queue, toRecord)` | Consume one message from a queue | `false` \| message \| `{headers, records, messages}` |
| `ackMessages(messages)` | Acknowledge consumed messages | `void` |
| `nackMessages(messages)` | Nack consumed messages (not requeued) | `void` |
| `sendToQueue({queue, correlationId, headers?, data})` | Send a message to a queue; rejects with 500 when `queue` is missing | `void` |
| `removeQueue(queue)` | Remove a queue | `void` |
| `messagesToRecords(messages)` | Parse the message bodies of consumed messages into MARC records | `MarcRecord[]` |
| `closeChannel()` | Close the channel | `void` |
| `closeConnection()` | Close the connection | `void` |

The consumed-payload shape depends on `toRecord`: `{headers, records,
messages}` when true, `{headers, messages}` when false (`headers` is the
AMQP properties headers of the first message of the chunk; `records` is the
MARC records parsed from the message bodies). `consumeOne` with `toRecord`
false returns the plain amqplib message instead of a payload object.

### MARC helpers

| Export | Description |
|--------|-------------|
| `conversions()` | Factory returning `{serialize, unserialize}`. `serialize(record, format)` returns the record as a string; `unserialize(data, format, validationOptions?)` returns a `MarcRecord`. `format` is a `CONVERSION_FORMATS` value (`MARCXML`, `ISO2709`, `JSON`, `ALEPHSEQ`); an unknown format rejects with 415, malformed data with 400 |
| `validations()` | Async factory returning an async validator: `(record) => {record, failed, messages}` — the (fixed) record, whether validation failed, and the validation report |
| `fixes.fixRecord(record, settings?)` | Apply the configured record fixes (`FixSettings`) to a clone of the record (the input is never mutated); returns a `MarcRecordObject` |
| `fixes.*` | Fix settings and constants: `BIB_F035_TO_SID`, `REPLACE_PREFIXES`, `BIB_FORMAT_SETTINGS`, `BIB_PREVALIDATION_FIX_SETTINGS`, `BIB_POSTMERGE_FIX_SETTINGS`, `BIB_PREIMPORT_FIX_SETTINGS`, `AUTNAME_PREIMPORT_FIX_SETTINGS` |

### Utilities

| Export | Description |
|--------|-------------|
| `logError(err)` | Log an error (`ApiError`s are stringified, the SIGINT marker as-is, everything else with its stack when it has one) |
| `createImportJobState(operation, state, queryImportJobState?)` | Build an `importJobState` object; the optional third argument keys it by the dotted query form (`importJobState.<operation>`) |
| `createRecordResponseItem({responsePayload, responseStatus, recordMetadata?, id?})` | Build one record response item (the payload must be an object or a string) |
| `addRecordResponseItem({recordResponseItem, correlationId, mongoOperator})` | Add one record response item to the `records` field of a queue item |
| `addRecordResponseItems({recordResponseItems, correlationId, mongoOperator})` | Add several record response items in one Mongo operation (avoids write conflicts) |

### Breaking changes since 6.0

If you upgrade from 5.x or 6.0, verify these methods — their return shape or
calling convention changed:

1. `checkAndSetState` / `checkAndSetImportJobState` no longer return a
   boolean; they return the `CheckAndSetResult` object above. Branch on
   `result.status` instead of the truthiness of the return value.
2. `createBulk` returns the normalized `{correlationId, acknowledged,
   queueItemState}` object on both the stream and the no-stream path; do not
   read driver result fields like `insertedId` anymore.
3. `getStream` is now async (returns a Promise) and rejects with `ApiError`
   404 when the GridFS file is missing, instead of surfacing the missing
   file as an async `error` event on the stream.
4. `getOne` is now async (returns a Promise); invalid input is rejected with
   `ApiError` 400 before any query is issued.

## Constants

### QUEUE_ITEM_STATE

#### QueueItemState flow for bulk jobs (multiple records, no validations):

| microservice | states                                                 |
|--------------|--------------------------------------------------------|
| `http`       | -> VALIDATOR.UPLOADING -> VALIDATOR.PENDING_QUEUING -> |
| `validator`  | VALIDATOR.QUEUING_IN_PROGRESS -> IMPORTER.IN_QUEUE ->  |
| `importer`   | IMPORTER.IMPORTING -> IMPORT_JOB_STATEs* -> DONE       |
|              |                                                        |
| any          | any -> ERROR if errored                                |

*IMPORT_JOB_STATEs: EMPTY or IN_QUEUE, PROCESSING -> final: DONE, ERROR, ABORT

#### QueueItemState flow for prio jobs (single record):

| microservice | states                                                     |
|--------------|------------------------------------------------------------|
| `http`       | -> VALIDATOR.PENDING_VALIDATION ->                         |
| `validator`  | VALIDATOR.VALIDATING -> IMPORTER.IN_QUEUE ->               |
| `importer`   | IMPORTER.IMPORTING -> IMPORT_JOB_STATEs* -> DONE           |
|              |                                                            |
| `http`       | any -> ABORT if job has stayed in an active state too long |
| `validator`  | VALIDATOR.VALIDATING -> DONE for noop (no-operation) jobs  |
|              |                                                            |
| any          | any -> ERROR if errored                                    |

*IMPORT_JOB_STATEs: EMPTY or IN_QUEUE, PROCESSING -> final: DONE, ERROR, ABORT

#### Timeout (ABORT) contract

A queue item that has not made progress for longer than the timeout window is
set to `ABORT` (with `errorStatus` 408 and `errorMessage`
`Timeout in <state>`). The check is not automatic: it only runs when a
consumer calls `checkTimeOut` or the `checkAndSetState` /
`checkAndSetImportJobState` wrappers. The window is the time since the last
write to the item's `modificationTime` (every Mongo write done through the
operator - `pushMessages`, `pushIds`, `addBlobSize`, `setBlobSize`,
`setState`, `setImportJobState` - refreshes it). The window defaults to
**1 minute** and can be made longer with the `MONGO_TIMEOUT_MINUTES` env var
when a single state phase may legitimately take longer:

```sh
MONGO_TIMEOUT_MINUTES=10 # abort only after 10 minutes without progress
```

#### Full `QUEUE_ITEM_STATE` reference

The flow tables above show the happy-path sequence per service. The full set of `queueItemState` values (see `src/constants.ts`):

| State | Group | Meaning |
|-------|-------|---------|
| `VALIDATOR.PENDING_QUEUING` | VALIDATOR | Bulk job accepted (http); waiting to be picked up for validation. |
| `VALIDATOR.PENDING_VALIDATION` | VALIDATOR | Prio job accepted (http); waiting to be picked up for validation. |
| `VALIDATOR.QUEUING_IN_PROGRESS` | VALIDATOR | Validator is distributing records to the per-operation import queues. |
| `VALIDATOR.UPLOADING` | VALIDATOR | Stream-bulk upload in progress (records written to the GridFS blob). |
| `VALIDATOR.VALIDATING` | VALIDATOR | Validator is validating records. |
| `VALIDATOR.WAITING_FOR_RECORDS` | VALIDATOR | Stream-bulk job: partial records received, waiting for the remainder. |
| `IMPORTER.IN_QUEUE` | IMPORTER | Records are queued for import, awaiting the importer. |
| `IMPORTER.IMPORTING` | IMPORTER | Importer has the job and is importing it. |
| `IMPORTER.IN_PROCESS` | IMPORTER | Importer is processing the job. |
| `DONE` | terminal | Job completed successfully. |
| `ERROR` | terminal | Job failed; see `errorStatus` / `errorMessage`. |
| `ABORT` | terminal | Job aborted (e.g. timeout on a stalled job; `errorStatus` 408). |

#### Full `IMPORT_JOB_STATE` reference

Each queue item also carries a per-operation `importJobState` subdocument (`CREATE` / `UPDATE` / `FIX`). The full set of values:

| State | Meaning |
|-------|---------|
| `EMPTY` | No such operation in the job (coalesced default when the subdocument is absent). |
| `QUEUING` | Validator is queuing this operation's records. |
| `IN_QUEUE` | This operation's records are queued for import. |
| `IMPORTING` | Importer is importing this operation. |
| `PROCESSING` | Importer is processing this operation (record-load). |
| `DONE` | This operation completed. |
| `ERROR` | This operation failed. |
| `ABORT` | This operation aborted (e.g. timeout). |

### CHUNK_SIZE
Chunk size to execution time ratio (From file to queue: ~450 records in 15sec)

| Total records | Chunk size | Chunks | Execution time | Time / chunk | Operation |
|---------------|------------|--------|----------------|--------------|-----------|
| 9248          | 100        | 93     | ~597 sec       | ~6.4 sec     | Update    |
Executed on test server using bridge to docker server and back to server

## Common confs for aleph-record-load-api
| P_manage_18 name    | Node name         | Prio update | Prio create | Bulk update | Bulk create | Description                                             |
|---------------------|-------------------|-------------|-------------|-------------|-------------|---------------------------------------------------------|
| p_active_library    | pActiveLibrary    | `params`    | `params`    | `params`    | `params`    | Library to use                                          |
| p_input_file        | pInputFile        | `generated` | `generated` | `generated` | `generated` | Source file location                                    |
| p_reject_file       | pRejectFile       | `generated` | `generated` | `generated` | `generated` | Log file for rejected records                           |
| p_log_file          | pLogFile          | `generated` | `generated` | `generated` | `generated` | Log file for updated/created record ids                 |
| p_old_new           | pOldNew           | OLD         | NEW         | OLD         | NEW         | Method of operation. Either *NEW* or *OLD*              |
| p_fix_type          | pFixType          | API         | API         | INSB        | INSB        | Aleph fix routine code                                  |
| p_check_references  | pCheckReferences  |             |             |             |             |                                                         |
| p_update_f          | pUpdateF          | FULL        | FULL        | FULL        | FULL        | Indexing action                                         |
| p_update_type       | pUpdateType       | REP         | REP         | REP         | REP         | REP or APP (REPlace or APPend)                          |
| p_update_mode       | pUpdateMode       | M           | M           | M           | M           | User mode. Either *M* (Multi-user) or *S* (Single-user) |
| p_char_conv         | pCharConv         |             |             |             |             | Character conversion to apply                           |
| p_merge_type        | pMergeType        |             |             |             |             | Merge/Preferred routine                                 |
| p_cataloger_in      | pCatalogerIn      | `params`    | `params`    | `params`    | `params`    | Value which is written to *CAT* fields                  |
| p_cataloger_level_x | pCatalogerLevelX  |             |             |             |             | Cataloger lever                                         |
| p_z07_priority_year | pZ07PriorityYear  | 1998        | 1990        | 2099        | 2099        | Override indexing priority                              |
| p_redirection_field | pRedirectionField |             |             |             |             |                                                         |

## TypeScript toolchain

The source is TypeScript (Node >= 24, native type stripping for tests).

- `npm run build` runs `tsc` (`tsconfig.json`): `src/` -> `dist/`, emitting
  `.js` + `.js.map` + `.d.ts` + `.d.ts.map` for every module. The published
  entry point stays `./dist/index.js`; the `.d.ts` files are additive for
  TypeScript consumers.
- `npm run typecheck` runs `tsc -p tsconfig.test.json` (typechecks `src/`
  and `test/`, no emit).
- `npm test` runs `npm run lint` then `npm run typecheck` then
  `npm run test:base` (what CI runs).

## Running the tests

There are three test suites. The base suite runs anywhere; the two AMQP
suites need a running RabbitMQ broker on `127.0.0.1:5672` (guest/guest) and
are therefore excluded from the base glob and from CI. Tests are `.ts`
files run directly by `node --test` (no loader).

| Command                 | What it runs                                                        | Requirements          |
|-------------------------|---------------------------------------------------------------------|-----------------------|
| `npm run test:base`     | all `test/**/*.test.ts` with coverage + thresholds                  | none                  |
| `npm test`              | `npm run lint`, `npm run typecheck`, then `test:base` (what CI runs) | none                 |
| `npm run test:local`    | `test/amqp.*.localtest.ts`, AMQP operator against a live broker     | RabbitMQ on localhost |
| `npm run test:healthcheck` | `test/amqp.healthtest.ts`, healthCheck loop vs live broker        | RabbitMQ on localhost |

`test:base` enforces minimum coverage thresholds via
`--test-coverage-lines/--test-coverage-branches/--test-coverage-functions`
(currently 88 / 88 / 90 over `src`); raise them in [`package.json`](package.json)
as coverage grows.

## License and copyright

Copyright (c) 2022-current **University of Helsinki (National Library of Finland)**

This project's source code is licensed under the terms of **MIT** or any later version.