import * as net from 'net';
import { RlnClient } from '../src/rln-client';
import { UnlockConfig } from '../src/types';

// ── Config ────────────────────────────────────────────────────────────────────

const BITCOIN_HOST   = process.env.BITCOIN_HOST   ?? 'bitcoind';
const BITCOIN_PORT   = Number(process.env.BITCOIN_PORT ?? '18443');
const BITCOIN_USER   = process.env.BITCOIN_USER   ?? 'user';
const BITCOIN_PASS   = process.env.BITCOIN_PASS   ?? 'password';
const PAYEE_URL      = process.env.PAYEE_RLN_URL  ?? 'http://rln-payee:3001';
const PAYER_URL      = process.env.PAYER_RLN_URL  ?? 'http://rln-payer:3001';
const PROXY_ENDPOINT = process.env.PROXY_ENDPOINT ?? 'rpc://proxy:3000/json-rpc';
const ELECTRS_HOST   = process.env.ELECTRS_HOST   ?? 'electrs';
const ELECTRS_PORT   = Number(process.env.ELECTRS_PORT ?? '50001');
const NODE_PASSWORD  = 'nodepassword';
const BURN_ADDR      = 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080';

// ── Logging ───────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

function log(msg: string): void {
  console.log(`[setup] ${msg}`);
}

function section(label: string): void {
  console.log(`\n── ${label} ${'─'.repeat(Math.max(0, 50 - label.length))}`);
}

// ── Retry ─────────────────────────────────────────────────────────────────────

async function retry<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  intervalMs: number,
  label: string,
): Promise<T> {
  for (let i = 0; i < maxAttempts; i++) {
    try { return await fn(); } catch { /* retry */ }
    if (i < maxAttempts - 1) await sleep(intervalMs);
  }
  throw new Error(`${label} not ready after ${maxAttempts} attempts`);
}

// ── Bitcoin RPC ───────────────────────────────────────────────────────────────

async function btcRpc(method: string, params: unknown[] = []): Promise<unknown> {
  const auth = Buffer.from(`${BITCOIN_USER}:${BITCOIN_PASS}`).toString('base64');
  const res = await fetch(`http://${BITCOIN_HOST}:${BITCOIN_PORT}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'setup', method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`bitcoind ${method} → ${res.status}`);
  const { result, error } = await res.json() as { result: unknown; error: unknown };
  if (error) throw new Error(`bitcoind ${method}: ${JSON.stringify(error)}`);
  return result;
}

const mine = (count: number, addr: string): Promise<unknown> =>
  btcRpc('generatetoaddress', [count, addr]);

// ── Network checks ────────────────────────────────────────────────────────────

function checkTcp(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(port, host);
    s.once('connect', () => { s.destroy(); resolve(); });
    s.once('error', reject);
  });
}

function checkElectrum(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(port, host);
    const req = JSON.stringify({
      jsonrpc: '2.0', method: 'server.version', params: ['setup', '1.4'], id: 1,
    }) + '\n';
    s.once('connect', () => s.write(req));
    s.once('data', data => {
      s.destroy();
      data.toString().includes('"result"')
        ? resolve()
        : reject(new Error('unexpected Electrum response'));
    });
    s.once('error', reject);
    s.setTimeout(3_000, () => { s.destroy(); reject(new Error('electrum timeout')); });
  });
}

// ── RLN wait helpers ──────────────────────────────────────────────────────────

async function waitUnlocked(client: RlnClient, label: string): Promise<void> {
  log(`waiting for ${label} to be unlocked…`);
  await retry(() => client.nodeInfo(), 60, 1_000, `${label} unlock`);
  log(`${label} is unlocked`);
}

async function waitBtcBalance(client: RlnClient, label: string): Promise<void> {
  log(`waiting for ${label} BTC balance…`);
  await retry(async () => {
    const { vanilla } = await client.btcBalance(false);
    if (vanilla.settled === 0) throw new Error('no balance yet');
  }, 120, 2_000, `${label} BTC balance`);
  log(`${label} has BTC`);
}

async function waitChannelUsable(
  client: RlnClient,
  assetId: string,
  miningAddr: string,
): Promise<void> {
  log('waiting for channel to become usable…');
  await retry(async () => {
    const channels = await client.listChannels();
    if (channels.find(c => c.asset_id === assetId && c.is_usable)) return;
    const mempool = await btcRpc('getrawmempool') as string[];
    if (mempool.length > 0) {
      log(`  ${mempool.length} pending tx(s) — mining 6 blocks…`);
      await mine(6, miningAddr);
    }
    throw new Error('channel not yet usable');
  }, 120, 2_000, 'channel usable');
  log('RGB consignment confirmed — channel is usable');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  section('1/7  Service Readiness');

  log('waiting for bitcoind RPC…');
  await retry(() => btcRpc('getblockchaininfo'), 120, 1_000, 'bitcoind');
  log('bitcoind ready');

  log('waiting for electrs TCP…');
  await retry(() => checkTcp(ELECTRS_HOST, ELECTRS_PORT), 120, 1_000, 'electrs TCP');

  // A single mined block clears IBD so electrs begins serving Electrum RPC.
  log('mining 1 block to clear IBD…');
  await mine(1, BURN_ADDR);

  log('waiting for electrs Electrum RPC…');
  await retry(() => checkElectrum(ELECTRS_HOST, ELECTRS_PORT), 60, 2_000, 'electrs Electrum RPC');
  log('electrs Electrum RPC is up');

  const payee = new RlnClient(PAYEE_URL, 30_000);
  const payer = new RlnClient(PAYER_URL, 30_000);

  // TCP readiness already confirmed by docker-compose healthcheck before this
  // container started. nodeInfo() requires the node to be unlocked, so we
  // defer that check to waitUnlocked() below (after init + unlock).

  section('2/7  Node Initialization');
  for (const [client, label] of [[payee, 'payee'], [payer, 'payer']] as Array<[RlnClient, string]>) {
    try { await client.init(NODE_PASSWORD); log(`${label} initialised`); }
    catch { log(`${label} already initialised`); }
  }

  section('3/7  Node Unlock');
  const mkUnlockCfg = (alias: string): UnlockConfig => ({
    password: NODE_PASSWORD,
    bitcoindRpcUsername: BITCOIN_USER,
    bitcoindRpcPassword: BITCOIN_PASS,
    bitcoindRpcHost: BITCOIN_HOST,
    bitcoindRpcPort: BITCOIN_PORT,
    indexerUrl: `${ELECTRS_HOST}:${ELECTRS_PORT}`,
    proxyEndpoint: PROXY_ENDPOINT,
    announceAlias: alias,
  });

  for (const [client, alias, label] of [
    [payee, 'payee-node', 'payee'],
    [payer, 'payer-node', 'payer'],
  ] as Array<[RlnClient, string, string]>) {
    try { await client.unlock(mkUnlockCfg(alias)); log(`${label} unlock requested`); }
    catch { log(`${label} may already be unlocked — continuing`); }
  }

  await Promise.all([waitUnlocked(payee, 'payee'), waitUnlocked(payer, 'payer')]);

  section('4/7  Wallet Funding');
  const [payeeAddr, payerAddr] = await Promise.all([payee.address(), payer.address()]);
  log(`payee addr: ${payeeAddr}`);
  log(`payer addr: ${payerAddr}`);

  // Mine 101 to each wallet, then 101 more to bury all coinbases ≥100 deep.
  await mine(101, payerAddr);
  await mine(101, payeeAddr);
  await mine(101, BURN_ADDR);
  log('mined 303 funding+burial blocks; all coinbases mature');

  await Promise.all([waitBtcBalance(payer, 'payer'), waitBtcBalance(payee, 'payee')]);

  section('5/7  RGB UTXOs');
  log('creating UTXOs on payee and payer…');
  await Promise.all([
    payee.createUtxos({ up_to: false, num: 5, fee_rate: 5, skip_sync: false }),
    payer.createUtxos({ up_to: false, num: 5, fee_rate: 5, skip_sync: false }),
  ]);
  await mine(6, payerAddr);
  log('UTXO creation mined; waiting for sync…');

  section('6/7  Asset Issuance');
  log('issuing USDT asset…');
  const asset = await payer.issueAssetNia({
    amounts: [1_000_000],
    ticker: 'USDT',
    name: 'Test USDT',
    precision: 0,
  });
  log(`asset ID: ${asset.asset_id}`);

  section('7/7  Channel Setup');
  const { pubkey: payeePubkey } = await payee.nodeInfo();
  log(`payee pubkey: ${payeePubkey}`);

  log('connecting payer → payee…');
  await payer.connectPeer(`${payeePubkey}@rln-payee:9735`);
  await sleep(2_000);

  log('opening RGB channel…');
  await payer.openChannel({
    peer_pubkey_and_opt_addr: `${payeePubkey}@rln-payee:9735`,
    capacity_sat: 100_000,
    push_msat: 10_000_000,
    asset_id: asset.asset_id,
    asset_amount: 100_000n,
    public: true,
    with_anchors: true,
  });

  log('mining 6 blocks — LN funding tx requires 6 confirmations…');
  await mine(6, payerAddr);
  log('LN funding confirmed; waiting for RGB consignment anchor…');
  await waitChannelUsable(payer, asset.asset_id, payerAddr);

  log('════════════════════════════════════════');
  log('setup complete');
  log(`  ASSET_ID = ${asset.asset_id}`);
  log('════════════════════════════════════════');
}

main().catch(err => {
  console.error('[setup] Fatal:', err);
  process.exit(1);
});
