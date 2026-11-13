# Shared modules for microservices of Melinda rest api import system
[![NPM Version](https://img.shields.io/npm/v/@natlibfi/melinda-rest-api-commons.svg)](https://npmjs.org/package/@natlibfi/melinda-rest-api-commons)
![Node Version](https://img.shields.io/node/v/@natlibfi/melinda-rest-api-commons.svg)

Shared modules for microservices of Melinda rest api import system

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
`Timeout in <state>`). The window is the time since the last write to the
item's `modificationTime` (each Mongo write done by the importer -
`pushMessages`, `pushIds`, `addBlobSize`, `setBlobSize`, `setState`,
`setImportJobState` - refreshes it). The window defaults to **1 minute** and
can be made longer with the `MONGO_TIMEOUT_MINUTES` env var, which large bulk
imports (see the CHUNK_SIZE benchmark below: ~9248 records / ~597 sec) may
need:

```sh
MONGO_TIMEOUT_MINUTES=10 # abort only after 10 minutes without progress
```

#### Full `QUEUE_ITEM_STATE` reference

The flow tables above show the happy-path sequence per service. The full set of `queueItemState` values (see `src/constants.js`):

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
Chunck size to execution time ratio (From file to queue: ~450 records in 15sec)

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

## Running the tests

There are three test suites. The base suite runs anywhere; the two AMQP
suites need a running RabbitMQ broker on `127.0.0.1:5672` (guest/guest) and
are therefore excluded from the base glob and from CI.

| Command                 | What it runs                                                        | Requirements          |
|-------------------------|---------------------------------------------------------------------|-----------------------|
| `npm run test:base`     | all `tests/**/*.test.js` with coverage + thresholds                 | none                  |
| `npm test`              | `npm run lint` then `test:base` (what CI runs)                      | none                  |
| `npm run test:local`    | `tests/amqp.*.localtest.js`, AMQP operator against a live broker    | RabbitMQ on localhost |
| `npm run test:healthcheck` | `tests/amqp.healthtest.js`, healthCheck loop vs live broker     | RabbitMQ on localhost |

`test:base` enforces minimum coverage thresholds via
`--test-coverage-lines/--test-coverage-branches/--test-coverage-functions`
(currently 88 / 88 / 90 over `src`); raise them in [`package.json`](package.json)
as coverage grows.

## License and copyright

Copyright (c) 2020-2026 **University Of Helsinki (The National Library Of Finland)**

This project's source code is licensed under the terms of **MIT** or any later version.