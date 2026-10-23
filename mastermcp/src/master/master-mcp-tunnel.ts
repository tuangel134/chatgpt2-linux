/** Embedded ngrok SDK wrapper for the incoming Master MCP server. */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Logger } from '../core/platform/logger.ts';

type NgrokListener = {
	url(): string;
	close(): Promise<void>;
};

type NgrokSdk = {
	forward(config: {
		addr: string;
		authtoken: string;
		proto: 'http';
		schemes: ['HTTPS'];
		forwards_to: string;
		domain?: string;
		session_metadata: string;
	}): Promise<NgrokListener>;
};

const runtimeRequire = createRequire(__filename);
const SESSION_METADATA = JSON.stringify({ product: 'ChatGPT2', feature: 'Independent Master MCP' });

function isNgrokSdk(value: unknown): value is NgrokSdk {
	return typeof value === 'object' && value !== null && 'forward' in value && typeof value.forward === 'function';
}

/**
 * The package carries the native ngrok SDK for its target operating system. In development
 * the workspace dependency is used, so both execution modes have the same API.
 */
export function resolveEmbeddedNgrokSdkEntry(): string {
	const bundledEntry = join(__dirname, 'ngrok-sdk', 'node_modules', '@ngrok', 'ngrok', 'index.js');
	return existsSync(bundledEntry) ? bundledEntry : '@ngrok/ngrok';
}

export function loadEmbeddedNgrokSdk(): NgrokSdk {
	const sdk = runtimeRequire(resolveEmbeddedNgrokSdkEntry()) as unknown;
	if (!isNgrokSdk(sdk)) throw new Error('The embedded ngrok SDK does not expose forward().');
	return sdk;
}

export class NgrokMasterMcpTunnel {
	private readonly logger: Logger;
	private readonly loadSdk: () => NgrokSdk;
	private listener: NgrokListener | undefined;
	private url: string | undefined;

	constructor(logger: Logger, loadSdk: () => NgrokSdk = loadEmbeddedNgrokSdk) {
		this.logger = logger.child('master-mcp.ngrok');
		this.loadSdk = loadSdk;
	}

	status(): { running: boolean; publicUrl?: string } {
		return { running: this.listener !== undefined, ...(this.url ? { publicUrl: this.url } : {}) };
	}

	async start(localUrl: string, authtoken: string, domain?: string): Promise<string> {
		if (this.listener && this.url) return this.url;
		if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(localUrl)) throw new Error('Master MCP ngrok must forward a loopback URL.');
		if (authtoken.trim().length < 10) throw new Error('The ngrok authtoken is missing or invalid.');
		await this.stop();
		try {
			const listener = await this.loadSdk().forward({
				addr: localUrl,
				authtoken: authtoken.trim(),
				proto: 'http',
				schemes: ['HTTPS'],
				forwards_to: localUrl,
				session_metadata: SESSION_METADATA,
				...(domain ? {domain} : {})
			});
			const publicUrl = listener.url().trim().replace(/\/+$/, '');
			if (!/^https:\/\//i.test(publicUrl)) {
				await listener.close();
				throw new Error('The embedded ngrok SDK did not return a public HTTPS URL.');
			}
			this.listener = listener;
			this.url = publicUrl;
			return publicUrl;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.logger.warn('Embedded ngrok SDK failed to start', { error: message.replace(authtoken.trim(), '[redacted]') });
			throw new Error(`Could not start the embedded ngrok tunnel: ${message.replace(authtoken.trim(), '[redacted]')}`);
		}
	}

	async stop(): Promise<void> {
		const listener = this.listener;
		this.listener = undefined;
		this.url = undefined;
		if (!listener) return;
		await listener.close();
	}
}
