# Discord Polymarket Bot — Architecture

## High-Level Overview

Polybot has **two independent operating modes**:

1. **AI Assistant (READ)** — Users ask natural-language questions about Polymarket and get AI-generated answers backed by live market data. **This mode works today with zero backend.** It requires only `OPENAI_API_KEY`.
2. **Wallet-Linked Trading (WRITE)** — Users link their Polymarket wallet via an EIP-191 challenge-response flow and place trades through their own account. This mode requires a persistent backend (planned: **Supabase**).

AI is used for intent parsing (WRITE) and conversational responses (READ).
All execution, validation, and security logic is handled by deterministic, auditable TypeScript code.

## Architecture

## Overview

PolyBot is a Discord bot that lets users query live Polymarket prediction markets via natural language. It has two pipelines:

- **READ** — AI-powered Q&A about markets (live, fully working)
- **WRITE** — Wallet-linked trading (scaffolded, needs Supabase backend)

```
Discord Message
      │
      ▼
  index.ts          ← Discord client, @mention listener
      │
      ▼
  DiscordMessageRouter.ts   ← Routes to READ or WRITE pipeline
      │
      ├── READ ──────────────────────────────────────────────┐
      │   classifyMessageIntent.ts  (regex, no AI)           │
      │        │                                             │
      │        ▼                                             │
      │   PolymarketReadService.ts  (service layer)          │
      │        │                                             │
      │        ▼                                             │
      │   PolymarketApiReadProvider.ts  (Gamma API client)   │
      │        │                                             │
      │        ▼                                             │
      │   aiReadExplainer.ts  (Gemini → Discord response)    │
      │                                                      │
      └──────────────────────────────────────────────────────┘
      │
      ├── WRITE ─────────────────────────────────────────────┐
      │   intentParser.ts        (Gemini → structured JSON)  │
      │   validateAgentOutput.ts (deterministic rules)       │
      │   buildTradeRequest.ts   (assembles TradeRequest)    │
      │   UserAccountTrader.ts   (execution gateway)         │
      └──────────────────────────────────────────────────────┘
```

---

## File Map

### Entry & Wiring

| File | Purpose |
|------|---------|
| `src/index.ts` | Discord client setup, @mention handler, routes to router |
| `src/wire.ts` | Dependency injection — wires all services together |
| `src/types.ts` | All TypeScript types/interfaces (branded IDs, Market, TradeRequest, etc.) |

### `src/discord/` — Discord Layer

| File | Purpose |
|------|---------|
| `DiscordMessageRouter.ts` | Routes messages to READ or WRITE pipeline, maps results to user-facing strings |
| `classifyMessageIntent.ts` | Deterministic regex classifier — READ unless explicit trade verb + money amount |
| `AccountLinkCommands.ts` | Handles `connect account`, `verify`, `disconnect` commands |
| `bot.ts` | Placeholder (entrypoint logic lives in `index.ts`) |

### `src/read/` — READ Pipeline (Market Data + AI Responses)

| File | Purpose |
|------|---------|
| `PolymarketReadService.ts` | Service layer — filters, searches, summarizes markets via provider |
| `PolymarketApiReadProvider.ts` | Gamma API client — fetches markets, events, paginated search with slug matching |
| `aiReadExplainer.ts` | Gemini-powered conversational response generator with fallback |
| `geminiClient.ts` | Shared Gemini client with multi-key rotation and rate-limit handling |

### `src/agent/` — AI Intent Parsing (WRITE Pipeline)

| File | Purpose |
|------|---------|
| `intentParser.ts` | Gemini → structured JSON intent (place_bet, get_balance, etc.) with deterministic validation |

### `src/backend/` — Trade Validation & Assembly

| File | Purpose |
|------|---------|
| `validateAgentOutput.ts` | Pure deterministic validator — checks account link, market status, amounts, limits |
| `buildTradeRequest.ts` | Assembles validated TradeRequest with idempotency key |
| `buildValidationContext.ts` | Builds ValidationContext from persistence services |

### `src/auth/` — Account Linking (EVM Signature Verification)

| File | Purpose |
|------|---------|
| `AccountLinkChallengeService.ts` | Issues/validates time-limited nonce challenges |
| `AccountLinkVerificationService.ts` | Verifies EVM signatures against challenges |
| `AccountLinkPersistenceService.ts` | Persists Discord ↔ Polymarket account mappings |
| `EvmSignatureVerifier.ts` | EIP-191 personal_sign verification via ethers.js |
| `polymarketAuth.ts` | Type definitions for redirect-based auth flow (future) |

### `src/trading/` — Trade Execution

| File | Purpose |
|------|---------|
| `UserAccountTrader.ts` | Executes validated trades via PolymarketExecutionGateway |
| `houseTrader.ts` | Alternative trader for house-wallet mode (scaffolded) |

### `src/storage/` — Persistence (Placeholder)

| File | Purpose |
|------|---------|
| `limits.ts` | Placeholder for per-user spend tracking (needs Supabase) |

---

## What Gemini Does

Gemini (Google's LLM) is used in **three places**, all read-only and non-authoritative:

1. **Keyword Extraction** (`PolymarketApiReadProvider.ts`)
   - Extracts search keywords from conversational queries
   - Example: `"tell me about US strikes Iran by...?"` → `"US strikes Iran by"`
   - Falls back to simple prefix stripping if Gemini is unavailable

2. **Conversational Response** (`aiReadExplainer.ts`)
   - Generates natural-language Discord responses from market data
   - Receives factual market context (prices, volume, status) as system prompt
   - Falls back to a structured template if Gemini is unavailable

3. **Intent Parsing** (`intentParser.ts`)
   - Parses trade commands into structured JSON for the WRITE pipeline
   - Output is **never trusted** — always validated by deterministic code
   - Used only for WRITE-classified messages (explicit trade verb + money amount)

**Key principle:** Gemini is untrusted. All AI output passes through deterministic validation before any action is taken. The bot works without Gemini — it just uses template responses and regex-based search instead.

---

## Key Rotation

The bot supports multiple Gemini API keys (`GEMINI_API_KEY`, `GEMINI_API_KEY_2`, `GEMINI_API_KEY_3`). When a key hits its rate limit (429), it's automatically disabled for 60 seconds and the next key is tried. This triples the effective free-tier quota.

---

## Search Strategy

When a user asks about a market, the search pipeline:

1. **Prefix strip / AI keyword extraction** — cleans conversational noise
2. **Event slug search** — tries the Gamma `/events?slug=...` endpoint with sliding-window slug candidates
3. **If events found** → return them (sorted: active first, then closed)
4. **If no events** → fallback to `/markets?slug=...&tag=...&text_query=...`
5. **Dedup + merge** results across all search methods

---

## Tech Stack

- **TypeScript** (ES2022, strict mode, CommonJS)
- **discord.js** v14 — Discord client
- **@google/genai** — Gemini SDK for AI features
- **ethers** v6 — EVM signature verification
- **dotenv** — env config
- **Polymarket Gamma API** — public, no auth, market data
