export function removeSubfield(field, code) {

  // Handle non-numeric fields, and fields with a numeric tag of 010 and greater
  // Aleph's FMT as a controlfield might be a problem
  if (!isNaN(field.tag) && parseInt(field.tag, 10) >= 10) {

    const filteredSubfields = field.subfields.filter(sf => sf.code !== code);

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


// sort fields by value of each fields first subfield with subfielCode
export function sortFieldsBySubfieldValue(fields, subfieldCode) {
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
  function getFirstSubfieldValue(field, subfieldCode) {
    const subs = field.subfields ? field.subfields.filter(subf => subf.code === subfieldCode) : [];
    return subs.length > 0 ? subs[0].value : '';
  }
}
