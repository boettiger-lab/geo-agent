import { describe, it, expect } from 'vitest';
import { rewriteS3UrlsInSql } from '../app/chat-ui.js';

describe('rewriteS3UrlsInSql', () => {
    it('rewrites a single s3:// URL inside read_parquet', () => {
        const sql = "SELECT * FROM read_parquet('s3://public-data/foo.parquet') LIMIT 5";
        expect(rewriteS3UrlsInSql(sql)).toBe(
            "SELECT * FROM read_parquet('https://s3-west.nrp-nautilus.io/public-data/foo.parquet') LIMIT 5"
        );
    });

    it('rewrites multiple s3:// URLs in one string (join)', () => {
        const sql =
            "SELECT a.* FROM read_parquet('s3://b1/a.parquet') a " +
            "JOIN read_parquet('s3://b2/b.parquet') b ON a.id = b.id";
        const out = rewriteS3UrlsInSql(sql);
        expect(out).toContain("'https://s3-west.nrp-nautilus.io/b1/a.parquet'");
        expect(out).toContain("'https://s3-west.nrp-nautilus.io/b2/b.parquet'");
        expect(out).not.toContain('s3://');
    });

    it('handles bare s3://bucket with no trailing slash', () => {
        expect(rewriteS3UrlsInSql('s3://my-bucket')).toBe(
            'https://s3-west.nrp-nautilus.io/my-bucket'
        );
    });

    it('preserves dotted and hyphenated bucket names', () => {
        const sql = "FROM read_parquet('s3://my.bucket-name/x.parquet')";
        expect(rewriteS3UrlsInSql(sql)).toBe(
            "FROM read_parquet('https://s3-west.nrp-nautilus.io/my.bucket-name/x.parquet')"
        );
    });

    it('leaves non-s3 schemes alone', () => {
        const sql = "FROM read_parquet('gs://bucket/x.parquet')";
        expect(rewriteS3UrlsInSql(sql)).toBe(sql);
    });

    it('returns empty string for empty input', () => {
        expect(rewriteS3UrlsInSql('')).toBe('');
    });
});

import { scrubCredentials } from '../app/chat-ui.js';

describe('scrubCredentials', () => {
    it('redacts DuckDB CREATE SECRET KEY_ID and SECRET values', () => {
        const sql =
            "CREATE SECRET my_secret (TYPE S3, KEY_ID 'AKIAIOSFODNN7EXAMPLE', " +
            "SECRET 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');";
        const out = scrubCredentials(sql);
        expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
        expect(out).not.toContain('wJalrXUtnFEMI');
        expect(out).toMatch(/KEY_ID\s+\[REDACTED\]/);
        expect(out).toMatch(/SECRET\s+\[REDACTED\]/);
        expect(out).toContain('CREATE SECRET my_secret');
    });

    it('redacts case-insensitive key_id and secret', () => {
        const sql = "key_id 'AKIA…' secret 'xyz'";
        const out = scrubCredentials(sql);
        expect(out).not.toContain('AKIA');
        expect(out).not.toContain('xyz');
    });

    it('redacts aws_access_key_id assignments (json/yaml/python)', () => {
        const json = '"aws_access_key_id": "AKIAEXAMPLE"';
        const py = "aws_access_key_id = 'AKIAEXAMPLE'";
        expect(scrubCredentials(json)).not.toContain('AKIAEXAMPLE');
        expect(scrubCredentials(py)).not.toContain('AKIAEXAMPLE');
    });

    it('redacts aws_secret_access_key assignments', () => {
        const text = '"aws_secret_access_key": "wJalrXUtnFEMI/K7MDENG"';
        expect(scrubCredentials(text)).not.toContain('wJalrXUtnFEMI');
    });

    it('redacts Authorization Bearer tokens', () => {
        const text = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def';
        const out = scrubCredentials(text);
        expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9');
        expect(out).toMatch(/Authorization:\s*\[REDACTED\]/);
    });

    it('redacts X-Amz-Signature values inside URLs', () => {
        const url =
            'https://s3-west.nrp-nautilus.io/b/x.parquet?' +
            'X-Amz-Signature=abc123def456&X-Amz-Credential=AKIA/20260101/us-east-1';
        const out = scrubCredentials(url);
        expect(out).not.toContain('abc123def456');
        expect(out).not.toContain('AKIA/20260101');
        expect(out).toContain('s3-west.nrp-nautilus.io/b/x.parquet');
    });

    it('redacts X-Amz-Security-Token values inside URLs (STS session tokens)', () => {
        const url =
            'https://s3-west.nrp-nautilus.io/b/x.parquet?' +
            'X-Amz-Security-Token=FQoGZ.eXampleToken/abc123&X-Amz-Signature=def456';
        const out = scrubCredentials(url);
        expect(out).not.toContain('FQoGZ.eXampleToken');
        expect(out).not.toContain('def456');
        expect(out).toContain('s3-west.nrp-nautilus.io/b/x.parquet');
        expect(out).toMatch(/X-Amz-Security-Token=\[REDACTED\]/);
    });

    it('leaves plain prose mentioning KEY_ID alone (no quoted value follows)', () => {
        const prose = 'You must provide your KEY_ID before running this query.';
        expect(scrubCredentials(prose)).toBe(prose);
    });

    it('returns empty input unchanged', () => {
        expect(scrubCredentials('')).toBe('');
        expect(scrubCredentials(undefined)).toBe(undefined);
        expect(scrubCredentials(null)).toBe(null);
    });
});
