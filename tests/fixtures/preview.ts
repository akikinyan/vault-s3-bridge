import type { NodeHttpHandler } from '@smithy/node-http-handler';
import type { AwsCredentialIdentity } from '@smithy/types';
import { vi } from 'vitest';
import type { SharedConfig } from '../../src/aws/profiles';
import { SharedCredentials, type CredentialGateDeps } from '../../src/preview/credentials';
import { PreviewService } from '../../src/preview/service';
import { emptyDeviceState, setProfile, type DeviceState } from '../../src/settings/device';
import { recordConnection, recordsOf } from '../../src/settings/registry';
import { DEFAULT_SETTINGS, type PluginSettings, type StorageConnection } from '../../src/settings/types';

export const ssoConfig: SharedConfig = {
	configFile: {
		sso: { sso_session: 's', sso_account_id: '123456789012', sso_role_name: 'Reader' },
		other: { sso_session: 's', sso_account_id: '123456789012', sso_role_name: 'Writer' },
	},
	credentialsFile: {},
};
export const ROLE_ARN = 'arn:aws:sts::123456789012:assumed-role/Reader/someone';
export const creds = (hoursValid = 1): AwsCredentialIdentity => ({
	accessKeyId: 'ASIAEXAMPLE',
	secretAccessKey: 's',
	sessionToken: 't',
	expiration: new Date(Date.UTC(2026, 0, 1) + hoursValid * 3_600_000),
});

export function connection(o: Partial<StorageConnection> = {}): StorageConnection {
	return { id: 'c-work', alias: 'work', provider: 'aws-s3', classification: 'private', bucket: 'x', region: 'ap-northeast-1', ...o };
}

export function settingsWith(...connections: StorageConnection[]): PluginSettings {
	let records = recordsOf(DEFAULT_SETTINGS);
	for (const c of connections) records = recordConnection(records, c);
	return { ...structuredClone(DEFAULT_SETTINGS), connections, ...records };
}

export class Clock {
	t = Date.UTC(2026, 0, 1);
	now = () => this.t;
}

export function gateDeps(clock: Clock, o: Partial<CredentialGateDeps> = {}) {
	return {
		loadConfig: vi.fn(o.loadConfig ?? (async () => ssoConfig)),
		resolve: vi.fn(o.resolve ?? (async () => creds())),
		callerArn: vi.fn(o.callerArn ?? (async () => ROLE_ARN)),
		now: clock.now,
	} satisfies CredentialGateDeps;
}

export const handler = { destroy: vi.fn() } as unknown as NodeHttpHandler;

/** A body that yields chunks and records whether it was destroyed. */
export function body(bytes: Uint8Array, chunkSize = 64 * 1024) {
	const b = {
		destroyed: false,
		destroy() {
			b.destroyed = true;
		},
		async *[Symbol.asyncIterator]() {
			for (let i = 0; i < bytes.length; i += chunkSize) yield bytes.subarray(i, i + chunkSize);
		},
	};
	return b;
}

export function pngBytes(w: number, h: number, size = 64): Uint8Array {
	const b = new Uint8Array(Math.max(size, 33));
	b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
	new DataView(b.buffer).setUint32(16, w);
	new DataView(b.buffer).setUint32(20, h);
	return b;
}

type Send = (command: { constructor: { name: string }; input: Record<string, unknown> }, signal: AbortSignal | undefined) => Promise<unknown>;

export function setupService(o: { settings?: PluginSettings; device?: DeviceState; send?: Send; clock?: Clock; gate?: Partial<CredentialGateDeps> } = {}) {
	const clock = o.clock ?? new Clock();
	let settings = o.settings ?? settingsWith(connection());
	const device = o.device ?? emptyDeviceState();
	if (!o.device) for (const c of settings.connections) setProfile(device, c.id, 'sso');
	const gate = gateDeps(clock, o.gate);
	const credentials = new SharedCredentials(gate, handler);
	const calls: { command: string; key?: unknown; bucket?: unknown; signal?: AbortSignal }[] = [];
	const send: Send = o.send ?? (async () => ({ ContentLength: 64, Body: body(pngBytes(10, 10)) }));
	const urls = { created: [] as string[], revoked: [] as string[] };
	let n = 0;
	const service = new PreviewService({
		settings: () => settings,
		device: () => device,
		credentials,
		s3For: () => ({
			send: ((command: { constructor: { name: string }; input: Record<string, unknown> }, options?: { abortSignal?: AbortSignal }) => {
				calls.push({ command: command.constructor.name, key: command.input.Key, bucket: command.input.Bucket, signal: options?.abortSignal });
				return send(command, options?.abortSignal);
			}) as never,
		}),
		createObjectURL: () => {
			const url = `blob:test/${++n}`;
			urls.created.push(url);
			return url;
		},
		revokeObjectURL: (url) => void urls.revoked.push(url),
		now: clock.now,
	});
	return {
		service,
		calls,
		urls,
		gate,
		clock,
		device,
		setSettings: (s: PluginSettings) => (settings = s),
		gets: () => calls.filter((c) => c.command === 'GetObjectCommand'),
	};
}

export const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A send implementation whose GetObject calls wait until released by the test. */
export function controllableSend() {
	const pending: { resolve: (v: unknown) => void; reject: (e: unknown) => void; signal?: AbortSignal; key: unknown }[] = [];
	const send: Send = (command, signal) =>
		new Promise((resolve, reject) => {
			const p = { resolve, reject, signal, key: command.input.Key };
			pending.push(p);
			signal?.addEventListener('abort', () => {
				const e = new Error('aborted');
				e.name = 'AbortError';
				reject(e);
			});
		});
	return { send, pending };
}
