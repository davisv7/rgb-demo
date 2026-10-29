import { RlnClient } from '../src/rln-client';

const BITCOIN_HOST = process.env.BITCOIN_HOST   ?? 'bitcoind';
const BITCOIN_PORT = Number(process.env.BITCOIN_PORT ?? '18443');
const BITCOIN_USER = process.env.BITCOIN_USER   ?? 'user';
const BITCOIN_PASS = process.env.BITCOIN_PASS   ?? 'password';
const PAYER_URL    = process.env.PAYER_RLN_URL  ?? 'http://rln-payer:3001';
const BURN_ADDR    = 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080';

function log(msg: string): void {
  console.log(`[teardown] ${msg}`);
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

async function btcRpc(method: string, params: unknown[] = []): Promise<unknown> {
  const auth = Buffer.from(`${BITCOIN_USER}:${BITCOIN_PASS}`).toString('base64');
  const res = await fetch(`http://${BITCOIN_HOST}:${BITCOIN_PORT}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'teardown', method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`bitcoind ${method} → ${res.status}`);
  const { result, error } = await res.json() as { result: unknown; error: unknown };
  if (error) throw new Error(`bitcoind ${method}: ${JSON.stringify(error)}`);
  return result;
}

async function main(): Promise<void> {
  const payer = new RlnClient(PAYER_URL, 30_000);

  let channels;
  try {
    channels = await payer.listChannels();
  } catch (err) {
    log(`skip: payer unreachable (${(err as Error).message})`);
    return;
  }

  if (channels.length === 0) {
    log('no channels to close');
    return;
  }

  log(`closing ${channels.length} channel(s)…`);
  let closedCount = 0;
  for (const ch of channels) {
    try {
      await payer.closeChannel({
        channel_id: ch.channel_id,
        peer_pubkey: ch.peer_pubkey,
        force: false,
      });
      log(`  closed ${ch.channel_id.slice(0, 16)}…`);
      closedCount++;
    } catch (err) {
      log(`  warn: ${(err as Error).message}`);
    }
  }

  // RLN's /closechannel returns before the settlement tx is actually broadcast —
  // poll bitcoind's mempool so we don't mine blocks that confirm nothing.
  if (closedCount > 0) {
    log(`waiting for ${closedCount} close tx(s) to hit mempool…`);
    const deadline = Date.now() + 30_000;
    let mempool: string[] = [];
    while (Date.now() < deadline) {
      mempool = await btcRpc('getrawmempool') as string[];
      if (mempool.length >= closedCount) break;
      await sleep(500);
    }
    if (mempool.length >= closedCount) {
      log(`  ${mempool.length} tx(s) in mempool`);
    } else {
      log(`  warn: only ${mempool.length}/${closedCount} tx(s) in mempool after 30s — mining anyway`);
    }
  }

  log('mining 6 blocks to confirm close transactions…');
  await btcRpc('generatetoaddress', [6, BURN_ADDR]);
  log('teardown complete');
}

main().catch(err => {
  console.error('[teardown] fatal:', err);
  process.exit(1);
});
