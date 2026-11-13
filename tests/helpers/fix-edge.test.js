// Edge-case tests for the MARC fix helpers.

import assert from 'node:assert';
import {test} from 'node:test';
import {MarcRecord} from '@natlibfi/marc-record';
import {fixRecord} from '../../src/helpers/fix.js';
import {BIB_STRIP_F884S_SETTINGS} from '../../src/helpers/fix-constants.js';

// a Melinda f884 (tag 884, $5 MELINDA, $a + $g present) that
// has NO $k subfield. findSource/findHash used to call `sfK.replace(...)` on
// undefined and crash the whole fixRecord call. Now a missing $k is treated
// as an empty string: the field gets NO_SOURCE (source) and the all-zero
// sentinel (hash), and the merged date range is applied to its $g.
test('fixRecord handles Melinda f884 without $k subfield without crashing', () => {
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

  // Fixed behaviour: fixRecord must not throw
  const result = fixRecord(record, BIB_STRIP_F884S_SETTINGS);

  // Both Melinda f884s survive (they are not identical, so uniq keeps both)
  const f884s = result.fields.filter((f) => f.tag === '884');
  assert.equal(f884s.length, 2);

  // The field WITHOUT $k still has its $a, $g and $5 MELINDA
  const noK = f884s.find((f) => !f.subfields.some((s) => s.code === 'k'));
  assert.ok(noK, 'field without $k should survive');
  assert.deepEqual(
    noK.subfields.map((s) => s.code).sort(),
    ['5', 'a', 'g']
  );
  const gNoK = noK.subfields.find((s) => s.code === 'g').value;
  const aNoK = noK.subfields.find((s) => s.code === 'a').value;
  assert.equal(aNoK, 'ONIX3 to MARC transformation');
  assert.equal(gNoK, '20220101');

  // The field WITH $k keeps its $a, $g, $k and $5 MELINDA
  const withK = f884s.find((f) => f.subfields.some((s) => s.code === 'k'));
  assert.ok(withK, 'field with $k should survive');
  assert.deepEqual(
    withK.subfields.map((s) => s.code).sort(),
    ['5', 'a', 'g', 'k']
  );
  assert.equal(withK.subfields.find((s) => s.code === 'g').value, '20000718');
  assert.equal(withK.subfields.find((s) => s.code === 'k').value,
    'SRC_4:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
});
