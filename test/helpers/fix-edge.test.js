// Edge-case tests for the MARC fix helpers.

import assert from 'node:assert';
import {test} from 'node:test';
import {MarcRecord} from '@natlibfi/marc-record';
import {fixRecord} from '../../src/helpers/fix.js';
import {BIB_STRIP_F884S_SETTINGS, BIB_F035_TO_SID} from '../../src/helpers/fix-constants.js';

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
  const f884s = /** @type {import("@natlibfi/marc-record").MarcField[]} */ (result.fields).filter((f) => f.tag === '884');
  assert.equal(f884s.length, 2);

  // The field WITHOUT $k still has its $a, $g and $5 MELINDA
  const noK = f884s.find((f) => !f.subfields.some((s) => s.code === 'k'));
  assert.ok(noK, 'field without $k should survive');
  assert.deepEqual(
    noK.subfields.map((s) => s.code).sort(),
    ['5', 'a', 'g']
  );
  const gNoK = (/** @type {*} */ (noK.subfields.find((s) => s.code === 'g'))).value;
  const aNoK = (/** @type {*} */ (noK.subfields.find((s) => s.code === 'a'))).value;
  assert.equal(aNoK, 'ONIX3 to MARC transformation');
  assert.equal(gNoK, '20220101');

  // The field WITH $k keeps its $a, $g, $k and $5 MELINDA
  const withK = f884s.find((f) => f.subfields.some((s) => s.code === 'k'));
  assert.ok(withK, 'field with $k should survive');
  assert.deepEqual(
    withK.subfields.map((s) => s.code).sort(),
    ['5', 'a', 'g', 'k']
  );
  assert.equal((/** @type {*} */ (withK.subfields.find((s) => s.code === 'g'))).value, '20000718');
  assert.equal((/** @type {*} */ (withK.subfields.find((s) => s.code === 'k'))).value,
    'SRC_4:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
});

// stripF884s early return: fewer than 2 Melinda f884s (0 or 1) means the
// record is returned unchanged (the merge/uniq pipeline never runs).
test('stripF884s returns the record unchanged when it has no Melinda f884s', () => {
  const record = new MarcRecord({
    leader: '03085cam a22006858i 4500',
    fields: [
      {tag: '001', value: '000000001'},
      {tag: '035', ind1: ' ', ind2: ' ', subfields: [{code: 'a', value: '(FI-BTJ)12345'}]}
    ]
  }, {subfieldValues: false});

  const result = fixRecord(record, BIB_STRIP_F884S_SETTINGS);
  assert.deepStrictEqual(result, record.toObject());
});

test('stripF884s returns the record unchanged when it has a single Melinda f884', () => {
  const record = new MarcRecord({
    leader: '03085cam a22006858i 4500',
    fields: [
      {tag: '001', value: '000000001'},
      {
        // a single Melinda f884: fewer than 2, so the field must survive
        // untouched (no date-range merge, no removeFields/insertFields)
        tag: '884',
        ind1: ' ',
        ind2: ' ',
        subfields: [
          {code: 'a', value: 'ONIX3 to MARC transformation'},
          {code: 'g', value: '20220101'},
          {
            code: 'k',
            value: 'SRC_4:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
          },
          {code: '5', value: 'MELINDA'}
        ]
      }
    ]
  }, {subfieldValues: false});

  const result = fixRecord(record, BIB_STRIP_F884S_SETTINGS);
  assert.deepStrictEqual(result, record.toObject());
});

// generateMissingSIDs: an existing SID field is only counted when its $b is
// in fSIDFilters AND it has a $c. Anything else maps to undefined and is
// filtered out, so the SID is (re)generated from the f035.
test('fixRecord ignores an existing SID field whose $b is not in fSIDFilters and generates the SID from the f035', () => {
  const record = new MarcRecord({
    leader: '03085cam a22006858i 4500',
    fields: [
      {tag: '001', value: '000000001'},
      {tag: '035', ind1: ' ', ind2: ' ', subfields: [{code: 'a', value: '(FI-BTJ)12345'}]},
      {
        // $b 'FI-KV' is NOT in fSIDFilters -> the field must be ignored,
        // so the f035 (FI-BTJ)12345 still yields a generated SID
        tag: 'SID',
        ind1: ' ',
        ind2: ' ',
        subfields: [
          {code: 'c', value: '12345'},
          {code: 'b', value: 'FI-KV'}
        ]
      }
    ]
  }, {subfieldValues: false});

  const result = fixRecord(record, {generateMissingSIDs: BIB_F035_TO_SID});
  const sids = /** @type {import("@natlibfi/marc-record").MarcField[]} */ (result.fields).filter((f) => f.tag === 'SID');
  assert.equal(sids.length, 2);
  const generated = sids.find((f) => f.subfields.some((s) => s.code === 'b' && s.value === 'FI-BTJ'));
  assert.ok(generated, 'a new SID with $b FI-BTJ should have been generated');
  assert.equal((/** @type {*} */ (generated.subfields.find((s) => s.code === 'c'))).value, '12345');
});

test('fixRecord ignores an existing SID field with a matching $b but missing $c and generates the SID from the f035', () => {
  const record = new MarcRecord({
    leader: '03085cam a22006858i 4500',
    fields: [
      {tag: '001', value: '000000001'},
      {tag: '035', ind1: ' ', ind2: ' ', subfields: [{code: 'a', value: '(FI-BTJ)12345'}]},
      {
        // $b 'FI-BTJ' IS in fSIDFilters, but there is no $c -> the field
        // must be ignored, so the f035 still yields a generated SID
        tag: 'SID',
        ind1: ' ',
        ind2: ' ',
        subfields: [
          {code: 'b', value: 'FI-BTJ'}
        ]
      }
    ]
  }, {subfieldValues: false});

  const result = fixRecord(record, {generateMissingSIDs: BIB_F035_TO_SID});
  const sids = /** @type {import("@natlibfi/marc-record").MarcField[]} */ (result.fields).filter((f) => f.tag === 'SID');
  assert.equal(sids.length, 2);
  const generated = sids.find((f) => f.subfields.some((s) => s.code === 'c'));
  assert.ok(generated, 'a generated SID with $c should exist');
  assert.equal((/** @type {*} */ (generated.subfields.find((s) => s.code === 'b'))).value, 'FI-BTJ');
  assert.equal((/** @type {*} */ (generated.subfields.find((s) => s.code === 'c'))).value, '12345');
});

test('fixRecord adds no SID when the f035 $a matches no f035Filter', () => {
  const record = new MarcRecord({
    leader: '03085cam a22006858i 4500',
    fields: [
      {tag: '001', value: '000000001'},
      // $a does not match any f035Filter in BIB_F035_TO_SID, so
      // f035ToSidInfo maps the field to undefined and nothing is generated
      {tag: '035', ind1: ' ', ind2: ' ', subfields: [{code: 'a', value: '(NOT-IN-FILTERS)999'}]}
    ]
  }, {subfieldValues: false});

  const result = fixRecord(record, {generateMissingSIDs: BIB_F035_TO_SID});
  assert.equal(result.fields.filter((f) => f.tag === 'SID').length, 0);
});
