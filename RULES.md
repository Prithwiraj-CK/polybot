# Non-Negotiable System Rules for Financial Discord Bot

These rules must be strictly enforced in deterministic backend code (not prompts). All are mandatory and subject to audit.

## System Rules (Enforced in Code)

### 1. Per-User Daily Spending Limits
- Each user is limited to a maximum of $5 in total bets per 24-hour period.
- All bet attempts exceeding this limit must be rejected, with clear feedback to the user.
- Limits are tracked and enforced using persistent, tamper-proof storage.

### 2. Market Validation
- Only allow trades on valid, active, and supported Polymarket markets.
- Reject trades on closed, paused, or unsupported markets.
- Validate market existence and status before any trade is executed.

### 3. Amount Validation
- Only accept bet amounts that are positive, within allowed minimum/maximum bounds, and do not exceed the user’s remaining daily limit.
- Reject zero, negative, or non-numeric amounts.
- Reject amounts that would cause the user to exceed their daily cap.

### 4. AI Output Validation
- All AI agent outputs (intents and parameters) must be strictly validated for correctness, completeness, and safety before execution.
- No action is taken on ambiguous, incomplete, or malformed AI outputs.
- Only allow whitelisted, explicitly supported intents.

### 5. Rate Limiting
- Enforce per-user rate limits on all actions (e.g., max N trades/queries per minute).
- Reject or delay requests that exceed rate limits, with clear user feedback.

### 6. Abuse Prevention
- Detect and block suspicious or abusive patterns (e.g., spamming, automation, repeated failed attempts).
- Blacklist or temporarily suspend users who violate usage policies.
- Monitor for and prevent attempts to circumvent limits or exploit the system.

### 7. Logging and Auditability
- Log all user actions, trades, errors, and system events with timestamps and user IDs.
- Ensure logs are immutable, tamper-evident, and retained for audit.
- All critical actions must be traceable from user request to execution.

### 8. Error Transparency to Users
- All errors (validation, limits, system failures) must be communicated to users in clear, actionable language.
- Never expose sensitive system details or stack traces to users.

---

## AI Agent: Forbidden Actions

The AI agent is NEVER allowed to:
- Execute trades, modify balances, or perform any state-changing action.
- Access, generate, or handle private keys, wallet credentials, or sensitive data.
- Bypass or override any system-enforced rules or limits.
- Return intents or parameters outside the explicitly supported set.
- Interact directly with external APIs or databases.

---

## Discord Bot: Forbidden Actions

The Discord bot is NEVER allowed to:
- Store or transmit private keys, wallet credentials, or sensitive financial data.
- Execute business logic, enforce limits, or validate trades (must delegate to backend).
- Bypass backend validation, limits, or safety checks.
- Modify persistent storage or logs directly.
- Expose internal errors, stack traces, or sensitive information to users.
