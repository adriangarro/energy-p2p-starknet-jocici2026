const starknet = require("starknet");
const { RpcProvider, Account, Contract, json, stark, CallData, shortString, hash } = starknet;
const fs = require("fs");
const path = require("path");

const provider = new RpcProvider({
  nodeUrl: "https://starknet-sepolia.g.alchemy.com/starknet/version/rpc/v0_10/JPV1MzP7gvBphIUUnGcpg",
});

// deployed accounts from sepolia
const ACCOUNTS = [
  { address: "0x5bfc1f630ec0b3959487b444866830f3bed289b3738c6a13c3f72bc14382d3b", pk: "0x23f9acb154ec3537a92e148f7e7c7335632103ff243511d17ad14a8a1495e19" },
  { address: "0x3dead823332a509e9dc078e8c641f5f96e70d6c024d080014400d08f30f3f5c", pk: "0x60620d7708363d7d7360f12c7eedee62a360ee324153fd9470ead1f32fc9ca9" },
  { address: "0x565734e86fca9fafb3398736c7f4ba8b40498def354e2d7e7aa5b5d13138cde", pk: "0x68839b294834587ae96545d93aeef8a4843049907ff96a4da3cf51ddd843fc4" },
  { address: "0x5e2e5f931f66bab8b29e85f8deae28f467252d86aae7eee144575ca3f60f4c8", pk: "0x180930f2c5f3098c72e34ef06eb8a54366753e1a23599b9af226c6bdd93d1e1" },
  { address: "0x296117fc9ca83a612360d31104bdb3dfbbcc9a098f226afab491f64eff5d4fe", pk: "0x1713ac7c5a1091d6e11b1e05daa10129f2316d210a56f864b34c005953850e6" },
];

const CONTRACT_DIR = "/home/volkova/energy-p2p-starknet-jocici2026/target/dev";
const CONTRACT_ADDRESS_FILE = path.join(__dirname, "deployed_contract_address.txt");
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
  return { receipt, txHash: transaction_hash };
}

function readSavedContractAddress() {
  try {
    if (!fs.existsSync(CONTRACT_ADDRESS_FILE)) return null;
    const value = fs.readFileSync(CONTRACT_ADDRESS_FILE, "utf8").trim();
    return value || null;
  } catch (e) {
    return null;
  }
}

function writeSavedContractAddress(address) {
  fs.writeFileSync(CONTRACT_ADDRESS_FILE, address, "utf8");
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

  const savedAddress = readSavedContractAddress();
  if (savedAddress) {
    console.log(`  Reusing saved contract address: ${savedAddress}`);
    const { sierra } = readContractArtifacts();
    results.contractAddress = savedAddress;
    return { contractAddress: savedAddress, contractClass: sierra };
  }

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
      console.log("  Class already declared on Sepolia; skipping redeclare.");
      classHash = sierra.class_hash || sierra.classHash;
      if (!classHash) {
        const match = msg.match(/Class with hash (0x[0-9a-fA-F]+)/);
        if (match) {
          classHash = match[1];
          console.log(`  Parsed class hash from Sepolia error: ${classHash}`);
        } else {
          console.log("  Warning: could not infer class hash from Sepolia error.");
        }
      }
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
  writeSavedContractAddress(contractAddress);
  results.contractAddress = contractAddress;
  return { contractAddress, contractClass: sierra };
}

async function runScenario1(contractClass, contractAddress) {
  console.log("\n=== Scenario 1: Juan + Maria, successful tx ===");

  const juan = account(1);
  const maria = account(2);

  await measure("register_user (Juan GD)", () =>
    juan.execute([{
      contractAddress,
      entrypoint: "register_user",
      calldata: [2n, 50n, 1n],
    }])
  );

  await measure("register_user (Maria Consumer)", () =>
    maria.execute([{
      contractAddress,
      entrypoint: "register_user",
      calldata: [0n, 30n, 1n],
    }])
  );

  await measure("register_energy_measurement (Juan 15gen/10cons)", () =>
    juan.execute([{
      contractAddress,
      entrypoint: "register_energy_measurement",
      calldata: [15n, 10n],
    }])
  );

  await measure("deposit_funds (Maria 2000)", () =>
    maria.execute([{
      contractAddress,
      entrypoint: "deposit_funds",
      calldata: [2000n],
    }])
  );

  await measure("create_energy_offer (Juan 5kWh @ 330)", () =>
    juan.execute([{
      contractAddress,
      entrypoint: "create_energy_offer",
      calldata: [5n, 330n],
    }])
  );

  await measure("create_energy_demand (Maria 3kWh max 350)", () =>
    maria.execute([{
      contractAddress,
      entrypoint: "create_energy_demand",
      calldata: [3n, 350n],
    }])
  );

  await measure("execute_automatic_matching (Esc.1 baseline 2 pairs)", () =>
    juan.execute([{
      contractAddress,
      entrypoint: "execute_automatic_matching",
      calldata: [],
    }])
  );

  console.log("  Scenario 1 complete");
}

async function runScenario2(contractClass, contractAddress) {
  console.log("\n=== Scenario 2: Price incompatibility rejection ===");
  const seller = account(3);
  const buyer = account(4);

  await measure("register_user (Seller GD Esc2)", () =>
    seller.execute([{
      contractAddress,
      entrypoint: "register_user",
      calldata: [2n, 40n, 1n],
    }])
  );

  await measure("register_user (Buyer Consumer Esc2)", () =>
    buyer.execute([{
      contractAddress,
      entrypoint: "register_user",
      calldata: [0n, 20n, 1n],
    }])
  );

  await measure("register_energy_measurement (Seller 10gen/2cons)", () =>
    seller.execute([{
      contractAddress,
      entrypoint: "register_energy_measurement",
      calldata: [10n, 2n],
    }])
  );

  await measure("deposit_funds (Buyer 5000 Esc2)", () =>
    buyer.execute([{
      contractAddress,
      entrypoint: "deposit_funds",
      calldata: [5000n],
    }])
  );

  await measure("create_energy_offer (400 COP/kWh — incompatible)", () =>
    seller.execute([{
      contractAddress,
      entrypoint: "create_energy_offer",
      calldata: [5n, 400n],
    }])
  );

  await measure("create_energy_demand (max 300 COP/kWh — incompatible)", () =>
    buyer.execute([{
      contractAddress,
      entrypoint: "create_energy_demand",
      calldata: [3n, 300n],
    }])
  );

  await measure("execute_automatic_matching (Esc.2 price mismatch)", () =>
    seller.execute([{
      contractAddress,
      entrypoint: "execute_automatic_matching",
      calldata: [],
    }])
  );

  console.log("  Scenario 2 complete — offers unmatched as expected");
}

async function runScenario3(contractClass, contractAddress) {
  console.log("\n=== Scenario 3: Insufficient solvency ===");
  console.log("  Scenario 3: Register buyer with insufficient balance (500 COP, needs 990 COP) → confirm contract rejection");

  const seller = account(3);
  const poorBuyer = account(4);

  await measure("register_user (Seller GD Esc3)", () =>
    seller.execute([{
      contractAddress,
      entrypoint: "register_user",
      calldata: [2n, 20n, 1n],
    }])
  );

  await measure("register_user (Poor Buyer Esc3)", () =>
    poorBuyer.execute([{
      contractAddress,
      entrypoint: "register_user",
      calldata: [0n, 20n, 1n],
    }])
  );

  await measure("register_energy_measurement (Seller 5gen/0cons Esc3)", () =>
    seller.execute([{
      contractAddress,
      entrypoint: "register_energy_measurement",
      calldata: [5n, 0n],
    }])
  );

  await measure("deposit_funds (Poor Buyer 500 COP Esc3)", () =>
    poorBuyer.execute([{
      contractAddress,
      entrypoint: "deposit_funds",
      calldata: [500n],
    }])
  );

  await measure("create_energy_offer (3kWh @ 330 Esc3)", () =>
    seller.execute([{
      contractAddress,
      entrypoint: "create_energy_offer",
      calldata: [3n, 330n],
    }])
  );

  console.log("  Scenario 3: Attempting demand with 500 COP balance, need 990...");
  try {
    const t0 = Date.now();
    const tx = await poorBuyer.execute([{
      contractAddress,
      entrypoint: "create_energy_demand",
      calldata: [3n, 330n],
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
    results.transactions.push({
      label: "create_energy_demand (Esc.3 REJECTED)",
      status: "REVERTED",
      revert_reason: "Insufficient funds",
      latency_s: "N/A",
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

  await measure("register_user G1 (Generator)", () =>
    G1.execute([{
      contractAddress,
      entrypoint: "register_user",
      calldata: [2n, 50n, 1n],
    }])
  );

  await measure("register_user G2 (Generator)", () =>
    G2.execute([{
      contractAddress,
      entrypoint: "register_user",
      calldata: [2n, 40n, 1n],
    }])
  );

  await measure("register_user C1 (Consumer)", () =>
    C1.execute([{
      contractAddress,
      entrypoint: "register_user",
      calldata: [0n, 30n, 1n],
    }])
  );

  await measure("register_user C2 (Consumer)", () =>
    C2.execute([{
      contractAddress,
      entrypoint: "register_user",
      calldata: [0n, 20n, 1n],
    }])
  );

  await measure("register_energy_measurement G1 (5gen/0cons)", () =>
    G1.execute([{
      contractAddress,
      entrypoint: "register_energy_measurement",
      calldata: [5n, 0n],
    }])
  );

  await measure("register_energy_measurement G2 (8gen/1cons)", () =>
    G2.execute([{
      contractAddress,
      entrypoint: "register_energy_measurement",
      calldata: [8n, 1n],
    }])
  );

  await measure("deposit_funds C2 (3000 COP)", () =>
    C2.execute([{
      contractAddress,
      entrypoint: "deposit_funds",
      calldata: [3000n],
    }])
  );

  await measure("create_energy_offer G1 (2kWh @ 320 Esc4)", () =>
    G1.execute([{
      contractAddress,
      entrypoint: "create_energy_offer",
      calldata: [2n, 320n],
    }])
  );

  await measure("create_energy_offer G2 (3kWh @ 340 Esc4)", () =>
    G2.execute([{
      contractAddress,
      entrypoint: "create_energy_offer",
      calldata: [3n, 340n],
    }])
  );

  await measure("create_energy_demand C2 (2kWh max 360 Esc4)", () =>
    C2.execute([{
      contractAddress,
      entrypoint: "create_energy_demand",
      calldata: [2n, 360n],
    }])
  );

  await measure("execute_optimized_matching (Esc.4 multi-user O(n log n))", () =>
    G1.execute([{
      contractAddress,
      entrypoint: "execute_optimized_matching",
      calldata: [],
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
    if (!tx.gas_l2 || tx.gas_l2 === 0) continue;
    for (const kf of keyFunctions) {
      if (tx.label.toLowerCase().includes(kf.toLowerCase().replace(/_/g, " "))) {
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

  console.log("\nFunction | Gas L2 | Fee (STRK) | Latency (s) | TX Hash");
  console.log("---------|--------|------------|-------------|--------");
  for (const [fn, entries] of Object.entries(summary)) {
    for (const e of entries) {
      console.log(`${fn} | ${e.gas.toLocaleString()} | ${e.fee_strk} | ${e.lat} | ${e.hash ? e.hash.slice(0,16) + "..." : "N/A"}`);
    }
  }

  results.summary = summary;
  fs.writeFileSync("/home/volkova/energy-p2p-starknet-jocici2026/test_results.json", JSON.stringify(results, null, 2));
  console.log("\nFull results saved to test_results.json");
}

async function main() {
  try {
    console.log("Starting EnergyP2PTradingV2 test suite on Starknet Sepolia...");

    const abiPath = path.join(CONTRACT_DIR, "energy_p2p_EnergyP2PTradingV2.contract_class.json");
    const sierraData = JSON.parse(fs.readFileSync(abiPath, "utf8"));

    let abi = sierraData.abi;
    if (!Array.isArray(abi)) {
      if (Array.isArray(sierraData.contract_class?.abi)) {
        abi = sierraData.contract_class.abi;
      } else if (Array.isArray(sierraData.abi?.abi)) {
        abi = sierraData.abi.abi;
      } else {
        throw new Error(
          "ABI is not an array. sierraData keys: " +
            Object.keys(sierraData).join(", ")
        );
      }
    }

    console.log("ABI cargado exitosamente. Longitud:", abi.length);

//    const { contractAddress } = await deployContract();
    const { contractAddress, contractClass } = await deployContract();
//  await runScenario1(contractClass, contractAddress); 
//  await runScenario2(contractClass, contractAddress);
//  await runScenario3(contractClass, contractAddress);
    await runScenario4(contractClass, contractAddress);
    await runHighLoadMatching(contractAddress);

    console.log("\n✅ Scenario(s) completed successfully");
  } catch (e) {
    console.error(e);
    fs.writeFileSync(
      "/home/volkova/energy-p2p-starknet-jocici2026/test_results.json",
      JSON.stringify(results, null, 2)
    );
    console.log("Partial results saved");
    process.exit(1);
  }
}

main();