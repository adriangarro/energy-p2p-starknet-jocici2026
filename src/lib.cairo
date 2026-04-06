use starknet::ContractAddress;

#[derive(Drop, Serde, Copy, starknet::Store)]
struct UserProfile {
    user_type: u8,       // 0=Consumer, 1=AGPE, 2=GD
    capacity_kw: u32,
    location_node: felt252,
    is_active: bool,
    registration_time: u64,
    total_generated: u32,
    total_consumed: u32,
}

#[derive(Drop, Serde, Copy, starknet::Store)]
struct EnergyBalance {
    available_kwh: u32,
    pending_kwh: u32,
    total_generated: u32,
    total_consumed: u32,
    financial_balance: u128,
    last_updated: u64,
}

#[derive(Drop, Serde, Copy, starknet::Store)]
struct EnergyOffer {
    seller: ContractAddress,
    amount_kwh: u32,
    price_per_kwh: u128,
    location_node: felt252,
    is_active: bool,
    created_at: u64,
}

#[derive(Drop, Serde, Copy, starknet::Store)]
struct EnergyDemand {
    buyer: ContractAddress,
    amount_kwh: u32,
    max_price_per_kwh: u128,
    location_node: felt252,
    is_active: bool,
    created_at: u64,
}

#[starknet::interface]
trait IEnergyP2PTrading<TContractState> {
    fn register_user(ref self: TContractState, user_type: u8, capacity_kw: u32, location_node: felt252);
    fn register_energy_measurement(ref self: TContractState, generated_kwh: u32, consumed_kwh: u32);
    fn deposit_funds(ref self: TContractState, amount: u128);
    fn withdraw_funds(ref self: TContractState, amount: u128);
    fn create_energy_offer(ref self: TContractState, amount_kwh: u32, price_per_kwh: u128);
    fn create_energy_demand(ref self: TContractState, amount_kwh: u32, max_price_per_kwh: u128);
    fn execute_automatic_matching(ref self: TContractState);
    fn execute_optimized_matching(ref self: TContractState);
    fn get_user_profile(self: @TContractState, user: ContractAddress) -> UserProfile;
    fn get_balance(self: @TContractState, user: ContractAddress) -> EnergyBalance;
    fn get_community_stats(self: @TContractState) -> (u32, u32, u32);
    fn get_base_price(self: @TContractState) -> u128;
}

#[starknet::contract]
mod EnergyP2PTradingV2 {
    use super::{UserProfile, EnergyBalance, EnergyOffer, EnergyDemand, IEnergyP2PTrading};
    use starknet::{ContractAddress, get_caller_address, get_block_timestamp};
    use starknet::storage::{
        StoragePointerReadAccess, StoragePointerWriteAccess,
        Map, StorageMapReadAccess, StorageMapWriteAccess,
    };

    #[storage]
    struct Storage {
        admin: ContractAddress,
        base_price_cop_kwh: u128,
        max_capacity_kw: u32,
        user_profiles: Map<ContractAddress, UserProfile>,
        energy_balances: Map<ContractAddress, EnergyBalance>,
        energy_offers: Map<u32, EnergyOffer>,
        energy_demands: Map<u32, EnergyDemand>,
        offer_count: u32,
        demand_count: u32,
        total_users: u32,
        total_energy_traded: u32,
        total_transactions: u32,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        UserRegistered: UserRegistered,
        EnergyMeasured: EnergyMeasured,
        FundsDeposited: FundsDeposited,
        FundsWithdrawn: FundsWithdrawn,
        EnergyOfferCreated: EnergyOfferCreated,
        EnergyDemandCreated: EnergyDemandCreated,
        EnergyTraded: EnergyTraded,
    }

    #[derive(Drop, starknet::Event)]
    struct UserRegistered {
        #[key]
        user: ContractAddress,
        user_type: u8,
        capacity_kw: u32,
    }

    #[derive(Drop, starknet::Event)]
    struct EnergyMeasured {
        #[key]
        user: ContractAddress,
        generated_kwh: u32,
        consumed_kwh: u32,
        surplus_kwh: u32,
    }

    #[derive(Drop, starknet::Event)]
    struct FundsDeposited {
        #[key]
        user: ContractAddress,
        amount: u128,
    }

    #[derive(Drop, starknet::Event)]
    struct FundsWithdrawn {
        #[key]
        user: ContractAddress,
        amount: u128,
    }

    #[derive(Drop, starknet::Event)]
    struct EnergyOfferCreated {
        #[key]
        offer_id: u32,
        seller: ContractAddress,
        amount_kwh: u32,
        price_per_kwh: u128,
    }

    #[derive(Drop, starknet::Event)]
    struct EnergyDemandCreated {
        #[key]
        demand_id: u32,
        buyer: ContractAddress,
        amount_kwh: u32,
        max_price_per_kwh: u128,
    }

    #[derive(Drop, starknet::Event)]
    struct EnergyTraded {
        #[key]
        transaction_id: u32,
        seller: ContractAddress,
        buyer: ContractAddress,
        amount_kwh: u32,
        price_per_kwh: u128,
        total_amount: u128,
    }

    #[constructor]
    fn constructor(ref self: ContractState, admin: ContractAddress, base_price: u128, max_capacity: u32) {
        self.admin.write(admin);
        self.base_price_cop_kwh.write(base_price);
        self.max_capacity_kw.write(max_capacity);
        self.offer_count.write(0);
        self.demand_count.write(0);
        self.total_users.write(0);
        self.total_energy_traded.write(0);
        self.total_transactions.write(0);
    }

    #[abi(embed_v0)]
    impl EnergyP2PTradingImpl of super::IEnergyP2PTrading<ContractState> {

        fn register_user(ref self: ContractState, user_type: u8, capacity_kw: u32, location_node: felt252) {
            let caller = get_caller_address();
            assert(user_type <= 2, 'Invalid user type');
            assert(capacity_kw <= self.max_capacity_kw.read(), 'Capacity exceeds limit');
            // Consumer: type=0, max 50kW; AGPE: type=1, max 100kW; GD: type=2, min 10kW
            if user_type == 0 {
                assert(capacity_kw <= 50, 'Consumer max 50kW');
            } else if user_type == 2 {
                assert(capacity_kw >= 10, 'GD min 10kW');
            }
            let profile = UserProfile {
                user_type,
                capacity_kw,
                location_node,
                is_active: true,
                registration_time: get_block_timestamp(),
                total_generated: 0,
                total_consumed: 0,
            };
            self.user_profiles.write(caller, profile);
            let balance = EnergyBalance {
                available_kwh: 0,
                pending_kwh: 0,
                total_generated: 0,
                total_consumed: 0,
                financial_balance: 0,
                last_updated: get_block_timestamp(),
            };
            self.energy_balances.write(caller, balance);
            self.total_users.write(self.total_users.read() + 1);
            self.emit(UserRegistered { user: caller, user_type, capacity_kw });
        }

        fn register_energy_measurement(ref self: ContractState, generated_kwh: u32, consumed_kwh: u32) {
            let caller = get_caller_address();
            let profile = self.user_profiles.read(caller);
            assert(profile.is_active, 'User not registered');
            assert(profile.user_type != 0 || generated_kwh == 0, 'Consumer cannot generate');
            let surplus = if generated_kwh > consumed_kwh { generated_kwh - consumed_kwh } else { 0 };
            let mut balance = self.energy_balances.read(caller);
            balance.available_kwh += surplus;
            balance.total_generated += generated_kwh;
            balance.total_consumed += consumed_kwh;
            balance.last_updated = get_block_timestamp();
            self.energy_balances.write(caller, balance);
            self.emit(EnergyMeasured { user: caller, generated_kwh, consumed_kwh, surplus_kwh: surplus });
        }

        fn deposit_funds(ref self: ContractState, amount: u128) {
            let caller = get_caller_address();
            let profile = self.user_profiles.read(caller);
            assert(profile.is_active, 'User not registered');
            let mut balance = self.energy_balances.read(caller);
            balance.financial_balance += amount;
            self.energy_balances.write(caller, balance);
            self.emit(FundsDeposited { user: caller, amount });
        }

        fn withdraw_funds(ref self: ContractState, amount: u128) {
            let caller = get_caller_address();
            let mut balance = self.energy_balances.read(caller);
            assert(balance.financial_balance >= amount, 'Insufficient funds');
            balance.financial_balance -= amount;
            self.energy_balances.write(caller, balance);
            self.emit(FundsWithdrawn { user: caller, amount });
        }

        fn create_energy_offer(ref self: ContractState, amount_kwh: u32, price_per_kwh: u128) {
            let caller = get_caller_address();
            let profile = self.user_profiles.read(caller);
            assert(profile.is_active, 'User not registered');
            assert(profile.user_type != 0, 'Consumer cannot offer energy');
            let mut balance = self.energy_balances.read(caller);
            assert(balance.available_kwh >= amount_kwh, 'Insufficient energy');
            balance.available_kwh -= amount_kwh;
            balance.pending_kwh += amount_kwh;
            self.energy_balances.write(caller, balance);
            let offer_id = self.offer_count.read() + 1;
            self.offer_count.write(offer_id);
            let offer = EnergyOffer {
                seller: caller,
                amount_kwh,
                price_per_kwh,
                location_node: profile.location_node,
                is_active: true,
                created_at: get_block_timestamp(),
            };
            self.energy_offers.write(offer_id, offer);
            self.emit(EnergyOfferCreated { offer_id, seller: caller, amount_kwh, price_per_kwh });
        }

        fn create_energy_demand(ref self: ContractState, amount_kwh: u32, max_price_per_kwh: u128) {
            let caller = get_caller_address();
            let profile = self.user_profiles.read(caller);
            assert(profile.is_active, 'User not registered');
            let required_funds: u128 = amount_kwh.into() * max_price_per_kwh;
            let balance = self.energy_balances.read(caller);
            assert(balance.financial_balance >= required_funds, 'Insufficient funds');
            let demand_id = self.demand_count.read() + 1;
            self.demand_count.write(demand_id);
            let demand = EnergyDemand {
                buyer: caller,
                amount_kwh,
                max_price_per_kwh,
                location_node: profile.location_node,
                is_active: true,
                created_at: get_block_timestamp(),
            };
            self.energy_demands.write(demand_id, demand);
            self.emit(EnergyDemandCreated { demand_id, buyer: caller, amount_kwh, max_price_per_kwh });
        }

        // Baseline O(n²) algorithm
        fn execute_automatic_matching(ref self: ContractState) {
            let offer_count = self.offer_count.read();
            let demand_count = self.demand_count.read();
            let mut offer_id = 1;
            while offer_id <= offer_count {
                let offer = self.energy_offers.read(offer_id);
                if offer.is_active {
                    let mut demand_id = 1;
                    while demand_id <= demand_count {
                        let demand = self.energy_demands.read(demand_id);
                        if demand.is_active
                            && demand.max_price_per_kwh >= offer.price_per_kwh
                            && demand.location_node == offer.location_node {
                            let trade_amount = if offer.amount_kwh <= demand.amount_kwh {
                                offer.amount_kwh
                            } else {
                                demand.amount_kwh
                            };
                            self._execute_trade(offer.seller, demand.buyer, trade_amount, offer.price_per_kwh, offer_id, demand_id);
                            break;
                        }
                        demand_id += 1;
                    };
                }
                offer_id += 1;
            };
        }

        // Optimized O(n log n) algorithm — sort + two-pointer
        fn execute_optimized_matching(ref self: ContractState) {
            let offer_count = self.offer_count.read();
            let demand_count = self.demand_count.read();
            // Collect active offers into arrays
            let mut offer_ids: Array<u32> = ArrayTrait::new();
            let mut offer_prices: Array<u128> = ArrayTrait::new();
            let mut i = 1_u32;
            while i <= offer_count {
                let o = self.energy_offers.read(i);
                if o.is_active {
                    // Insertion sort ascending by price
                    let mut inserted = false;
                    let mut sorted_ids: Array<u32> = ArrayTrait::new();
                    let mut sorted_prices: Array<u128> = ArrayTrait::new();
                    let mut k = 0_u32;
                    while k < offer_ids.len() {
                        if !inserted && o.price_per_kwh <= *offer_prices.at(k) {
                            sorted_ids.append(i);
                            sorted_prices.append(o.price_per_kwh);
                            inserted = true;
                        }
                        sorted_ids.append(*offer_ids.at(k));
                        sorted_prices.append(*offer_prices.at(k));
                        k += 1;
                    };
                    if !inserted {
                        sorted_ids.append(i);
                        sorted_prices.append(o.price_per_kwh);
                    }
                    offer_ids = sorted_ids;
                    offer_prices = sorted_prices;
                }
                i += 1;
            };
            // Collect active demands sorted descending by max_price
            let mut demand_ids: Array<u32> = ArrayTrait::new();
            let mut demand_prices: Array<u128> = ArrayTrait::new();
            let mut j = 1_u32;
            while j <= demand_count {
                let d = self.energy_demands.read(j);
                if d.is_active {
                    let mut inserted = false;
                    let mut sorted_ids: Array<u32> = ArrayTrait::new();
                    let mut sorted_prices: Array<u128> = ArrayTrait::new();
                    let mut k = 0_u32;
                    while k < demand_ids.len() {
                        if !inserted && d.max_price_per_kwh >= *demand_prices.at(k) {
                            sorted_ids.append(j);
                            sorted_prices.append(d.max_price_per_kwh);
                            inserted = true;
                        }
                        sorted_ids.append(*demand_ids.at(k));
                        sorted_prices.append(*demand_prices.at(k));
                        k += 1;
                    };
                    if !inserted {
                        sorted_ids.append(j);
                        sorted_prices.append(d.max_price_per_kwh);
                    }
                    demand_ids = sorted_ids;
                    demand_prices = sorted_prices;
                }
                j += 1;
            };
            // Two-pointer scan
            let mut pi = 0_u32;
            let mut pj = 0_u32;
            while pi < offer_ids.len() && pj < demand_ids.len() {
                let oid = *offer_ids.at(pi);
                let did = *demand_ids.at(pj);
                let offer = self.energy_offers.read(oid);
                let demand = self.energy_demands.read(did);
                if demand.max_price_per_kwh >= offer.price_per_kwh {
                    let trade_amount = if offer.amount_kwh <= demand.amount_kwh {
                        offer.amount_kwh
                    } else {
                        demand.amount_kwh
                    };
                    self._execute_trade(offer.seller, demand.buyer, trade_amount, offer.price_per_kwh, oid, did);
                    pi += 1;
                    pj += 1;
                } else {
                    break;
                }
            };
        }

        fn get_user_profile(self: @ContractState, user: ContractAddress) -> UserProfile {
            self.user_profiles.read(user)
        }

        fn get_balance(self: @ContractState, user: ContractAddress) -> EnergyBalance {
            self.energy_balances.read(user)
        }

        fn get_community_stats(self: @ContractState) -> (u32, u32, u32) {
            (self.total_users.read(), self.total_energy_traded.read(), self.total_transactions.read())
        }

        fn get_base_price(self: @ContractState) -> u128 {
            self.base_price_cop_kwh.read()
        }
    }

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        fn _execute_trade(
            ref self: ContractState,
            seller: ContractAddress,
            buyer: ContractAddress,
            amount_kwh: u32,
            price_per_kwh: u128,
            offer_id: u32,
            demand_id: u32,
        ) {
            let total_amount: u128 = amount_kwh.into() * price_per_kwh;
            // Verify buyer has funds
            let mut buyer_balance = self.energy_balances.read(buyer);
            assert(buyer_balance.financial_balance >= total_amount, 'Buyer insufficient funds');
            // Transfer funds
            buyer_balance.financial_balance -= total_amount;
            buyer_balance.total_consumed += amount_kwh;
            self.energy_balances.write(buyer, buyer_balance);
            // Credit seller
            let mut seller_balance = self.energy_balances.read(seller);
            seller_balance.financial_balance += total_amount;
            seller_balance.pending_kwh -= amount_kwh;
            seller_balance.total_generated += amount_kwh;
            self.energy_balances.write(seller, seller_balance);
            // Update offer
            let mut offer = self.energy_offers.read(offer_id);
            if offer.amount_kwh <= amount_kwh {
                offer.is_active = false;
                offer.amount_kwh = 0;
            } else {
                offer.amount_kwh -= amount_kwh;
            }
            self.energy_offers.write(offer_id, offer);
            // Update demand
            let mut demand = self.energy_demands.read(demand_id);
            if demand.amount_kwh <= amount_kwh {
                demand.is_active = false;
                demand.amount_kwh = 0;
            } else {
                demand.amount_kwh -= amount_kwh;
            }
            self.energy_demands.write(demand_id, demand);
            // Update community stats
            let tx_id = self.total_transactions.read() + 1;
            self.total_transactions.write(tx_id);
            self.total_energy_traded.write(self.total_energy_traded.read() + amount_kwh);
            self.emit(EnergyTraded { transaction_id: tx_id, seller, buyer, amount_kwh, price_per_kwh, total_amount });
        }
    }
}
