// Fakes shared by the uploader and job tests: settings and record files in memory, and a bucket that never overwrites.
import type { StoreIO } from '../../src/settings/store';
import type { PendingIO, ReadOutcome } from '../../src/upload/pending';

/** One event log shared by every fake, to check the order of writes and requests. */
export type Log = string[];

export class MemoryStoreIO implements StoreIO {
	disk: unknown = null;
	failSave = false;
	readonly local = new Map<string, unknown>();
	constructor(private readonly log: Log) {}
	readonly device = { load: (k: string) => this.local.get(k), save: (k: string, v: unknown) => void this.local.set(k, structuredClone(v)) };
	loadData(): Promise<unknown> {
		return Promise.resolve(this.disk === null ? null : structuredClone(this.disk));
	}
	saveData(data: Record<string, unknown>): Promise<void> {
		if (this.failSave) return Promise.reject(new Error('disk full'));
		this.log.push('settings:save');
		this.disk = structuredClone(data);
		return Promise.resolve();
	}
	sleep(): Promise<void> {
		return Promise.resolve();
	}
}

export class MemoryPendingIO implements PendingIO {
	readonly files = new Map<string, string>();
	writes = 0;
	/** After this many writes the "process" is gone: later writes fail. */
	crashAfter = Infinity;
	onCrash?: () => void;
	constructor(private readonly log: Log) {}
	read(name: string): Promise<ReadOutcome> {
		const text = this.files.get(name);
		return Promise.resolve(text === undefined ? { kind: 'missing' } : { kind: 'text', text });
	}
	writeAtomic(name: string, text: string): Promise<void> {
		if (this.writes >= this.crashAfter) return Promise.reject(new Error('process ended'));
		this.writes++;
		const states = (JSON.parse(text) as { items: { state: string }[] }).items.map((i) => i.state).join(',');
		this.log.push(`pending:${states}`);
		this.files.set(name, text);
		if (this.writes === this.crashAfter) this.onCrash?.();
		return Promise.resolve();
	}
	rename(): Promise<void> {
		return Promise.resolve();
	}
	unlink(name: string): Promise<void> {
		this.files.delete(name);
		return Promise.resolve();
	}
	list(): Promise<string[]> {
		return Promise.resolve([...this.files.keys()]);
	}
}

export const sdkError = (status: number, name: string) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });

export type Answer = (key: string, signal: AbortSignal | undefined) => unknown;

/** In-memory bucket: Head returns the stored checksum, Put never overwrites. Scripted answers come first. */
export class FakeS3 {
	readonly objects = new Map<string, string>();
	readonly calls: { op: 'head' | 'put'; key: string; timeout?: number }[] = [];
	readonly script: { op: 'head' | 'put'; answer: Answer }[] = [];
	constructor(private readonly log: Log) {}
	send(command: { constructor: { name: string }; input: Record<string, unknown> }, options?: { abortSignal?: AbortSignal; requestTimeout?: number }) {
		const op = command.constructor.name === 'HeadObjectCommand' ? 'head' : 'put';
		const key = command.input.Key as string;
		this.calls.push({ op, key, timeout: options?.requestTimeout });
		this.log.push(`s3:${op}:${key}`);
		const i = this.script.findIndex((s) => s.op === op);
		if (i >= 0) {
			const [s] = this.script.splice(i, 1);
			return Promise.resolve().then(() => s!.answer(key, options?.abortSignal));
		}
		if (op === 'head') {
			const sum = this.objects.get(key);
			return sum === undefined ? Promise.reject(sdkError(404, 'NotFound')) : Promise.resolve({ ChecksumSHA256: sum, ChecksumType: 'FULL_OBJECT' });
		}
		if (this.objects.has(key)) return Promise.reject(sdkError(412, 'PreconditionFailed'));
		this.objects.set(key, command.input.ChecksumSHA256 as string);
		return Promise.resolve({});
	}
	on(op: 'head' | 'put', answer: Answer): this {
		this.script.push({ op, answer });
		return this;
	}
	ops(): string[] {
		return this.calls.map((c) => `${c.op}:${c.key}`);
	}
}

