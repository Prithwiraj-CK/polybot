# Discord Polymarket Bot Architecture

## High-Level Overview

This bot enables Discord users to chat about Polymarket markets, query info, check balances, view trade history, and place small demo bets using a house-funded wallet. The system is designed for safety, extensibility, and production-readiness.

## Architecture Diagram

```mermaid
flowchart TD
	subgraph Discord Layer
		A[Discord Bot]
	end
	subgraph AI Agent Layer
		B[Intent Parser (AI)]
	end
	subgraph Backend API
		C[API Gateway]
		D[Trading/Polymarket Service]
		E[Storage & Limits Service]
	end
	subgraph Polymarket
		F[Polymarket API]
	end
	subgraph Future Web App
		G[User Wallets & OAuth]
	end

	A-->|User Message|B
	B-->|Intent + Params|C
	C-->|Validated Request|D
	C-->|User Data|E
	D-->|Market Data/Trade|F
	D-->|Log/Check Limits|E
	E-->|Balances/History|C
	C-->|Response|A
	G-.->|Future: User Wallets|C
```

## Layer Responsibilities

- **Discord Layer:** Handles all Discord interactions, passes messages to AI, returns responses.
- **AI Agent Layer:** Parses user intent, returns structured commands (no execution).
- **Backend API:**
  - **API Gateway:** Orchestrates requests, enforces rules, and routes to services.
  - **Trading/Polymarket Service:** Executes trades, fetches market data, manages house wallet.
  - **Storage & Limits Service:** Tracks users, enforces daily bet limits, stores balances and trade logs.
- **Polymarket:** External API for market data and trades.
- **Future Web App:** For extensibility to user wallets and advanced features.

## Data Flows

### Placing a Trade
1. User sends message in Discord.
2. Discord Layer → AI Agent Layer (intent parsing).
3. AI Agent Layer → Backend API (intent, params).
4. API Gateway checks Storage/limits.
5. If valid, Trading Service executes trade via Polymarket API.
6. Storage logs trade, updates limits.
7. Response returned to user.

### Checking Balances
1. User requests balance in Discord.
2. Discord Layer → AI Agent Layer → Backend API.
3. API Gateway queries Storage.
4. Response returned to user.

### Fetching Recent Trades
1. User requests trade history.
2. Discord Layer → AI Agent Layer → Backend API.
3. API Gateway queries Storage.
4. Response returned to user.

## Failure Handling & Safety
- All API calls use retries and idempotent request IDs.
- Storage writes are atomic; failed trades are rolled back.
- User-facing errors are clear and actionable.
- Circuit breakers for Polymarket outages.
- No private keys or sensitive data in Discord/AI layers.
- All business logic and safety rules enforced in backend.

## Scalability & Extensibility
- Stateless Discord and AI layers can be scaled horizontally.
- Modular backend services for independent scaling.
- Intent-based architecture supports new features and web app integration.
