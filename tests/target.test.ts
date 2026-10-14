import { describe, expect, it } from 'vitest';
import { targetKey } from '../src/storage/target';

describe('targetKey', () => {
	it('identifies AWS buckets by name regardless of endpoint', () => {
		expect(targetKey('b', undefined)).toBe('aws:b');
		expect(targetKey('b', 'https://s3.ap-northeast-1.amazonaws.com')).toBe('aws:b');
		expect(targetKey('b', 'https://S3.dualstack.us-east-1.AMAZONAWS.com/path')).toBe('aws:b');
		expect(targetKey('b', 'https://b.s3.cn-north-1.amazonaws.com.cn')).toBe('aws:b');
	});

	it('normalizes S3-compatible endpoints', () => {
		expect(targetKey('b', 'https://MinIO.example.com/')).toBe('s3c:minio.example.com/b');
		expect(targetKey('b', 'https://minio.example.com:443/x')).toBe('s3c:minio.example.com/b');
		expect(targetKey('b', 'https://minio.example.com:9000')).toBe('s3c:minio.example.com:9000/b');
	});

	it('does not treat look-alike hosts as AWS', () => {
		expect(targetKey('b', 'https://amazonaws.com.evil.example')).toBe('s3c:amazonaws.com.evil.example/b');
		expect(targetKey('b', 'https://notamazonaws.com')).toBe('s3c:notamazonaws.com/b');
	});
});
