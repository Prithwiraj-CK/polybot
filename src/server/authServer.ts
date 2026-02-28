import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import cors from 'cors';
import crypto from 'crypto';
import path from 'path';
import { ethers } from 'ethers';
import {
  accountLinkPersistenceService,
  executionGateway,
} from '../wire';
import type { DiscordUserId, PolymarketAccountId } from '../types';

/* ------------------------------------------------------------------ */
/*  In-memory session store for wallet-link challenges                */
/* ------------------------------------------------------------------ */

interface LinkSession {
  sessionId: string;
  discordUserId: DiscordUserId;
  nonce: string;
  challengeMessage: string;
  expiresAtMs: number;
  used: boolean;
}

interface PendingTradeSession {
  sessionId: string;
  discordUserId: DiscordUserId;
  marketId: string;
  marketQuestion: string;
  outcome: 'YES' | 'NO';
  amountCents: number;
  createdAtMs: number;
  expiresAtMs: number;
  consumed: boolean;
}

const sessions = new Map<string, LinkSession>();
const tradeSessions = new Map<string, PendingTradeSession>();

/** Purge expired sessions every 5 minutes */
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.expiresAtMs < now) sessions.delete(id);
  }
  for (const [id, s] of tradeSessions) {
    if (s.expiresAtMs < now) tradeSessions.delete(id);
  }
}, 5 * 60 * 1000);

/* ------------------------------------------------------------------ */
/*  Express app                                                       */
/* ------------------------------------------------------------------ */

const app = express();
const AUTH_PORT = process.env.AUTH_PORT || 3001;

const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS ?? `http://localhost:${AUTH_PORT}`)
  .split(',')
  .map(o => o.trim());
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', '..', 'public')));

/* ---------- 1. Create a session (called by the Discord bot) ------- */

const MAX_SESSIONS = 10_000;

app.post('/api/session', (req: Request, res: Response) => {
  // Only the bot process should call this endpoint
  const botSecret = process.env.BOT_API_SECRET;
  if (botSecret && req.headers['x-bot-secret'] !== botSecret) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { discordUserId } = req.body as { discordUserId?: string };
  if (!discordUserId) {
    return res.status(400).json({ error: 'Missing discordUserId' });
  }

  if (sessions.size >= MAX_SESSIONS) {
    return res.status(503).json({ error: 'Too many active sessions. Try again later.' });
  }

  const sessionId = crypto.randomUUID();
  const nonce = crypto.randomUUID();
  const expiresAtMs = Date.now() + 10 * 60 * 1000; // 10 min

  const challengeMessage = [
    'PolyBot Wallet Link',
    `Discord User: ${discordUserId}`,
    `Nonce: ${nonce}`,
    `Expires: ${new Date(expiresAtMs).toISOString()}`,
  ].join('\n');

  const session: LinkSession = {
    sessionId,
    discordUserId: discordUserId as DiscordUserId,
    nonce,
    challengeMessage,
    expiresAtMs,
    used: false,
  };

  sessions.set(sessionId, session);

  return res.json({ sessionId });
});

/* ---------- 2. Get challenge for a session (called by web page) --- */

app.get('/api/challenge/:sessionId', (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  if (session.used) {
    return res.status(410).json({ error: 'Session already used' });
  }
  if (session.expiresAtMs < Date.now()) {
    return res.status(410).json({ error: 'Session expired' });
  }

  return res.json({ challengeMessage: session.challengeMessage });
});

/* ---------- 3. Verify signature (called by web page) ------------- */

app.post('/api/verify', async (req: Request, res: Response) => {
  const { sessionId, signature, walletAddress, polymarketAddress } = req.body as {
    sessionId?: string;
    signature?: string;
    walletAddress?: string;
    polymarketAddress?: string;
  };

  if (!sessionId || !signature || !walletAddress || !polymarketAddress) {
    return res.status(400).json({ error: 'Missing sessionId, signature, walletAddress, or polymarketAddress' });
  }

  // Validate address formats
  if (!/^0x[a-fA-F0-9]{40}$/.test(polymarketAddress)) {
    return res.status(400).json({ error: 'Invalid Polymarket address format' });
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
    return res.status(400).json({ error: 'Invalid wallet address format' });
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  if (session.used) {
    return res.status(410).json({ error: 'Session already used' });
  }
  if (session.expiresAtMs < Date.now()) {
    return res.status(410).json({ error: 'Session expired' });
  }

  // Verify the signature recovers to the claimed wallet address
  try {
    const recovered = ethers.verifyMessage(session.challengeMessage, signature);
    if (recovered.toLowerCase() !== walletAddress.toLowerCase()) {
      return res.status(400).json({ error: 'Signature does not match wallet address' });
    }
  } catch {
    return res.status(400).json({ error: 'Invalid signature' });
  }

  // Mark session as used
  session.used = true;

  // Persist the link: discord user → Polymarket address (the one they use on polymarket.com)
  const result = await accountLinkPersistenceService.persistLink(
    session.discordUserId,
    polymarketAddress.toLowerCase() as PolymarketAccountId,
    Date.now(),
  );

  if (!result.ok) {
    console.error('❌ Failed to persist account link for', session.discordUserId);
    return res.status(500).json({ error: 'Failed to save account link' });
  }

  return res.json({
    success: true,
    discordUserId: session.discordUserId,
    polymarketAddress: polymarketAddress.toLowerCase(),
    signerAddress: walletAddress.toLowerCase(),
  });
});

/* ---------- 4. Serve the connect page ----------------------------- */

app.get('/connect', (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'connect.html'));
});

app.get('/trade-confirm', (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'trade-confirm.html'));
});

app.get('/setup-trading', (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'setup-trading.html'));
});

/* ---------- 5. Setup trading credentials (called by web page) ----- */

app.post('/api/setup-trading', async (req: Request, res: Response) => {
  const { sessionId, privateKey, proxyWallet } = req.body as {
    sessionId?: string;
    privateKey?: string;
    proxyWallet?: string;
  };

  if (!sessionId || !privateKey || !proxyWallet) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Validate formats
  if (!/^0x[a-fA-F0-9]{40}$/i.test(proxyWallet)) {
    return res.status(400).json({ error: 'Invalid proxy wallet address format' });
  }
  if (!/^0x[a-fA-F0-9]{64}$/.test(privateKey)) {
    return res.status(400).json({ error: 'Invalid private key format. Must be 0x-prefixed, 64 hex characters.' });
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found or expired. Please use /setup-trading in Discord to get a new link.' });
  }
  if (session.used) {
    return res.status(410).json({ error: 'This link was already used. Please use /setup-trading in Discord to get a new link.' });
  }
  if (session.expiresAtMs < Date.now()) {
    return res.status(410).json({ error: 'This link has expired. Please use /setup-trading in Discord to get a new link.' });
  }

  // Mark session as used
  session.used = true;

  const credentialStore = executionGateway.getCredentialStore();
  if (!credentialStore) {
    return res.status(500).json({ error: 'Trading credential store is not configured on this server.' });
  }

  try {
    // Build a wallet from the private key
    const wallet = new ethers.Wallet(privateKey) as ethers.Wallet & {
      _signTypedData: typeof ethers.Wallet.prototype.signTypedData;
    };
    wallet._signTypedData = wallet.signTypedData.bind(wallet);

    console.log(`🔑 Deriving API credentials for ${session.discordUserId} (EOA: ${wallet.address})...`);

    // Derive API credentials — same approach as the leader wallet
    const { ClobClient: ClobClientClass, Chain: ChainEnum } = await import('@polymarket/clob-client');
    const tempClient = new ClobClientClass(
      'https://clob.polymarket.com',
      ChainEnum.POLYGON,
      wallet as any,
    );

    const apiCreds = await tempClient.createOrDeriveApiKey() as unknown as {
      key: string;
      secret: string;
      passphrase: string;
    };

    if (!apiCreds.key || !apiCreds.secret || !apiCreds.passphrase) {
      return res.status(400).json({
        error: 'Could not derive API credentials. Make sure you are using your Phantom Polygon private key.',
      });
    }

    console.log(`✅ API credentials derived successfully (key: ${apiCreds.key.slice(0, 8)}...)`);

    await credentialStore.saveCredentials(session.discordUserId, {
      apiKey: apiCreds.key,
      apiSecret: apiCreds.secret,
      passphrase: apiCreds.passphrase,
      privateKey,
      proxyWallet,
    });

    // Evict cached ClobClient
    executionGateway.evictUserClient(session.discordUserId);

    // Auto-link the proxy wallet as their Polymarket account
    await accountLinkPersistenceService.persistLink(
      session.discordUserId,
      proxyWallet.toLowerCase() as PolymarketAccountId,
      Date.now(),
    );

    console.log(`🔑 Trading setup complete for ${session.discordUserId}`);

    return res.json({
      success: true,
      discordUserId: session.discordUserId,
      proxyWallet: proxyWallet.toLowerCase(),
    });
  } catch (err: any) {
    console.error('❌ Setup trading failed:', err?.response?.data || err?.message || err);

    // Check for specific CLOB errors
    if (err?.response?.data?.error === 'Could not create api key') {
      return res.status(400).json({
        error: 'This wallet is not registered on Polymarket. Make sure you export the private key from reveal.magic.link/polymarket (your Polymarket embedded wallet), NOT from MetaMask or Phantom.',
      });
    }

    return res.status(500).json({ error: 'Failed to set up trading. Please try again.' });
  }
});

app.get('/api/trade-session/:sessionId', (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  const session = tradeSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Trade session not found' });
  }

  if (session.expiresAtMs < Date.now()) {
    return res.status(410).json({ error: 'Trade session expired' });
  }

  return res.json({
    sessionId: session.sessionId,
    marketId: session.marketId,
    marketQuestion: session.marketQuestion,
    outcome: session.outcome,
    amountCents: session.amountCents,
    expiresAtMs: session.expiresAtMs,
  });
});

app.post('/api/trade-session/:sessionId/consume', (req: Request, res: Response) => {
  const botSecret = process.env.BOT_API_SECRET;
  if (botSecret && req.headers['x-bot-secret'] !== botSecret) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const sessionId = req.params.sessionId as string;
  const session = tradeSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Trade session not found' });
  }

  if (session.expiresAtMs < Date.now()) {
    return res.status(410).json({ error: 'Trade session expired' });
  }

  if (session.consumed) {
    return res.status(410).json({ error: 'Trade session already consumed' });
  }

  session.consumed = true;

  return res.json({ success: true });
});

/* ---------- Start ------------------------------------------------- */

export function startAuthServer(): void {
  app.listen(AUTH_PORT, () => {
    console.log(`🔗 Auth server running at http://localhost:${AUTH_PORT}`);
  });
}

export { app, sessions };