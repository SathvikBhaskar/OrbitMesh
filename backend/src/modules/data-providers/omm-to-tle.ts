/**
 * Utility functions to convert OMM JSON elements to standard Two-Line Element (TLE) strings.
 * This is retained as a compatibility layer for OrbitMesh's underlying satellite.js engine
 * which currently relies on TLE format.
 */

export function computeChecksum(line: string): number {
  let sum = 0;
  for (let i = 0; i < 68; i++) {
    const char = line[i];
    if (char && char >= '0' && char <= '9') {
      sum += parseInt(char, 10);
    } else if (char === '-') {
      sum += 1;
    }
  }
  return sum % 10;
}

export function formatEpoch(isoString: string): string {
  const utcString = isoString.endsWith('Z') ? isoString : `${isoString}Z`;
  const date = new Date(utcString);
  const year = date.getUTCFullYear();
  const startOfYear = new Date(Date.UTC(year, 0, 1));
  const diffMs = date.getTime() - startOfYear.getTime();
  const days = (diffMs / (1000 * 60 * 60 * 24)) + 1;
  const yy = String(year).slice(-2);
  const ddd = days.toFixed(8).padStart(12, '0');
  return `${yy}${ddd}`;
}

export function formatBstar(bstar: number): string {
  if (bstar === 0) return " 00000-0";
  const str = bstar.toExponential(4).toUpperCase();
  let [mantissa, exponent] = str.split('E');
  if (!mantissa || !exponent) return " 00000-0";
  
  mantissa = mantissa.replace('.', '').slice(0, 5).padEnd(5, '0');
  let exp = parseInt(exponent, 10) + 1;
  return `${bstar > 0 ? ' ' : '-'}${mantissa}${exp >= 0 ? '+' : '-'}${Math.abs(exp)}`;
}

export function ommToTleLine1(omm: any): string {
  const noradId = String(omm.NORAD_CAT_ID || "").padStart(5, '0');
  const classification = omm.CLASSIFICATION_TYPE || "U";
  
  let intlDesig = String(omm.OBJECT_ID || "");
  // Convert YYYY-NNNA to YYNNNA (e.g. 2005-049B -> 05049B)
  if (intlDesig.length >= 9 && intlDesig.includes('-')) {
    const parts = intlDesig.split('-');
    if (parts.length === 2 && parts[0]?.length === 4) {
      intlDesig = parts[0].slice(2) + parts[1];
    }
  }
  intlDesig = intlDesig.padEnd(8, ' ');
  
  const epoch = formatEpoch(omm.EPOCH).padEnd(14, ' ');
  
  // MEAN_MOTION_DOT and DDOT are rarely used for most standard propagation but we keep format
  // For simplicity, we can default them to 0s if they are extremely small or not provided correctly
  let nDot = String(omm.MEAN_MOTION_DOT || "0");
  if (!nDot.startsWith('-')) nDot = ' ' + nDot;
  if (nDot.startsWith(' 0.')) nDot = '  .' + nDot.slice(3);
  if (nDot.startsWith('-0.')) nDot = '- .' + nDot.slice(3);
  nDot = nDot.padEnd(10, ' ').slice(0, 10);

  const nDDot = " 00000-0"; 
  const bstar = formatBstar(omm.BSTAR || 0);
  const ephemeris = String(omm.EPHEMERIS_TYPE || "0");
  const elementSet = String(omm.ELEMENT_SET_NO || "999").padStart(4, ' ');

  let line1 = `1 ${noradId}${classification} ${intlDesig} ${epoch} ${nDot} ${nDDot} ${bstar} ${ephemeris} ${elementSet}`;
  line1 = line1.padEnd(68, ' ');
  return line1 + computeChecksum(line1);
}

export function ommToTleLine2(omm: any): string {
  const noradId = String(omm.NORAD_CAT_ID || "").padStart(5, '0');
  const incl = Number(omm.INCLINATION || 0).toFixed(4).padStart(8, ' ');
  const raan = Number(omm.RA_OF_ASC_NODE || 0).toFixed(4).padStart(8, ' ');
  const ecc = Number(omm.ECCENTRICITY || 0).toFixed(7).replace('0.', '').padStart(7, '0');
  const argp = Number(omm.ARG_OF_PERICENTER || 0).toFixed(4).padStart(8, ' ');
  const ma = Number(omm.MEAN_ANOMALY || 0).toFixed(4).padStart(8, ' ');
  const mm = Number(omm.MEAN_MOTION || 0).toFixed(8).padStart(11, ' ');
  const rev = String(omm.REV_AT_EPOCH || 0).padStart(5, ' ');

  let line2 = `2 ${noradId} ${incl} ${raan} ${ecc} ${argp} ${ma} ${mm}${rev}`;
  line2 = line2.padEnd(68, ' ');
  return line2 + computeChecksum(line2);
}
