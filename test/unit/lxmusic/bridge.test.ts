import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';

// test/unit/lxmusic/bridge.test.ts
// The LX Music bridge in the main process: reading LX Music's custom source, the combined search,
// picking the quality a custom source is asked for, and trying another source's copy of a song.

const require = createRequire(import.meta.url);
const { createLxMusicApiBridge } = require('../../../electron/lxmusic/lxmusicApiBridge.cjs');
const { createLxMusicData, toOldMusicInfo, inflateScript } = require('../../../electron/lxmusic/lxmusicData.cjs');
const { scriptHttp } = require('../../../electron/lxmusic/userApiHost.cjs');

const song = (source: string, songmid: string, name: string, singer: string, types = ['128k', '320k', 'flac']) => ({
    source, songmid, name, singer, interval: '03:30', albumName: '', albumId: '', img: '', typeUrl: {},
    types: types.map(type => ({ type })), _types: {},
});

const createStore = () => {
    const values = new Map<string, unknown>();
    return { get: (key: string) => values.get(key), set: (key: string, value: unknown) => { values.set(key, value); }, delete: (key: string) => { values.delete(key); } };
};

const bridgeWith = ({ served, search, request }: {
    served: Record<string, { actions: string[]; qualitys: string[] }>;
    search?: (source: string, query: string, page: number, limit: number) => Promise<{ list: unknown[]; total: number }>;
    request?: (source: string, action: string, info: any) => Promise<unknown>;
}) => {
    const host = {
        ensure: vi.fn(async () => served),
        request: vi.fn(request ?? (async (_source: string, _action: string, info: any) => ({ data: { url: `https://audio.example/${info.musicInfo.source}/${info.type}` } }))),
        close: vi.fn(),
        getSources: () => served,
        getLastError: () => null,
        getLoadedId: () => 'api',
    };
    const data = {
        readUserApi: () => ({ found: true, reason: null, api: { id: 'api', name: 'My source', script: '' }, count: 1 }),
        readLists: () => [{ id: 'default', name: '试听列表', count: 2 }],
        readListSongs: () => ({ total: 0, items: [] }),
    };
    const sources = { search: vi.fn(search ?? (async () => ({ list: [], total: 0 }))), lyric: vi.fn(), pic: vi.fn() };
    const registered: string[] = [];
    const bridge = createLxMusicApiBridge({
        store: createStore(), data, sources, host, onAudioSource: (url: string) => registered.push(url),
        log: () => {}, warn: () => {}, now: () => 1000,
    });
    return { bridge, host, sources, registered };
};

describe('LX Music custom source data', () => {
    it('reads the custom source LX Music has selected, inflating a stored script', () => {
        const dir = mkdtempSync(join(tmpdir(), 'lx-'));
        const lxDir = join(dir, 'lx-music-desktop', 'LxDatas');
        mkdirSync(lxDir, { recursive: true });
        const script = '/**\n * @name Test\n */\nlx.send(lx.EVENT_NAMES.inited, {})';
        writeFileSync(join(lxDir, 'user_api.json'), JSON.stringify({ userApis: [
            { id: 'first', name: 'First', script: 'plain' },
            { id: 'second', name: 'Second', script: `gz_${deflateSync(Buffer.from(script)).toString('base64')}` },
        ] }));
        writeFileSync(join(lxDir, 'config_v2.json'), JSON.stringify({ setting: { 'common.apiSource': 'second' } }));
        const read = createLxMusicData({ appDataDir: dir }).readUserApi();
        expect(read.api).toMatchObject({ id: 'second', name: 'Second', script });
        expect(read.selected).toBe(true);
    });

    it('says what is missing: LX Music itself, or a custom source in it', () => {
        const dir = mkdtempSync(join(tmpdir(), 'lx-'));
        expect(createLxMusicData({ appDataDir: dir }).readUserApi()).toMatchObject({ found: false, reason: 'no-lx-music', api: null });
        mkdirSync(join(dir, 'lx-music-desktop', 'LxDatas'), { recursive: true });
        expect(createLxMusicData({ appDataDir: dir }).readUserApi()).toMatchObject({ found: true, reason: 'no-custom-source', api: null });
    });

    it('turns a list row into the music info a custom source is handed', () => {
        expect(toOldMusicInfo({ name: 'A', singer: 'B', source: 'tx', interval: '03:00', meta: JSON.stringify({
            songId: 'mid', albumName: 'Al', picUrl: 'https://p', qualitys: [{ type: '128k' }], _qualitys: { '128k': true },
            albumId: 'am', strMediaMid: 'sm', albumMid: 'am', id: 7,
        }) })).toEqual({
            name: 'A', singer: 'B', source: 'tx', songmid: 'mid', interval: '03:00', albumName: 'Al', img: 'https://p', typeUrl: {},
            albumId: 'am', types: [{ type: '128k' }], _types: { '128k': true }, strMediaMid: 'sm', albumMid: 'am', songId: 7,
        });
        expect(inflateScript('plain text')).toBe('plain text');
    });
});

describe('the script\'s lx.request', () => {
    it('sends an object body as a form, as needle does, and JSON where the header asks for it', async () => {
        const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{"ok":1}', { status: 200 }));
        await scriptHttp(fetchFn, 'https://a.example/x', { method: 'post', body: { a: 1 } });
        expect(fetchFn.mock.calls[0][1]).toMatchObject({ method: 'POST', body: 'a=1', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        await scriptHttp(fetchFn, 'https://a.example/x', { method: 'post', headers: { 'content-type': 'application/json' }, body: { a: 1 } });
        expect(fetchFn.mock.calls[1][1]).toMatchObject({ body: '{"a":1}' });
        await expect(scriptHttp(fetchFn, 'file:///etc/passwd', {})).rejects.toThrow();
    });
});

describe('LX Music bridge', () => {
    it('searches the sources the custom source plays, one of each in turn, without a second copy of a song', async () => {
        const { bridge, sources } = bridgeWith({
            served: { kw: { actions: ['musicUrl'], qualitys: ['128k'] }, tx: { actions: ['musicUrl'], qualitys: ['128k'] } },
            search: async (source) => ({
                list: source === 'kw' ? [song('kw', '1', 'Song', 'Singer'), song('kw', '2', 'Other', 'X')] : [song('tx', 'a', 'song', 'singer'), song('tx', 'b', 'Third', 'Y')],
                total: 100,
            }),
        });
        const result = await bridge.request('search', { query: 'q', limit: 20, offset: 0 });
        expect(sources.search.mock.calls.map(call => call[0])).toEqual(['kw', 'tx']);
        expect(result.data.items.map((item: any) => `${item.source}_${item.songmid}`)).toEqual(['kw_1', 'kw_2', 'tx_b']);
        expect(result.data).toMatchObject({ hasMore: true, nextOffset: 20 });
    });

    it('asks for the best quality at or below the one wanted that both the song and the source have', async () => {
        const { bridge, host, registered } = bridgeWith({ served: { kw: { actions: ['musicUrl'], qualitys: ['128k', '320k'] } } });
        const result = await bridge.request('audio', { musicInfo: song('kw', '1', 'S', 'A'), quality: 'lossless' });
        expect(host.request.mock.calls[0][2].type).toBe('320k');
        expect(result).toEqual({ ok: true, data: { url: 'https://audio.example/kw/320k', fetchedAt: 1000, expiresAt: 1000 + 20 * 60 * 1000, quality: 'high' } });
        expect(registered).toEqual(['https://audio.example/kw/320k']);
    });

    it('plays another source\'s copy of the song where the custom source gives none', async () => {
        const { bridge } = bridgeWith({
            served: { kw: { actions: ['musicUrl'], qualitys: ['128k'] }, kg: { actions: ['musicUrl'], qualitys: ['128k'] } },
            search: async (source) => ({ list: source === 'kg' ? [song('kg', 'h', 'S', 'A')] : [], total: 1 }),
            request: async (source, _action, info) => {
                if (source === 'kw') throw new Error('refused');
                return { data: { url: `https://audio.example/${source}/${info.type}` } };
            },
        });
        const result = await bridge.request('audio', { musicInfo: song('kw', '1', 'S', 'A'), quality: 'standard' });
        expect(result).toMatchObject({ ok: true, data: { url: 'https://audio.example/kg/128k' } });
    });

    it('answers in the shared error codes, and refuses an operation it does not have', async () => {
        const { bridge } = bridgeWith({ served: {} });
        expect(await bridge.request('audio', { musicInfo: song('kw', '1', 'S', 'A'), quality: 'standard' }))
            .toMatchObject({ ok: false, error: { code: 'not-playable' } });
        expect(await bridge.request('eval', {})).toMatchObject({ ok: false, error: { code: 'unsupported' } });
    });

    it('shows no lists once disconnected, and again after connecting', async () => {
        const { bridge, host } = bridgeWith({ served: {} });
        expect((await bridge.request('playlists')).data).toHaveLength(1);
        await bridge.request('disconnect');
        expect(host.close).toHaveBeenCalled();
        expect((await bridge.request('playlists')).data).toEqual([]);
        expect((await bridge.request('status')).data.connected).toBe(false);
        await bridge.request('connect');
        expect((await bridge.request('playlists')).data).toHaveLength(1);
    });
});
