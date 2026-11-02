import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lxmusicProvider } from '@/services/onlineMusic/lxmusic/lxmusicProvider';
import { normalizeLxMusicSong } from '@/services/onlineMusic/lxmusic/lxmusicNormalize';
import { OnlineProviderError } from '@/types/onlineMusic';

// test/unit/lxmusic/adapter.test.ts
// The LX Music adapter: its songs carry LX Music's music info to be played by, lyrics never stop a
// song, and the library is LX Music's lists.

const request = vi.fn();
beforeEach(() => {
    request.mockReset();
    vi.stubGlobal('window', { electron: { lxmusicRequest: request } });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const info = { source: 'kw', songmid: '123', name: 'Song', singer: 'A、B', interval: '03:05', albumName: 'Al', albumId: '9', img: 'https://img4.kuwo.cn/x.jpg', types: [{ type: '128k' }], _types: {}, typeUrl: {} };

describe('LX Music adapter', () => {
    it('makes a song that carries its source and LX Music music info', () => {
        const song = normalizeLxMusicSong(info);
        expect(song).toMatchObject({
            id: 'kw_123', name: 'Song', durationMs: 185000,
            artists: [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }],
            album: { id: '9', name: 'Al', coverUrl: 'https://img4.kuwo.cn/x.jpg' },
            sourceRef: { kind: 'online', providerId: 'lxmusic', mediaId: 'kw_123', providerData: { musicInfo: info } },
        });
        expect(normalizeLxMusicSong(song)).toBe(song);
        expect(() => normalizeLxMusicSong({ source: 'kw' })).toThrow(OnlineProviderError);
    });

    it('asks the bridge for audio with the music info and the quality', async () => {
        request.mockResolvedValueOnce({ ok: true, data: { url: 'https://a/1.mp3', fetchedAt: 1, quality: 'high' } });
        const source = await lxmusicProvider.playback!.getAudioSource(normalizeLxMusicSong(info), 'high');
        expect(request).toHaveBeenCalledWith('audio', { musicInfo: info, quality: 'high' });
        expect(source.url).toBe('https://a/1.mp3');
    });

    it('parses line lyrics with their translation, and answers none rather than failing', async () => {
        request.mockResolvedValueOnce({ ok: true, data: { format: 'lrc', lyric: '[00:01.00]Hello\n[00:03.00]World', tlyric: '[00:01.00]你好' } });
        const result = await lxmusicProvider.lyrics!.getLyrics(normalizeLxMusicSong(info));
        expect(result.lyrics?.lines.map(line => line.fullText)).toEqual(['Hello', 'World']);
        expect(result.lyrics?.lines[0].translation).toBe('你好');
        request.mockResolvedValueOnce({ ok: false, error: { code: 'network', message: 'down' } });
        expect(await lxmusicProvider.lyrics!.getLyrics(normalizeLxMusicSong(info))).toMatchObject({ lyrics: null, isPureMusic: false });
    });

    it('is signed in while LX Music is found and connected', async () => {
        request.mockResolvedValueOnce({ ok: true, data: { connected: true, lxFound: true, sourceName: 'My source' } });
        expect(await lxmusicProvider.auth!.getLoginStatus()).toEqual({ id: 'lx-music-local', nickname: 'LX Music · My source' });
        request.mockResolvedValueOnce({ ok: true, data: { connected: false, lxFound: true, sourceName: null } });
        expect(await lxmusicProvider.auth!.getLoginStatus()).toBeNull();
    });

    it('connects on sign-in, and waits while LX Music is not found', async () => {
        const key = await lxmusicProvider.auth!.startLogin!();
        request.mockResolvedValueOnce({ ok: true, data: { connected: true, lxFound: false } });
        expect(await lxmusicProvider.auth!.checkLogin!(key)).toEqual({ state: 'waiting' });
        request.mockResolvedValueOnce({ ok: true, data: { connected: true, lxFound: true } });
        expect(await lxmusicProvider.auth!.checkLogin!(key)).toEqual({ state: 'confirmed' });
        expect(request).toHaveBeenCalledWith('connect', {});
    });

    it('lists LX Music\'s song lists as the library and pages through one', async () => {
        request.mockResolvedValueOnce({ ok: true, data: [{ id: 'default', name: '试听列表', count: 3 }, { id: 'love', name: '我的收藏', count: 0 }] });
        const page = await lxmusicProvider.library!.getUserPlaylists('lx-music-local', 1, 0);
        expect(page).toMatchObject({ items: [{ providerId: 'lxmusic', id: 'default', name: '试听列表', trackCount: 3, isOwned: true }], hasMore: true, nextOffset: 1 });
        request.mockResolvedValueOnce({ ok: true, data: { items: [info], total: 3, hasMore: true, nextOffset: 1 } });
        const tracks = await lxmusicProvider.catalog!.getPlaylistTracks!('default', 1, 0);
        expect(tracks).toMatchObject({ items: [{ id: 'kw_123' }], total: 3, hasMore: true, nextOffset: 1 });
    });
});
