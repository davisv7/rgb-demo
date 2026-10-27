import { RlnClient } from './rln-client';
import {
  AssetConfig,
  InvoiceStatus,
  PaymentCallback,
  PaymentDetails,
  PaymentStatus,
  PendingEntry,
  RlnPayment,
} from './types';

// ── bolt11 payment hash extraction ────────────────────────────────────────────

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function bolt11PaymentHash(invoice: string): string {
  const lower = invoice.toLowerCase();
  const sep = lower.lastIndexOf('1');
  if (sep < 0) throw new Error('invalid bolt11: no separator');
  const dataChars = lower.slice(sep + 1, -6); // strip 6-char checksum

  const words = Array.from(dataChars).map(c => {
    const v = BECH32_CHARSET.indexOf(c);
    if (v < 0) throw new Error(`invalid bech32 char: ${c}`);
    return v;
  });

  let pos = 7; // skip 7-word (35-bit) timestamp
  while (pos + 2 < words.length) {
    const type = words[pos];
    const len  = (words[pos + 1] << 5) | words[pos + 2];
    pos += 3;
    if (type === 1 && len === 52) { // 'p' tag — 52 × 5-bit words = 256-bit hash
      const bytes: number[] = [];
      let acc = 0, bits = 0;
      for (const w of words.slice(pos, pos + len)) {
        acc = (acc << 5) | w;
        bits += 5;
        if (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 0xff); }
      }
      return Buffer.from(bytes).toString('hex');
    }
    pos += len;
  }
  throw new Error('payment hash (p tag) not found in invoice');
}

export class PaymentModule {
  private callback: PaymentCallback | null = null;
  private readonly pending = new Map<string, PendingEntry>();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly rlnClient: RlnClient,
    private readonly assetRegistry: Map<string, AssetConfig>,
    private readonly minAmtMsat: number = 3_000_000,
    private readonly pollIntervalMs: number = 2_000,
  ) {}

  setCallback(callback: PaymentCallback): void {
    this.callback = callback;
  }

  async expectPayment(
    invoiceId: string,
    currency: string,
    amount: bigint,
    expirySeconds = 1800,
  ): Promise<PaymentDetails> {
    if (this.pending.has(invoiceId))
      throw new Error(`invoiceId already in use: ${invoiceId}`);

    const asset = this.assetRegistry.get(currency);
    if (!asset) throw new Error(`Unknown currency: ${currency}`);

    const expiresAt = new Date(Date.now() + expirySeconds * 1_000);

    const { invoice } = await this.rlnClient.lnInvoice({
      amt_msat: this.minAmtMsat,
      expiry_sec: expirySeconds,
      description: `${currency} payment ${invoiceId}`,
      asset_id: asset.assetId,
      asset_amount: amount,
    });

    const entry: PendingEntry = { invoice, assetId: asset.assetId, currency, amount, expiresAt };
    this.pending.set(invoiceId, entry);

    if (this.pollTimer === null) this.scheduleNextPoll();

    return {
      invoiceId,
      invoice,
      assetId: asset.assetId,
      currency,
      amount,
      amtMsat: this.minAmtMsat,
      expiresAt,
    };
  }

  private scheduleNextPoll(): void {
    this.pollTimer = setTimeout(() => {
      void this.poll().finally(() => {
        if (this.pending.size > 0) this.scheduleNextPoll();
        else this.pollTimer = null;
      });
    }, this.pollIntervalMs);
  }

  private async poll(): Promise<void> {
    const now = new Date();
    await Promise.all(
      [...this.pending].map(([invoiceId, entry]) => this.check(invoiceId, entry, now)),
    );
  }

  private async check(invoiceId: string, entry: PendingEntry, now: Date): Promise<void> {
    if (now >= entry.expiresAt) {
      await this.settle(invoiceId, 'expired');
      return;
    }
    let status: InvoiceStatus;
    try {
      status = await this.rlnClient.invoiceStatus(entry.invoice);
    } catch {
      return; // transient error — retry next tick
    }
    if (status === 'Succeeded') {
      const verified = await this.verifyPayment(entry);
      await this.settle(invoiceId, verified ? 'paid' : 'invalid');
    } else if (status === 'Expired' || status === 'Failed') {
      await this.settle(invoiceId, 'expired');
    }
    // 'Pending' → keep polling
  }

  private async verifyPayment(entry: PendingEntry): Promise<boolean> {
    let payments: RlnPayment[];
    try {
      payments = await this.rlnClient.listPayments();
    } catch {
      return false; // fail closed
    }
    let paymentHash: string;
    try {
      paymentHash = bolt11PaymentHash(entry.invoice);
    } catch {
      return false;
    }
    const match = payments.find(p => p.inbound && p.payment_hash.toLowerCase() === paymentHash.toLowerCase());
    if (!match) return false;
    if (match.asset_id !== entry.assetId) {
      console.warn(`[PaymentModule] asset mismatch on ${paymentHash}: expected ${entry.assetId}, got ${match.asset_id}`);
      return false;
    }
    if (match.asset_amount == null) {
      console.warn(`[PaymentModule] null asset_amount on ${paymentHash}`);
      return false;
    }
    if (match.asset_amount !== Number(entry.amount)) {
      console.warn(`[PaymentModule] amount mismatch on ${paymentHash}: expected ${entry.amount}, got ${match.asset_amount}`);
      return false;
    }
    return true;
  }

  private async settle(invoiceId: string, status: PaymentStatus): Promise<void> {
    if (!this.callback) { this.pending.delete(invoiceId); return; }
    try {
      await this.callback(invoiceId, status);
    } catch (err) {
      console.error(`[PaymentModule] callback error for ${invoiceId}:`, err);
    }
    this.pending.delete(invoiceId);
  }

  close(): void {
    if (this.pollTimer !== null) { clearTimeout(this.pollTimer); this.pollTimer = null; }
  }
}
