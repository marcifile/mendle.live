# mendle-engine

Backend engine for **mendle.live**.

Mendle is a continuous digital genetics experiment:

```
market data
  -> market scores
  -> habitat
  -> fitness
  -> selection
  -> reproduction + mutation
  -> next generation
  -> lineages + notebook
```

## What this service does

- Watches the single `project_config` row created by Lovable.
- When `/op5` stores a CA and sets `mode=validating_mint`, the worker:
  1. validates the Solana mint with RPC,
  2. locates the token's highest-liquidity DexScreener pair,
  3. starts a 2-second market poll,
  4. seeds generation 000 with 128 organisms,
  5. waits for the first 5-minute observation window,
  6. computes market scores + habitat,
  7. runs selection, reproduction and mutation,
  8. repeats every 5 minutes.
- Writes status, logs, market state, snapshots, generations, organisms, lineages, events and epochs into Lovable Cloud / Supabase.
- Respects `is_paused` and `manual_generation_requested`.

## V1 market model

Five scores:

- **volatility**: realized log-return volatility vs recent baseline
- **activity**: current 5m volume + trade count vs recent baseline
- **depth**: liquidity relative to current 5m volume
- **direction**: buy/sell transaction imbalance, -1 to +1
- **disturbance**: how far the current regime is from recent score history

Habitat mapping is direct:

- volatility -> temperature
- activity -> nutrients
- depth -> capacity
- direction -> current
- disturbance -> disturbance

DexScreener supplies current pair data. Because its public token-pair response provides buy/sell **counts**, not per-side USD volume, V1 estimates buy/sell volume by splitting 5m volume according to buy/sell count. Direction itself uses the actual buy/sell counts.

## Genetics

Six genes, each 0-99:

- A resilience
- B efficiency
- C mobility
- D fertility
- E size
- F plasticity

Fitness is environment-dependent; there is no universally best genome.

Children inherit each locus from either parent. Mutation probability increases modestly with disturbance. A sufficiently large mutation creates a lineage split.

## Epochs

24 generations = 1 epoch (~2 hours with 5-minute generations).

At epoch close, the current dominant lineage is archived and its strongest trait creates a small, capped legacy effect for the next two epochs.

## Railway

Create a Railway service from this repository and copy the variables from `.env.example`.

Do **not** put the token CA in Railway. The CA lives in `project_config.contract_address` and is entered from `/op5`.

Required secrets:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SOLANA_RPC_URL`

`MENDLE_PROJECT_ID` is optional when there is exactly one project_config row.

## Safety / recovery

The engine never holds private keys and never executes trades. It only observes the market and writes simulation state.

On restart it reloads current state from Supabase. Existing generation/organism history is not reset unless the database is reset manually.
