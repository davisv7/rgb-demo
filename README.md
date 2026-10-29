# rgb-demo

A TypeScript module that accepts USDT-like RGB asset payments over the Lightning Network,
backed by two [RGB Lightning Node](https://github.com/RGB-Tools/rgb-lightning-node) instances
running on Bitcoin regtest.

## How to run

**Prerequisites:** Docker (Engine ≥ 23 or Desktop ≥ 4.x). Docker builds one local image (the `e2e` runner); all other service images are pulled from public registries.

```bash
docker compose run e2e
```

`docker compose run e2e` starts all dependencies (bitcoind, electrs, proxy, two RLN nodes),
runs `scripts/setup.js` to mine blocks / issue the asset / open a channel, then runs the
TypeScript demo which exercises three scenarios:

1. A payment created and fully paid → callback fires with `'paid'`
2. A payment created with a 12-second expiry, never paid → callback fires with `'expired'`
3. Three payments created concurrently, paid in reverse order → each callback fires correctly

### Re-running

Volumes persist between runs. Tear them down first if you want a clean state:

```bash
docker compose down -v
docker compose run e2e
```

### Unit tests (no environment needed)

```bash
cd rgb-demo
npm ci
npm test
```

## Architecture

```
src/
  types.ts            — PaymentDetails, AssetConfig, RLN API shapes
  rln-client.ts       — Typed HTTP client for the RLN REST API
  payment-module.ts   — PaymentModule: expectPayment() + setCallback()
e2e/
  demo.ts             — Three-scenario end-to-end demo
__tests__/
  payment-module.test.ts  — Unit tests (RlnClient mocked)
scripts/
  setup.ts            — Regtest environment bootstrap (TypeScript)
  entrypoint.sh       — Thin launcher: runs setup.js then demo.js
docker-compose.yml    — All six services (uses pre-built images; see Pinned versions table)
Dockerfile            — Node.js image for e2e runner (built locally by compose)
```

### Payment flow

```
Payee (PaymentModule)               Payer (e2e demo)
─────────────────────────────────   ──────────────────────────────
POST /lninvoice {amt_msat, expiry}
  → bolt11 invoice string

return PaymentDetails {
  invoice,       ← hand to payer
  assetId,       ← payer must include
  amount,        ← payer must include
  ...
}

poll /invoicestatus every 2 s       POST /sendpayment {
                                      invoice,
                                      asset_id,
                                      asset_amount,
                                    }

status == Succeeded                 Lightning + RGB settle atomically
  → callback('paid')
status == Expired / wall-clock
  → callback('expired')
```

The RLN node validates that the received asset ID and amount match the invoice before
releasing the payment preimage
([RGB-Tools/rgb-lightning-node#180](https://github.com/RGB-Tools/rgb-lightning-node/pull/180)),
so underpayments and wrong-asset payments are rejected at the node level.

### Pinned versions

| Component | Image / Tag |
|-----------|-------------|
| rgb-lightning-node | `huhwhat/rgb-lightning-node:pr180` |
| electrs | `registry.gitlab.com/hashbeam/docker/electrs:0.11.0` |
| rgb-proxy-server | `ghcr.io/rgb-tools/rgb-proxy-server:0.3.0` |
| bitcoind | `ruimarinho/bitcoin-core:28` |

## Known limitations

- **`--disable-authentication` flag** — used on both RLN nodes for demo simplicity.
  If the pinned RLN version doesn't recognise this flag, the nodes won't start; switch
  to a version that does or add Biscuit-token management to `RlnClient`.

- **Single-hop channel** — the demo opens a direct channel between payer and payee.
  Multi-hop RGB routing is not exercised.

- **Hardcoded regtest credentials** — `bitcoind` RPC credentials (`user`/`password`) are
  hardcoded in `docker-compose.yml`. This is intentional for a self-contained regtest
  environment with no external exposure. A production deployment must move credentials
  to a secrets manager or at minimum an uncommitted `.env` file.

- **Asset amount precision limit** — the RLN REST API accepts `asset_amount` as a JSON
  number (IEEE 754 double), which cannot safely represent integers above `2^53 - 1`
  (~9 quadrillion). For assets with high precision or large supply (e.g. real USDT at
  6 decimal places with ~140 billion circulating supply ≈ 1.4 × 10^17 base units), amounts
  above this threshold will be rejected with an explicit error rather than silently
  truncated. A production integration would require the RLN API to accept amounts as
  strings.
