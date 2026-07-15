const fs = require('fs');
const path = require('path');

const fileArg = process.argv[2];
const filePath = fileArg ? path.resolve(fileArg) : path.resolve(__dirname, 'test_results.json');

function readJson(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to read or parse JSON file: ${file}`);
    console.error(err.message);
    process.exit(1);
  }
}

function buildSummary(results) {
  if (results.summary && Object.keys(results.summary).length > 0) {
    return results.summary;
  }

  const keyFunctions = [
    'register_user',
    'register_energy_measurement',
    'create_energy_offer',
    'create_energy_demand',
    'execute_automatic_matching',
    'execute_optimized_matching',
    'deposit_funds',
  ];

  const summary = {};
  for (const tx of results.transactions || []) {
    if (!tx.label) continue;
    const label = tx.label.toLowerCase();
    for (const fn of keyFunctions) {
      if (label.includes(fn)) {
        if (!summary[fn]) summary[fn] = [];
        summary[fn].push(tx);
        break;
      }
    }
  }
  return summary;
}

function formatNumber(value, digits = 2) {
  if (value === undefined || value === null || Number.isNaN(value)) return 'N/A';
  if (typeof value === 'number') return value.toFixed(digits);
  if (typeof value === 'bigint') return value.toString();
  return Number(value).toFixed(digits);
}

function parseNumber(value) {
  if (value === undefined || value === null) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function summarize(summary) {
  const rows = [];
  for (const [fn, entries] of Object.entries(summary)) {
    if (!entries.length) continue;
    const gasValues = entries
      .map(e => parseNumber(e.gas ?? e.gas_l2))
      .filter(v => v !== null);
    const feeValues = entries
      .map(e => parseNumber(e.actual_fee_strk ?? e.fee_strk))
      .filter(v => v !== null);
    const latValues = entries
      .map(e => parseNumber(e.lat ?? e.latency_s))
      .filter(v => v !== null);
    const count = entries.length;
    const totalGas = gasValues.reduce((sum, v) => sum + v, 0);
    const totalFee = feeValues.reduce((sum, v) => sum + v, 0);
    const totalLat = latValues.reduce((sum, v) => sum + v, 0);
    const avgGas = gasValues.length ? totalGas / gasValues.length : 0;
    const avgFee = feeValues.length ? totalFee / feeValues.length : 0;
    const avgLat = latValues.length ? totalLat / latValues.length : 0;
    const sampleHash = entries.find(e => e.hash || e.tx_hash)?.hash
      || entries.find(e => e.hash || e.tx_hash)?.tx_hash
      || 'N/A';

    rows.push({
      function: fn,
      count,
      avgGas,
      avgFee,
      avgLatency: avgLat
    });
  }
  return rows;
}

function printTable(rows) {
  if (!rows.length) {
    console.log('No metrics found in the summary.');
    return;
  }

  const headers = ['Function', 'Count', 'Avg Gas', 'Avg Fee (STRK)', 'Avg Latency (s)'];
  const colWidths = headers.map(h => h.length);

  for (const row of rows) {
    const gasStr = row.avgGas ? Math.round(row.avgGas).toLocaleString() : 'N/A';
    
    colWidths[0] = Math.max(colWidths[0], String(row.function).length);
    colWidths[1] = Math.max(colWidths[1], String(row.count).length);
    colWidths[2] = Math.max(colWidths[2], gasStr.length); 
    colWidths[3] = Math.max(colWidths[3], String(formatNumber(row.avgFee, 6)).length);
    colWidths[4] = Math.max(colWidths[4], String(formatNumber(row.avgLatency)).length);
  }

  const pad = (value, width) => String(value).padEnd(width, ' ');
  const headerLine = headers.map((h, i) => pad(h, colWidths[i])).join(' | ');
  const separator = colWidths.map(w => '-'.repeat(w)).join('-|-');

  console.log(headerLine);
  console.log(separator);
  for (const row of rows) {
    const gasStr = row.avgGas ? Math.round(row.avgGas).toLocaleString() : 'N/A';

    const line = [
      pad(row.function, colWidths[0]),
      pad(row.count, colWidths[1]),
      pad(gasStr, colWidths[2]), 
      pad(formatNumber(row.avgFee, 6), colWidths[3]),
      pad(formatNumber(row.avgLatency), colWidths[4]),
    ].join(' | ');
    console.log(line);
  }
}

const results = readJson(filePath);
const summary = buildSummary(results);
const rows = summarize(summary);
printTable(rows);

console.log(`\nSource file: ${filePath}`);