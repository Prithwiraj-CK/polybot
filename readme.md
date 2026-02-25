# Polymarket Discord Bot (Demo Mode)

## Overview

This production-grade Discord bot enables users to interact with Polymarket markets directly from Discord. Users can query market information, check virtual balances, view trade history, and place small demo trades using a house-funded wallet. The bot leverages advanced AI for natural language understanding, ensuring a seamless and intuitive user experience.

## What the Bot Does
- Allows users to chat naturally about Polymarket markets.
- Provides real-time market information, balances, and trade history.
- Enables users to place small demo trades (up to $5/day per user) using a house-funded wallet.
- Enforces strict per-user daily spending limits and all safety rules in deterministic backend code.
- Uses AI solely for intent parsing; all execution and validation are handled by secure, auditable backend services.

## What the Bot Does NOT Do
- Does NOT custody, transfer, or interact with real user funds or wallets.
- Does NOT allow users to connect or manage their own wallets within Discord.
- Does NOT use AI for any execution, trading, or business logic—AI is strictly limited to natural language understanding.
- Does NOT bypass or relax any enforced safety or compliance rules.

## Demo Mode Disclaimer
**This bot operates exclusively in demo mode. All trades are simulated using a house-funded wallet for demonstration and educational purposes only. No real money is at risk, and users cannot deposit, withdraw, or earn real funds through this bot.**

## Security Model
- No private keys, wallet credentials, or sensitive financial data are ever stored or transmitted via Discord or the AI layer.
- All business logic, spending limits, and safety rules are enforced in deterministic, auditable backend code.
- All user actions and system events are logged for full auditability and compliance.
- The bot is designed to be safe, scalable, and robust against abuse, with strict rate limiting and abuse prevention mechanisms.

## Limitations
- Users are limited to $5 in demo trades per 24-hour period.
- Only supported, active Polymarket markets are available for demo trading.
- No real funds can be deposited, withdrawn, or earned.
- The bot cannot be used for actual trading or financial transactions.
- AI is used only for intent parsing and never for execution or decision-making.

## Future Roadmap
- Integration with a secure web application to allow users to connect their own wallets (outside Discord) for real trading.
- Enhanced analytics, notifications, and market insights.
- Expanded support for additional prediction markets and financial products.

---

**For questions, audits, or partnership inquiries, please contact the project maintainers.**
