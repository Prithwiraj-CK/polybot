import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { DiscordUserId } from '../types';
import crypto from 'crypto';

/**
 * Per-user CLOB trading credentials.
 * Private key is stored encrypted at rest.
 *
 * Table: user_credentials
 *   discord_user_id       TEXT PRIMARY KEY
 *   api_key               TEXT NOT NULL
 *   api_secret            TEXT NOT NULL
 *   passphrase            TEXT NOT NULL
 *   encrypted_private_key TEXT NOT NULL
 *   proxy_wallet          TEXT NOT NULL
 *   iv                    TEXT NOT NULL
 *   auth_tag              TEXT NOT NULL
 *   created_at_ms         BIGINT NOT NULL
 *
 * Run this SQL in Supabase Dashboard → SQL Editor:
 *
 *   CREATE TABLE IF NOT EXISTS user_credentials (
 *     discord_user_id       TEXT PRIMARY KEY,
 *     api_key               TEXT NOT NULL,
 *     api_secret            TEXT NOT NULL,
 *     passphrase            TEXT NOT NULL,
 *     encrypted_private_key TEXT NOT NULL,
 *     proxy_wallet          TEXT NOT NULL,
 *     iv                    TEXT NOT NULL,
 *     auth_tag              TEXT NOT NULL,
 *     created_at_ms         BIGINT NOT NULL
 *   );
 */

export interface UserClobCredentials {
    readonly apiKey: string;
    readonly apiSecret: string;
    readonly passphrase: string;
    readonly privateKey: string;
    readonly proxyWallet: string;
}

export class SupabaseUserCredentialStore {
    private readonly supabase: SupabaseClient;
    private readonly encryptionKey: Buffer;

    constructor() {
        const url = process.env.SUPABASE_URL;
        const key = process.env.SUPABASE_KEY;
        if (!url || !key) {
            throw new Error('Missing SUPABASE_URL or SUPABASE_KEY in .env');
        }

        const encKeyHex = process.env.CREDENTIAL_ENCRYPTION_KEY;
        if (!encKeyHex || encKeyHex.length !== 64) {
            throw new Error(
                'Missing or invalid CREDENTIAL_ENCRYPTION_KEY in .env. Must be a 64-character hex string (32 bytes).',
            );
        }
        this.encryptionKey = Buffer.from(encKeyHex, 'hex');
        this.supabase = createClient(url, key);
    }

    /**
     * Store (or overwrite) CLOB credentials for a Discord user.
     * The private key is encrypted with AES-256-GCM before storage.
     */
    public async saveCredentials(
        discordUserId: DiscordUserId,
        creds: UserClobCredentials,
    ): Promise<void> {
        const { encrypted, iv, authTag } = this.encrypt(creds.privateKey);

        const { error } = await this.supabase.from('user_credentials').upsert(
            {
                discord_user_id: discordUserId,
                api_key: creds.apiKey,
                api_secret: creds.apiSecret,
                passphrase: creds.passphrase,
                encrypted_private_key: encrypted,
                proxy_wallet: creds.proxyWallet,
                iv,
                auth_tag: authTag,
                created_at_ms: Date.now(),
            },
            { onConflict: 'discord_user_id' },
        );

        if (error) {
            throw new Error(`Supabase saveCredentials error: ${error.message}`);
        }
    }

    /**
     * Retrieve CLOB credentials for a Discord user.
     * Returns null if no credentials are stored.
     */
    public async getCredentials(
        discordUserId: DiscordUserId,
    ): Promise<UserClobCredentials | null> {
        const { data, error } = await this.supabase
            .from('user_credentials')
            .select('api_key, api_secret, passphrase, encrypted_private_key, proxy_wallet, iv, auth_tag')
            .eq('discord_user_id', discordUserId)
            .single();

        if (error && error.code === 'PGRST116') {
            // No row found
            return null;
        }
        if (error) {
            throw new Error(`Supabase getCredentials error: ${error.message}`);
        }
        if (!data) {
            return null;
        }

        const privateKey = this.decrypt(
            data.encrypted_private_key as string,
            data.iv as string,
            data.auth_tag as string,
        );

        return {
            apiKey: data.api_key as string,
            apiSecret: data.api_secret as string,
            passphrase: data.passphrase as string,
            privateKey,
            proxyWallet: data.proxy_wallet as string,
        };
    }

    /**
     * Delete stored credentials for a Discord user.
     */
    public async deleteCredentials(discordUserId: DiscordUserId): Promise<boolean> {
        // Check existence first
        const existing = await this.getCredentials(discordUserId);
        if (!existing) {
            return false;
        }

        const { error } = await this.supabase
            .from('user_credentials')
            .delete()
            .eq('discord_user_id', discordUserId);

        if (error) {
            throw new Error(`Supabase deleteCredentials error: ${error.message}`);
        }
        return true;
    }

    // ── Encryption helpers ──────────────────────────────────────

    private encrypt(plaintext: string): { encrypted: string; iv: string; authTag: string } {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);

        let encrypted = cipher.update(plaintext, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        const authTag = cipher.getAuthTag().toString('hex');

        return {
            encrypted,
            iv: iv.toString('hex'),
            authTag,
        };
    }

    private decrypt(encrypted: string, ivHex: string, authTagHex: string): string {
        const iv = Buffer.from(ivHex, 'hex');
        const authTag = Buffer.from(authTagHex, 'hex');
        const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
        decipher.setAuthTag(authTag);

        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    }
}
