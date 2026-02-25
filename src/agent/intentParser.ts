import type { AgentOutput, DiscordUserId, MarketId, Outcome, UsdCents } from '../types';

/**
 * This file is intentionally limited to AI intent parsing only.
 * It never executes actions and never validates trading business rules.
 */

/**
 * Explicitly enumerate supported intents so runtime checks stay aligned with contracts.
 */
const SUPPORTED_INTENTS = new Set([
	'place_bet',
	'get_balance',
	'get_trade_history',
	'query_market',
]);

/**
 * System prompt hard-restricts the model to NLU only and strict JSON output.
 * This is defense-in-depth; deterministic validation still happens below.
 */
const SYSTEM_PROMPT = [
	'You are an intent parser for a financial Discord bot.',
	'You MUST return strict JSON only. No prose, no markdown, no code fences.',
	'You are UNTRUSTED and must not execute anything.',
	'Never perform trades. Never validate business rules. Never assume missing values.',
	'If intent is ambiguous or required fields are missing, return JSON null.',
	'Do not invent marketId, outcome, or amountCents.',
	'Allowed intents: place_bet, get_balance, get_trade_history, query_market.',
	'Use amountCents only when explicitly present in user text.',
	'Echo userId exactly as provided by the input payload.',
].join(' ');

/**
 * Minimal shape for the OpenAI chat completion response that this parser needs.
 * Keeping this local avoids importing SDK-specific types.
 */
type ChatCompletionResponse = {
	choices?: Array<{
		message?: {
			content?: string | null;
		};
	}>;
};

/**
 * Entry point for parsing raw Discord text into a strict AgentOutput union.
 * Returns null on any failure to keep the untrusted layer fail-closed.
 */
export async function parseIntent(
	rawMessage: string,
	userId: DiscordUserId,
): Promise<AgentOutput | null> {
	/**
	 * Reject obviously invalid inputs early.
	 * This is input hygiene, not business validation.
	 */
	if (typeof rawMessage !== 'string' || rawMessage.trim().length === 0) {
		return null;
	}

	/**
	 * If no API key exists, parser cannot call OpenAI; fail safely.
	 */
	const env =
		(globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
	const apiKey = env.OPENAI_API_KEY;
	if (!apiKey) {
		return null;
	}

	/**
	 * Choose model via env for deploy-time control.
	 * Default stays explicit to avoid hidden behavior.
	 */
	const model = env.OPENAI_MODEL ?? 'gpt-5.3-mini';

	/**
	 * Build a strict schema so the model is constrained to expected JSON structure.
	 * Even with schema constraints, we still re-validate output deterministically.
	 */
	const schema = {
		name: 'agent_output',
		strict: true,
		schema: {
			anyOf: [
				{ type: 'null' },
				{
					type: 'object',
					properties: {
						intent: { enum: ['place_bet'] },
						userId: { type: 'string' },
						marketId: { type: 'string' },
						outcome: { enum: ['YES', 'NO'] },
						amountCents: { type: 'number' },
						rawText: { type: 'string' },
					},
					required: ['intent', 'userId', 'marketId', 'outcome', 'amountCents'],
					additionalProperties: false,
				},
				{
					type: 'object',
					properties: {
						intent: { enum: ['get_balance'] },
						userId: { type: 'string' },
						rawText: { type: 'string' },
					},
					required: ['intent', 'userId'],
					additionalProperties: false,
				},
				{
					type: 'object',
					properties: {
						intent: { enum: ['get_trade_history'] },
						userId: { type: 'string' },
						limit: { type: 'number' },
						rawText: { type: 'string' },
					},
					required: ['intent', 'userId'],
					additionalProperties: false,
				},
				{
					type: 'object',
					properties: {
						intent: { enum: ['query_market'] },
						userId: { type: 'string' },
						marketId: { type: 'string' },
						query: { type: 'string' },
						rawText: { type: 'string' },
					},
					required: ['intent', 'userId'],
					additionalProperties: false,
				},
			],
		},
	} as const;

	/**
	 * Send only parsing context to OpenAI; no credentials, no execution data.
	 */
	const body = {
		model,
		messages: [
			{ role: 'system', content: SYSTEM_PROMPT },
			{
				role: 'user',
				content: JSON.stringify({
					userId,
					message: rawMessage,
					instruction:
						'Return JSON null if ambiguous or missing required fields; otherwise return one valid intent object.',
				}),
			},
		],
		response_format: {
			type: 'json_schema',
			json_schema: schema,
		},
		temperature: 0,
	};

	try {
		/**
		 * Network call is isolated in try/catch so this layer never throws upward.
		 */
		const response = await fetch('https://api.openai.com/v1/chat/completions', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify(body),
		});

		/**
		 * Non-2xx means parser cannot trust an output payload; fail closed.
		 */
		if (!response.ok) {
			return null;
		}

		/**
		 * Parse provider response shape safely without assumptions.
		 */
		const payload = (await response.json()) as ChatCompletionResponse;
		const content = payload.choices?.[0]?.message?.content;
		if (typeof content !== 'string' || content.trim().length === 0) {
			return null;
		}

		/**
		 * Parse model text as JSON; malformed JSON is treated as failure.
		 */
		let parsed: unknown;
		try {
			parsed = JSON.parse(content);
		} catch {
			return null;
		}

		/**
		 * Model can explicitly return null for ambiguity or missing required fields.
		 */
		if (parsed === null) {
			return null;
		}

		/**
		 * Deterministic runtime validation ensures exact AgentOutput conformance.
		 */
		if (!isAgentOutput(parsed)) {
			return null;
		}

		/**
		 * Enforce identity consistency so parser cannot switch users.
		 */
		if (parsed.userId !== userId) {
			return null;
		}

		return toBrandedAgentOutput(parsed);
	} catch {
		/**
		 * Any runtime/network/provider error must not bubble; return null safely.
		 */
		return null;
	}
}

/**
 * Narrow unknown values to plain objects for safe property checks.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate optional rawText field type only.
 */
function hasValidRawText(value: Record<string, unknown>): boolean {
	return value.rawText === undefined || typeof value.rawText === 'string';
}

/**
 * Guard against extra keys so output matches strict union members exactly.
 */
function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	const allowedSet = new Set(allowed);
	return Object.keys(value).every((key) => allowedSet.has(key));
}

/**
 * Deterministic AgentOutput validator.
 * This validates JSON shape and primitive types only; no business rules.
 */
function isAgentOutput(value: unknown): value is AgentOutput {
	if (!isRecord(value)) {
		return false;
	}

	if (typeof value.intent !== 'string' || !SUPPORTED_INTENTS.has(value.intent)) {
		return false;
	}

	if (typeof value.userId !== 'string') {
		return false;
	}

	if (!hasValidRawText(value)) {
		return false;
	}

	if (value.intent === 'place_bet') {
		if (
			typeof value.marketId !== 'string' ||
			(value.outcome !== 'YES' && value.outcome !== 'NO') ||
			typeof value.amountCents !== 'number' ||
			!Number.isFinite(value.amountCents)
		) {
			return false;
		}

		if (!hasOnlyKeys(value, ['intent', 'userId', 'marketId', 'outcome', 'amountCents', 'rawText'])) {
			return false;
		}

		return true;
	}

	if (value.intent === 'get_balance') {
		if (!hasOnlyKeys(value, ['intent', 'userId', 'rawText'])) {
			return false;
		}

		return true;
	}

	if (value.intent === 'get_trade_history') {
		if (
			value.limit !== undefined &&
			(typeof value.limit !== 'number' || !Number.isFinite(value.limit))
		) {
			return false;
		}

		if (!hasOnlyKeys(value, ['intent', 'userId', 'limit', 'rawText'])) {
			return false;
		}

		return true;
	}

	if (value.intent === 'query_market') {
		if (
			(value.marketId !== undefined && typeof value.marketId !== 'string') ||
			(value.query !== undefined && typeof value.query !== 'string')
		) {
			return false;
		}

		if (!hasOnlyKeys(value, ['intent', 'userId', 'marketId', 'query', 'rawText'])) {
			return false;
		}

		return true;
	}

	return false;
}

/**
 * Explicit cast helper functions keep branding local to parsing boundary.
 * They do not add business meaning; they only align runtime strings/numbers to contracts.
 */
function asDiscordUserId(value: string): DiscordUserId {
	return value as DiscordUserId;
}

function asMarketId(value: string): MarketId {
	return value as MarketId;
}

function asUsdCents(value: number): UsdCents {
	return value as UsdCents;
}

function asOutcome(value: 'YES' | 'NO'): Outcome {
	return value;
}

/**
 * Re-map validated object into branded AgentOutput values.
 * This keeps caller-facing output aligned with strict contract types.
 */
function toBrandedAgentOutput(value: AgentOutput): AgentOutput {
	if (value.intent === 'place_bet') {
		return {
			intent: 'place_bet',
			userId: asDiscordUserId(value.userId),
			marketId: asMarketId(value.marketId),
			outcome: asOutcome(value.outcome),
			amountCents: asUsdCents(value.amountCents),
			rawText: value.rawText,
		};
	}

	if (value.intent === 'get_balance') {
		return {
			intent: 'get_balance',
			userId: asDiscordUserId(value.userId),
			rawText: value.rawText,
		};
	}

	if (value.intent === 'get_trade_history') {
		return {
			intent: 'get_trade_history',
			userId: asDiscordUserId(value.userId),
			limit: value.limit,
			rawText: value.rawText,
		};
	}

	return {
		intent: 'query_market',
		userId: asDiscordUserId(value.userId),
		marketId: value.marketId ? asMarketId(value.marketId) : undefined,
		query: value.query,
		rawText: value.rawText,
	};
}
