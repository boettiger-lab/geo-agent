import { describe, it, expect } from 'vitest';
import {
    buildDuckdbSetupSql, PUBLIC_S3_ENDPOINT, scrubCredentials,
} from '../app/chat-ui.js';

describe('buildDuckdbSetupSql', () => {
    it('loads httpfs and creates an s3 secret at the public endpoint', () => {
        const sql = buildDuckdbSetupSql();
        expect(sql).toContain('INSTALL httpfs; LOAD httpfs;');
        expect(sql).toContain('CREATE OR REPLACE SECRET public_s3');
        expect(sql).toContain('TYPE s3');
        expect(sql).toContain(`ENDPOINT '${PUBLIC_S3_ENDPOINT}'`);
        expect(sql).toContain("URL_STYLE 'path'");
        expect(sql).toContain('USE_SSL true');
    });

    it('carries no credentials — anonymous access is the point', () => {
        const sql = buildDuckdbSetupSql();
        expect(sql).not.toMatch(/KEY_ID/i);
        // `SECRET` appears only as the CREATE SECRET keyword, never as a value.
        expect(sql).not.toMatch(/\bSECRET\s+'/i);
    });

    it('survives the credential scrub unchanged', () => {
        // scrubCredentials rewrites `SECRET '…'`; an emitted block that tripped
        // it would reach the reader mangled.
        const sql = buildDuckdbSetupSql();
        expect(scrubCredentials(sql)).toBe(sql);
    });

    it('honours a per-app endpoint override', () => {
        expect(buildDuckdbSetupSql('minio.example.org'))
            .toContain("ENDPOINT 'minio.example.org'");
    });

    it('normalises a scheme or trailing slash in the override', () => {
        const sql = buildDuckdbSetupSql('https://minio.example.org/');
        expect(sql).toContain("ENDPOINT 'minio.example.org'");
        expect(sql).not.toContain('https://minio');
    });

    it('falls back to the default for an empty override', () => {
        expect(buildDuckdbSetupSql('')).toContain(`ENDPOINT '${PUBLIC_S3_ENDPOINT}'`);
    });
});

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

import {
    buildMapEmbedHtml,
    EXPORT_MAP_MAPLIBRE_VERSION,
    EXPORT_MAP_PMTILES_VERSION,
} from '../app/chat-ui.js';

describe('buildMapEmbedHtml', () => {
    const sampleState = () => ({
        center: [-119.4, 36.8],
        zoom: 6.5,
        bearing: 0,
        pitch: 0,
        projection: 'mercator',
        style: {
            version: 8,
            sources: { natgeo: { type: 'raster', tiles: ['https://example/{z}/{x}/{y}.png'] } },
            layers: [{ id: 'natgeo-base', type: 'raster', source: 'natgeo' }],
        },
    });

    // Pull the JSON out of the <script type="application/json"> block and
    // reverse the < escaping so it can be JSON.parsed back.
    const extractState = (body) => {
        const m = body.match(
            /<script type="application\/json" id="export-map-state">([\s\S]*?)<\/script>/
        );
        expect(m).toBeTruthy();
        return JSON.parse(m[1].replace(/\\u003c/g, '<'));
    };

    it('returns empty strings when there is no map state', () => {
        expect(buildMapEmbedHtml(null)).toEqual({ headTags: '', body: '' });
        expect(buildMapEmbedHtml(undefined)).toEqual({ headTags: '', body: '' });
        expect(buildMapEmbedHtml({})).toEqual({ headTags: '', body: '' });
    });

    it('pins the CDN builds to the versions the app loads', () => {
        const { headTags } = buildMapEmbedHtml(sampleState());
        expect(headTags).toContain(`maplibre-gl@${EXPORT_MAP_MAPLIBRE_VERSION}/dist/maplibre-gl.js`);
        expect(headTags).toContain(`maplibre-gl@${EXPORT_MAP_MAPLIBRE_VERSION}/dist/maplibre-gl.css`);
        expect(headTags).toContain(`pmtiles@${EXPORT_MAP_PMTILES_VERSION}/dist/pmtiles.js`);
    });

    it('embeds a parseable state and a container the init script targets', () => {
        const { body } = buildMapEmbedHtml(sampleState());
        expect(body).toContain('id="export-map"');
        expect(body).toContain("maplibregl.addProtocol('pmtiles'");
        const parsed = extractState(body);
        expect(parsed.center).toEqual([-119.4, 36.8]);
        expect(parsed.zoom).toBe(6.5);
        expect(parsed.style.layers[0].id).toBe('natgeo-base');
    });

    it('scrubs AWS signatures and MapTiler keys from source URLs', () => {
        const state = sampleState();
        state.style.sources.natgeo.tiles = [
            'https://api.maptiler.com/tiles/x/{z}/{x}/{y}.png?key=SECRETKEY123',
        ];
        state.style.sources.signed = {
            type: 'raster',
            tiles: ['https://s3-west.nrp-nautilus.io/b/x?X-Amz-Signature=abc123def456'],
        };
        const { body } = buildMapEmbedHtml(state);
        expect(body).not.toContain('SECRETKEY123');
        expect(body).not.toContain('abc123def456');
        // Still valid JSON after scrubbing.
        expect(() => extractState(body)).not.toThrow();
    });

    it('neutralizes a </script> breakout hidden in the state', () => {
        const state = sampleState();
        state.style.name = 'evil</script><script>alert(1)</script>';
        const { body } = buildMapEmbedHtml(state);
        // The only real closing tags are the two we emit; the injected one is escaped.
        expect(body).not.toContain('<script>alert(1)');
        expect(body).toContain('\\u003c/script');
        // And it still round-trips.
        expect(extractState(body).style.name).toBe('evil</script><script>alert(1)</script>');
    });
});
