import { describe, expect, it } from 'vitest';
import { errorDetail, recordedKeys } from '../scripts/smokeReport';
import { storedItem } from './fixtures/pendingItems';
import { sdkError } from './fixtures/uploadFakes';

describe('smoke scripts: what they print and clean up', () => {
	it('an unexpected error prints its classification, never its message', () => {
		const error = new Error('request to https://example-bucket.s3.ap-northeast-1.amazonaws.com/k?X-Amz-Signature=secret failed');
		const detail = errorDetail(error);
		expect(detail).not.toContain('https://');
		expect(detail).not.toContain('secret');
		expect(errorDetail(sdkError(403, 'AccessDenied'))).toMatch(/AccessDenied http=403$/);
	});

	it('every key a record names under the prefix is cleaned up, the alternate key included', () => {
		const items = [
			storedItem('h', { key: 'run/uploader.png', preparedKey: 'run/uploader.png', altKey: 'run/uploader-1a2b3c4d.png', state: 'indeterminate' }),
			storedItem('x', { key: 'elsewhere/x.png', preparedKey: 'elsewhere/x.png' }),
		];
		expect(recordedKeys(items, 'run/').sort()).toEqual(['run/uploader-1a2b3c4d.png', 'run/uploader.png']);
	});
});
