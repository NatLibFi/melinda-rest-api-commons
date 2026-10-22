import createDebugLogger from 'debug';
import type {MarcField, MarcRecord} from '@natlibfi/marc-record';

const debug = createDebugLogger('@natlibfi/melinda-rest-api-commons:fixRecord:handleTempUrns');
const debugData = debug.extend('data');

/**
 * Handle temporary URNs in f856s: remove temp URN fields when an existing
 * legal deposit URN exists, or strip the temp subfields from the temp URN
 */
export function handleTempUrns(newRecord: MarcRecord, options: boolean | undefined): MarcRecord {

  if (options !== true) {
    debug(`NOT running handleTempUrns fixer, no options`);
    return newRecord;
  }

  debug(`Running handleTempUrns fixer`);
  debugData(`Options for handleTempUrns: ${JSON.stringify(options)}`);

  const {f856sUrnsWithTempSubfields, f856sUrnsWithNoTempSubfields} = getf856sUrns(newRecord);

  // None of the URNs has temp subfields, we don't need to do anything
  if (f856sUrnsWithTempSubfields.length < 1) {
    debug(`No Urns with temp subfield`);
    return newRecord;
  }

  // Do we have an existing URN with legal deposit subfields, if we have, we can remove the temp URN field(s)
  const existingLegalDepositURN = validateLD(f856sUrnsWithNoTempSubfields);
  debug(`existingLegalDepositURN: ${existingLegalDepositURN}`);

  if (existingLegalDepositURN) {
    debug(`We have an existing LD URN, we can delete temp fields (${f856sUrnsWithTempSubfields.length})`);
    newRecord.removeFields(f856sUrnsWithTempSubfields);
    return newRecord;
  }

  // We do not have an existing legalDepositURN, we should use the tempURN and remove the temp subfields from it
  if (!existingLegalDepositURN && f856sUrnsWithTempSubfields.length > 0) {
    //debug(`All Urns (${f856sUrn.length}) have a temp subfield`);
    debugData(`Original temp URNs: (${JSON.stringify(f856sUrnsWithTempSubfields)})`);
    const fixedFields = f856sUrnsWithTempSubfields.map(removeTempSubfield).filter((field): field is MarcField => field !== false);
    debug(`We removed temp subfields: (${JSON.stringify(fixedFields)})`);
    newRecord.removeFields(f856sUrnsWithTempSubfields);
    newRecord.insertFields(fixedFields);
    return newRecord;
  }
  // Should we check that the non-temp URN has 2nd ind '0' - meaning that the URN handles the actual resource itself?
  return newRecord;
}

// Split the f856 URN fields into the ones with / without temp subfields
function getf856sUrns(newRecord: MarcRecord): {f856sUrn: MarcField[], f856sUrnsWithTempSubfields: MarcField[], f856sUrnsWithNoTempSubfields: MarcField[]} {
  const hasURN = (f: MarcField): boolean => f.tag === '856' && f.subfields.some(({code, value}) => code === 'u' && (/urn.fi/u).test(value as string));

  const hasTempSubfield = (f: MarcField): boolean => f.subfields.some(({code, value}) => code === '9' && (/^MELINDA<TEMP>$/u).test(value as string));
  const hasNoTempSubfield = (f: MarcField): boolean => !f.subfields.some(({code, value}) => code === '9' && (/^MELINDA<TEMP>$/u).test(value as string));

  // newRecord.fields is the control/data field union; the JSDoc baseline
  // cast to MarcField[] is kept so the runtime behavior is unchanged
  const f856sUrn = (newRecord.fields as MarcField[]).filter(hasURN);
  const f856sUrnsWithTempSubfields = f856sUrn.filter(hasTempSubfield);
  const f856sUrnsWithNoTempSubfields = f856sUrn.filter(hasNoTempSubfield);

  debugData(`URN f856s: ${JSON.stringify(f856sUrn)}`);
  debugData(`URN f856s with temp subfield: ${JSON.stringify(f856sUrnsWithTempSubfields)}`);
  return {f856sUrn, f856sUrnsWithTempSubfields, f856sUrnsWithNoTempSubfields};
}

// ---- LD-functions below are same as in https://github.com/NatLibFi/marc-record-validators-melinda/blob/feature-updates-to-urn/src/urn.js
// we propably should develop the urn/legaldeposit -validator to use also here

// Check that at least one f856 URN has the legal deposit subfields
function validateLD(f856sUrn: MarcField[]): boolean {
  debug(`Validating the existence of legal deposit subfields`);

  const LD_SUBFIELDS_OLD: {code: string, value: string}[] = [
    {code: 'z', value: 'Käytettävissä vapaakappalekirjastoissa'},
    {code: '5', value: 'FI-Vapaa'}
  ];

  const LD_SUBFIELDS_NEW: {code: string, value: string}[] = [
    {code: 'z', value: 'Käytettävissä vapaakappaletyöasemilla'},
    {code: '5', value: 'FI-Vapaa'}
  ];

  const f856sUrnWithOldLdSubfields = f856sUrn.filter(field => fieldHasLDSubfields(field, LD_SUBFIELDS_OLD));
  const f856sUrnWithNewLdSubfields = f856sUrn.filter(field => fieldHasLDSubfields(field, LD_SUBFIELDS_NEW));
  const f856sUrnWithLdSubfields = [...f856sUrnWithNewLdSubfields, ...f856sUrnWithOldLdSubfields];

  if (f856sUrnWithLdSubfields.length > 0) {
    debug(`Record has ${f856sUrnWithLdSubfields.length} URN fields with all necessary legal deposit subfields`);
    debugData(`f856sUrnWithLdSubfields: ${JSON.stringify(f856sUrnWithLdSubfields)}`);
    return true;
  }
  return false;
}

function fieldHasLDSubfields(field: MarcField, ldSubfields: {code: string, value: string}[]): boolean {
  if (ldSubfields.every(ldsf => field.subfields.some(sf => sf.code === ldsf.code && sf.value === ldsf.value))) {
    return true;
  }
  return false;
}

// Remove the temp subfields from a f856 field
// the field without temp subfields, or false when no subfields remain
function removeTempSubfield(field: MarcField): MarcField | false {

  // Handle non-numeric fields, and fields with a numeric tag of 010 and greater
  // Aleph's FMT as a controlfield might be a problem
  if (!isNaN(Number(field.tag)) && parseInt(field.tag, 10) >= 10) {

    const filteredSubfields = field.subfields.filter(sf => sf.code !== '9' && !(/^MELINDA<TEMP>$/u).test(sf.value as string));

    // Remove whole field if there are no subfields left
    if (filteredSubfields.length < 1) {
      return false;
    }

    return {
      tag: field.tag,
      ind1: field.ind1,
      ind2: field.ind2,
      subfields: filteredSubfields
    };
  }
  // return controlFields as is
  return field;
}
