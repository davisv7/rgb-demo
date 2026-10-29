import { RlnClient } from './rln-client';
import {
  AssetConfig,
  InvoiceStatus,
  PaymentCallback,
  PaymentDetails,
  PaymentStatus,
  PendingEntry,
} from './types';

export class PaymentModule {
  private callback: PaymentCallback | null = null;
  private readonly pending = new Map<string, PendingEntry>();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private inflightPoll: Promise<void> | null = null;
  private closed = false;

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

    const entry: PendingEntry = { invoice, expiresAt };
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
    if (this.closed) return;
    this.pollTimer = setTimeout(() => {
      this.inflightPoll = this.poll().finally(() => {
        this.inflightPoll = null;
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
      await this.settle(invoiceId, 'paid');
    } else if (status === 'Expired' || status === 'Failed') {
      await this.settle(invoiceId, 'expired');
    }
    // 'Pending' → keep polling
  }

  private async settle(invoiceId: string, status: PaymentStatus): Promise<void> {
    this.pending.delete(invoiceId);
    if (!this.callback) return;
    try {
      await this.callback(invoiceId, status);
    } catch (err) {
      console.error(`[PaymentModule] callback error for ${invoiceId}:`, err);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.pollTimer !== null) { clearTimeout(this.pollTimer); this.pollTimer = null; }
    if (this.inflightPoll) await this.inflightPoll;
  }
}
