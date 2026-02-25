# Polymarket Discord Bot

## Overview

Polybot is a Discord bot that lets users **query live Polymarket markets** and **place trades through their own linked Polymarket account** — all via natural language in Discord.

Account ownership is proven by an **EIP-191 challenge-response flow** (sign a message in your wallet, verify in Discord).
AI is used **only** for intent parsing; all execution, validation, and security logic is deterministic TypeScript.

## What the Bot Does

- **Market intelligence** — Ask about any live market and get real-time data, summaries, and search results.
- **Account linking** — Link your Polymarket wallet to your Discord account via a cryptographic signature challenge (`connect account` → sign → `verify`).
- **Trading** — Place trades on linked Polymarket accounts with deterministic validation and per-user spending limits.
- **Safety-first routing** — Ambiguous messages are always routed to READ. WRITE requires both an explicit trade verb and a monetary reference.

## Account Linking Flow

1. **`connect account`** — Bot issues a unique challenge nonce (5-minute TTL).
2. **Sign the message** — In your wallet, sign the exact message the bot provides (EIP-191 `personal_sign`).
3. **`verify <accountId> <nonce> <signature>`** — Bot verifies your signature and links your account.
4. **`disconnect`** — Removes the link at any time.

Each Discord user can link **exactly one** Polymarket account. Re-linking overwrites the previous mapping.

## Commands

| Command | Description |
|---------|-------------|
| `connect account` | Start the account-linking challenge |
| `verify <accountId> <nonce> <signature>` | Complete linking by proving wallet ownership |
| `disconnect` | Remove your linked Polymarket account |
| *(natural language)* | Ask about markets or place trades conversationally |

## Security Model

- **No private keys in Discord/AI layers** — Wallet credentials never leave the user's wallet.
- **Challenge-response ownership proof** — `crypto.randomUUID()` nonces, 5-minute TTL, one-time consumption (consumed only after signature verification).
- **Deterministic validation** — All business rules, spending limits, and preconditions are enforced in pure, auditable backend code. AI has zero execution authority.
- **Result unions over exceptions** — Every service returns typed success/error results; no unchecked exceptions cross boundaries.
- **Branded types** — `DiscordUserId`, `PolymarketAccountId`, `MarketId`, `UsdCents` prevent accidental type mixing at compile time.

## Spending Limits

- Per-user daily limit: **$5.00** (500 cents).
- Per-user hourly ceiling: **$5.00** (500 cents).
- Limits are enforced deterministically in the validation layer before any trade reaches execution.
- *Note: Limit tracking is currently stubbed. Production deployment requires a persistent spend-tracking service.*

## Current Status: Pre-Production

The core architecture is implemented and compiles cleanly with zero errors. All services are wired with **in-memory stubs** suitable for local development and integration testing.

### What works today
- Full account-link lifecycle (challenge → verify → persist → disconnect)
- READ/WRITE pipeline classification and routing
- Deterministic validation of trade intents
- Idempotent trade request assembly
- User-account trade execution (against stub gateway)
- Market data queries (against fixture data)

### What needs production backends
- Real Polymarket CLOB API integration (market data + order execution)
- Persistent stores (challenges, account links, trade logs)
- Real per-user spend tracking (daily + hourly limits)
- Environment validation and graceful shutdown
- Observability (structured logging, metrics, alerting)

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js + TypeScript (ES2022, strict) |
| Discord | discord.js v14 |
| Crypto | ethers v6 (EIP-191 signature verification) |
| AI | OpenAI structured output (intent parsing only) |
| Config | dotenv |

## Getting Started

```bash
npm install
# Set DISCORD_BOT_TOKEN and OPENAI_API_KEY in .env
npx ts-node src/index.ts
```

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full architecture diagram, layer responsibilities, data flows, and stub boundary documentation.

---

**For questions, audits, or partnership inquiries, contact the project maintainers.**
