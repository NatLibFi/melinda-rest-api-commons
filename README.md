# Shared modules for microservices of Melinda rest api import system

Shared modules for microservices of Melinda rest api import system

## Constants
Chunck size to execution time ratio (From file to queue: ~450 records in 15sec)

| Chunk size | Execution time | Chunks | Time / chunk | Total records |
|------------|----------------|--------|--------------|---------------|
| 5          | ~ 180 sec      | 94     | 1.8 sec      | 466           |
| 25         | ~ 90  sec      | 19     | 3.9 sec      | 466           |
| 50         | ~ 60  sec      | 10     | 4.5 sec      | 466           |
| 100        | ~ 50  sec      | 5      | 7 sec        | 466           |
| 200        | ~ 45  sec      | 3      | 10           | 466           |
| 500        | ~ 38  sec      | 1      | 23           | 466           |

## License and copyright

Copyright (c) 2020-2020 **University Of Helsinki (The National Library Of Finland)**

This project's source code is licensed under the terms of **GNU Affero General Public License Version 3** or any later version.
