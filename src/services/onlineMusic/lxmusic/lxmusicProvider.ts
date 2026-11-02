import type { LoginState, OnlineMusicProvider, ProviderAudioSource, ProviderCollection, ProviderLyricsResult, ProviderPage } from '../../../types/onlineMusic';
import { OnlineProviderError } from '../../../types/onlineMusic';
import { createProviderSongMetadata } from '../../../utils/songMetadata';
import { parseLyricsByFormat } from '../../../utils/lyrics/parserCore';
import { getLxMusicAvailability, LXMUSIC_BRIDGE_FAILED, LXMUSIC_NEEDS_DESKTOP, requestLxMusic } from './lxmusicTransport';
import {
    lxMusicInfoOf, lxSongPage, normalizeLxMusicCollection, normalizeLxMusicSong, normalizeLxMusicUser,
} from './lxmusicNormalize';

// src/services/onlineMusic/lxmusic/lxmusicProvider.ts
// LX Music (洛雪音乐) as a platform: songs are searched at the sources LX Music uses, played through
// the custom source the listener imported in LX Music on this computer, and LX Music's own song
// lists are the library. There is no account: "signing in" connects to the LX Music app here.

type LxStatus = {
    connected: boolean;
    lxFound: boolean;
    reason: string | null;
    sourceName: string | null;
    sourceCount: number;
};

type LxLyric = { format: 'lrc' | 'krc'; lyric: string; tlyric?: string } | null;

const EMPTY_LYRICS: ProviderLyricsResult = { lyrics: null, mainText: '', isPureMusic: false };

function parseLxLyric(raw: LxLyric): ProviderLyricsResult {
    if (!raw || typeof raw.lyric !== 'string' || !raw.lyric.trim()) return EMPTY_LYRICS;
    const lyrics = parseLyricsByFormat(raw.format === 'krc' ? 'krc' : 'lrc', raw.lyric, raw.format === 'krc' ? '' : (raw.tlyric || ''));
    if (raw.format === 'krc' && raw.tlyric) {
        const byTime = new Map(parseLyricsByFormat('lrc', raw.tlyric).lines.map(line => [line.startTime, line.fullText]));
        for (const line of lyrics.lines) line.translation = byTime.get(line.startTime) || line.translation;
    }
    return {
        lyrics: lyrics.lines.length ? lyrics : null,
        mainText: raw.lyric,
        wordByWordText: raw.format === 'krc' ? raw.lyric : null,
        translationText: raw.tlyric || null,
        isPureMusic: false,
    };
}

const loginKeys = new Set<string>();

export const lxmusicProvider: OnlineMusicProvider = {
    id: 'lxmusic', displayName: 'LX Music', shortName: 'LX',
    mark: { letter: '洛', color: '#4daf7c' },
    getAvailability: getLxMusicAvailability,
    capabilities: {
        search: true, playback: true, lyrics: true, wordByWordLyrics: true, auth: true,
        userLibrary: true, playlists: true, albums: false, artists: false, recommendations: false,
        mutations: false, songDetail: false,
    },
    normalizeSong: normalizeLxMusicSong,
    normalizeUser: normalizeLxMusicUser,
    normalizeCollection: normalizeLxMusicCollection,
    songMetadata: { getSongMetadata: createProviderSongMetadata },
    describeFailure(_operation, error) {
        if (!(error instanceof OnlineProviderError) || error.providerId !== 'lxmusic') return null;
        if (error.message === LXMUSIC_NEEDS_DESKTOP) return { case: 'not-configured' };
        if (error.message === LXMUSIC_BRIDGE_FAILED) return { case: 'local-service-stopped' };
        // No custom source in LX Music, or it would not start: nothing here can play.
        if (error.code === 'unavailable') return { case: 'not-configured', message: error.message };
        if (error.code === 'not-playable') return { case: 'no-audio', message: error.message };
        return { message: error.message };
    },
    search: {
        async searchSongs(query, limit, offset) {
            if (!query.trim()) return { items: [], hasMore: false, nextOffset: offset };
            return lxSongPage(await requestLxMusic<ProviderPage<unknown>>('search', { query, limit, offset }));
        },
    },
    playback: {
        audioQualityLevels: ['standard', 'high', 'lossless', 'hires'],
        async getSongDetail() { return null; },
        async getAudioSource(song, quality) {
            const source = await requestLxMusic<ProviderAudioSource>('audio', { musicInfo: lxMusicInfoOf(song), quality });
            console.info('[LX Music] Audio address found', { quality: source.quality });
            return source;
        },
    },
    lyrics: {
        async getLyrics(song) {
            try {
                return parseLxLyric(await requestLxMusic<LxLyric>('lyrics', { musicInfo: lxMusicInfoOf(song) }));
            } catch (error) {
                // Lyrics of a song are never worth stopping it for: the shared lyric matching takes over.
                console.warn('[LX Music] Lyrics could not be read', error);
                return EMPTY_LYRICS;
            }
        },
    },
    auth: {
        getLoginTexts: () => ({ title: 'home.loginTitleLxmusic', note: 'home.loginNoteLxmusic' }),
        async getLoginStatus() {
            const status = await requestLxMusic<LxStatus>('status');
            return status.connected && status.lxFound ? normalizeLxMusicUser(status) : null;
        },
        async logout() { await requestLxMusic('disconnect'); },
        async startLogin() {
            const key = `lx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            loginKeys.add(key);
            return key;
        },
        // Connecting needs nothing opened: Folia reads LX Music's own files on this computer.
        async openLoginPage(key) {
            if (loginKeys.has(key)) await requestLxMusic('connect');
        },
        opensLoginPageItself: () => true,
        async checkLogin(key): Promise<LoginState> {
            if (!loginKeys.has(key)) return { state: 'expired' };
            const status = await requestLxMusic<LxStatus>('connect');
            if (status.lxFound) {
                loginKeys.delete(key);
                return { state: 'confirmed' };
            }
            return { state: 'waiting' };
        },
        async cancelLogin(key) { loginKeys.delete(key); },
        getLoginTtlMs: () => 5 * 60 * 1000,
    },
    library: {
        async getUserPlaylists(_userId, limit, offset) {
            const lists = (await requestLxMusic<unknown[]>('playlists')).map(normalizeLxMusicCollection);
            const items = lists.slice(offset, offset + limit);
            return { items, total: lists.length, hasMore: offset + items.length < lists.length, nextOffset: offset + items.length };
        },
    },
    catalog: {
        async getPlaylistTracks(id, limit, offset) {
            return lxSongPage(await requestLxMusic<ProviderPage<unknown>>('playlist_tracks', { id: String(id), limit, offset }));
        },
        async getPlaylistDetail(id, collection): Promise<ProviderCollection | null> {
            const found = (await requestLxMusic<unknown[]>('playlists')).map(normalizeLxMusicCollection)
                .find(list => String(list.id) === String(id));
            return found ? { ...collection, ...found } : null;
        },
    },
};
