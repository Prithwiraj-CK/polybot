import { callGemini, hasGeminiKeys } from './geminiClient';
import type { ReadExplainerInput } from '../discord/DiscordMessageRouter';

/**
 * System prompt for the READ-mode AI assistant.
 */
const READ_SYSTEM_PROMPT = [
	'You are a helpful Polymarket assistant inside a Discord server.',
	'You answer user questions about prediction markets, odds, market status, and general Polymarket concepts.',
	'You are given factual market data as context — use it when relevant.',
	'Be concise, accurate, and conversational. Keep responses under 300 words.',
	'You have NO ability to execute trades, access wallets, or modify anything.',
	'If the user asks you to place a trade or do something you cannot do, politely explain they need to use a trade command instead.',
	'Never fabricate market data.',
	'IMPORTANT: For sports/esports queries (teams, players, matches), the search returns the top active markets from that league or sport.',
	'Even if the exact match or teams are not in the sample markets, DO NOT say you cannot find the market.',
	'Instead, tell the user that while you do not have the specific match details, here are the top trending markets from that league/sport right now.',
	'You MUST present the sample markets provided in the context. Never hide them.',
	'Format responses for Discord (markdown is OK, no HTML).',
].join(' ');

/**
 * Creates an AI-powered read explainer using the official Google GenAI SDK.
 * Requires only GEMINI_API_KEY — no backend, no database, no auth.
 */
export function createAiReadExplainer(): (input: ReadExplainerInput) => Promise<string> {
	return async (input: ReadExplainerInput): Promise<string> => {
		if (!hasGeminiKeys()) {
			return fallbackExplainer(input);
		}

		const contextBlock = buildMarketContext(input);
		const fullPrompt = READ_SYSTEM_PROMPT + '\n\nCurrent market context:\n' + contextBlock;

		console.log('\n[gemini] --- SYSTEM PROMPT ---');
		console.log(fullPrompt);
		console.log('[gemini] ----------------------\n');

		const text = await callGemini({
			contents: input.message,
			systemInstruction: fullPrompt,
			temperature: 0.4,
			maxOutputTokens: 500,
		});

		console.log(`[gemini] Response: "${text}"`);

		if (!text) {
			return fallbackExplainer(input);
		}

		return text;
	};
}

/**
 * Builds a compact market-context string for the system prompt.
 * Keeps token usage low while giving the model enough to be useful.
 */
function buildMarketContext(input: ReadExplainerInput): string {
	const lines: string[] = [];

	lines.push(`Live markets: ${input.liveMarketCount}`);
	lines.push(`Search matches for user query: ${input.searchResultsCount}`);

	if (input.sampleMarketSummaries.length > 0) {
		lines.push('');
		lines.push('Sample markets:');
		for (const summary of input.sampleMarketSummaries) {
			const priceInfo = summary.outcomes.map((o, i) => `${o}: ${Math.round((summary.outcomePrices[i] ?? 0) * 100)}%`).join(', ');
			const vol = summary.volume >= 1_000_000 ? `$${(summary.volume / 1_000_000).toFixed(1)}M` : summary.volume >= 1_000 ? `$${(summary.volume / 1_000).toFixed(0)}K` : `$${Math.round(summary.volume)}`;
			lines.push(`- [${summary.status}] "${summary.question}" (${priceInfo}) vol=${vol}`);
		}
	}

	return lines.join('\n');
}

/**
 * Graceful fallback when Gemini is unavailable or rate-limited.
 * Returns basic factual data without AI generation.
 */
function fallbackExplainer(input: ReadExplainerInput): string {
	const parts: string[] = [];

	parts.push(`I found **${input.liveMarketCount}** live markets`);
	if (input.searchResultsCount > 0) {
		parts.push(` and **${input.searchResultsCount}** matching your query`);
	}
	parts.push('.');

	if (input.sampleMarketSummaries.length > 0) {
		parts.push('\n\nHere are some markets:');
		for (const summary of input.sampleMarketSummaries) {
			const priceInfo = summary.outcomes.map((o, i) => {
				const pct = Math.round((summary.outcomePrices[i] ?? 0) * 100);
				return `${o}: ${pct}%`;
			}).join(' / ');
			const vol = summary.volume >= 1_000_000 ? `$${(summary.volume / 1_000_000).toFixed(1)}M` : summary.volume >= 1_000 ? `$${(summary.volume / 1_000).toFixed(0)}K` : `$${Math.round(summary.volume)}`;
			parts.push(`\n• **${summary.question}** — ${priceInfo} (Vol: ${vol})`);
		}
	}

	return parts.join('');
}
