import { abortError } from '../diagnostics/types';

/** Limits concurrent downloads. Waiters that are aborted leave the queue. */
export class Limiter {
	private active = 0;
	private readonly queue: { start: () => void; signal?: AbortSignal; onAbort: () => void }[] = [];

	constructor(private readonly max: number) {}

	acquire(signal?: AbortSignal): Promise<() => void> {
		if (signal?.aborted) return Promise.reject(abortError());
		return new Promise((resolve, reject) => {
			const entry = {
				signal,
				start: () => {
					signal?.removeEventListener('abort', entry.onAbort);
					this.active++;
					let released = false;
					resolve(() => {
						if (released) return;
						released = true;
						this.active--;
						this.next();
					});
				},
				onAbort: () => {
					const i = this.queue.indexOf(entry);
					if (i >= 0) this.queue.splice(i, 1);
					reject(abortError());
				},
			};
			signal?.addEventListener('abort', entry.onAbort, { once: true });
			this.queue.push(entry);
			this.next();
		});
	}

	private next(): void {
		while (this.active < this.max && this.queue.length > 0) this.queue.shift()?.start();
	}

	get running(): number {
		return this.active;
	}

	get waiting(): number {
		return this.queue.length;
	}
}
