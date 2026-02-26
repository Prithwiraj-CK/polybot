# PolyBot — Polymarket Discord Bot

A Discord bot that answers questions about [Polymarket](https://polymarket.com) prediction markets using live data and AI.

**@mention the bot** in any channel and ask about any market — it fetches real-time odds, volume, and status from Polymarket's public API and responds conversationally using Google Gemini.

## Features

- **Natural language market search** — Ask `"tell me about US strikes Iran by...?"` and get live odds for all related markets
- **Live market data** — Prices, volume, and status pulled directly from the Polymarket Gamma API (public, no auth)
- **AI-powered responses** — Gemini generates conversational answers with market context
- **Graceful degradation** — When AI quota is exhausted, falls back to structured data responses with prices and volume
- **Multi-key rotation** — Supports up to 3 Gemini API keys with automatic failover on rate limits
- **Wallet linking** (scaffolded) — EIP-191 signature challenge flow for connecting Polymarket accounts
- **Trade execution** (scaffolded) — Deterministic validation pipeline with spending limits, ready for backend integration

## Quick Start

```bash
git clone https://github.com/Prithwiraj-CK/polybot.git
cd polybot
npm install
```

Create a `.env` file:

```env
DISCORD_BOT_TOKEN=your_discord_bot_token
GEMINI_API_KEY=your_gemini_api_key
GEMINI_API_KEY_2=optional_second_key
GEMINI_API_KEY_3=optional_third_key
```

Run:

```bash
npm run dev
```

The bot will log in and respond to @mentions in any server it's added to.

## How It Works

```
User @mentions bot → Message Router → READ or WRITE pipeline

READ (default):
  1. Extract search keywords (AI or regex)
  2. Search Polymarket events/markets API
  3. Fetch prices, volume, status
  4. Generate conversational response (Gemini)
  5. Reply in Discord

WRITE (explicit trade commands only):
  1. Parse intent via AI (structured JSON)
  2. Validate deterministically (account, market, amount, limits)
  3. Execute trade via gateway
  4. Reply with result
```

## What Gemini Does

Gemini is used for **three things**, all non-authoritative:

| Use | File | What happens without it |
|-----|------|------------------------|
| **Keyword extraction** | `PolymarketApiReadProvider.ts` | Falls back to regex prefix stripping |
| **Conversational responses** | `aiReadExplainer.ts` | Falls back to structured data template |
| **Intent parsing** (WRITE) | `intentParser.ts` | Trade commands won't parse |

**Gemini is untrusted.** All AI output passes through deterministic validation before any action is taken.

## Project Structure

```
src/
├── index.ts                 # Discord client, @mention handler
├── wire.ts                  # Dependency injection wiring
├── types.ts                 # Branded types (MarketId, UsdCents, etc.)
│
├── read/                    # READ pipeline (fully working)
│   ├── geminiClient.ts      # Shared Gemini client with key rotation
│   ├── PolymarketApiReadProvider.ts  # Gamma API client + search
│   ├── PolymarketReadService.ts      # Service layer
│   └── aiReadExplainer.ts   # AI response generator + fallback
│
├── discord/                 # Discord layer
│   ├── DiscordMessageRouter.ts    # Routes READ/WRITE, maps responses
│   ├── classifyMessageIntent.ts   # Regex classifier (no AI)
│   └── AccountLinkCommands.ts     # connect/verify/disconnect
│
├── agent/                   # AI intent parsing
│   └── intentParser.ts      # Gemini → structured JSON
│
├── backend/                 # Deterministic validation
│   ├── validateAgentOutput.ts     # Pure precondition checks
│   ├── buildTradeRequest.ts       # Trade assembly + idempotency
│   └── buildValidationContext.ts  # Context construction
│
├── auth/                    # EVM wallet linking
│   ├── AccountLinkChallengeService.ts
│   ├── AccountLinkVerificationService.ts
│   ├── AccountLinkPersistenceService.ts
│   └── EvmSignatureVerifier.ts
│
└── trading/                 # Trade execution
    ├── UserAccountTrader.ts
    └── houseTrader.ts
```

## Tech Stack

| Component | Technology |
|-----------|------------|
| Language | TypeScript (ES2022, strict mode) |
| Discord | discord.js v14 |
| AI | Google Gemini via `@google/genai` SDK |
| Market Data | Polymarket Gamma API (public, no auth) |
| Crypto | ethers v6 (EIP-191 signature verification) |
| Config | dotenv |

## Current Status

| Mode | Status |
|------|--------|
| **AI Assistant (READ)** | **Working** — live Polymarket data + Gemini responses |
| **Trading (WRITE)** | **Scaffolded** — needs Supabase backend for persistence |

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full file map, data flows, search strategy, and design principles.
