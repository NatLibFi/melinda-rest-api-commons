import createDebugLogger from 'debug';
//import {sortFieldsBySubfieldValue, removeSubfield} from './fix-utils';
import type {MarcField, MarcRecord} from '@natlibfi/marc-record';
import {inspect} from 'util';

/**
 * A conversion:source result collected from the Melinda f884s
 */
export interface F884Result {
  conversion: string | undefined;
  source: string;
  firstDate: string;
  lastDate: string;
  hash: string;
}

/**
 * Strip the redundant Melinda f884s from a record, keeping one
 * conversion:source combination per pair with edited $g/$k subfields
 */
export function stripF884s(newRecord: MarcRecord, options: boolean | undefined): MarcRecord {
  const debug = createDebugLogger('@natlibfi/melinda-rest-api-commons:fixRecord:stripF884s');
  const debugData = debug.extend('data');

  if (options !== true) {
    debug(`NOT running stripF884s fixer, no options`);
    return newRecord;
  }

  debug(`Running stripF884s fixer`);
  debugData(`Options for stripF884s: ${JSON.stringify(options)}`);

  // Handle only f884 with $5 MELINDA - let's no remove random f884s
  const isMelindaf884 = (f: MarcField): boolean => f.tag === '884' && f.subfields.some(({code, value}) => code === '5' && value === 'MELINDA');

  // newRecord.fields is the control/data field union; the JSDoc baseline
  // cast to MarcField[] is kept so the runtime behavior is unchanged
  const f884Melindas = (newRecord.fields as MarcField[]).filter(isMelindaf884);
  debugData(`Melinda's f884s (${f884Melindas.length}) \n ${JSON.stringify(f884Melindas)}`);
  //debugData(`Melinda's f884s (${f884Melindas.length}) \n ${inspect(f884Melindas, {depth: 3})}`);

  if (f884Melindas.length < 2) {
    debug(`Not enough Melinda's f884s to filter (${f884Melindas.length})`);
    return newRecord;
  }

  // Pick data (firstDate, lastDate, hash with latest date) for all conversion : source combinations
  const results = f884Melindas.reduce(
    (allResults: Record<string, F884Result>, f884: MarcField, index: number): Record<string, F884Result> => {
    debugData(`All results: ${JSON.stringify(allResults)}`);
    //debugData(`Handling field (${index}): ${inspect(f884, {depth: 3})}`);
    debugData(`Handling field *(${index})*: ${JSON.stringify(f884)}`);

    const conversion = findConversion(f884);
    const source = findSource(f884);
    const convSource = `${conversion}:${source}`;
    const {firstDate, lastDate} = findDates(f884);
    const hash = findHash(f884);

    // Find currently existing data for conversion : source combination
    const currResult = allResults[convSource];
    debugData(JSON.stringify(currResult));

    // If we do not have any current data, add data from field
    if (!currResult) {
      debug(`Add a new convSource ${convSource} to results`);
      const newResult: F884Result = {
        conversion,
        source,
        firstDate,
        lastDate,
        hash
      };
      debugData(`- New result: ${JSON.stringify(newResult)}`);
      return {
        ...allResults,
        [convSource]: newResult
      };
    }
    // If we have current data, update it from the data from field, if needed
    debug(`Update result for ${convSource}`);
    debugData(`- Current result: ${JSON.stringify(currResult)}`);

    // '00000000' is the deliberate no-date sentinel for a missing $g (see
    // findDates): it must never win a date comparison, and both sides must
    // agree on this sentinel
    const updatedResult: F884Result = {
      ...currResult,
      firstDate: currResult.firstDate > firstDate && firstDate !== '00000000' ? firstDate : currResult.firstDate,
      lastDate: currResult.lastDate < lastDate ? lastDate : currResult.lastDate,
      hash: currResult.lastDate < lastDate && lastDate !== '00000000' && hash !== '0000000000000000000000000000000000000000000000000000000000000000' ? hash : currResult.hash
    };
    debugData(`- Updated result: ${JSON.stringify(updatedResult)}`);
    return {
      ...allResults,
      [convSource]: updatedResult
    };
    },
    {} as Record<string, F884Result>);

  debugData(`RESULTS: ${JSON.stringify(results)}`);
  const editedf884s = editFields(f884Melindas, results);

  debug(`Edited fields (${editedf884s.length})`);
  //debugData(inspect(editedf884s, {depth: 3}));
  debugData(`${JSON.stringify(editedf884s)}`);

  // We update each field based on the results we got from fields
  // Note: we do not add $g:s or $k:s if the field doesn't have them
  function editFields(fields: MarcField[], results: Record<string, F884Result>): MarcField[] {
    debug(`EDITING FIELDS (${fields.length})`);
    const editedFields = fields.map((field) => {
      const convSource = `${findConversion(field)}:${findSource(field)}`;
      debug(`Looking for: ${convSource}`);

      if (convSource && results[convSource]) {
        debugData(`Found: ${JSON.stringify(results[convSource])}`);
        const firstDate = results[convSource].firstDate && results[convSource].firstDate !== '00000000' ? results[convSource].firstDate : '';
        const lastDate = results[convSource].lastDate && results[convSource].lastDate !== '00000000' ? results[convSource].lastDate : '';

        const source = results[convSource].source && results[convSource].source !== 'NO_SOURCE' ? results[convSource].source : '';
        const hash = results[convSource].hash && results[convSource].hash !== '0000000000000000000000000000000000000000000000000000000000000000' ? results[convSource].hash : '';

        const sfGAll = firstDate === lastDate ? `${firstDate}` : `${firstDate} - ${lastDate}`;
        debugData(`EditedDates: ${sfGAll}`);
        const sfKAll = `${source}:${hash}`;

        const sfG = sfGAll.replace(/^ - /u, '').replace(/ - $/u, '');
        const sfK = sfKAll.replace(/^:/u, '').replace(/:$/u, '');

        return {
          ...field,
          subfields: field.subfields.map(subfield => {

            // we don't get $g or $k if the original field doesn't have them
            if (subfield.code === 'g') {
              return {
                code: subfield.code,
                value: sfG
              };
            }

            if (subfield.code === 'k') {
              return {
                code: subfield.code,
                value: sfK
              };
            }

            return subfield;
          })

        };
      }
      // Defensive: results is keyed from the same f884Melindas array, so
      // convSource is always present when truthy.
      debug(`Not found: ${convSource}`);
      return field;
    });
    return editedFields;
  }

  // we'll need to uniq these too

  const uniq884s = uniqFields(editedf884s);
  debug(`UniqFields (${uniq884s.length})`);
  debugData(inspect(uniq884s, {depth: 3}));


  // Canonicalize a raw field object ({tag, ind1, ind2, subfields: [...]}) so
  // that two structurally equal fields stringify identically: object keys are
  // sorted recursively, arrays keep their order, primitives pass through.
  function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map(canonicalize);
    }
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      // insertion order follows the sorted keys, as in the original reduce
      return Object.fromEntries(Object.keys(obj).sort().map(key => [key, canonicalize(obj[key])] as [string, unknown]));
    }
    return value;
  }

  function fieldsAreEqual(a: unknown, b: unknown): boolean {
    return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
  }

  function uniqFields(fields: MarcField[]): MarcField[] {
    const uniqed = fields.reduce((uniq: MarcField[], field: MarcField) => {
      if (!uniq.some(f => fieldsAreEqual(f, field))) {
        uniq.push(field);
      }

      return uniq;
    }, []);
    return uniqed;
  }
  // Replace original Melinda-f884s with remaining Melinda-f884s
  // NOTE: this sorts MELINDA-f884s after possible other f884s
  newRecord.removeFields(f884Melindas);
  newRecord.insertFields(uniq884s);

  return newRecord;


  // Find conversion:source pairs
  // Find first date
  // Find last date and last hash


  function findConversion(f884: MarcField): string | undefined {
    const [sfA] = f884.subfields.filter((subfield) => subfield.code === 'a').map(subfield => subfield.value);
    const conversion = sfA;
    debugData(`Conversion: "${conversion}"`);
    return conversion;
  }

  function findSource(f884: MarcField): string {
    const [sfK] = f884.subfields.filter((subfield) => subfield.code === 'k').map(subfield => subfield.value);
    // a Melinda f884 may have no $k subfield -> sfK is undefined
    const source = (sfK ?? '').replace(/:.*$/u, '');
    if (source && source.length !== 64) {
      debugData(`Source: "${source}"`);
      return source;
    }
    const emptySource = 'NO_SOURCE';
    debugData(`Source: "${emptySource}"`);
    return emptySource;
  }

  function findHash(f884: MarcField): string {
    const [sfK] = f884.subfields.filter((subfield) => subfield.code === 'k').map(subfield => subfield.value);
    // a Melinda f884 may have no $k subfield -> sfK is undefined
    const hash = (sfK ?? '').replace(/^.*:/u, '');
    if (hash && hash.length === 64) {
      debugData(`Hash: "${hash}"`);
      return hash;
    }
    const emptyHash = '0000000000000000000000000000000000000000000000000000000000000000';
    debugData(`Hash: "${emptyHash}"`);
    return emptyHash;
  }

  function findDates(f884: MarcField): {firstDate: string, lastDate: string} {
    const [sfG] = f884.subfields.filter((subfield) => subfield.code === 'g').map(subfield => subfield.value);
    if (sfG && (/ - /u).test(sfG)) {
      const firstDate = sfG.replace(/ - .*$/u, '').padStart(8, '0');
      const lastDate = sfG.replace(/^.* - /u, '').padStart(8, '0');
      debugData(`FirstDate: "${firstDate}", LastDate: "${lastDate}"`);
      return {firstDate, lastDate};
    }
    // '00000000' is the deliberate no-date sentinel for a missing $g; the
    // consumer side (updatedResult / editFields above) must keep agreeing on
    // this exact sentinel
    const firstDate = sfG ? sfG.padStart(8, '0') : '00000000';
    const lastDate = sfG ? sfG.padStart(8, '0') : '00000000';

    debugData(`FirstDate: "${firstDate}", LastDate: "${lastDate}"`);
    return {firstDate, lastDate};
  }

}
