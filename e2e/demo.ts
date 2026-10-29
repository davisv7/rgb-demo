import { AssetConfig, PaymentCallback, PaymentStatus } from '../src/types';
import { PaymentModule } from '../src/payment-module';
import { RlnClient } from '../src/rln-client';

const PAYEE_URL = process.env.PAYEE_RLN_URL ?? 'http://rln-payee:3001';
const PAYER_URL = process.env.PAYER_RLN_URL ?? 'http://rln-payer:3001';

const HR  = '━'.repeat(68);
const HR2 = '═'.repeat(68);

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function shortInvoice(invoice: string): string {
  return invoice.slice(0, 16) + '…' + invoice.slice(-24);
}

async function waitForSettlement(
  results: Map<string, PaymentStatus>,
  ids: string[],
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ids.every(id => results.has(id))) return;
    await sleep(500);
  }
  const missing = ids.filter(id => !results.has(id));
  throw new Error(`Timeout waiting for: ${missing.join(', ')}`);
}

async function main(): Promise<void> {
  const payeeClient = new RlnClient(PAYEE_URL);
  const payerClient = new RlnClient(PAYER_URL);

  const [channels, { rgb_htlc_min_msat }] = await Promise.all([
    payeeClient.listChannels(),
    payeeClient.nodeInfo(),
  ]);
  const rgbChannel = channels.find(c => c.asset_id && c.is_usable);
  if (!rgbChannel?.asset_id) throw new Error('no usable RGB channel found on payee');
  const ASSET_ID = rgbChannel.asset_id;

  const assetRegistry = new Map<string, AssetConfig>([
    ['USDT', { assetId: ASSET_ID, ticker: 'USDT', precision: 0 }],
  ]);

  const results = new Map<string, PaymentStatus>();

  const callback: PaymentCallback = async (invoiceId, status) => {
    results.set(invoiceId, status);
    const icon = status === 'paid' ? '✓' : '✗';
    console.log(`  ${icon} callback fired  ${invoiceId} → ${status}`);
  };

  const module = new PaymentModule(payeeClient, assetRegistry, rgb_htlc_min_msat);
  module.setCallback(callback);

  // ── Header ──────────────────────────────────────────────────────────────────
  console.log(`\n${HR2}`);
  console.log('  RGB Lightning Payment Module — End-to-End Demo');
  console.log(HR2);
  console.log(`\n  asset   ${ASSET_ID}`);
  console.log(`  payee   ${PAYEE_URL}`);
  console.log(`  payer   ${PAYER_URL}\n`);

  // ── Scenario 1: paid ────────────────────────────────────────────────────────
  console.log(`${HR}`);
  console.log('  Scenario 1 of 3 — Successful Payment');
  console.log(`${HR}`);
  console.log('  Payee creates an invoice for 1000 USDT (2 min expiry).');
  console.log('  Payer sends the payment. Callback must fire with "paid".\n');

  const d1 = await module.expectPayment('pay-001', 'USDT', 1000n, 120);
  console.log(`  invoice  ${shortInvoice(d1.invoice)}`);
  console.log(`  amount   ${d1.amount} USDT  (${d1.amtMsat} msat)\n`);

  console.log('  payer sending…');
  await payerClient.sendPayment({ invoice: d1.invoice, asset_id: d1.assetId, asset_amount: d1.amount });
  await waitForSettlement(results, ['pay-001']);

  // ── Scenario 2: expired ─────────────────────────────────────────────────────
  console.log(`\n${HR}`);
  console.log('  Scenario 2 of 3 — Expired Payment');
  console.log(`${HR}`);
  console.log('  Payee creates an invoice with a 12-second expiry.');
  console.log('  No payment is sent. Callback must fire with "expired".\n');

  const d2 = await module.expectPayment('pay-002', 'USDT', 500n, 12);
  console.log(`  invoice  ${shortInvoice(d2.invoice)}`);
  console.log(`  amount   ${d2.amount} USDT  (expires in 12s — not paying)\n`);

  console.log('  waiting for expiry…');
  // 12s invoice + up to 2s poll interval + headroom for slow environments
  await waitForSettlement(results, ['pay-002'], 30_000);

  // ── Scenario 3: concurrent, out-of-order ────────────────────────────────────
  console.log(`\n${HR}`);
  console.log('  Scenario 3 of 3 — Concurrent Out-of-Order Payments');
  console.log(`${HR}`);
  console.log('  Three invoices are created simultaneously.');
  console.log('  They are paid in reverse order (c → a → b).');
  console.log('  Each callback must fire independently with "paid".\n');

  const [d3a, d3b, d3c] = await Promise.all([
    module.expectPayment('pay-003a', 'USDT', 100n, 120),
    module.expectPayment('pay-003b', 'USDT', 200n, 120),
    module.expectPayment('pay-003c', 'USDT', 300n, 120),
  ]);

  console.log(`  pay-003a  ${shortInvoice(d3a.invoice)}  100 USDT`);
  console.log(`  pay-003b  ${shortInvoice(d3b.invoice)}  200 USDT`);
  console.log(`  pay-003c  ${shortInvoice(d3c.invoice)}  300 USDT`);
  console.log('');

  // Paid in reverse creation order without waiting for any settlement in between.
  await payerClient.sendPayment({ invoice: d3c.invoice, asset_id: d3c.assetId, asset_amount: d3c.amount });
  await payerClient.sendPayment({ invoice: d3a.invoice, asset_id: d3a.assetId, asset_amount: d3a.amount });
  await payerClient.sendPayment({ invoice: d3b.invoice, asset_id: d3b.assetId, asset_amount: d3b.amount });

  await waitForSettlement(results, ['pay-003a', 'pay-003b', 'pay-003c']);

  await module.close();

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(`\n${HR2}`);
  console.log('  Results');
  console.log(HR2);

  const expected: Record<string, PaymentStatus> = {
    'pay-001':  'paid',
    'pay-002':  'expired',
    'pay-003a': 'paid',
    'pay-003b': 'paid',
    'pay-003c': 'paid',
  };

  let allPassed = true;
  for (const [id, want] of Object.entries(expected)) {
    const got  = results.get(id);
    const pass = got === want;
    const icon = pass ? '✓' : '✗';
    if (!pass) allPassed = false;
    console.log(`  ${icon}  ${id.padEnd(10)}  ${(got ?? 'missing').padEnd(8)}  (expected ${want})`);
  }

  console.log('');
  if (!allPassed) {
    console.error('  FAILED — one or more scenarios produced unexpected results.');
    process.exit(1);
  }
  console.log('  All scenarios passed.');
  console.log(`${HR2}\n`);
}

main().catch(err => {
  console.error('Demo failed:', err);
  process.exit(1);
});
