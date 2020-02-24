# Shared modules for microservices of Melinda rest api import system

Shared modules for microservices of Melinda rest api import system

## Constants

### QUEUE_ITEM_STATE
`Rest-api-http`: UPLOADING -> PENDING_QUEUING ->
`Rest-api-Validator`: QUEUING_IN_PROGRESS -> IN_QUEUE ->
`Rest-api-importer`: IN_PROCESS -> DONE, ERROR or VALIDATE_PROCESS -> IN_PROCESS...

### CHUNK_SIZE
Chunck size to execution time ratio (From file to queue: ~450 records in 15sec)

| Total records | Chunk size | Chunks | Execution time | Time / chunk | Operation |
|---------------|------------|--------|----------------|--------------|-----------|
| 9248          | 100        | 93     | ~597 sec       | ~6.4 sec     | Update    |
Executed on test server using bridge to docker server and back to server

## Common confs
| P_manage_18 name    | Node name         | Prio update | Prio create | Bulk update | Bulk create | Description                                             |
|---------------------|-------------------|-------------|-------------|-------------|-------------|---------------------------------------------------------|
| p_active_library    | pActiveLibrary    | `params`    | `params`    | `params`    | `params`    | Library to use                                          |
| p_input_file        | pInputFile        | `generated` | `generated` | `generated` | `generated` | Source file location                                    |
| p_reject_file       | pRejectFile       | `generated` | `generated` | `generated` | `generated` | Log file for rejected records                           |
| p_log_file          | pLogFile          | `generated` | `generated` | `generated` | `generated` | Log file for updated/created record ids                 |
| p_old_new           | pOldNew           | OLD         | NEW         | OLD         | NEW         | Method of operation. Either *NEW* or *OLD*              |
| p_fix_type          | pFixType          | API         | API         | INSB        | INSB        | Alpeh fix routine code                                  |
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

## License and copyright

Copyright (c) 2020-2020 **University Of Helsinki (The National Library Of Finland)**

This project's source code is licensed under the terms of **GNU Affero General Public License Version 3** or any later version.
