function computeChecksum(line) {
  let sum = 0;
  for (let i = 0; i < 68; i++) {
    const char = line[i];
    if (char >= '0' && char <= '9') {
      sum += parseInt(char, 10);
    } else if (char === '-') {
      sum += 1;
    }
  }
  return sum % 10;
}

function formatEpoch(isoString) {
  const date = new Date(isoString);
  const year = date.getUTCFullYear();
  const startOfYear = new Date(Date.UTC(year, 0, 1));
  const diffMs = date.getTime() - startOfYear.getTime();
  const days = (diffMs / (1000 * 60 * 60 * 24)) + 1;
  const yy = String(year).slice(-2);
  const ddd = String(days.toFixed(8)).padStart(12, '0');
  return `${yy}${ddd}`;
}

function formatBstar(bstar) {
  if (bstar === 0) return " 00000-0";
  const str = bstar.toExponential(4).toUpperCase(); // e.g., 9.1313E-6
  let [mantissa, exponent] = str.split('E');
  mantissa = mantissa.replace('.', '').slice(0, 5).padEnd(5, '0'); // e.g. 91313
  let exp = parseInt(exponent, 10) + 1;
  return `${bstar > 0 ? ' ' : '-'}${mantissa}${exp >= 0 ? '+' : '-'}${Math.abs(exp)}`;
}

console.log(formatEpoch("2026-08-16T06:58:42.101184"));
console.log(formatBstar(0.000009131353));
