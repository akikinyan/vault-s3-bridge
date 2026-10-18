// Compile-time checks (run by `npm run typecheck`, not by vitest).
// Each line marked @ts-expect-error must stay a type error; tsc fails if one starts to compile.
/* eslint-disable @typescript-eslint/no-unsafe-call -- the calls below are type errors on purpose */
import type { SettingsStore } from '../../src/settings/store';
import type { StorageConnection } from '../../src/settings/types';

declare const store: SettingsStore;
declare const connection: StorageConnection;

export function settingsAreDeeplyReadOnly(): void {
	// @ts-expect-error nested objects are read-only
	store.current.network.proxyUrl = 'http://proxy.example.com';
	// @ts-expect-error arrays are read-only
	store.current.connections.push(connection);
	// @ts-expect-error array elements are read-only
	store.current.connections[0]!.region = 'us-east-1';
	// @ts-expect-error records are read-only
	store.current.privateBuckets.push('aws:x');
	// @ts-expect-error private-file records are read-only
	store.current.privateFiles.push('a'.repeat(64));
	// @ts-expect-error history entries are read-only
	store.current.history[0]!.key = 'k/other.png';
	// @ts-expect-error device state is read-only
	store.device.profiles.c1 = { profile: 'p', generation: 1 };
}

export function checkpointMustNotReturnAPromise(): void {
	// @ts-expect-error the queue would wait for the response
	void store.checkpoint(() => Promise.resolve(1));
	// @ts-expect-error thenables are rejected too
	void store.checkpoint(() => ({ then: () => undefined }));
	// A plain object carrying the promise is the intended shape.
	void store.checkpoint(() => ({ response: Promise.resolve(1) }));
}
/* eslint-enable @typescript-eslint/no-unsafe-call -- end of the intentional type errors */
