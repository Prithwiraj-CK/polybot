import { AccountLinkChallengeService } from '../auth/AccountLinkChallengeService';
import { AccountLinkPersistenceService } from '../auth/AccountLinkPersistenceService';
import {
	AccountLinkVerificationService,
	buildSignedLinkMessage,
} from '../auth/AccountLinkVerificationService';
import type { DiscordUserId, PolymarketAccountId } from '../types';

interface AccountLinkCommandDependencies {
	readonly challengeService: AccountLinkChallengeService;
	readonly verificationService: AccountLinkVerificationService;
	readonly persistenceService: AccountLinkPersistenceService;
	readonly nowMs: () => number;
}

/**
 * Handles plain-text account-link commands from Discord.
 *
 * This layer is orchestration + presentation only:
 * - Calls backend auth services.
 * - Returns user-facing strings.
 * - Does not implement crypto, validation, or persistence logic itself.
 */
export async function handleAccountLinkCommand(
	message: string,
	discordUserId: DiscordUserId,
	deps: AccountLinkCommandDependencies,
): Promise<string> {
	try {
		const trimmed = message.trim();

		if (/^connect\s+account$/i.test(trimmed)) {
			return handleConnectAccount(discordUserId, deps);
		}

		const verifyMatch = trimmed.match(/^verify\s+(\S+)\s+(\S+)\s+(.+)$/i);
		if (verifyMatch) {
			const polymarketAccountId = verifyMatch[1] as PolymarketAccountId;
			const nonce = verifyMatch[2];
			const signature = verifyMatch[3];
			return handleVerify(discordUserId, polymarketAccountId, nonce, signature, deps);
		}

		if (/^disconnect$/i.test(trimmed)) {
			return handleDisconnect(discordUserId, deps);
		}

		return [
			'Supported commands:',
			'- connect account',
			'- verify <polymarketAccountId> <nonce> <signature>',
			'- disconnect',
		].join('\n');
	} catch {
		return 'Unable to process account-link command right now. Please try again.';
	}
}

async function handleConnectAccount(
	discordUserId: DiscordUserId,
	deps: AccountLinkCommandDependencies,
): Promise<string> {
	const issued = await deps.challengeService.issueChallenge(discordUserId, deps.nowMs());
	if (!issued.ok) {
		return 'Could not start account connection right now. Please try again.';
	}

	const challengeMessage = buildSignedLinkMessage(issued.challenge);

	return [
		'Sign the exact message below with your wallet using personal_sign, then submit:',
		`verify <polymarketAccountId> ${issued.challenge.nonce} <signature>`,
		'',
		challengeMessage,
	].join('\n');
}

async function handleVerify(
	discordUserId: DiscordUserId,
	polymarketAccountId: PolymarketAccountId,
	nonce: string,
	signature: string,
	deps: AccountLinkCommandDependencies,
): Promise<string> {
	const verification = await deps.verificationService.verifyLink(
		discordUserId,
		nonce,
		polymarketAccountId,
		signature,
		deps.nowMs(),
	);

	if (!verification.ok) {
		if (verification.errorCode === 'CHALLENGE_INVALID') {
			return 'Challenge is invalid or expired. Please run "connect account" again.';
		}

		return 'Signature verification failed. Please ensure you signed the exact challenge message.';
	}

	const persisted = await deps.persistenceService.persistLink(
		discordUserId,
		polymarketAccountId,
		deps.nowMs(),
	);
	if (!persisted.ok) {
		return 'Account verified, but linking could not be saved right now. Please try again.';
	}

	return 'Your Polymarket account is now connected successfully.';
}

async function handleDisconnect(
	discordUserId: DiscordUserId,
	deps: AccountLinkCommandDependencies,
): Promise<string> {
	const result = await deps.persistenceService.unlink(discordUserId);
	if (!result.ok) {
		if (result.errorCode === 'LINK_NOT_FOUND') {
			return 'No linked Polymarket account was found for your Discord user.';
		}

		return 'Could not disconnect your account right now. Please try again.';
	}

	return 'Your Polymarket account has been disconnected.';
}

