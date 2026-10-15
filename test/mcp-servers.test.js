import { describe, it, expect, vi } from 'vitest';
import { resolveMcpServers, DEFAULT_MCP_URL } from '../app/mcp-servers.js';

const DUCK = 'https://duckdb-mcp.nrp-nautilus.io/mcp';
const SDM = 'https://sdm-mcp.nrp-nautilus.io/mcp';

describe('resolveMcpServers', () => {
    it('defaults to one primary duckdb-mcp server', () => {
        expect(resolveMcpServers({})).toEqual([
            { url: DEFAULT_MCP_URL, headers: {}, optional: false, primary: true },
        ]);
    });

    it('reads the mcp_url / mcp_auth_token shorthand', () => {
        expect(resolveMcpServers({ mcp_url: 'https://a/mcp', mcp_auth_token: 't' })).toEqual([
            { url: 'https://a/mcp', headers: { Authorization: 'Bearer t' }, optional: false, primary: true },
        ]);
    });

    it('reads mcp_servers in order; the first is primary', () => {
        const out = resolveMcpServers({
            mcp_servers: [{ url: DUCK }, { url: SDM, optional: true, auth_token: 's' }],
        });
        expect(out).toEqual([
            { url: DUCK, headers: {}, optional: false, primary: true },
            { url: SDM, headers: { Authorization: 'Bearer s' }, optional: true, primary: false },
        ]);
    });

    it('lets mcp_url (incl. a runtime mcp_server_url merged into it) replace only the primary', () => {
        const out = resolveMcpServers({
            mcp_url: 'https://runtime-duck/mcp',
            mcp_auth_token: 'secret',
            mcp_servers: [{ url: DUCK }, { url: SDM, optional: true }],
        });
        expect(out[0]).toMatchObject({ url: 'https://runtime-duck/mcp', headers: { Authorization: 'Bearer secret' }, primary: true });
        expect(out[1]).toEqual({ url: SDM, headers: {}, optional: true, primary: false });
    });

    it('fills a primary entry with no url from mcp_url or the default', () => {
        expect(resolveMcpServers({ mcp_servers: [{ url: SDM, optional: true }] })[0].url).toBe(SDM);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(resolveMcpServers({ mcp_servers: [{}, null] })).toEqual([
            { url: DEFAULT_MCP_URL, headers: {}, optional: false, primary: true },
        ]);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    it('only treats optional === true as optional', () => {
        const out = resolveMcpServers({ mcp_servers: [{ url: DUCK }, { url: SDM, optional: 'yes' }] });
        expect(out[1].optional).toBe(false);
    });

    it('does not mutate the config', () => {
        const cfg = { mcp_url: 'https://x/mcp', mcp_servers: [{ url: DUCK }] };
        resolveMcpServers(cfg);
        expect(cfg.mcp_servers).toEqual([{ url: DUCK }]);
    });
});
