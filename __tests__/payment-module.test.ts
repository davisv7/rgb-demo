import { PaymentModule } from '../src/payment-module';
import { RlnClient } from '../src/rln-client';
import { AssetConfig, InvoiceStatus } from '../src/types';

jest.mock('../src/rln-client', () => ({
  ...jest.requireActual('../src/rln-client'),
  RlnClient: jest.fn(),
}));

const ASSET_ID = 'rgb:test-asset-id';
const ASSET_REGISTRY = new Map<string, AssetConfig>([
  ['USDT', { assetId: ASSET_ID, ticker: 'USDT', precision: 0 }],
]);

const TEST_INVOICE   = 'lnbcrt-test-invoice';
const TEST_INVOICE_A = 'lnbcrt-test-invoice-a';

function makeModule(): {
  module: PaymentModule;
  mockInvoice: jest.Mock;
  mockStatus: jest.Mock;
} {
  const mockInvoice = jest.fn().mockResolvedValue({ invoice: TEST_INVOICE });
  const mockStatus = jest.fn();

  (RlnClient as jest.MockedClass<typeof RlnClient>).mockImplementation(() => ({
    lnInvoice: mockInvoice,
    invoiceStatus: mockStatus,
  } as unknown as RlnClient));

  const client = new RlnClient('http://dummy');
  const module = new PaymentModule(client, ASSET_REGISTRY, 3_000_000, 50);
  return { module, mockInvoice, mockStatus };
}

afterEach(() => jest.clearAllMocks());

describe('PaymentModule.expectPayment', () => {
  it('returns PaymentDetails with correct fields', async () => {
    const { module } = makeModule();
    const before = Date.now();
    const details = await module.expectPayment('inv-1', 'USDT', 500n, 60);
    await module.close();

    expect(details.invoiceId).toBe('inv-1');
    expect(details.currency).toBe('USDT');
    expect(details.amount).toBe(500n);
    expect(details.assetId).toBe(ASSET_ID);
    expect(details.invoice).toBe(TEST_INVOICE);
    expect(details.amtMsat).toBe(3_000_000);
    expect(details.expiresAt.getTime()).toBeGreaterThan(before + 59_000);
  });

  it('throws for unknown currency', async () => {
    const { module } = makeModule();
    await expect(module.expectPayment('inv-x', 'BTC', 1n)).rejects.toThrow('Unknown currency');
    await module.close();
  });

  it('passes expiry_sec to lnInvoice', async () => {
    const { module, mockInvoice } = makeModule();
    await module.expectPayment('inv-2', 'USDT', 1n, 300);
    await module.close();
    expect(mockInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ expiry_sec: 300 }),
    );
  });
});

describe('PaymentModule callback – paid', () => {
  it('fires callback with "paid" when invoiceStatus returns Succeeded', async () => {
    const { module, mockStatus } = makeModule();
    mockStatus.mockResolvedValue('Succeeded');

    const cb = jest.fn().mockResolvedValue(undefined);
    module.setCallback(cb);

    await module.expectPayment('inv-3', 'USDT', 100n, 60);
    await new Promise(r => setTimeout(r, 200)); // let a few poll ticks fire
    await module.close();

    expect(cb).toHaveBeenCalledWith('inv-3', 'paid');
    expect(cb).toHaveBeenCalledTimes(1); // not called again after resolution
  });
});

describe('PaymentModule callback – expired via RLN status', () => {
  it('fires callback with "expired" when invoiceStatus returns Expired', async () => {
    const { module, mockStatus } = makeModule();
    mockStatus.mockResolvedValue('Expired');

    const cb = jest.fn().mockResolvedValue(undefined);
    module.setCallback(cb);

    await module.expectPayment('inv-4', 'USDT', 100n, 60);
    await new Promise(r => setTimeout(r, 200));
    await module.close();

    expect(cb).toHaveBeenCalledWith('inv-4', 'expired');
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('PaymentModule callback – expired via wall clock', () => {
  it('fires callback with "expired" when expiresAt passes without payment', async () => {
    const { module, mockStatus } = makeModule();
    mockStatus.mockResolvedValue('Pending');

    const cb = jest.fn().mockResolvedValue(undefined);
    module.setCallback(cb);

    // 0-second expiry → expires immediately on next poll
    await module.expectPayment('inv-5', 'USDT', 100n, 0);
    await new Promise(r => setTimeout(r, 300));
    await module.close();

    expect(cb).toHaveBeenCalledWith('inv-5', 'expired');
  });
});

describe('PaymentModule – multiple concurrent invoices', () => {
  it('resolves each invoice independently', async () => {
    const statuses: Record<string, InvoiceStatus> = {
      [TEST_INVOICE_A]:       'Succeeded',
      'lnbcrt-test-invoice-b': 'Pending',
      'lnbcrt-test-invoice-c': 'Expired',
    };

    let invoiceCounter = 0;
    const invoiceNames = [TEST_INVOICE_A, 'lnbcrt-test-invoice-b', 'lnbcrt-test-invoice-c'];

    const mockInvoice = jest.fn().mockImplementation(() => {
      const invoice = invoiceNames[invoiceCounter++];
      return Promise.resolve({ invoice });
    });
    const mockStatus = jest.fn().mockImplementation((invoice: string) => {
      return Promise.resolve(statuses[invoice]);
    });
    (RlnClient as jest.MockedClass<typeof RlnClient>).mockImplementation(() => ({
      lnInvoice: mockInvoice,
      invoiceStatus: mockStatus,
    } as unknown as RlnClient));

    const client = new RlnClient('http://dummy');
    const module = new PaymentModule(client, ASSET_REGISTRY, 3_000_000, 50);

    const cb = jest.fn().mockResolvedValue(undefined);
    module.setCallback(cb);

    await module.expectPayment('inv-a', 'USDT', 100n, 60);
    await module.expectPayment('inv-b', 'USDT', 200n, 60);
    await module.expectPayment('inv-c', 'USDT', 300n, 60);

    await new Promise(r => setTimeout(r, 300));
    await module.close();

    const calls = new Map(cb.mock.calls.map(([id, st]) => [id, st]));
    expect(calls.get('inv-a')).toBe('paid');
    expect(calls.get('inv-c')).toBe('expired');
    // inv-b is still Pending — no callback yet
    expect(calls.has('inv-b')).toBe(false);
  });
});

describe('PaymentModule – transient invoiceStatus errors', () => {
  it('retries on error without crashing', async () => {
    const mockInvoice = jest.fn().mockResolvedValue({ invoice: TEST_INVOICE });
    const mockStatus = jest.fn()
      .mockRejectedValueOnce(new Error('network error'))
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValue('Succeeded');

    (RlnClient as jest.MockedClass<typeof RlnClient>).mockImplementation(() => ({
      lnInvoice: mockInvoice,
      invoiceStatus: mockStatus,
    } as unknown as RlnClient));

    const client = new RlnClient('http://dummy');
    const module = new PaymentModule(client, ASSET_REGISTRY, 3_000_000, 50);

    const cb = jest.fn().mockResolvedValue(undefined);
    module.setCallback(cb);

    await module.expectPayment('inv-err', 'USDT', 1n, 60);
    await new Promise(r => setTimeout(r, 400));
    await module.close();

    expect(cb).toHaveBeenCalledWith('inv-err', 'paid');
  });
});
