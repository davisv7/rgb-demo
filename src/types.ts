export interface PaymentDetails {
  invoiceId: string;
  invoice: string;     // bolt11 LN invoice — hand this to the payer
  assetId: string;     // RGB asset ID — payer must include this in sendpayment
  currency: string;    // e.g. "USDT"
  amount: bigint;      // expected asset units — payer must include this in sendpayment
  amtMsat: number;     // sats side of the HTLC (≥ rgb_htlc_min_msat)
  expiresAt: Date;
}

export type PaymentStatus = 'paid' | 'expired' | 'invalid';
export type PaymentCallback = (invoiceId: string, status: PaymentStatus) => Promise<void>;

export interface AssetConfig {
  assetId: string;
  ticker: string;
  precision: number;
}

// ── RLN API shapes ────────────────────────────────────────────────────────────

export interface NodeInfo {
  pubkey: string;
  num_channels: number;
  num_usable_channels: number;
  local_balance_sat: number;
  rgb_htlc_min_msat: number;
  rgb_channel_capacity_min_sat: number;
  channel_capacity_min_sat: number;
  network_nodes: number;
  network_channels: number;
}

export interface Channel {
  channel_id: string;
  funding_txid?: string;
  peer_pubkey: string;
  status: 'Opening' | 'Opened' | 'Closing';
  ready: boolean;
  capacity_sat: number;
  local_balance_sat: number;
  outbound_balance_msat: number;
  inbound_balance_msat: number;
  is_usable: boolean;
  public: boolean;
  asset_id?: string;
  asset_local_amount?: number;
  asset_remote_amount?: number;
}

export type InvoiceStatus = 'Pending' | 'Succeeded' | 'Failed' | 'Expired';

export interface PendingEntry {
  invoice: string;
  assetId: string;
  currency: string;
  amount: bigint;
  expiresAt: Date;
}

export interface RlnPayment {
  payment_hash: string;
  inbound: boolean;
  asset_id?: string | null;
  asset_amount?: number | null;
}

export interface AssetNia {
  asset_id: string;
  ticker: string;
  name: string;
  precision: number;
  issued_supply: number;
  timestamp: number;
  balance: {
    settled: number;
    future: number;
    spendable: number;
    offchain_outbound: number;
    offchain_inbound: number;
  };
}

export interface UnlockConfig {
  password: string;
  bitcoindRpcUsername: string;
  bitcoindRpcPassword: string;
  bitcoindRpcHost: string;
  bitcoindRpcPort: number;
  indexerUrl: string;
  proxyEndpoint: string;
  announceAddresses?: string[];
  announceAlias?: string;
}
