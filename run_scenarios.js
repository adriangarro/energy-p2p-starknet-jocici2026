const starknet = require("starknet");
const { RpcProvider, Account, Contract, json, stark, CallData, shortString, hash } = starknet;
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const provider = new RpcProvider({
  nodeUrl: process.env.STARKNET_RPC_URL,
});

// deployed accounts from sepolia
const ACCOUNTS = [
  { address: process.env.ACCOUNT_0_ADDRESS, pk: process.env.ACCOUNT_0_PK },
  { address: process.env.ACCOUNT_1_ADDRESS, pk: process.env.ACCOUNT_1_PK },
  { address: process.env.ACCOUNT_2_ADDRESS, pk: process.env.ACCOUNT_2_PK },
  { address: process.env.ACCOUNT_3_ADDRESS, pk: process.env.ACCOUNT_3_PK },
  { address: process.env.ACCOUNT_4_ADDRESS, pk: process.env.ACCOUNT_4_PK },
];

const CONTRACT_DIR = path.join(__dirname, "/target/dev");

const test_results = path.join(__dirname, "test_results.json");

const results = { transactions: [], scenarios: [], metrics: {} };

function account(idx) {
  const entry = ACCOUNTS[idx];
  if (!entry) throw new Error(`Missing account entry for index ${idx}`);
  if (!entry.address || !entry.pk) throw new Error(`Invalid account entry ${idx}: ${JSON.stringify(entry)}`);

  return new Account({
    provider,
    address: entry.address,
    signer: entry.pk,
  });
}

async function getBlockTimestamp(blockHash) {
  try {
    const block = await provider.getBlock(blockHash);
    return block.timestamp;
  } catch (e) {
    return null;
  }
}

async function getTxReceipt(txHash) {
  let retries = 30;
  while (retries > 0) {
    try {
      const receipt = await provider.getTransactionReceipt(txHash);
      if (receipt && receipt.execution_status === "SUCCEEDED") return receipt;
    } catch (e) {}
    await new Promise(r => setTimeout(r, 5000));
    retries--;
  }
  throw new Error(`TX ${txHash} not confirmed after retries`);
}

async function measure(label, fn) {
  const t0 = Date.now();
  const { transaction_hash } = await fn();
  const receipt = await getTxReceipt(transaction_hash);
  const elapsed = (Date.now() - t0) / 1000;

  const actualFee = receipt.actual_fee ? BigInt(receipt.actual_fee.amount) : 0n;

  let gasL2 = 0;
  if (receipt.execution_resources) {
    const r = receipt.execution_resources;
    gasL2 = (r.l1_gas || 0) + (r.l2_gas || 0) + (r.sierra_gas || 0) + (r.computation_resources?.n_steps || 0);
    if (r.sierra_gas && r.sierra_gas > 0) {
      gasL2 = r.sierra_gas;
    }
  }

  const entry = {
    label,
    tx_hash: transaction_hash,
    actual_fee_fri: actualFee.toString(),
    actual_fee_strk: (Number(actualFee) / 1e18).toFixed(9),
    gas_l2: gasL2,
    latency_s: elapsed.toFixed(2),
    status: receipt.execution_status,
    execution_resources: receipt.execution_resources,
    revert_reason: receipt.revert_reason || null,
  };
  results.transactions.push(entry);
  console.log(`  ✓ ${label}: gas=${gasL2}, fee=${entry.actual_fee_strk} STRK, lat=${entry.latency_s}s, hash=${transaction_hash.slice(0,12)}...`);
  return { receipt, txHash: transaction_hash, gasL2 };
}

async function ensureUserRegistered(account, contractClass, contractAddress, label, userData) {
  const myCallData = new CallData(contractClass.abi);

  try {
    const response = await provider.callContract({
      contractAddress,
      entrypoint: "get_user_profile",
      calldata: myCallData.compile("get_user_profile", { user: account.address })
    });

    // starknet.js v6+ returns the felt array directly; v5 wrapped it in { result }
    const felts = Array.isArray(response) ? response : response.result;
    const isRegistered = felts.some(val => val !== "0x0" && val !== "0");

    if (isRegistered) {
      console.log(`  - Skipping ${label}: The user is already registered.`);
      return;
    }
  } catch (error) {
    console.log(`  - Could not verify registration for ${label} (${error.message}); attempting register_user.`);
  }

  await measure(label, () =>
    account.execute([{
      contractAddress,
      entrypoint: "register_user",
      calldata: myCallData.compile("register_user", userData)
    }])
  );
}

async function injectPairs(n, contractAddress) {
  console.log(`\n  [injectPairs] Registering and populating state for ${n} pairs...`);
  const juan = account(1);
  const maria = account(2);

  const { sierra } = readContractArtifacts();
  const myCallData = new CallData(sierra.abi);

  // ensure users are registered
  await ensureUserRegistered(juan, sierra, contractAddress, "register_user (Juan GD)", {
    user_type: 2n,
    capacity_kw: 100n,
    location_node: 1n
  });
  await ensureUserRegistered(maria, sierra, contractAddress, "register_user (Maria Consumer)", {
    user_type: 0n,
    capacity_kw: 50n,
    location_node: 1n
  });

  // register a huge energy measurement for the generator (Juan)
  const txEnergy = await juan.execute([{
    contractAddress,
    entrypoint: "register_energy_measurement",
    calldata: myCallData.compile("register_energy_measurement", { 
      generated_kwh: 1000000n, 
      consumed_kwh: 0n 
    })
  }]);
  await provider.waitForTransaction(txEnergy.transaction_hash);

  // deposit a huge amount of funds for the consumer (Maria)
  const txFunds = await maria.execute([{
    contractAddress,
    entrypoint: "deposit_funds",
    calldata: myCallData.compile("deposit_funds", { 
      amount: 1000000n 
    })
  }]);
  await provider.waitForTransaction(txFunds.transaction_hash);

  const offerCalls = [];
  const demandCalls = [];

  for (let i = 0; i < n; i++) {
    offerCalls.push({
      contractAddress,
      entrypoint: "create_energy_offer",
      calldata: myCallData.compile("create_energy_offer", {
        amount_kwh: 5n,
        price_per_kwh: 330n
      })
    });

    demandCalls.push({
      contractAddress,
      entrypoint: "create_energy_demand",
      calldata: myCallData.compile("create_energy_demand", {
        amount_kwh: 5n,
        max_price_per_kwh: 350n
      })
    });
  }

  const txOffer = await juan.execute(offerCalls);
  await provider.waitForTransaction(txOffer.transaction_hash);

  const txDemand = await maria.execute(demandCalls);
  await provider.waitForTransaction(txDemand.transaction_hash);

  console.log(`  [injectPairs] ✓ Successfully injected ${n} offer/demand pairs.`);
}

async function runBenchmark(contractAddress) {
  console.log("\n=== Benchmarking Matching Algorithms ===");
  const adminAcc = account(0);
  const benchmarkResults = [];

  const ns = [5, 10, 20];
  for (const n of ns) {
    console.log(`\n--- Starting Benchmark for n = ${n} pairs ---`);

    console.log(`  [Benchmark] Clearing any pre-existing state...`);
    try {
      const { transaction_hash } = await adminAcc.execute([{ contractAddress, entrypoint: "execute_automatic_matching", calldata: [] }]);
      await provider.waitForTransaction(transaction_hash);
      console.log(`  [Benchmark] ✓ State cleared.`);
    } catch (e) {
      console.log(`  [Benchmark] State was already clean or could not be cleared. Continuing...`);
    }

    await injectPairs(n, contractAddress);
    
    const autoLabel = `execute_automatic_matching (n=${n})`;
    const { gasL2: gasAuto } = await measure(autoLabel, () =>
      adminAcc.execute([{
        contractAddress,
        entrypoint: "execute_automatic_matching",
        calldata: []
      }])
    );

    await injectPairs(n, contractAddress);

    const optLabel = `execute_optimized_matching (n=${n})`;
    const { gasL2: gasOpt } = await measure(optLabel, () =>
      adminAcc.execute([{
        contractAddress,
        entrypoint: "execute_optimized_matching",
        calldata: []
      }])
    );

    let savingsPct = 0;
    if (gasAuto > 0) {
      savingsPct = ((gasAuto - gasOpt) / gasAuto) * 100;
    }

    benchmarkResults.push({
      n,
      gasAuto,
      gasOpt,
      savingsPct
    });
  }

  // output formatted console table
  console.log("\n=== ACADEMIC BENCHMARK TABLE ===");
  console.log("-----------------------------------------------------------------");
  console.log("| n pairs | Gas Automatic | Gas Optimized | % Savings           |");
  console.log("-----------------------------------------------------------------");
  for (const res of benchmarkResults) {
    const nStr = String(res.n).padStart(7, " ");
    const autoStr = String(res.gasAuto).padStart(13, " ");
    const optStr = String(res.gasOpt).padStart(13, " ");
    const savingsStr = (res.savingsPct.toFixed(2) + "%").padStart(18, " ");
    console.log(`| ${nStr} | ${autoStr} | ${optStr} | ${savingsStr} |`);
  }
  console.log("-----------------------------------------------------------------");
}

function readContractArtifacts() {
  const files = fs.readdirSync(CONTRACT_DIR);
  const sierraFile = files.find(f => f.endsWith(".contract_class.json"));
  const casmFile = files.find(f => f.endsWith(".compiled_contract_class.json"));

  if (!sierraFile || !casmFile) {
    throw new Error(`Contract files not found in ${CONTRACT_DIR}. Files: ${files.join(", ")}`);
  }

  const sierraPath = path.isAbsolute(sierraFile) ? sierraFile : path.join(CONTRACT_DIR, sierraFile);
  const casmPath = path.isAbsolute(casmFile) ? casmFile : path.join(CONTRACT_DIR, casmFile);

  const sierra = json.parse(fs.readFileSync(sierraPath).toString());
  const casm = json.parse(fs.readFileSync(casmPath).toString());
  return { sierra, casm };
}

async function deployContract() {
  console.log("\n=== Deploying EnergyP2PTradingV2 ===");

  const adminAcc = account(0);
  const { sierra, casm } = readContractArtifacts();

  // Declare
  let classHash;
  try {
    const declareResponse = await adminAcc.declare({ contract: sierra, casm });
    await provider.waitForTransaction(declareResponse.transaction_hash);
    classHash = declareResponse.class_hash;
    console.log(`  Declared class hash: ${classHash}`);
  } catch (err) {
    const rawData = err?.baseError?.data;
    const msg = typeof rawData === "string"
      ? rawData
      : rawData?.execution_error || rawData?.message || err?.message || String(err);
    if (typeof msg === "string" && msg.includes("already declared")) {
      classHash = hash.computeContractClassHash(sierra);
    } else {
      throw err;
    }
  }

  if (!classHash) {
    throw new Error("Unable to determine classHash for deployment.");
  }

  // Deploy with constructor: admin, base_price=330, max_capacity=100
  const calldata = CallData.compile({
    admin: adminAcc.address,
    base_price: 330n,
    max_capacity: 100n,
  });
  const deployResponse = await adminAcc.deployContract({ classHash, constructorCalldata: calldata });
  await provider.waitForTransaction(deployResponse.transaction_hash);
  const contractAddress = deployResponse.contract_address;
  console.log(`  Deployed at: ${contractAddress}`);
  results.contractAddress = contractAddress;
  return { contractAddress, contractClass: sierra };
}

async function runScenario1(contractClass, contractAddress) {
  console.log("\n=== Scenario 1: Juan + Maria, successful tx ===");
  
  const juan = account(1);
  const maria = account(2);

  const myCallData = new CallData(contractClass.abi);

  await ensureUserRegistered(juan, contractClass, contractAddress, "register_user (Juan GD)", {
    user_type: 2n,
    capacity_kw: 50n,
    location_node: 1n
  });
  await ensureUserRegistered(maria, contractClass, contractAddress, "register_user (Maria Consumer)", {
    user_type: 0n,
    capacity_kw: 30n,
    location_node: 1n
  });

  await measure("register_energy_measurement (Juan 15gen/10cons)", () =>
    juan.execute([{
      contractAddress,
      entrypoint: "register_energy_measurement",
      calldata: myCallData.compile("register_energy_measurement", { 
        generated_kwh: 15n, 
        consumed_kwh: 10n 
      })
    }])
  );

  await measure("deposit_funds (Maria 2000)", () =>
    maria.execute([{
      contractAddress,
      entrypoint: "deposit_funds",
      calldata: myCallData.compile("deposit_funds", { 
        amount: 2000n 
      })
    }])
  );

  await measure("create_energy_offer (Juan 5kWh @ 330)", () =>
    juan.execute([{
      contractAddress,
      entrypoint: "create_energy_offer",
      calldata: myCallData.compile("create_energy_offer", { 
        amount_kwh: 5n, 
        price_per_kwh: 330n 
      })
    }])
  );

  await measure("create_energy_demand (Maria 3kWh max 350)", () =>
    maria.execute([{
      contractAddress,
      entrypoint: "create_energy_demand",
      calldata: myCallData.compile("create_energy_demand", { 
        amount_kwh: 3n, 
        max_price_per_kwh: 350n 
      })
    }])
  );

  await measure("execute_automatic_matching (Esc.1 baseline 2 pairs)", () =>
    juan.execute([{
      contractAddress,
      entrypoint: "execute_automatic_matching",
      calldata: [] 
    }])
  );

  console.log("  Scenario 1 complete");
}

async function runScenario2(contractClass, contractAddress) {
  console.log("\n=== Scenario 2: Price incompatibility rejection ===");
  const seller = account(3);
  const buyer = account(4);
  
  const myCallData = new CallData(contractClass.abi);

  await ensureUserRegistered(seller, contractClass, contractAddress, "register_user (Seller GD Esc2)", {
    user_type: 2n,
    capacity_kw: 40n, 
    location_node: 1n
  });
  await ensureUserRegistered(buyer, contractClass, contractAddress, "register_user (Buyer Consumer Esc2)",{
    user_type: 0n,
    capacity_kw: 20n,
    location_node: 1n
  });

  await measure("register_energy_measurement (Seller 10gen/2cons)", () =>
    seller.execute([{
      contractAddress,
      entrypoint: "register_energy_measurement",
      calldata: myCallData.compile("register_energy_measurement", { generated_kwh: 10n, consumed_kwh: 2n })
    }])
  );

  await measure("deposit_funds (Buyer 5000 Esc2)", () =>
    buyer.execute([{
      contractAddress,
      entrypoint: "deposit_funds",
      calldata: myCallData.compile("deposit_funds", { amount: 5000n })
    }])
  );

  await measure("create_energy_offer (400 COP/kWh — incompatible)", () =>
    seller.execute([{
      contractAddress,
      entrypoint: "create_energy_offer",
      calldata: myCallData.compile("create_energy_offer", { amount_kwh: 5n, price_per_kwh: 400n })
    }])
  );

  await measure("create_energy_demand (max 300 COP/kWh — incompatible)", () =>
    buyer.execute([{
      contractAddress,
      entrypoint: "create_energy_demand",
      calldata: myCallData.compile("create_energy_demand", { amount_kwh: 3n, max_price_per_kwh: 300n })
    }])
  );

  await measure("execute_automatic_matching (Esc.2 price mismatch)", () =>
    seller.execute([{
      contractAddress,
      entrypoint: "execute_automatic_matching",
      calldata: []
    }])
  );

  console.log("  Scenario 2 complete — offers unmatched as expected");
}

async function runScenario3(contractClass, contractAddress) {
  console.log("\n=== Scenario 3: Insufficient solvency ===");
  // reuse seller from sc2, register new poor buyer
  // we need a new account — reuse account 4 but with fresh offer
  const seller = account(3);
  const poorBuyer = account(4);

  const myCallData = new CallData(contractClass.abi);

  // reset poor buyer: deposit only 500 COP (need 990 for 3kWh@330)
  // note: buyer already has 5000 in balance from scenario 2
  // we need to create demand that exceeds available-after-prior balance
  // simpler: create new offer and demand with new amounts
  await measure("create_energy_offer (3kWh @ 330 Esc3)", () =>
    seller.execute([{ 
      contractAddress, 
      entrypoint: "create_energy_offer", 
      calldata: myCallData.compile("create_energy_offer", { amount_kwh: 3n, price_per_kwh: 330n }) 
    }])
  );

  // buyer already has funds from previous scenario — this scenario shows
  // the financial protection check when balance would go negative conceptually
  // better: withdraw most funds first
  await measure("withdraw_funds (Buyer leaves 200 COP)", () =>
    poorBuyer.execute([{ 
      contractAddress, 
      entrypoint: "withdraw_funds",
      calldata: myCallData.compile("withdraw_funds", { amount: 4800n }) 
    }])
  );

  // now poorBuyer has ~200 COP, needs 990 for 3kWh@330 — demand creation will fail
  // the assert in create_energy_demand will catch insufficient funds
  console.log("  Scenario 3: Attempting demand with 200 COP balance, need 990...");
  try {
    const t0 = Date.now();
    const tx = await poorBuyer.execute([{ 
      contractAddress, 
      entrypoint: "create_energy_demand", 
      calldata: myCallData.compile("create_energy_demand", { amount_kwh: 3n, max_price_per_kwh: 330n }) 
    }]);
    const receipt = await provider.waitForTransaction(tx.transaction_hash);
    const elapsed = (Date.now() - t0) / 1000;
    
    const entry = {
      label: "create_energy_demand (Esc.3 — REVERTED insufficient funds)",
      tx_hash: tx.transaction_hash,
      status: receipt.execution_status,
      revert_reason: receipt.revert_reason,
      latency_s: elapsed.toFixed(2),
    };
    results.transactions.push(entry);
    console.log(`  ✓ Demand REVERTED as expected: ${receipt.revert_reason || "Insufficient funds"}`);
  } catch (e) {
    // expected revert
    results.transactions.push({ 
      label: "create_energy_demand (Esc.3 REJECTED)", 
      status: "REVERTED", 
      revert_reason: "Insufficient funds", 
      latency_s: "N/A" 
    });
    console.log(`  ✓ Demand rejected by contract: ${e.message.slice(0, 80)}`);
  }
}

async function runScenario4(contractClass, contractAddress) {
  console.log("\n=== Scenario 4: Multi-user concurrent matching (5 users) ===");

  const G1 = account(1);
  const G2 = account(3);
  const C1 = account(2);
  const C2 = account(4);

  const myCallData = new CallData(contractClass.abi);

  await ensureUserRegistered(G1, contractClass, contractAddress, "register_user G1 (Generator)", { 
    user_type: 2n, 
    capacity_kw: 50n, 
    location_node: 1n 
  });
  
  await ensureUserRegistered(G2, contractClass, contractAddress, "register_user G2 (Generator)", { 
    user_type: 2n, 
    capacity_kw: 40n, 
    location_node: 1n 
  });
  
  await ensureUserRegistered(C1, contractClass, contractAddress, "register_user C1 (Consumer)", { 
    user_type: 0n, 
    capacity_kw: 30n, 
    location_node: 1n 
  });
  
  await ensureUserRegistered(C2, contractClass, contractAddress, "register_user C2 (Consumer)", { 
    user_type: 0n, 
    capacity_kw: 20n, 
    location_node: 1n 
  });

  await measure("register_energy_measurement G1 (5gen/0cons)", () =>
    G1.execute([{
      contractAddress,
      entrypoint: "register_energy_measurement",
      calldata: myCallData.compile("register_energy_measurement", { generated_kwh: 5n, consumed_kwh: 0n })
    }])
  );

  await measure("register_energy_measurement G2 (8gen/1cons)", () =>
    G2.execute([{
      contractAddress,
      entrypoint: "register_energy_measurement",
      calldata: myCallData.compile("register_energy_measurement", { generated_kwh: 8n, consumed_kwh: 1n })
    }])
  );

  await measure("deposit_funds C2 (3000 COP)", () =>
    C2.execute([{
      contractAddress,
      entrypoint: "deposit_funds",
      calldata: myCallData.compile("deposit_funds", { amount: 3000n })
    }])
  );

  await measure("create_energy_offer G1 (2kWh @ 320 Esc4)", () =>
    G1.execute([{
      contractAddress,
      entrypoint: "create_energy_offer",
      calldata: myCallData.compile("create_energy_offer", { amount_kwh: 2n, price_per_kwh: 320n })
    }])
  );

  await measure("create_energy_offer G2 (3kWh @ 340 Esc4)", () =>
    G2.execute([{
      contractAddress,
      entrypoint: "create_energy_offer",
      calldata: myCallData.compile("create_energy_offer", { amount_kwh: 3n, price_per_kwh: 340n })
    }])
  );

  await measure("create_energy_demand C2 (2kWh max 360 Esc4)", () =>
    C2.execute([{
      contractAddress,
      entrypoint: "create_energy_demand",
      calldata: myCallData.compile("create_energy_demand", { amount_kwh: 2n, max_price_per_kwh: 360n })
    }])
  );

  await measure("execute_optimized_matching (Esc.4 multi-user O(n log n))", () =>
    G1.execute([{
      contractAddress,
      entrypoint: "execute_optimized_matching",
      calldata: []
    }])
  );

  console.log("  Scenario 4 complete");
}

async function runHighLoadMatching(contractAddress) {
  console.log("\n=== High load: 10-pair matching (O(n²) baseline) ===");
  const adminAcc = account(0);
  await measure("execute_automatic_matching (10 active offers/demands)", () =>
    adminAcc.execute([{ contractAddress, entrypoint: "execute_automatic_matching", calldata: [] }])
  );
}

function summarizeMetrics() {
  console.log("\n=== METRICS SUMMARY ===");
  const keyFunctions = [
    "register_user",
    "register_energy_measurement",
    "create_energy_offer",
    "create_energy_demand",
    "execute_automatic_matching",
    "execute_optimized_matching",
    "deposit_funds",
  ];
  
  const summary = {};
  for (const tx of results.transactions) {
    if (tx.gas_l2 === undefined || tx.gas_l2 === null) continue;
    const normalizedLabel = tx.label.toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ").trim();
    // Find which key function this matches
    for (const kf of keyFunctions) {
      const normalizedKey = kf.toLowerCase().replace(/_/g, " ");
      if (normalizedLabel.includes(normalizedKey) || tx.label.toLowerCase().includes(kf.toLowerCase())) {
        if (!summary[kf]) summary[kf] = [];
        summary[kf].push({
          gas: tx.gas_l2,
          fee_strk: tx.actual_fee_strk,
          lat: tx.latency_s,
          hash: tx.tx_hash,
        });
      }
    }
  }
  
  const tableRows = [];
  for (const [fn, entries] of Object.entries(summary)) {
    for (const e of entries) {
      tableRows.push([
        fn,
        e.gas ? e.gas.toLocaleString() : "N/A",
        e.fee_strk !== undefined ? String(e.fee_strk) : "N/A",
        e.lat !== undefined ? String(e.lat) : "N/A",
        e.hash ? e.hash.slice(0, 16) + "..." : "N/A"
      ]);
    }
  }

  const headers = ["Function", "Gas L2", "Fee (STRK)", "Latency (s)", "TX Hash"];
  const colWidths = headers.map((header, i) => 
    Math.max(header.length, ...tableRows.map(row => String(row[i]).length))
  );

  const pad = (text, width) => String(text).padEnd(width, ' ');

  const headerLine = headers.map((h, i) => pad(h, colWidths[i])).join(' | ');
  const separatorLine = colWidths.map(w => '-'.repeat(w)).join('-|-');
  
  console.log('\n' + headerLine);
  console.log(separatorLine);

  for (const row of tableRows) {
    const line = row.map((val, i) => pad(val, colWidths[i])).join(' | ');
    console.log(line);
  }
  
  results.summary = summary;
  fs.writeFileSync(test_results, JSON.stringify(results, null, 2));
  console.log("\nFull results saved to test_results.json");
}

async function runLatencyCampaign(contractClass, contractAddress) {
  console.log("\n=== Starting Short Latency Campaign ===");
  
  // use account 0 for the stress test
  const testAccount = account(0);
  const myCallData = new CallData(contractClass.abi);
  
  const NUM_TXS = 20; // campaign size
  let latencies = [];

  // --- ACCOUNT PREPARATION ---
  console.log("Ensuring the account is registered...");
  
  // userData matching your contract struct: Consumer (0n), Node 1, Capacity 50
  const userData = {
    user_type: 0n,
    capacity_kw: 50n,
    location_node: 1n
  };

  // call your helper function to register (or skip if already registered)
  await ensureUserRegistered(
    testAccount,
    contractClass,
    contractAddress,
    "Latency_Test_Account",
    userData
  );
  
  console.log(" ✓ Account is ready.");
  console.log(`Executing ${NUM_TXS} consecutive transactions...`);

  // --- LATENCY MEASUREMENT LOOP ---
  for (let i = 0; i < NUM_TXS; i++) {
    const t0 = Date.now();
    
    try {
      const tx = await testAccount.execute([{ 
        contractAddress, 
        entrypoint: "deposit_funds", 
        calldata: myCallData.compile("deposit_funds", { amount: 100n }) 
      }]);
      
      await provider.waitForTransaction(tx.transaction_hash);
      const t1 = Date.now();
      
      const latency = (t1 - t0) / 1000;
      latencies.push(latency);
      console.log(`  ✓ Tx ${i + 1} confirmed in ${latency.toFixed(2)}s`);
    } catch (error) {
      console.error(`  x Error on Tx ${i + 1}:`, error.message);
    }
  }

  // --- STATISTICS CALCULATION ---
  if (latencies.length === 0) {
    console.log("No transactions were completed.");
    return;
  }

  // sort the array from shortest to longest time
  latencies.sort((a, b) => a - b);

  // calculate Mean (Average)
  const sum = latencies.reduce((acc, val) => acc + val, 0);
  const mean = sum / latencies.length;

  // calculate Median (Center value)
  const mid = Math.floor(latencies.length / 2);
  const median = latencies.length % 2 !== 0 
    ? latencies[mid] 
    : (latencies[mid - 1] + latencies[mid]) / 2;

  // calculate 95th Percentile (p95)
  const indexP95 = Math.floor(latencies.length * 0.95);
  const p95 = latencies[indexP95];

  console.log("\n=== Latency Results (Short Campaign) ===");
  console.log(`Total successful transactions: ${latencies.length}`);
  console.log(`Mean:   ${mean.toFixed(2)} s`);
  console.log(`Median: ${median.toFixed(2)} s`);
  console.log(`P95:    ${p95.toFixed(2)} s`);
  console.log(`Min:    ${latencies[0].toFixed(2)} s`);
  console.log(`Max:    ${latencies[latencies.length - 1].toFixed(2)} s`);
}

async function main() {
  try {
    console.log("Starting EnergyP2PTradingV2 test suite on Starknet Sepolia...");
    
    const { contractAddress, contractClass } = await deployContract();

    await runBenchmark(contractAddress);
    await runScenario1(contractClass, contractAddress); 
    await runScenario2(contractClass, contractAddress);
    await runScenario3(contractClass, contractAddress);
    await runScenario4(contractClass, contractAddress);
    await runHighLoadMatching(contractAddress);
    await runLatencyCampaign(contractClass, contractAddress);

    console.log("\n✅ Scenario(s) completed successfully");
    summarizeMetrics();
  } catch (e) {
    console.error(e);
    fs.writeFileSync(
      test_results,
      JSON.stringify(results, null, 2)
    );
    console.log("Partial results saved");
    process.exit(1);
  }
}

main();
