import { describe, expect, it } from 'vitest';
import { redactArn, redactText, sanitizeForLog } from '../src/util/redact';

describe('redaction', () => {
	it('masks the account ID and the session name of assumed roles', () => {
		const arn = 'arn:aws:sts::123456789012:assumed-role/Reader/someone@example.com';
		expect(redactArn(arn)).toBe('arn:aws:sts::****:assumed-role/Reader/****');
	});

	it('is idempotent', () => {
		const once = redactArn('arn:aws:sts::123456789012:assumed-role/Reader/someone@example.com');
		expect(redactArn(once)).toBe(once);
		expect(redactText(once)).toBe(once);
	});

	it('masks IAM user ARNs and bare account IDs', () => {
		expect(redactText('arn:aws:iam::123456789012:user/alice and 123456789012')).toBe('arn:aws:iam::****:user/alice and ****');
	});

	it('replaces literal values', () => {
		expect(redactText('bucket my-bucket in profile p1', { replacements: [['my-bucket', '<bucket>'], ['p1', '<profile>']] })).toBe(
			'bucket <bucket> in profile <profile>',
		);
	});

	it('drops secret fields from logged objects', () => {
		const error = Object.assign(new Error('failed for 123456789012'), {
			credentials: {
				accessKeyId: 'ASIAEXAMPLE',
				secretAccessKey: 'secret',
				sessionToken: 'session-token-value',
				expiration: '2026-01-01',
			},
			token: { accessToken: 'a', refreshToken: 'r', clientSecret: 's', clientId: 'c' },
		});
		const text = JSON.stringify(sanitizeForLog({ error }));
		for (const secret of ['ASIAEXAMPLE', '"secret"', 'session-token-value', '"a"', '"r"', '"s"', '"c"', '123456789012']) {
			expect(text).not.toContain(secret);
		}
		expect(text).toContain('2026-01-01');
		expect(text).toContain('failed for ****');
	});
});
