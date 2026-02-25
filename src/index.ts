import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';

import { handleAccountLinkCommand } from './discord/AccountLinkCommands';
import { DiscordMessageRouter } from './discord/DiscordMessageRouter';
import type { DiscordUserId } from './types';

// ⬇️ import all your services
import {
  accountLinkChallengeService,
  accountLinkVerificationService,
  accountLinkPersistenceService,
  trader,
  readService,
} from './wire';
import { createBuildValidationContext } from './backend/buildValidationContext';

// ---- Discord Client ----
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // REQUIRED
  ],
});

const buildValidationContext = createBuildValidationContext({
  accountLinkPersistenceService,
  polymarketReadService: readService,
});

// ---- Router ----
const router = new DiscordMessageRouter({
  readService,
  trader,
  buildValidationContext,
  nowMs: () => Date.now(),
});

// ---- Ready ----
client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user?.tag}`);
});

// ---- Message Handler ----
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const discordUserId = message.author.id as DiscordUserId;
  const text = message.content;

  try {
    const isAccountCommand =
      /^connect\s+account$/i.test(text.trim()) ||
      /^verify\s+\S+\s+\S+\s+.+$/i.test(text.trim()) ||
      /^disconnect$/i.test(text.trim());

    if (isAccountCommand) {
      const linkResponse = await handleAccountLinkCommand(text, discordUserId, {
        challengeService: accountLinkChallengeService,
        verificationService: accountLinkVerificationService,
        persistenceService: accountLinkPersistenceService,
        nowMs: () => Date.now(),
      });
      await message.reply(linkResponse);
      return;
    }

    const response = await router.routeMessage(text, discordUserId);
    await message.reply(response);
  } catch {
    await message.reply('Unable to process your request right now. Please try again.');
  }
});

// ---- Login ----
client.login(process.env.DISCORD_BOT_TOKEN);