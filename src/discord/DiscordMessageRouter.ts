import { parseIntent } from '../agent/intentParser';
import { buildTradeRequest } from '../backend/buildTradeRequest';
import {
	type ValidationErrorCode,
	type ValidationContext,
	validateAgentOutput,
} from '../backend/validateAgentOutput';
import { classifyMessageIntent } from './classifyMessageIntent';
import { PolymarketReadService, type MarketSummary } from '../read/PolymarketReadService';
import type { DiscordUserId, TradeErrorCode, TradeResult, Trader, UserIdentity } from '../types';

/**
 * Data passed to the READ explainer.
 * The explainer is intentionally read-only and receives factual inputs only.
 */
export interface ReadExplainerInput {
	readonly message: string;
	readonly liveMarketCount: number;
	readonly sampleMarketSummaries: readonly MarketSummary[];
	readonly searchResultsCount: number;
}

/**
 * Dependency contract for Discord orchestration.
 *
 * Routing is centralized here so lower layers stay focused:
 * - READ layer returns market information only.
 * - WRITE layers parse/validate/build/execute only.
 * - This router is the first user-facing message boundary.
 */
export interface DiscordMessageRouterDependencies {
	readonly readService: PolymarketReadService;
	readonly trader: Trader;
	readonly buildValidationContext: (discordUserId: DiscordUserId) => Promise<ValidationContext>;
	readonly nowMs: () => number;
	readonly readExplainer?: (input: ReadExplainerInput) => Promise<string>;
}

/**
 * Orchestrates inbound Discord message handling.
 *
 * This class intentionally contains presentation mapping, while business rules remain
 * in deterministic validation/execution layers.
 */
export class DiscordMessageRouter {
	private readonly readExplainer: (input: ReadExplainerInput) => Promise<string>;

	public constructor(private readonly deps: DiscordMessageRouterDependencies) {
		this.readExplainer = deps.readExplainer ?? defaultReadExplainer;
	}

	/**
	 * Main entry point for routing a Discord message.
	 * Always returns a user-facing string and never throws outward.
	 */
	public async routeMessage(message: string, discordUserId: DiscordUserId): Promise<string> {
		try {
			const pipeline = classifyMessageIntent(message);

			if (pipeline === 'READ') {
				return this.handleRead(message);
			}

			return this.handleWrite(message, discordUserId);
		} catch {
			return 'Something went wrong while handling your request. Please try again.';
		}
	}

	private async handleRead(message: string): Promise<string> {
		const liveMarkets = await this.deps.readService.listLiveMarkets();
		const searchResults = await this.deps.readService.searchMarketsByText(message);
		const sampleSummaries = await summarizeUpToThree(this.deps.readService, liveMarkets);

		return this.readExplainer({
			message,
			liveMarketCount: liveMarkets.length,
			sampleMarketSummaries: sampleSummaries,
			searchResultsCount: searchResults.length,
		});
	}

	private async handleWrite(message: string, discordUserId: DiscordUserId): Promise<string> {
		const agentOutput = await parseIntent(message, discordUserId);
		if (agentOutput === null) {
			return 'I could not confidently parse that trade request. Please include an explicit action, market, and amount.';
		}

		if (agentOutput.intent !== 'place_bet') {
			return 'I could not confirm a trade placement request. Please restate the trade with explicit action and amount.';
		}

		const resolvedMarket = await this.deps.readService.getMarketById(agentOutput.marketId);

		const baseValidationContext = await this.deps.buildValidationContext(discordUserId);
		const validationContext: ValidationContext = {
			...baseValidationContext,
			marketLookup: (marketId) => {
				if (marketId !== agentOutput.marketId) {
					return baseValidationContext.marketLookup(marketId);
				}

				if (resolvedMarket === null) {
					return null;
				}

				return {
					id: resolvedMarket.id,
					status: resolvedMarket.status,
				};
			},
		};

		const validation = validateAgentOutput(agentOutput, validationContext);
		if (!validation.ok) {
			return mapValidationErrorToUserMessage(validation.error.code);
		}

		if (resolvedMarket === null) {
			return mapValidationErrorToUserMessage('INVALID_MARKET');
		}

		const polymarketAccountId = validationContext.polymarketAccountId as NonNullable<
			ValidationContext['polymarketAccountId']
		>;

		const identity: UserIdentity = {
			discordUserId,
			polymarketAccountId,
		};

		const tradeRequest = buildTradeRequest(agentOutput, {
			identity,
			market: resolvedMarket,
			nowMs: this.deps.nowMs(),
		});

		const tradeResult = await this.deps.trader.placeTrade(tradeRequest);
		return mapTradeResultToUserMessage(tradeResult);
	}
}

/**
 * Default READ-mode explainer stub.
 * This is intentionally a placeholder for a dedicated read-only AI explainer.
 */
async function defaultReadExplainer(input: ReadExplainerInput): Promise<string> {
	void input.message;
	return `I found ${input.liveMarketCount} live markets and ${input.searchResultsCount} matching results.`;
}

/**
 * Produces up to three factual summaries for READ responses.
 */
async function summarizeUpToThree(
	readService: PolymarketReadService,
	markets: readonly { id: MarketSummary['id'] }[],
): Promise<readonly MarketSummary[]> {
	const selected = markets.slice(0, 3);
	const summaries = await Promise.all(selected.map((market) => readService.summarizeMarket(market.id)));
	return summaries.filter((summary): summary is MarketSummary => summary !== null);
}

/**
 * Validation errors are mapped to user-safe language at the orchestration boundary.
 * Internal error codes are not exposed directly to Discord users.
 */
function mapValidationErrorToUserMessage(errorCode: ValidationErrorCode): string {
	switch (errorCode) {
		case 'ACCOUNT_NOT_CONNECTED':
			return 'Your Polymarket account is not connected yet. Please connect your account before placing a trade.';
		case 'INVALID_MARKET':
			return 'That market could not be found. Please check the market and try again.';
		case 'MARKET_NOT_ACTIVE':
			return 'That market is not currently active for trading.';
		case 'INVALID_AMOUNT':
			return 'The trade amount is invalid. Please provide a positive whole-number amount in cents.';
		case 'LIMIT_EXCEEDED':
			return 'This trade exceeds your current spending limit window.';
		default:
			return assertNever(errorCode);
	}
}

/**
 * Trade execution results are mapped to user-safe response strings here.
 */
function mapTradeResultToUserMessage(result: TradeResult): string {
	if (result.ok) {
		return `Trade placed successfully. Trade ID: ${result.tradeId}.`;
	}

	return mapTradeErrorToUserMessage(result.errorCode);
}

function mapTradeErrorToUserMessage(errorCode: TradeErrorCode): string {
	switch (errorCode) {
		case 'LIMIT_EXCEEDED':
			return 'This trade exceeds your current allowed limit.';
		case 'INVALID_MARKET':
			return 'The selected market is invalid.';
		case 'MARKET_NOT_ACTIVE':
			return 'The selected market is not active.';
		case 'INVALID_AMOUNT':
			return 'The trade amount was invalid.';
		case 'RATE_LIMITED':
			return 'The trading service is temporarily rate limited. Please try again shortly.';
		case 'ABUSE_BLOCKED':
			return 'This request cannot be processed at this time.';
		case 'UPSTREAM_UNAVAILABLE':
			return 'Trading is temporarily unavailable. Please try again.';
		case 'INTERNAL_ERROR':
			return 'Trade execution failed due to an internal error.';
		default:
			return assertNever(errorCode);
	}
}

function assertNever(value: never): never {
	throw new Error(`Unhandled case: ${String(value)}`);
}
