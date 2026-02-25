import type {
	Balance,
	DiscordUserId,
	PolymarketAccountId,
	TradeRequest,
	TradeResult,
	TradeResultSuccess,
	Trader,
} from '../types';

/**
 * Provider-facing trade payload.
 * This is a structural placeholder until real Polymarket API wiring is added.
 */
export interface ProviderTradePayload {
	readonly marketId: string;
	readonly outcome: 'YES' | 'NO';
	readonly amountCents: number;
	readonly idempotencyKey: string;
}

/**
 * Provider-facing trade response.
 * This keeps this module deterministic and testable without concrete SDK usage.
 */
export interface ProviderTradeResponse {
	readonly providerTradeId: string;
	readonly executedAtMs: number;
}

/**
 * Provider-facing recent trade row.
 * Includes fields required to map deterministically to TradeResultSuccess.
 */
export interface ProviderRecentTrade {
	readonly providerTradeId: string;
	readonly marketId: string;
	readonly outcome: 'YES' | 'NO';
	readonly amountCents: number;
	readonly executedAtMs: number;
}

/**
 * Provider-facing balance response.
 * Balance semantics are intentionally simple placeholders pending API integration.
 */
export interface ProviderBalanceResponse {
	readonly availableCents: number;
	readonly asOfMs: number;
}

/**
 * Gateway abstraction for account-scoped Polymarket actions.
 *
 * Security boundary:
 * - Calls are always scoped by a user-connected Polymarket account ID.
 * - No private keys are handled in this trader module.
 */
export interface UserPolymarketGateway {
	executeTradeForAccount(
		accountId: PolymarketAccountId,
		payload: ProviderTradePayload,
	): Promise<ProviderTradeResponse>;

	getAccountBalance(accountId: PolymarketAccountId): Promise<ProviderBalanceResponse>;

	getRecentTradesForAccount(
		accountId: PolymarketAccountId,
		limit: number,
	): Promise<readonly ProviderRecentTrade[]>;
}

/**
 * Resolves a linked Polymarket account from Discord identity.
 * Authentication/authorization is handled upstream; this is lookup-only.
 */
export interface AccountBindingReader {
	getLinkedPolymarketAccountId(discordUserId: DiscordUserId): Promise<PolymarketAccountId | null>;
}

/**
 * Trader implementation for real user-connected accounts.
 *
 * Constraints intentionally preserved:
 * - No AI logic.
 * - No limit enforcement.
 * - No house-wallet assumptions.
 * - Assumes requests already passed deterministic validation upstream.
 */
export class UserAccountTrader implements Trader {
	public constructor(
		private readonly gateway: UserPolymarketGateway,
		private readonly bindingReader: AccountBindingReader,
	) {}

	/**
	 * Executes a validated trade using the requesting user's connected account context.
	 * Real provider wiring belongs in the injected gateway implementation.
	 */
	public async placeTrade(request: TradeRequest): Promise<TradeResult> {
		try {
			const response = await this.gateway.executeTradeForAccount(
				request.identity.polymarketAccountId,
				{
					marketId: request.market.id,
					outcome: request.outcome,
					amountCents: request.amountCents,
					idempotencyKey: request.idempotencyKey,
				},
			);

			return {
				ok: true,
				tradeId: response.providerTradeId,
				userId: request.identity.discordUserId,
				marketId: request.market.id,
				outcome: request.outcome,
				amountCents: request.amountCents,
				executedAtMs: response.executedAtMs,
			};
		} catch {
			return {
				ok: false,
				errorCode: 'UPSTREAM_UNAVAILABLE',
				failedAtMs: Date.now(),
			};
		}
	}

	/**
	 * Retrieves balance for the Discord user by resolving the linked account first.
	 * Mapping uses placeholder fields where product-specific semantics are not finalized.
	 */
	public async getBalance(userId: DiscordUserId): Promise<Balance> {
		const accountId = await this.bindingReader.getLinkedPolymarketAccountId(userId);

		if (!accountId) {
			return {
				userId,
				availableCents: 0 as Balance['availableCents'],
				spentTodayCents: 0 as Balance['spentTodayCents'],
				remainingDailyLimitCents: 0 as Balance['remainingDailyLimitCents'],
				asOfMs: Date.now(),
			};
		}

		const providerBalance = await this.gateway.getAccountBalance(accountId);

		return {
			userId,
			availableCents: providerBalance.availableCents as Balance['availableCents'],
			spentTodayCents: 0 as Balance['spentTodayCents'],
			remainingDailyLimitCents: 0 as Balance['remainingDailyLimitCents'],
			asOfMs: providerBalance.asOfMs,
		};
	}

	/**
	 * Retrieves recent trades for the linked account.
	 * Returned shape is mapped to TradeResult to preserve the existing Trader interface.
	 */
	public async getRecentTrades(userId: DiscordUserId, limit: number): Promise<readonly TradeResult[]> {
		const accountId = await this.bindingReader.getLinkedPolymarketAccountId(userId);

		if (!accountId) {
			return [];
		}

		const providerTrades = await this.gateway.getRecentTradesForAccount(accountId, limit);

		return providerTrades.map((trade) => ({
			ok: true,
			tradeId: trade.providerTradeId,
			userId,
			marketId: trade.marketId as TradeResultSuccess['marketId'],
			outcome: trade.outcome,
			amountCents: trade.amountCents as TradeResultSuccess['amountCents'],
			executedAtMs: trade.executedAtMs,
		}));
	}
}

/**
 * TODO:
 * - Implement concrete UserPolymarketGateway with real provider API calls.
 * - Map provider trade history fields to full TradeResultSuccess data.
 * - Replace placeholder zero-values once canonical balance/trade schemas are finalized.
 */
