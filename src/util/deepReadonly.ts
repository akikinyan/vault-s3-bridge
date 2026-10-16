/** Read-only view of a value, including nested objects and array elements. */
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
	? T
	: T extends readonly (infer U)[]
		? ReadonlyArray<DeepReadonly<U>>
		: T extends object
			? { readonly [K in keyof T]: DeepReadonly<T[K]> }
			: T;

/** Freezes a plain data value and everything it contains. Returns the same value. */
export function deepFreeze<T>(value: T): DeepReadonly<T> {
	if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value)) deepFreeze(child);
	}
	return value as DeepReadonly<T>;
}

/** Deep copy of JSON-compatible data (settings are always serialisable). */
export function cloneData<T>(value: T): T {
	return structuredClone(value);
}
