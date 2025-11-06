import createDebugLogger from 'debug';
//import {sortFieldsBySubfieldValue, removeSubfield} from './fix-utils';
import {inspect} from 'util';
import {MarcRecord} from '@natlibfi/marc-record';

export function stripF884s(newRecord, options) {
  const debug = createDebugLogger('@natlibfi/melinda-rest-api-commons:fixRecord:stripF884s');
  const debugData = debug.extend('data');

  if (options !== true) {
    debug(`NOT running stripF884s fixer, no options`);
    return newRecord;
  }

  debug(`Running stripF884s fixer`);
  debugData(`Options for stripF884s: ${JSON.stringify(options)}`);

  // Handle only f884 with $5 MELINDA - let's no remove random f884s
  const isMelindaf884 = f => f.tag === '884' && f.subfields.some(({code, value}) => code === '5' && value === 'MELINDA');

  const f884Melindas = newRecord.fields.filter(isMelindaf884);
  debugData(`Melinda's f884s (${f884Melindas.length}) \n ${JSON.stringify(f884Melindas)}`);
  //debugData(`Melinda's f884s (${f884Melindas.length}) \n ${inspect(f884Melindas, {depth: 3})}`);

  if (f884Melindas.length < 2) {
    debug(`Not enough Melinda's f884s to filter (${f884Melindas.length})`);
    return newRecord;
  }

  // Pick data (firstDate, lastDate, hash with latest date) for all conversion : source combinations
  const results = f884Melindas.reduce((allResults, f884, index) => {
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
      const newResult = {
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

    const updatedResult = {
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
  }, {});

  debugData(`RESULTS: ${JSON.stringify(results)}`);
  const editedf884s = editFields(f884Melindas, results);

  debug(`Edited fields (${editedf884s.length})`);
  //debugData(inspect(editedf884s, {depth: 3}));
  debugData(`${JSON.stringify(editedf884s)}`);

  // We update each field based on the results we got from fields
  // Note: we do not add $g:s or $k:s if the field doesn't have them
  function editFields(fields, results) {
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
      debug(`Not found: ${convSource}`);
      return field;
    });
    return editedFields;
  }

  // we'll need to uniq these too

  const uniq884s = uniqFields(editedf884s);
  debug(`UniqFields (${uniq884s.length})`);
  debugData(inspect(uniq884s, {depth: 3}));


  function uniqFields(fields) {
    return fields.reduce((uniq, field) => {
      if (!uniq.some(f => MarcRecord.isEqual(f, field))) {
        uniq.push(field);
      }

      return uniq;
    }, []);
  }
  // Replace original Melinda-f884s with remaining Melinda-f884s
  // NOTE: this sorts MELINDA-f884s after possible other f884s
  newRecord.removeFields(f884Melindas);
  newRecord.insertFields(uniq884s);

  return newRecord;


  // Find conversion:source pairs
  // Find first date
  // Find last date and last hash


  function findConversion(f884) {
    const [sfA] = f884.subfields.filter((subfield) => subfield.code === 'a').map(subfield => subfield.value);
    const conversion = sfA;
    debugData(`Conversion: "${conversion}"`);
    return conversion;
  }

  function findSource(f884) {
    const [sfK] = f884.subfields.filter((subfield) => subfield.code === 'k').map(subfield => subfield.value);
    const source = sfK.replace(/:.*$/u, '');
    if (source && source.length !== 64) {
      debugData(`Source: "${source}"`);
      return source;
    }
    const emptySource = 'NO_SOURCE';
    debugData(`Source: "${emptySource}"`);
    return emptySource;
  }

  function findHash(f884) {
    const [sfK] = f884.subfields.filter((subfield) => subfield.code === 'k').map(subfield => subfield.value);
    const hash = sfK.replace(/^.*:/u, '');
    if (hash && hash.length === 64) {
      debugData(`Hash: "${hash}"`);
      return hash;
    }
    const emptyHash = '0000000000000000000000000000000000000000000000000000000000000000';
    debugData(`Hash: "${emptyHash}"`);
    return emptyHash;
  }

  function findDates(f884) {
    const [sfG] = f884.subfields.filter((subfield) => subfield.code === 'g').map(subfield => subfield.value);
    if (sfG && (/ - /u).test(sfG)) {
      const firstDate = sfG.replace(/ - .*$/u, '').padStart(8, '0');
      const lastDate = sfG.replace(/^.* - /u, '').padStart(8, '0');
      debugData(`FirstDate: "${firstDate}", LastDate: "${lastDate}"`);
      return {firstDate, lastDate};
    }
    const firstDate = sfG ? sfG.padStart(8, '0') : '00000000';
    const lastDate = sfG ? sfG.padStart(8, '0') : '00000000';

    debugData(`FirstDate: "${firstDate}", LastDate: "${lastDate}"`);
    return {firstDate, lastDate};
  }

}
