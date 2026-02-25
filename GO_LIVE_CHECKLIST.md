# Go-Live Checklist

Status as of 2026-02-26: **Not production-ready.**
Core architecture is complete and compiles cleanly. All services are wired with in-memory stubs.

---

## Must-Fix (Blocking)

### 1. Real Polymarket API Integration

- [ ] **PolymarketReadProvider** — Implement against the live Polymarket CLOB/REST API (replace `InMemoryPolymarketReadProvider`).
  - `listMarkets()` → paginated active-market fetch
  - `getMarket(id)` → single-market lookup
  - `searchMarkets(query)` → text search / filtering
- [ ] **PolymarketExecutionGateway** — Implement against the live Polymarket order API (replace `StubPolymarketExecutionGateway`).
  - `executeTradeForAccount()` → submit order, return trade ID
  - `getBalanceForAccount()` → fetch real balance
  - `getRecentTradesForAccount()` → fetch trade history
- [ ] Handle Polymarket API rate limits, retries, and transient failures.

### 2. Persistent Storage

- [ ] **AccountLinkChallengeStore** — Replace `InMemoryAccountLinkChallengeStore` with Redis or database-backed store with TTL enforcement.
- [ ] **AccountLinkStore** — Replace `InMemoryAccountLinkStore` with database-backed persistence (e.g., PostgreSQL, SQLite).
- [ ] **Spend tracking** — Replace `DAILY_LIMIT_CENTS_STUB` (500) and `SPENT_THIS_HOUR_CENTS_STUB` (0) in `buildValidationContext.ts` with a real per-user spend tracking service that reads from persisted trade logs.

### 3. Environment & Configuration

- [ ] Validate required env vars on startup (`DISCORD_BOT_TOKEN`, `OPENAI_API_KEY`, Polymarket API credentials). Fail fast with clear error messages if missing.
- [ ] Add `.env.example` documenting all required/optional variables.

### 4. Graceful Shutdown

- [ ] Handle `SIGINT` / `SIGTERM` — destroy Discord client, flush pending writes, close database connections.

---

## Should-Fix (High Priority)

### 5. Error Observability

- [ ] Add structured logging (e.g., pino) throughout service layers — especially trade execution, signature verification, and validation failures.
- [ ] Log trade audit trail: who, what market, how much, result, timestamp.

### 6. Rate Limiting & Abuse Prevention

- [ ] Per-user Discord command rate limiting (prevent challenge spam, rapid-fire trade attempts).
- [ ] Consider per-IP or per-account Polymarket API rate budgets.

### 7. Tests

- [ ] Unit tests for pure functions: `classifyMessageIntent`, `validateAgentOutput`, `buildTradeRequest`, `buildSignedLinkMessage`.
- [ ] Integration tests for account-link lifecycle (challenge → verify → persist → disconnect).
- [ ] Integration tests for WRITE pipeline (parse → validate → build → execute).
- [ ] Mock-based tests for `DiscordMessageRouter` orchestration.

---

## Nice-to-Have (Post-Launch)

### 8. Slash Commands

- [ ] Register Discord slash commands (`/connect`, `/verify`, `/disconnect`, `/trade`, `/markets`) for better UX and discoverability.

### 9. OpenAI Fallback

- [ ] Handle OpenAI API outages gracefully (timeout, retry, or fall back to READ-only mode).

### 10. Multi-Market Support

- [ ] Support non-binary markets if Polymarket adds them.

### 11. Admin Dashboard

- [ ] Admin commands or web dashboard for monitoring linked accounts, trade volume, error rates.

---

## Already Done ✅

- [x] Branded type system (`DiscordUserId`, `PolymarketAccountId`, `MarketId`, `UsdCents`)
- [x] Result union pattern (no unchecked exceptions across boundaries)
- [x] EIP-191 challenge-response account linking with `crypto.randomUUID()` nonces
- [x] Challenge consumption after signature verification (no DoS vector)
- [x] Conservative READ/WRITE classifier (defaults ambiguous to READ)
- [x] Deterministic validation with injected context (pure, testable)
- [x] Deterministic idempotency keys (5-min time buckets)
- [x] Discord message routing with user-facing error mapping
- [x] Account link commands (connect / verify / disconnect)
- [x] Wire/DI barrel with in-memory stubs
- [x] Zero compile errors across entire workspace
- [x] ARCHITECTURE.md and readme.md match current codebase
