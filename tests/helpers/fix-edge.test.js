// Edge-case tests for the MARC fix helpers that document CURRENT
// (possibly buggy) behaviour. See zoo/bug-report.md (B-31).
// These tests are test-only: they must pass against the unmodified
// source and assert what the code ACTUALLY does today.

import assert from 'node:assert';
import {test} from 'node:test';
import {MarcRecord} from '@natlibfi/marc-record';
import {fixRecord} from '../../src/helpers/fix.js';
import {BIB_STRIP_F884S_SETTINGS} from '../../src/helpers/fix-constants.js';

// B-31: a Melinda f884 (tag 884, $5 MELINDA, $a + $g present) that has
// NO $k subfield. In fix-strip-f884s.js, findSource/findHash then call
// `sfK.replace(...)` on undefined (fix-strip-f884s.js:177/189) and
// fixRecord throws a TypeError instead of handling the missing $k.
test('B-31: fixRecord throws TypeError for Melinda f884 without $k subfield', () => {
  const record = new MarcRecord({
    leader: '03085cam a22006858i 4500',
    fields: [
      {tag: '001', value: '000000001'},
      {tag: '003', value: 'FI-MELINDA'},
      {tag: '005', value: '20220818041047.0'},
      {
        // Melinda f884 WITHOUT $k
        tag: '884',
        ind1: ' ',
        ind2: ' ',
        subfields: [
          {code: 'a', value: 'ONIX3 to MARC transformation'},
          {code: 'g', value: '20220101'},
          {code: '5', value: 'MELINDA'}
        ]
      },
      {
        // A second Melinda f884 with $k so that the
        // "not enough Melinda f884s" early return does not trigger
        tag: '884',
        ind1: ' ',
        ind2: ' ',
        subfields: [
          {code: 'a', value: 'ONIX3 to MARC transformation'},
          {code: 'g', value: '20000718'},
          {
            code: 'k',
            value: 'SRC_4:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
          },
          {code: '5', value: 'MELINDA'}
        ]
      }
    ]
  }, {subfieldValues: false});

  // Documents current buggy behaviour: crash instead of graceful handling
  assert.throws(
    () => fixRecord(record, BIB_STRIP_F884S_SETTINGS),
    {
      name: 'TypeError',
      message: "Cannot read properties of undefined (reading 'replace')"
    }
  );
});
