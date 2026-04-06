const { RpcProvider, Account, Contract, json, stark, CallData } = require("starknet");
const fs = require("fs");

const provider = new RpcProvider({ nodeUrl: "http://127.0.0.1:5050/rpc" });
const ACCOUNTS = [
  { address: "0x34ba56f92265f0868c57d3fe72ecab144fc96f97954bbbc4252cef8e8a979ba", pk: "0xb137668388dbe9acdfa3bc734cc2c469" },
  { address: "0x2939f2dc3f80cc7d620e8a86f2e69c1e187b7ff44b74056647368b5c49dc370", pk: "0xe8c2801d899646311100a661d32587aa" },
  { address: "0x25a6c9f0c15ef30c139065096b4b8e563e6b86191fd600a4f0616df8f22fb77", pk: "0x7b2e5d0e627be6ce12ddc6fd0f5ff2fb" },
  { address: "0x5e627ad77c89f728f67916e9362f0723aa9d5ecf9243b87da5551345eb0d11d", pk: "0x3bce0683ea650ed0271c9dd24c923142" },
  { address: "0x455fb718b603f851318bed2eb7c52647d7155ded0f06b74042f0178bf810c24", pk: "0x3b50445f14cdad0cfce66465332dde80" },
];

// Contract deployed in previous run
const contractAddress = "0x5681469e26e3e1eaa335047f4050b1f7bfd758f1cf85db6c55da28e0f73c523";

function acct(i) { return new Account(provider, ACCOUNTS[i].address, ACCOUNTS[i].pk); }

async function waitTx(hash) {
  let retries = 20;
  while (retries-- > 0) {
    try {
      const r = await provider.getTransactionReceipt(hash);
      if (r && r.execution_status) return r;
    } catch(e) {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`TX ${hash} timed out`);
}

async function call(label, acc, entrypoint, params = {}) {
  const t0 = Date.now();
  const res = await acc.execute([{ contractAddress, entrypoint, calldata: CallData.compile(params) }]);
  const receipt = await waitTx(res.transaction_hash);
  const lat = ((Date.now()-t0)/1000).toFixed(2);
  const gas = receipt.execution_resources?.sierra_gas || receipt.execution_resources?.l2_gas || receipt.execution_resources?.l1_gas || 0;
  const fee = receipt.actual_fee ? (Number(BigInt(receipt.actual_fee.amount)) / 1e18).toFixed(9) : "0";
  console.log(`  ${receipt.execution_status === 'SUCCEEDED' ? '✓' : '✗'} ${label}: gas=${gas.toLocaleString()}, fee=${fee} STRK, lat=${lat}s, hash=${res.transaction_hash.slice(0,14)}...`);
  return { gas, fee, lat, hash: res.transaction_hash, status: receipt.execution_status };
}

const metrics = [];

async function main() {
  console.log("=== Scenario 4: Multi-user concurrent matching ===");
  const G1 = acct(1); // Juan — needs more energy
  const G2 = acct(3);
  const C1 = acct(2); // Maria
  const C2 = acct(4);

  // Give G1 more energy first
  metrics.push({ label: "register_energy_measurement G1 fresh (10gen/2cons)", ...await call("register_energy_measurement G1 (10gen/2cons Esc4)", G1, "register_energy_measurement", { generated_kwh: 10n, consumed_kwh: 2n }) });
  
  // G1 creates offer 330 COP, G2 creates offer 340 COP
  metrics.push({ label: "create_energy_offer G1 (3kWh @ 330 Esc4)", ...await call("create_energy_offer G1 (3kWh @ 330 Esc4)", G1, "create_energy_offer", { amount_kwh: 3n, price_per_kwh: 330n }) });
  metrics.push({ label: "create_energy_offer G2 (3kWh @ 340 Esc4)", ...await call("create_energy_offer G2 (3kWh @ 340 Esc4)", G2, "create_energy_offer", { amount_kwh: 3n, price_per_kwh: 340n }) });

  // Deposit and create demands
  metrics.push({ label: "deposit_funds C1 (4000 Esc4)", ...await call("deposit_funds C1 (4000 Esc4)", C1, "deposit_funds", { amount: 4000n }) });
  metrics.push({ label: "deposit_funds C2 (3000 Esc4)", ...await call("deposit_funds C2 (3000 Esc4)", C2, "deposit_funds", { amount: 3000n }) });
  metrics.push({ label: "create_energy_demand C1 (2kWh max 350 Esc4)", ...await call("create_energy_demand C1 (2kWh max 350 Esc4)", C1, "create_energy_demand", { amount_kwh: 2n, max_price_per_kwh: 350n }) });
  metrics.push({ label: "create_energy_demand C2 (2kWh max 360 Esc4)", ...await call("create_energy_demand C2 (2kWh max 360 Esc4)", C2, "create_energy_demand", { amount_kwh: 2n, max_price_per_kwh: 360n }) });

  // Run optimized matching on all active offers/demands
  metrics.push({ label: "execute_optimized_matching (Esc.4 multi-user 4 orders)", ...await call("execute_optimized_matching (Esc.4 O(n log n) multi-user)", G1, "execute_optimized_matching", {}) });

  console.log("\n=== High-load: 10 active pairs ===");
  // Create more offers and demands for high-load test
  const extra = [acct(0)]; // admin can also call
  
  // Add fresh energy to G1 and G2 for more offers
  await call("register_energy_measurement G1 (20gen/0cons extra)", G1, "register_energy_measurement", { generated_kwh: 20n, consumed_kwh: 0n });
  await call("register_energy_measurement G2 (20gen/0cons extra)", G2, "register_energy_measurement", { generated_kwh: 20n, consumed_kwh: 0n });
  
  // Create 5 more offers (G1: 3 offers, G2: 2 offers) at different prices
  for (let i = 0; i < 3; i++) {
    await call(`create_energy_offer G1 extra ${i+1}`, G1, "create_energy_offer", { amount_kwh: 2n, price_per_kwh: BigInt(320+i*5) });
  }
  for (let i = 0; i < 2; i++) {
    await call(`create_energy_offer G2 extra ${i+1}`, G2, "create_energy_offer", { amount_kwh: 2n, price_per_kwh: BigInt(335+i*5) });
  }
  
  // More deposits and demands
  await call("deposit_funds C1 extra", C1, "deposit_funds", { amount: 20000n });
  await call("deposit_funds C2 extra", C2, "deposit_funds", { amount: 20000n });
  for (let i = 0; i < 3; i++) {
    await call(`create_energy_demand C1 extra ${i+1}`, C1, "create_energy_demand", { amount_kwh: 1n, max_price_per_kwh: BigInt(400) });
  }
  for (let i = 0; i < 2; i++) {
    await call(`create_energy_demand C2 extra ${i+1}`, C2, "create_energy_demand", { amount_kwh: 1n, max_price_per_kwh: BigInt(400) });
  }
  
  // Now run baseline matching with ~10 active pairs
  const m = await call("execute_automatic_matching (10 pairs high-load baseline)", G1, "execute_automatic_matching", {});
  metrics.push({ label: "execute_automatic_matching (10 pairs)", ...m });
  
  console.log("\n=== FINAL METRICS ===");
  for (const m of metrics) {
    if (m.gas > 0) console.log(`${m.label}: gas=${m.gas}, fee=${m.fee} STRK, lat=${m.lat}s`);
  }
  
  fs.writeFileSync("/home/user/workspace/energy_contract/sc4_results.json", JSON.stringify(metrics, null, 2));
  console.log("\nResults saved to sc4_results.json");
}

main().catch(e => { console.error(e.message.slice(0,300)); process.exit(1); });
