import type { S3Client } from '@aws-sdk/client-s3';
import type { STSClient } from '@aws-sdk/client-sts';

export interface SentCall {
	command: string;
	input: Record<string, unknown>;
	signal?: AbortSignal;
	/** Whether the signal was already aborted when the command was sent. */
	abortedAtSend: boolean;
}

type Handler = (input: Record<string, unknown>, signal: AbortSignal | undefined) => unknown;

/** A minimal stand-in for an SDK client that records every command and its abort signal. */
export class FakeClient {
	readonly calls: SentCall[] = [];
	readonly events: string[];
	destroyed = false;

	constructor(
		private readonly name: string,
		private readonly handlers: Record<string, Handler>,
		events: string[] = [],
	) {
		this.events = events;
	}

	async send(command: { constructor: { name: string }; input: Record<string, unknown> }, options?: { abortSignal?: AbortSignal }) {
		const name = command.constructor.name;
		const signal = options?.abortSignal;
		this.calls.push({ command: name, input: command.input, signal, abortedAtSend: signal?.aborted === true });
		this.events.push(`${this.name}:${name}`);
		const handler = this.handlers[name];
		if (!handler) throw new Error(`unexpected command ${name}`);
		return handler(command.input, signal);
	}

	destroy(): void {
		this.destroyed = true;
		this.events.push(`${this.name}:destroy`);
	}

	commands(): string[] {
		return this.calls.map((c) => c.command);
	}

	asS3(): S3Client {
		return this as unknown as S3Client;
	}

	asSts(): STSClient {
		return this as unknown as STSClient;
	}
}

export const ok = (value: unknown = {}) => () => value;
export const fail = (error: Error) => () => {
	throw error;
};

/** Never settles until the signal aborts, then rejects with an AbortError. */
export const hangUntilAbort = () => (_input: Record<string, unknown>, signal: AbortSignal | undefined) =>
	new Promise((_resolve, reject) => {
		signal?.addEventListener('abort', () => {
			const e = new Error('aborted');
			e.name = 'AbortError';
			reject(e);
		});
	});
