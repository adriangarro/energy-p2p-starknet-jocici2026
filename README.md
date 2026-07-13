# EnergyP2PTradingV2 — Smart Contract on Starknet

**Paper:** *Introducción a la Ejecución de Contratos Inteligentes en la Red de Starknet para Transacciones en el Ámbito de Energías Locales*

**Authors:** Elberth Adrián Garro Sánchez (Universidad Fidélitas, Costa Rica) · Jhon Esteban Viveros Ramírez (Universidad Autónoma de Occidente, Colombia)

**Conference:** JoCICI 2026

---

## Description

This repository contains the full Cairo 2.x implementation of `EnergyP2PTradingV2`, a peer-to-peer energy trading smart contract designed for local energy communities in Colombia, compliant with Decree 2236/2023 and Resolution CREG 101-072/2025.

## Contract Features

- **User registration** with regulatory validation (Consumer ≤50 kW, AGPE ≤100 kW, GD 10–100 kW)
- **Energy measurement** recording with surplus calculation
- **Automated matching** — two algorithms:
  - Baseline O(n²) nested-loop (`execute_automatic_matching`)
  - Optimized O(n log n) order-book with two-pointer scan (`execute_optimized_matching`)
- **Financial management** (deposit, withdraw, balance tracking)
- **Event traceability** (UserRegistered, EnergyMeasured, FundsDeposited, EnergyTraded)

## Performance Metrics (starknet-devnet v0.4.3)

| Function | Gas L2 (Sierra) | Fee (STRK) | Latency |
|---|---|---|---|
| `register_user` | 1,317,000 | 0.001318 | 1.6s |
| `register_energy_measurement` | 1,277,000 | 0.001277 | 1.3s |
| `create_energy_offer` | 1,477,000 | 0.001478 | 1.3s |
| `create_energy_demand` | 1,357,000 | 0.001358 | 1.3s |
| `execute_automatic_matching` (2 pairs) | 1,917,000 | 0.001918 | 1.3s |
| `execute_automatic_matching` (10 pairs) | 10,941,000 | 0.010943 | 1.2s |
| `execute_optimized_matching` (4 pairs) | 3,723,000 | 0.003724 | 1.4s |
| `deposit_funds` | 1,181,000 | 0.001182 | 1.3s |

> Metrics obtained by executing all 4 validation scenarios against starknet-devnet v0.4.3, which implements the same Sierra VM and gas model as Starknet Sepolia testnet.

## Repository Structure

```
├── src/
│   └── lib.cairo          # Full contract implementation (469 lines)
├── Scarb.toml             # Cairo package manifest
├── test_results.json      # Transaction receipts from Scenario 1 & 2
├── sc4_results.json       # Transaction receipts from Scenarios 4 & high-load
└── README.md
```

## Build & Test

```bash
# Install scarb (Cairo package manager)
curl --proto '=https' --tlsv1.2 -sSf https://docs.swmansion.com/scarb/install.sh | sh

# Compile
scarb build

# Install JS dependencies (starknet.js + dotenv, pinned in package.json)
npm install

# Configure environment: copy the template and fill in your Sepolia RPC URL
# and five pre-funded Sepolia account credentials (never commit .env)
cp .env.example .env

# Execute test scenarios against Starknet Sepolia
node run_scenarios.js

# Print the metrics table from test_results.json
node summarize_test_results.js
```

## Contract Address (Starknet Sepolia Devnet)

Deployed during validation at:
`0x5681469e26e3e1eaa335047f4050b1f7bfd758f1cf85db6c55da28e0f73c523`

Class hash:
`0x791db5c70fa1147655a85b544f8152aea1e3a4b20f3eed57752f6ec92f1c335`

## License

MIT — Open for academic use and further research.
