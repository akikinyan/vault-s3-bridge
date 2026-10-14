const ACCOUNT_ID = /\b\d{12}\b/g;
const ARN = /arn:aws[a-z-]*:[a-z0-9-]+:[a-z0-9-]*:(\d{12}|\*{4}):([A-Za-z0-9+=,.@_/*-]+)/g;

export const SECRET_KEYS = new Set([
	'accesskeyid',
	'secretaccesskey',
	'sessiontoken',
	'accesstoken',
	'refreshtoken',
	'clientsecret',
	'clientid',
	'authorization',
	'x-amz-security-token',
]);

/** Masks the account ID and, for assumed roles, the session name: `arn:aws:sts::****:assumed-role/<role>/****`. */
export function redactArn(arn: string): string {
	return arn.replace(ARN, (match: string, _acct: string, resource: string) => {
		const prefix = match.slice(0, match.length - resource.length).replace(ACCOUNT_ID, '****');
		const parts = resource.split('/');
		if (parts[0] === 'assumed-role' && parts.length >= 3) return `${prefix}assumed-role/${parts[1]}/****`;
		return prefix + resource;
	});
}

export interface RedactOptions {
	/** Literal values (bucket names, profile names, ...) to replace with placeholders. */
	replacements?: ReadonlyArray<readonly [value: string, placeholder: string]>;
}

/** Redacts account IDs, ARN session names and the given literal values from free text. */
export function redactText(text: string, options: RedactOptions = {}): string {
	let out = redactArn(text).replace(ACCOUNT_ID, '****');
	for (const [value, placeholder] of options.replacements ?? []) {
		if (value) out = out.split(value).join(placeholder);
	}
	return out;
}

/** Deep-copies a value for logging, dropping secret fields and redacting strings. */
export function sanitizeForLog(value: unknown, options: RedactOptions = {}, seen = new WeakSet<object>()): unknown {
	if (typeof value === 'string') return redactText(value, options);
	if (typeof value !== 'object' || value === null) return value;
	if (seen.has(value)) return '[circular]';
	seen.add(value);
	if (Array.isArray(value)) return value.map((v) => sanitizeForLog(v, options, seen));
	const out: Record<string, unknown> = {};
	const source = value instanceof Error ? { ...value, name: value.name, message: value.message } : value;
	for (const [key, v] of Object.entries(source)) {
		if (SECRET_KEYS.has(key.toLowerCase())) continue;
		out[key] = sanitizeForLog(v, options, seen);
	}
	return out;
}
