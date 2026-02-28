import {
  AccountLinkChallengeService,
  type AccountLinkChallenge,
  type AccountLinkChallengeStore,
} from './auth/AccountLinkChallengeService';
import {
  AccountLinkPersistenceService,
  type AccountLinkStore,
} from './auth/AccountLinkPersistenceService';
import { AccountLinkVerificationService } from './auth/AccountLinkVerificationService';
import { EvmSignatureVerifier } from './auth/EvmSignatureVerifier';
import { PolymarketReadService, type PolymarketReadProvider } from './read/PolymarketReadService';
import { PolymarketApiReadProvider } from './read/PolymarketApiReadProvider';
import { createAiReadExplainer } from './read/aiReadExplainer';
import {
  UserAccountTrader,
  type PolymarketExecutionGateway,
  type ExecuteTradeParams,
  type ExecuteTradeResponse,
} from './trading/UserAccountTrader';
import { SupabaseAccountLinkStore } from './storage/SupabaseAccountLinkStore';
import { SupabaseUserCredentialStore, type UserClobCredentials } from './storage/SupabaseUserCredentialStore';
import type { Balance, DiscordUserId, Market, PolymarketAccountId, TradeResult } from './types';
import { ClobClient, Chain, Side, OrderType, AssetType } from '@polymarket/clob-client';
import { SignatureType } from '@polymarket/order-utils';
import { ethers } from 'ethers';

class InMemoryAccountLinkChallengeStore implements AccountLinkChallengeStore {
  private readonly byDiscordUserId = new Map<DiscordUserId, AccountLinkChallenge>();
  private readonly ownerByNonce = new Map<string, DiscordUserId>();

  public async create(challenge: AccountLinkChallenge): Promise<void> {
    this.byDiscordUserId.set(challenge.discordUserId, challenge);
    this.ownerByNonce.set(challenge.nonce, challenge.discordUserId);
  }

  public async getActive(discordUserId: DiscordUserId): Promise<AccountLinkChallenge | null> {
    return this.byDiscordUserId.get(discordUserId) ?? null;
  }

  public async markUsed(nonce: string): Promise<void> {
    const owner = this.ownerByNonce.get(nonce);
    if (!owner) {
      return;
    }

    const challenge = this.byDiscordUserId.get(owner);
    if (!challenge) {
      return;
    }

    this.byDiscordUserId.set(owner, {
      ...challenge,
      used: true,
    });
  }
}

class InMemoryAccountLinkStore implements AccountLinkStore {
  private readonly links = new Map<DiscordUserId, { accountId: PolymarketAccountId; linkedAtMs: number }>();

  public async link(
    discordUserId: DiscordUserId,
    polymarketAccountId: PolymarketAccountId,
    linkedAtMs: number,
  ): Promise<void> {
    this.links.set(discordUserId, { accountId: polymarketAccountId, linkedAtMs });
  }

  public async getLinkedAccount(discordUserId: DiscordUserId): Promise<PolymarketAccountId | null> {
    return this.links.get(discordUserId)?.accountId ?? null;
  }

  public async unlink(discordUserId: DiscordUserId): Promise<void> {
    this.links.delete(discordUserId);
  }
}

const MARKET_FIXTURES: readonly Market[] = [
  {
    id: 'market-1' as Market['id'],
    question: 'Will BTC close above $100k by Dec 31, 2026?',
    status: 'active',
    outcomes: ['YES', 'NO'],
    outcomePrices: [0.65, 0.35],
    volume: 1500000,
  },
  {
    id: 'market-2' as Market['id'],
    question: 'Will ETH ETF inflows be positive this quarter?',
    status: 'active',
    outcomes: ['YES', 'NO'],
    outcomePrices: [0.42, 0.58],
    volume: 800000,
  },
  {
    id: 'market-3' as Market['id'],
    question: 'Will the Fed cut rates in the next meeting?',
    status: 'paused',
    outcomes: ['YES', 'NO'],
    outcomePrices: [0.3, 0.7],
    volume: 2200000,
  },
];

class InMemoryPolymarketReadProvider implements PolymarketReadProvider {
  public async listMarkets(): Promise<readonly Market[]> {
    return MARKET_FIXTURES;
  }

  public async getMarket(marketId: Market['id']): Promise<Market | null> {
    return MARKET_FIXTURES.find((market) => market.id === marketId) ?? null;
  }

  public async searchMarkets(query: string): Promise<readonly Market[]> {
    const normalized = query.trim().toLowerCase();
    if (normalized.length === 0) {
      return MARKET_FIXTURES;
    }

    return MARKET_FIXTURES.filter((market) => market.question.toLowerCase().includes(normalized));
  }
}

class ClobPolymarketExecutionGateway implements PolymarketExecutionGateway {
  private static readonly USDC_CONTRACT = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
  private static readonly RPC_ENDPOINTS = [
    process.env.POLYGON_RPC_URL,
    'https://polygon-bor-rpc.publicnode.com',
    'https://1rpc.io/matic',
  ].filter((value): value is string => Boolean(value && value.length > 0));

  /** Leader (fallback) ClobClient — created from .env credentials */
  private readonly leaderClobClient: ClobClient;
  /** Per-user ClobClient cache: discordUserId → { client, createdAtMs } */
  private readonly userClientCache = new Map<DiscordUserId, { client: ClobClient; createdAtMs: number }>();
  /** Cache TTL: 30 minutes */
  private static readonly CLIENT_CACHE_TTL_MS = 30 * 60 * 1000;
  /** User credential store (null if encryption key not configured) */
  private readonly credentialStore: SupabaseUserCredentialStore | null;

  public constructor() {
    const privateKey = process.env.WALLET_PRIVATE_KEY;
    const apiKey = process.env.POLYMARKET_API_KEY;
    const apiSecret = process.env.POLYMARKET_API_SECRET;
    const passphrase = process.env.POLYMARKET_PASSPHRASE;

    const proxyWallet = process.env.POLYMARKET_PROXY_WALLET;

    if (!privateKey || !apiKey || !apiSecret || !passphrase || !proxyWallet) {
      throw new Error(
        'Missing CLOB credentials. Set WALLET_PRIVATE_KEY, POLYMARKET_API_KEY, POLYMARKET_API_SECRET, POLYMARKET_PASSPHRASE, POLYMARKET_PROXY_WALLET in .env',
      );
    }

    const wallet = new ethers.Wallet(privateKey) as ethers.Wallet & {
      _signTypedData: typeof ethers.Wallet.prototype.signTypedData;
    };
    // CLOB client expects ethers v5 _signTypedData; shim for ethers v6
    wallet._signTypedData = wallet.signTypedData.bind(wallet);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CLOB client expects ethers v5 Wallet shape
    this.leaderClobClient = new ClobClient(
      'https://clob.polymarket.com',
      Chain.POLYGON,
      wallet as any,
      { key: apiKey, secret: apiSecret, passphrase },
      SignatureType.POLY_GNOSIS_SAFE,
      proxyWallet,
    );

    const maskedEoa = `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`;
    const maskedProxy = `${proxyWallet.slice(0, 6)}…${proxyWallet.slice(-4)}`;
    console.log(`🔗 ClobPolymarketExecutionGateway initialized — leader wallet (EOA: ${maskedEoa}, Proxy: ${maskedProxy})`);

    // Initialize per-user credential store if encryption key is configured
    try {
      this.credentialStore = new SupabaseUserCredentialStore();
      console.log('🔐 Per-user credential store initialized');
    } catch {
      console.warn('⚠️ Per-user credential store not available (missing CREDENTIAL_ENCRYPTION_KEY). All trades will use leader wallet.');
      this.credentialStore = null;
    }

    // Ensure USDC allowance is set for exchange contracts (one-time on-chain approval)
    this.ensureAllowance(this.leaderClobClient).catch((err) => {
      console.error('⚠️ Failed to set USDC allowance — trades may fail:', err);
    });
  }

  /**
   * Get the user credential store (for use by slash commands).
   */
  public getCredentialStore(): SupabaseUserCredentialStore | null {
    return this.credentialStore;
  }

  /**
   * Build a ClobClient from user credentials.
   */
  private buildClobClientFromCredentials(creds: UserClobCredentials): ClobClient {
    const wallet = new ethers.Wallet(creds.privateKey) as ethers.Wallet & {
      _signTypedData: typeof ethers.Wallet.prototype.signTypedData;
    };
    wallet._signTypedData = wallet.signTypedData.bind(wallet);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CLOB client expects ethers v5 Wallet shape
    return new ClobClient(
      'https://clob.polymarket.com',
      Chain.POLYGON,
      wallet as any,
      { key: creds.apiKey, secret: creds.apiSecret, passphrase: creds.passphrase },
      SignatureType.POLY_GNOSIS_SAFE,
      creds.proxyWallet,
    );
  }

  /**
   * Resolve the ClobClient for a given Discord user.
   * Returns user-specific client if credentials are stored, otherwise falls back to leader.
   */
  public async getClobClientForUser(discordUserId: DiscordUserId | null): Promise<{ client: ClobClient; isLeader: boolean }> {
    if (!discordUserId || !this.credentialStore) {
      return { client: this.leaderClobClient, isLeader: true };
    }

    // Check cache first
    const cached = this.userClientCache.get(discordUserId);
    if (cached && (Date.now() - cached.createdAtMs) < ClobPolymarketExecutionGateway.CLIENT_CACHE_TTL_MS) {
      return { client: cached.client, isLeader: false };
    }

    // Look up credentials
    try {
      const creds = await this.credentialStore.getCredentials(discordUserId);
      if (!creds) {
        return { client: this.leaderClobClient, isLeader: true };
      }

      const client = this.buildClobClientFromCredentials(creds);
      this.userClientCache.set(discordUserId, { client, createdAtMs: Date.now() });

      const wallet = new ethers.Wallet(creds.privateKey);
      const maskedEoa = `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`;
      console.log(`🔑 Using per-user ClobClient for ${discordUserId} (EOA: ${maskedEoa})`);

      // Set USDC allowance for this user's wallet (fire-and-forget)
      this.ensureAllowance(client).catch((err) => {
        console.warn(`⚠️ Failed to set USDC allowance for ${discordUserId}:`, err);
      });

      return { client, isLeader: false };
    } catch (err) {
      console.error(`⚠️ Failed to load credentials for ${discordUserId}, falling back to leader:`, err);
      return { client: this.leaderClobClient, isLeader: true };
    }
  }

  /**
   * Invalidate the cached ClobClient for a user (e.g., after /remove-trading).
   */
  public evictUserClient(discordUserId: DiscordUserId): void {
    this.userClientCache.delete(discordUserId);
  }

  /**
   * Check and set USDC balance allowance for the Polymarket exchange contracts.
   * This is an idempotent operation — if allowance is already max, it's a no-op on-chain.
   */
  private async ensureAllowance(client: ClobClient): Promise<void> {
    try {
      const collateralParams = { asset_type: AssetType.COLLATERAL };
      const current = await client.getBalanceAllowance(collateralParams) as unknown as Record<string, unknown>;

      // CLOB client may return an HTTP error object instead of { balance, allowance }
      if (typeof current.status === 'number' && current.status >= 400) {
        console.warn('⚠️ getBalanceAllowance returned error, updating allowance anyway...');
        await client.updateBalanceAllowance(collateralParams);
        console.log('✅ USDC allowance updated');
        return;
      }

      const balance = current.balance as string | undefined;
      const allowance = current.allowance as string | undefined;
      console.log(`💰 Current allowance: ${allowance}, balance: ${balance}`);

      // If allowance is very low (or zero), update it
      const allowanceBigInt = BigInt(allowance || '0');
      const threshold = BigInt('1000000000'); // 1000 USDC in 6 decimals
      if (allowanceBigInt < threshold) {
        console.log('🔓 Setting max USDC allowance for Polymarket exchange...');
        await client.updateBalanceAllowance(collateralParams);
        console.log('✅ USDC allowance updated successfully');
      } else {
        console.log('✅ USDC allowance already sufficient');
      }
    } catch (err) {
      console.error('⚠️ Allowance check/update error:', err);
      // Try to set allowance anyway
      try {
        await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
        console.log('✅ USDC allowance updated (fallback)');
      } catch (updateErr) {
        console.error('❌ Could not update allowance:', updateErr);
      }
    }
  }

  public async executeTradeForAccount(
    _polymarketAccountId: PolymarketAccountId,
    params: ExecuteTradeParams,
  ): Promise<ExecuteTradeResponse> {
    // Resolve the correct ClobClient for this user (per-user or leader fallback)
    const { client: clobClient, isLeader } = await this.getClobClientForUser(params.discordUserId ?? null);
    if (isLeader && params.discordUserId) {
      // User has NOT registered via /setup-trading — block the trade
      throw {
        code: 'ACCOUNT_NOT_CONNECTED',
        message: 'You need to set up your own trading credentials first. Use `/setup-trading` to register your wallet.',
      };
    }

    const conditionId = String(params.marketId);

    // 1. Resolve token ID for this market
    const tokenId = await this.resolveTokenId(conditionId, params.outcome);

    // 2. Fetch the correct tick size from the CLOB (varies per market: 0.1 / 0.01 / 0.001 / 0.0001)
    const tickSize = await clobClient.getTickSize(tokenId);
    console.log(`⏱️  Tick size for token ${tokenId.substring(0, 12)}...: ${tickSize}`);

    // 3. Amount in dollars (CLOB expects dollars for BUY, shares for SELL)
    const amountDollars = params.amountCents / 100;
    if (amountDollars < 5) {
      throw { code: 'INVALID_AMOUNT', message: 'Polymarket minimum order size is $5' };
    }

    const side = params.action === 'SELL' ? Side.SELL : Side.BUY;

    // 4. Place the market order via CLOB
    console.log(
      `📤 Placing market order: ${side} ${params.outcome} $${amountDollars} on ${conditionId} (token ${tokenId.substring(0, 12)}... tickSize=${tickSize})`,
    );

    let result: unknown;
    try {
      result = await clobClient.createAndPostMarketOrder(
        {
          tokenID: tokenId,
          amount: amountDollars,
          side,
        },
        { tickSize },
        OrderType.FOK,
      );
    } catch (error: unknown) {
      const errMsg =
        error instanceof Error
          ? error.message
          : typeof error === 'object' && error !== null
            ? JSON.stringify(error)
            : String(error);
      console.error('❌ CLOB order failed:', errMsg.substring(0, 200));

      if (errMsg.includes('insufficient') || errMsg.includes('balance')) {
        throw { code: 'INVALID_AMOUNT', message: 'Insufficient balance on Polymarket' };
      }
      if (errMsg.includes('not found') || errMsg.includes('404')) {
        throw { code: 'INVALID_MARKET', message: 'Market not found on CLOB' };
      }
      if (errMsg.includes('not accepting')) {
        throw { code: 'MARKET_NOT_ACTIVE', message: 'Market is not accepting orders' };
      }
      throw { code: 'UPSTREAM_UNAVAILABLE', message: errMsg };
    }

    const resultObj = result as Record<string, unknown>;
    const logSafe = { status: resultObj.status, success: resultObj.success, orderID: resultObj.orderID, data: resultObj.data };
    console.log('📥 Order result:', JSON.stringify(logSafe));

    // CLOB client may return HTTP error responses (e.g. 400) without throwing
    const httpStatus = typeof resultObj.status === 'number' ? resultObj.status : null;
    const dataError = (resultObj.data as Record<string, unknown> | undefined)?.error as string | undefined;

    if (httpStatus && httpStatus >= 400) {
      const errText = dataError ?? String(resultObj.statusText ?? `HTTP ${httpStatus}`);
      console.error(`❌ CLOB returned HTTP ${httpStatus}:`, errText);

      if (errText.includes('balance') || errText.includes('allowance') || errText.includes('insufficient')) {
        throw { code: 'INVALID_AMOUNT', message: 'Insufficient USDC balance on Polymarket. Deposit funds first.' };
      }
      if (errText.includes('not found') || httpStatus === 404) {
        throw { code: 'INVALID_MARKET', message: 'Market not found on CLOB' };
      }
      throw { code: 'UPSTREAM_UNAVAILABLE', message: errText };
    }

    const success = resultObj.success as boolean | undefined;
    const status = typeof resultObj.status === 'string' ? resultObj.status : undefined;
    const errorMsg = resultObj.errorMsg as string | undefined;

    // Check if order actually filled
    if (success === false || (status && status !== 'matched' && status !== 'delayed')) {
      const reason = String(errorMsg || status || 'Order was not filled');
      console.error('❌ Order not filled:', reason);
      // Provide a more helpful message for FOK unmatched orders
      if (!reason || reason.toLowerCase().includes('unmatched') || reason.toLowerCase().includes('unfilled')) {
        throw { code: 'UPSTREAM_UNAVAILABLE', message: 'Order not filled — no match available right now. Try again in a moment.' };
      }
      throw { code: 'UPSTREAM_UNAVAILABLE', message: reason };
    }

    // Extract transaction hash or order ID
    const txHashes = resultObj.transactionsHashes as string[] | undefined;
    const tradeId =
      txHashes?.[0] ??
      (resultObj.orderID as string | undefined) ??
      params.idempotencyKey;

    return {
      tradeId: String(tradeId),
      executedAtMs: Date.now(),
    };
  }

  /**
   * Resolves the CLOB token ID and tick size for a given conditionId + outcome.
   * Tries CLOB getMarket first, falls back to Gamma clobTokenIds.
   */
  private async resolveTokenId(conditionId: string, outcome: 'YES' | 'NO'): Promise<string> {
    // Map YES/NO to the market's actual outcome labels
    // Timed up/down markets use "Up"/"Down"; standard markets use "Yes"/"No"
    const desiredOutcomes =
      outcome === 'YES' ? ['up', 'yes'] : ['down', 'no'];

    try {
      // Use leader client for market metadata lookups (token IDs are global, not account-specific)
      const clobMarket = await this.leaderClobClient.getMarket(conditionId);
      const raw = clobMarket as Record<string, unknown>;
      const tokens = raw.tokens as
        | Array<{ token_id: string; outcome: string }>
        | undefined;

      if (tokens && tokens.length > 0) {
        const match = tokens.find((t) =>
          desiredOutcomes.includes(t.outcome.toLowerCase()),
        );
        return match
          ? match.token_id
          : outcome === 'YES' ? tokens[0].token_id : tokens[1].token_id;
      }
    } catch {
      console.warn('CLOB getMarket failed for', conditionId, '- trying Gamma fallback');
    }

    // Fallback: query Gamma API for clobTokenIds
    const gammaResp = await fetch(
      `https://gamma-api.polymarket.com/markets?condition_id=${encodeURIComponent(conditionId)}`,
    );
    if (gammaResp.ok) {
      const markets = (await gammaResp.json()) as Array<{
        clobTokenIds?: string;
        outcomes?: string;
      }>;
      if (markets.length > 0) {
        const m = markets[0];
        const tokenIds: string[] = m.clobTokenIds ? JSON.parse(m.clobTokenIds) : [];
        const outcomeNames: string[] = m.outcomes ? JSON.parse(m.outcomes) : [];
        if (tokenIds.length >= 2) {
          const idx = outcomeNames.findIndex((o) =>
            desiredOutcomes.includes(o.toLowerCase()),
          );
          return idx >= 0 ? tokenIds[idx] : (outcome === 'YES' ? tokenIds[0] : tokenIds[1]);
        }
      }
    }

    throw { code: 'INVALID_MARKET', message: `Could not resolve token for ${conditionId} outcome ${outcome}` };
  }

  public async getBalanceForAccount(polymarketAccountId: PolymarketAccountId): Promise<Balance> {
    try {
      const safeCents = await this.readOnchainUsdcCents(polymarketAccountId);

      return {
        userId: String(polymarketAccountId) as Balance['userId'],
        availableCents: safeCents as Balance['availableCents'],
        spentTodayCents: 0 as Balance['spentTodayCents'],
        remainingDailyLimitCents: 500 as Balance['remainingDailyLimitCents'],
        asOfMs: Date.now(),
      };
    } catch (error) {
      console.error('Failed to read Polymarket public value:', error);
    }

    return {
      userId: String(polymarketAccountId) as Balance['userId'],
      availableCents: 0 as Balance['availableCents'],
      spentTodayCents: 0 as Balance['spentTodayCents'],
      remainingDailyLimitCents: 500 as Balance['remainingDailyLimitCents'],
      asOfMs: Date.now(),
    };
  }

  private async readOnchainUsdcCents(account: PolymarketAccountId): Promise<number> {
    const addressHex = String(account).toLowerCase().replace(/^0x/, '');
    if (addressHex.length !== 40) {
      throw new Error('Invalid account address for USDC balance lookup');
    }

    const data = `0x70a08231000000000000000000000000${addressHex}`;

    let lastError: unknown;
    for (const endpoint of ClobPolymarketExecutionGateway.RPC_ENDPOINTS) {
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'eth_call',
            params: [{ to: ClobPolymarketExecutionGateway.USDC_CONTRACT, data }, 'latest'],
            id: 1,
          }),
        });

        if (!response.ok) {
          throw new Error(`RPC ${endpoint} returned ${response.status}`);
        }

        const payload = (await response.json()) as { result?: string; error?: { message?: string } };
        if (payload.error) {
          throw new Error(payload.error.message || `RPC ${endpoint} returned error`);
        }
        if (!payload.result || !payload.result.startsWith('0x')) {
          throw new Error(`RPC ${endpoint} returned invalid result`);
        }

        const raw = BigInt(payload.result);
        const cents = raw / 10_000n; // USDC 6 decimals -> cents
        const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
        return Number(cents > maxSafe ? maxSafe : cents);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error('No Polygon RPC endpoints available');
  }

  public async getRecentTradesForAccount(
    polymarketAccountId: PolymarketAccountId,
    limit: number,
  ): Promise<readonly TradeResult[]> {
    try {
      const safeLimit = Math.max(1, Math.min(20, Math.floor(limit || 5)));
      const encodedUser = encodeURIComponent(polymarketAccountId);
      const response = await fetch(`https://data-api.polymarket.com/trades?user=${encodedUser}&limit=${safeLimit}`);

      if (!response.ok) {
        throw new Error(`trades endpoint failed with status ${response.status}`);
      }

      const rows = (await response.json()) as Array<{
        transactionHash?: string;
        conditionId?: string;
        outcome?: string;
        size?: number;
        price?: number;
        timestamp?: number;
      }>;

      return rows.slice(0, safeLimit).map((row, index) => {
        const outcomeRaw = (row.outcome || '').toLowerCase();
        const normalizedOutcome: 'YES' | 'NO' =
          outcomeRaw === 'no' || outcomeRaw === 'down' ? 'NO' : 'YES';

        const size = Number.isFinite(row.size) ? Number(row.size) : 0;
        const price = Number.isFinite(row.price) ? Number(row.price) : 0;
        const amountCents = Math.max(0, Math.round(size * price * 100));
        const executedAtMs = row.timestamp ? row.timestamp * 1000 : Date.now();

        return {
          ok: true as const,
          tradeId: row.transactionHash || `trade:${index}:${executedAtMs}`,
          userId: String(polymarketAccountId) as unknown as DiscordUserId,
          marketId: (row.conditionId || 'unknown-market') as Market['id'],
          outcome: normalizedOutcome,
          amountCents: amountCents as Balance['availableCents'],
          executedAtMs,
        };
      });
    } catch (error) {
      console.error('Failed to read Polymarket recent trades:', error);
      return [];
    }
  }
}

export const accountLinkChallengeService = new AccountLinkChallengeService(
  new InMemoryAccountLinkChallengeStore(),
);

export const accountLinkPersistenceService = new AccountLinkPersistenceService(
  (() => {
    if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
      console.log('📦 Using Supabase for account link persistence');
      return new SupabaseAccountLinkStore();
    }
    console.warn('⚠️ Using in-memory account link store (links will reset on restart)');
    return new InMemoryAccountLinkStore();
  })(),
);

export const accountLinkVerificationService = new AccountLinkVerificationService(
  accountLinkChallengeService,
  new EvmSignatureVerifier(),
);

/**
 * READ pipeline — works without any backend.
 * Uses the live Polymarket Gamma API (public, no auth) for market data
 * and Gemini for conversational responses.
 */
export const readService = new PolymarketReadService(new PolymarketApiReadProvider());
export const aiReadExplainer = createAiReadExplainer();

/**
 * WRITE pipeline — requires backend (Supabase) for production.
 * The gateway now supports per-user CLOB clients with leader fallback.
 */
export const executionGateway = new ClobPolymarketExecutionGateway();
export const trader = new UserAccountTrader(
  executionGateway,
  async (discordUserId: DiscordUserId) => {
    const linked = await accountLinkPersistenceService.getLinkedAccount(discordUserId);
    if (!linked.ok) {
      return null;
    }
    return linked.polymarketAccountId;
  },
);
