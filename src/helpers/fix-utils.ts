import type {MarcControlField, MarcField} from '@natlibfi/marc-record';

type AnyField = MarcControlField | MarcField;

/**
 * Remove a subfield code from a field; drops the field when no subfields remain
 * returns the field, with the subfield removed, or false
 */
export function removeSubfield(field: AnyField, code: string): AnyField | false {

  // Handle non-numeric fields, and fields with a numeric tag of 010 and greater
  // Aleph's FMT as a controlfield might be a problem
  if (!isNaN(Number(field.tag)) && parseInt(field.tag, 10) >= 10) {

    const dataField = field as MarcField;
    const filteredSubfields = dataField.subfields.filter(sf => sf.code !== code);

    // Remove whole field if there are no subfields left
    if (filteredSubfields.length < 1) {
      return false;
    }

    return {
      tag: dataField.tag,
      ind1: dataField.ind1,
      ind2: dataField.ind2,
      subfields: filteredSubfields
    };
  }
  // return controlFields as is
  return field;
}


// sort fields by value of each fields first subfield with subfielCode
export function sortFieldsBySubfieldValue(fields: AnyField[], subfieldCode: string): AnyField[] {
  return [...fields].sort((a, b) => {
    const a1value = getFirstSubfieldValue(a, subfieldCode);
    const b1value = getFirstSubfieldValue(b, subfieldCode);
    if (a1value && !b1value) {
      return -1;
    }
    if (!a1value && b1value) {
      return 1;
    }
    if (a1value > b1value) {
      return 1;
    }
    if (b1value > a1value) {
      return -1;
    }
    return 0;
  });
  // get value for the for instance of subfield with subfieldCode
  function getFirstSubfieldValue(field: AnyField, subfieldCode: string): string {
    const dataField = field as MarcField;
    const subs = dataField.subfields ? dataField.subfields.filter(subf => subf.code === subfieldCode) : [];
    return subs.length > 0 ? subs[0]?.value ?? '' : '';
  }
}
