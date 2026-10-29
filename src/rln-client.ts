import { z } from 'zod';
import {
  AssetNia,
  Channel,
  InvoiceStatus,
  NodeInfo,
  UnlockConfig,
} from './types';

// ── Response schemas ──────────────────────────────────────────────────────────

const nodeInfoSchema = z.object({
  pubkey: z.string(),
  num_channels: z.number(),
  num_usable_channels: z.number(),
  local_balance_sat: z.number(),
  rgb_htlc_min_msat: z.number(),
  rgb_channel_capacity_min_sat: z.number(),
  channel_capacity_min_sat: z.number(),
  network_nodes: z.number(),
  network_channels: z.number(),
});

const channelSchema = z.object({
  channel_id: z.string(),
  funding_txid: z.string().optional(),
  peer_pubkey: z.string(),
  status: z.enum(['Opening', 'Opened', 'Closing']),
  ready: z.boolean(),
  capacity_sat: z.number(),
  local_balance_sat: z.number(),
  outbound_balance_msat: z.number(),
  inbound_balance_msat: z.number(),
  is_usable: z.boolean(),
  public: z.boolean(),
  asset_id: z.string().optional(),
  asset_local_amount: z.number().optional(),
  asset_remote_amount: z.number().optional(),
});

const assetNiaSchema = z.object({
  asset_id: z.string(),
  ticker: z.string(),
  name: z.string(),
  precision: z.number(),
  issued_supply: z.number(),
  timestamp: z.number(),
  balance: z.object({
    settled: z.number(),
    future: z.number(),
    spendable: z.number(),
    offchain_outbound: z.number(),
    offchain_inbound: z.number(),
  }),
});

const initResponseSchema          = z.object({ mnemonic: z.string() });
const addressResponseSchema       = z.object({ address: z.string() });
const btcBalanceResponseSchema    = z.object({ vanilla: z.object({ settled: z.number() }) });
const assetResponseSchema         = z.object({ asset: assetNiaSchema });
const openChannelResponseSchema   = z.object({ temporary_channel_id: z.string() });
const channelsResponseSchema      = z.object({ channels: z.array(channelSchema) });
const lnInvoiceResponseSchema     = z.object({ invoice: z.string() });
const invoiceStatusResponseSchema = z.object({
  status: z.enum(['Pending', 'Succeeded', 'Failed', 'Expired']),
});
const sendPaymentResponseSchema   = z.object({
  payment_id: z.string(),
  status: z.enum(['Pending', 'Succeeded', 'Failed']),
  payment_hash: z.string().optional(),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

export function toSafeNumber(n: bigint): number {
  if (n > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error(`asset_amount ${n} exceeds MAX_SAFE_INTEGER — RLN API cannot represent this value safely as a JSON number`);
  return Number(n);
}

// ── Client ────────────────────────────────────────────────────────────────────

export class RlnClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number = 10_000,
  ) {}

  private async post(path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`RLN POST ${path} → ${res.status}: ${text}`);
    }
    return res.json();
  }

  private async get(path: string): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`RLN GET ${path} → ${res.status}: ${text}`);
    }
    return res.json();
  }

  async nodeInfo(): Promise<NodeInfo> {
    return nodeInfoSchema.parse(await this.get('/nodeinfo'));
  }

  async init(password: string, mnemonic?: string): Promise<{ mnemonic: string }> {
    return initResponseSchema.parse(await this.post('/init', { password, ...(mnemonic && { mnemonic }) }));
  }

  async unlock(cfg: UnlockConfig): Promise<void> {
    await this.post('/unlock', {
      password: cfg.password,
      ldk_chain_sync: {
        mode: 'BlockSync',
        config: {
          bitcoind_rpc_username: cfg.bitcoindRpcUsername,
          bitcoind_rpc_password: cfg.bitcoindRpcPassword,
          bitcoind_rpc_host: cfg.bitcoindRpcHost,
          bitcoind_rpc_port: cfg.bitcoindRpcPort,
        },
      },
      indexer_url: cfg.indexerUrl,
      proxy_endpoint: cfg.proxyEndpoint,
      announce_addresses: cfg.announceAddresses ?? [],
      announce_alias: cfg.announceAlias ?? null,
    });
  }

  async address(): Promise<string> {
    return addressResponseSchema.parse(await this.post('/address')).address;
  }

  async btcBalance(skipSync = false): Promise<{ vanilla: { settled: number } }> {
    return btcBalanceResponseSchema.parse(await this.post('/btcbalance', { skip_sync: skipSync }));
  }

  async createUtxos(params: {
    up_to: boolean;
    num?: number;
    fee_rate: number;
    skip_sync: boolean;
  }): Promise<void> {
    await this.post('/createutxos', params);
  }

  async issueAssetNia(params: {
    amounts: number[];
    ticker: string;
    name: string;
    precision: number;
  }): Promise<AssetNia> {
    return assetResponseSchema.parse(await this.post('/issueassetnia', params)).asset;
  }

  async connectPeer(peerPubkeyAndAddr: string): Promise<void> {
    await this.post('/connectpeer', { peer_pubkey_and_addr: peerPubkeyAndAddr });
  }

  async openChannel(params: {
    peer_pubkey_and_opt_addr: string;
    capacity_sat: number;
    push_msat: number;
    asset_id?: string;
    asset_amount?: bigint;
    push_asset_amount?: bigint;
    public: boolean;
    with_anchors: boolean;
    fee_base_msat?: number;
    fee_proportional_millionths?: number;
  }): Promise<{ temporary_channel_id: string }> {
    const body = {
      ...params,
      asset_amount: params.asset_amount !== undefined ? toSafeNumber(params.asset_amount) : undefined,
      push_asset_amount: params.push_asset_amount !== undefined ? toSafeNumber(params.push_asset_amount) : undefined,
    };
    return openChannelResponseSchema.parse(await this.post('/openchannel', body));
  }

  async listChannels(): Promise<Channel[]> {
    return channelsResponseSchema.parse(await this.get('/listchannels')).channels;
  }

  async closeChannel(params: {
    channel_id: string;
    peer_pubkey: string;
    force: boolean;
  }): Promise<void> {
    await this.post('/closechannel', params);
  }

  async lnInvoice(params: {
    amt_msat: number;
    expiry_sec: number;
    description?: string;
    asset_id?: string;
    asset_amount?: bigint;
  }): Promise<{ invoice: string }> {
    const body = {
      ...params,
      asset_amount: params.asset_amount !== undefined
        ? toSafeNumber(params.asset_amount)
        : undefined,
    };
    return lnInvoiceResponseSchema.parse(await this.post('/lninvoice', body));
  }

  async invoiceStatus(invoice: string): Promise<InvoiceStatus> {
    return invoiceStatusResponseSchema.parse(await this.post('/invoicestatus', { invoice })).status;
  }

  async sendPayment(params: {
    invoice: string;
    amt_msat?: number;
    asset_id?: string;
    asset_amount?: bigint;
  }): Promise<{ payment_id: string; status: 'Pending' | 'Succeeded' | 'Failed'; payment_hash?: string }> {
    const body = {
      ...params,
      asset_amount: params.asset_amount !== undefined
        ? toSafeNumber(params.asset_amount)
        : undefined,
    };
    return sendPaymentResponseSchema.parse(await this.post('/sendpayment', body));
  }

}
