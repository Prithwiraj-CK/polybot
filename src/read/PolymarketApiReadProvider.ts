import type { PolymarketReadProvider } from './PolymarketReadService';
import type { Market, MarketId, Outcome } from '../types';
import { callGemini, hasGeminiKeys } from './geminiClient';

/**
 * Base URL for the Polymarket Gamma API (market metadata).
 * This is the public, unauthenticated endpoint for reading market data.
 */
const GAMMA_API_BASE = 'https://gamma-api.polymarket.com';

/**
 * Maximum number of markets to fetch per list/search request.
 */
const DEFAULT_PAGE_LIMIT = 50;
const SEARCH_PAGE_LIMIT = 200;
const MAX_SEARCH_PAGES = 25; // safety cap to avoid unbounded requests

/**
 * Raw market shape returned by the Gamma API.
 * Only the fields we actually use are typed here; the real payload has many more.
 */

interface GammaMarketResponse {
	readonly id?: string;
	readonly condition_id?: string;
	readonly question?: string;
	readonly title?: string; // events payload may use title
	readonly active?: boolean;
	readonly closed?: boolean;
	readonly outcomes?: string | string[]; // Gamma markets use JSON string; events may send string[]
	readonly outcomePrices?: string | string[]; // JSON string or array of price strings
	readonly volume?: string | number;
	readonly accepting_orders?: boolean;
}

/**
 * PolymarketReadProvider backed by the public Polymarket Gamma API.
 *
 * This provider is read-only and requires NO authentication.
 * It can power the full READ pipeline (AI assistant mode) without any backend.
 */
export class PolymarketApiReadProvider implements PolymarketReadProvider {
	/**
	 * Fetches ALL active markets from the Gamma API via pagination.
	 */
	public async listMarkets(): Promise<readonly Market[]> {
		const baseUrl = `${GAMMA_API_BASE}/markets?closed=false`;
		const all = await this.fetchAllMarkets(baseUrl);
		console.log(`[listMarkets] Fetched ${all.length} active markets`);
		return all;
	}

	/**
	 * Fetches a single market by its condition ID / slug.
	 */
	public async getMarket(marketId: MarketId): Promise<Market | null> {
		try {
			const url = `${GAMMA_API_BASE}/markets/${encodeURIComponent(marketId)}`;
			const response = await fetch(url);

			if (!response.ok) {
				return null;
			}

			const raw = (await response.json()) as GammaMarketResponse;
			return mapGammaMarketToMarket(raw);
		} catch {
			return null;
		}
	}

	/**
	 * Searches markets by text using the Gamma API's slug/text filtering.
	 */
	public async searchMarkets(query: string): Promise<readonly Market[]> {
		const normalized = query.trim();
		if (normalized.length === 0) {
			return this.listMarkets();
		}

		console.log(`[search] Raw query: "${normalized}"`);

		// Use AI to extract search keywords from conversational queries
		const searchTerms = await extractSearchKeywords(normalized);
		console.log(`[search] AI-extracted keywords: "${searchTerms}"`);

		// Try events endpoint with multiple slug candidates
		let eventMarkets: Market[] = [];
		const eventSlugCandidates = buildEventSlugCandidates(searchTerms);
		console.log(`[search] Event slug candidates:`, eventSlugCandidates.slice(0, 5));
		const eventScopes = ['closed=false', 'closed=true'];
		for (const scope of eventScopes) {
			if (eventMarkets.length > 0) break;
			for (const slug of eventSlugCandidates) {
				try {
					const eventUrl = `${GAMMA_API_BASE}/events?${scope}&limit=1&slug=${encodeURIComponent(slug)}`;
					const eventResp = await fetch(eventUrl);
					if (eventResp.ok) {
						const events = await eventResp.json();
						if (Array.isArray(events) && events.length > 0 && Array.isArray(events[0].markets)) {
							console.log(`[search] Event hit! slug="${slug}" title="${events[0].title}" markets=${events[0].markets.length}`);
							eventMarkets = events[0].markets
								.map(mapGammaMarketToMarket)
								.filter((m: Market | null): m is Market => m !== null);
							if (eventMarkets.length > 0) {
								break;
							}
						}
					}
				} catch {
					// best-effort; ignore and try next slug
				}
			}
		}

		// If event search found results, return them directly — no need for
		// broad tag/text queries that return thousands of irrelevant matches.
		// Sort so active markets appear first (users care about open markets).
		if (eventMarkets.length > 0) {
			eventMarkets.sort((a, b) => {
				const rank = (s: Market['status']): number => s === 'active' ? 0 : s === 'paused' ? 1 : 2;
				return rank(a.status) - rank(b.status);
			});
			const activeCount = eventMarkets.filter(m => m.status === 'active').length;
			console.log(`[search] Event results sufficient (${eventMarkets.length} total, ${activeCount} active), skipping fallback searches`);
			return eventMarkets;
		}

		// Fallback: try slug, tag, and text_query searches (limited to 1 page each)
		const searchSlug = searchTerms.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
		let slugResults: Market[] = [];
		let tagResults: Market[] = [];
		let textResults: Market[] = [];
		for (const scope of ['closed=false', 'closed=true']) {
			const slugUrl = `${GAMMA_API_BASE}/markets?${scope}&limit=${DEFAULT_PAGE_LIMIT}&slug=${encodeURIComponent(searchSlug)}`;
			slugResults = slugResults.concat(await this.fetchAndMapMarkets(slugUrl));

			const tagUrl = `${GAMMA_API_BASE}/markets?${scope}&limit=${DEFAULT_PAGE_LIMIT}&tag=${encodeURIComponent(searchTerms)}`;
			tagResults = tagResults.concat(await this.fetchAndMapMarkets(tagUrl));

			const textUrl = `${GAMMA_API_BASE}/markets?${scope}&limit=${DEFAULT_PAGE_LIMIT}&text_query=${encodeURIComponent(searchTerms)}`;
			textResults = textResults.concat(await this.fetchAndMapMarkets(textUrl));
		}

		// Merge and deduplicate by market id — use Map to preserve insertion order
		const deduped = new Map<string, Market>();
		for (const m of [...slugResults, ...tagResults, ...textResults]) {
			if (!deduped.has(m.id)) {
				deduped.set(m.id, m);
			}
		}
		const results = [...deduped.values()];
		console.log(`[search] Results: slug=${slugResults.length} tag=${tagResults.length} text=${textResults.length} total=${results.length}`);
		return results;
	}

	/**
	 * Shared fetch + parse logic for list/search endpoints.
	 */
	private async fetchAndMapMarkets(url: string): Promise<readonly Market[]> {
		try {
			const response = await fetch(url);

			if (!response.ok) {
				return [];
			}

			const raw = (await response.json()) as GammaMarketResponse[] | GammaMarketResponse;

			// API may return a single object or an array
			const items = Array.isArray(raw) ? raw : [raw];
			const mapped = items.map(mapGammaMarketToMarket).filter((m): m is Market => m !== null);
			return mapped;
		} catch {
			return [];
		}
	}

	/**
	 * Paginates through markets using limit/offset until exhausted or capped.
	 */
	private async fetchAllMarkets(urlBase: string): Promise<Market[]> {
		const results: Market[] = [];
		for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
			const offset = page * SEARCH_PAGE_LIMIT;
			const url = `${urlBase}&limit=${SEARCH_PAGE_LIMIT}&offset=${offset}`;
			const pageResults = await this.fetchAndMapMarkets(url);
			if (pageResults.length === 0) {
				break;
			}
			results.push(...pageResults);
			if (pageResults.length < SEARCH_PAGE_LIMIT) {
				break;
			}
		}
		return results;
	}
}

/**
 * Uses Gemini to extract the core topic/search keywords from a conversational
 * Discord message. Falls back to simple prefix stripping if AI is unavailable.
 *
 * Example: "tell me about US strikes Iran by...?" → "US strikes Iran by"
 * Example: "what about Democratic Presidential Nominee 2028" → "Democratic Presidential Nominee 2028"
 */
async function extractSearchKeywords(message: string): Promise<string> {
	// First try simple prefix stripping — if it changes the message, we already
	// have good keywords without burning an API call.
	const stripped = stripConversationalPrefix(message);
	if (stripped !== message) {
		console.log('[extractSearchKeywords] Prefix strip sufficient, skipping AI');
		return stripped;
	}

	// Short messages (≤5 words) with no conversational prefix are likely
	// already just keywords — no need to call AI.
	const wordCount = message.trim().split(/\s+/).length;
	if (wordCount <= 5) {
		console.log('[extractSearchKeywords] Short query, skipping AI');
		return message;
	}

	if (!hasGeminiKeys()) {
		return message;
	}

	const text = await callGemini({
		contents: message,
		systemInstruction: [
			'Extract the core topic or search keywords from the user message.',
			'Return ONLY the keywords — no explanation, no quotes, no punctuation except what is part of the topic name.',
			'Remove conversational words like "tell me about", "what is", "can you show me", etc.',
			'Keep the essential topic words exactly as the user wrote them.',
			'Examples:',
			'  "tell me about US strikes Iran by...?" → US strikes Iran by',
			'  "what about Democratic Presidential Nominee 2028" → Democratic Presidential Nominee 2028',
			'  "show me the trump deportation markets" → trump deportation',
			'  "hi" → general',
			'  "how does polymarket work" → how polymarket works',
		].join('\n'),
		temperature: 0,
		maxOutputTokens: 50,
	});

	if (text && text.length < 200) {
		return text;
	}

	return message; // prefix stripping already attempted above
}

/**
 * Simple prefix stripper as fallback when AI is unavailable.
 */
function stripConversationalPrefix(query: string): string {
	const lower = query.toLowerCase();
	const prefixes = [
		'tell me about ', 'what about ', 'what is ', 'what are ',
		'show me ', 'can you tell me about ', 'please tell me about ',
		'i want to know about ', 'info on ', 'info about ',
	];
	for (const p of prefixes) {
		if (lower.startsWith(p)) {
			return query.slice(p.length).trim();
		}
	}
	return query;
}

/**
 * Builds multiple slug candidates from conversational queries like
 * "tell me about US strikes Iran by...?" so the events endpoint can match.
 *
 * Strategy: generate sliding windows of the ORIGINAL words (not just filtered)
 * so country codes like "US" aren't stripped. Only strip leading conversational
 * prefixes like "tell me about", "what about", etc.
 */
function buildEventSlugCandidates(query: string): string[] {
	const words = query
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, ' ')
		.split(/\s+/)
		.filter(Boolean);

	const slugify = (tokens: string[]): string =>
		tokens
			.join('-')
			.replace(/-+/g, '-')
			.replace(/^-+|-+$/g, '');

	// Strip common conversational prefixes
	const prefixes = [
		['tell', 'me', 'about'],
		['what', 'about'],
		['what', 'is'],
		['what', 'are'],
		['show', 'me'],
		['can', 'you', 'tell', 'me', 'about'],
		['please', 'tell', 'me', 'about'],
		['i', 'want', 'to', 'know', 'about'],
		['do', 'you', 'have', 'info', 'on'],
		['info', 'on'],
		['info', 'about'],
	];

	let stripped = words;
	for (const prefix of prefixes) {
		if (words.length > prefix.length && words.slice(0, prefix.length).join(' ') === prefix.join(' ')) {
			stripped = words.slice(prefix.length);
			break;
		}
	}

	const candidates: string[] = [];
	const add = (s: string) => {
		if (s && !candidates.includes(s)) candidates.push(s);
	};

	// Stripped query is the best candidate (e.g. "us-strikes-iran-by")
	add(slugify(stripped));

	// Full query slug
	add(slugify(words));

	// Sliding windows on ALL words (not filtered) — largest first
	for (let size = Math.min(8, words.length); size >= 2; size--) {
		for (let start = 0; start + size <= words.length; start++) {
			add(slugify(words.slice(start, start + size)));
		}
		if (candidates.length >= 15) break;
	}

	return candidates.slice(0, 15);
}

/**
 * Maps a raw Gamma API market response to our internal Market shape.
 * Returns null if the response is malformed or missing required fields.
 */
function mapGammaMarketToMarket(raw: GammaMarketResponse): Market | null {
	const id = raw.id ?? raw.condition_id;
	const question = raw.question ?? raw.title;
	if (!id || !question) {
		return null;
	}

	const status = resolveMarketStatus(raw);
	const outcomes = parseOutcomes(raw.outcomes);
	const outcomePrices = parseOutcomePrices(raw.outcomePrices, outcomes.length);
	const volume = typeof raw.volume === 'number' ? raw.volume : parseFloat(String(raw.volume ?? '0')) || 0;

	return {
		id: id as MarketId,
		question,
		status,
		outcomes,
		outcomePrices,
		volume,
	};
}

/**
 * Derives our tri-state status from the Gamma API's boolean flags.
 */
function resolveMarketStatus(raw: GammaMarketResponse): Market['status'] {
	if (raw.closed === true) {
		return 'closed';
	}

	if (raw.active === false || raw.accepting_orders === false) {
		return 'paused';
	}

	return 'active';
}

/**
 * Parses the Gamma API's JSON-encoded outcomes string into typed Outcome array.
 * Falls back to binary ['YES','NO'] if parsing fails (Polymarket default).
 */
/**
 * Parses outcomePrices from the Gamma API into a number array.
 * Falls back to equal probabilities if parsing fails.
 */
function parseOutcomePrices(value: string | string[] | undefined, outcomeCount: number): readonly number[] {
	const fallback = Array(outcomeCount).fill(1 / outcomeCount);
	if (!value) return fallback;

	try {
		const arr: string[] = Array.isArray(value) ? value : JSON.parse(value);
		if (!Array.isArray(arr) || arr.length === 0) return fallback;
		return arr.map(v => parseFloat(v) || 0);
	} catch {
		return fallback;
	}
}

function parseOutcomes(outcomesValue: string | string[] | undefined): readonly Outcome[] {
	if (!outcomesValue) {
		return ['YES', 'NO'];
	}

	const normalize = (arr: string[]): Outcome[] => arr.map((o) => o.toUpperCase() as Outcome);

	if (Array.isArray(outcomesValue)) {
		return normalize(outcomesValue.length > 0 ? outcomesValue : ['YES', 'NO']);
	}

	try {
		const parsed = JSON.parse(outcomesValue) as string[];
		if (!Array.isArray(parsed) || parsed.length === 0) {
			return ['YES', 'NO'];
		}
		return normalize(parsed);
	} catch {
		return ['YES', 'NO'];
	}
}
