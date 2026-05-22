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
