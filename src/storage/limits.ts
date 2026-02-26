import type { DiscordUserId } from '../types';

/**
 * Per-user daily spend limit in cents ($5.00).
 * This is enforced in-memory per bot process; persistence will be added with Supabase.
 */
export const DAILY_LIMIT_CENTS = 500;

/**
 * UTC date string used as the key for a daily spend bucket.
 * Format: "YYYY-MM-DD"
 */
function utcDateKey(): string {
	return new Date().toISOString().slice(0, 10);
}

/**
 * Spend ledger: userId → dayKey → centsSpent.
 * In-memory only; resets on bot restart. Supabase will replace this.
 */
const spendLedger = new Map<DiscordUserId, Map<string, number>>();

/** Evict entries older than 2 days to prevent unbounded growth. */
function evictStaleEntries(userMap: Map<string, number>): void {
	const today = utcDateKey();
	const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
	for (const key of userMap.keys()) {
		if (key !== today && key !== yesterday) {
			userMap.delete(key);
		}
	}
}

function getOrInitDay(discordUserId: DiscordUserId): number {
	const dayKey = utcDateKey();
	const userMap = spendLedger.get(discordUserId);
	if (!userMap) return 0;
	evictStaleEntries(userMap);
	return userMap.get(dayKey) ?? 0;
}

/**
 * Returns the cents the user has spent today.
 */
export function getSpentToday(discordUserId: DiscordUserId): number {
	return getOrInitDay(discordUserId);
}

/**
 * Returns how many cents the user can still spend today.
 */
export function getRemainingToday(discordUserId: DiscordUserId): number {
	return Math.max(0, DAILY_LIMIT_CENTS - getSpentToday(discordUserId));
}

/**
 * Returns true if the user can spend `amountCents` within today's limit.
 */
export function canSpend(discordUserId: DiscordUserId, amountCents: number): boolean {
	return getSpentToday(discordUserId) + amountCents <= DAILY_LIMIT_CENTS;
}

/**
 * Records a confirmed spend for the user today.
 * Only call this after a trade has been successfully executed.
 */
export function recordSpend(discordUserId: DiscordUserId, amountCents: number): void {
	const dayKey = utcDateKey();
	let userMap = spendLedger.get(discordUserId);
	if (!userMap) {
		userMap = new Map<string, number>();
		spendLedger.set(discordUserId, userMap);
	}
	const current = userMap.get(dayKey) ?? 0;
	userMap.set(dayKey, current + amountCents);
}

/**
 * Atomic check-and-record: returns true and records the spend if within limit,
 * or returns false without recording if it would exceed the daily limit.
 * Eliminates TOCTOU race between canSpend + recordSpend.
 */
export function trySpend(discordUserId: DiscordUserId, amountCents: number): boolean {
	if (!canSpend(discordUserId, amountCents)) return false;
	recordSpend(discordUserId, amountCents);
	return true;
}
