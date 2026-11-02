import type { SongResult, UnifiedSong } from '../../../types';
import type { JsonValue, ProviderCollection, ProviderPage, ProviderUser } from '../../../types/onlineMusic';
import { OnlineProviderError } from '../../../types/onlineMusic';
import { getPlaybackSourceRef } from '../../../utils/appPlaybackGuards';

// src/services/onlineMusic/lxmusic/lxmusicNormalize.ts
// LX Music's music info (the shape a custom source is handed) to Folia's song, and back. The music
// info rides along in the song's providerData, so that the song can be played without a look-up.

export type LxMusicInfo = Record<string, any> & { source: string; songmid: string | number; name: string; singer: string };

export const LX_SOURCE_NAMES: Record<string, string> = { kw: '酷我', kg: '酷狗', tx: 'QQ', wy: '网易云', mg: '咪咕', local: '本地' };

const record = (raw: unknown): Record<string, any> => raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, any> : {};
const text = (value: unknown) => value == null ? '' : String(value);

const intervalMs = (info: Record<string, any>): number => {
    if (Number(info._interval) > 0) return Number(info._interval) * 1000;
    const parts = text(info.interval).split(':').map(Number);
    if (!parts.length || parts.some(part => !Number.isFinite(part))) return 0;
    return parts.reduce((sum, part) => sum * 60 + part, 0) * 1000;
};

// Only JSON goes into providerData: what the music info holds that is not (functions, undefined) is left out.
const toJson = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value ?? null)) as JsonValue;

export const lxMediaId = (info: { source: string; songmid: string | number }) => `${info.source}_${info.songmid}`;

export function normalizeLxMusicSong(raw: unknown): UnifiedSong {
    const value = record(raw);
    if (value.sourceRef?.kind === 'online' && value.sourceRef.providerId === 'lxmusic') return value as UnifiedSong;
    const info = record(value.musicInfo ?? value) as LxMusicInfo;
    if (!info.source || info.songmid == null || info.songmid === '') {
        throw new OnlineProviderError('invalid-response', 'LX Music song id is missing', 'lxmusic');
    }
    const id = lxMediaId(info);
    const singers = text(info.singer).split(/、|\s*\/\s*/).map(name => name.trim()).filter(Boolean);
    return {
        id,
        name: text(info.name),
        durationMs: intervalMs(info),
        artists: singers.map(name => ({ id: name, name })),
        album: { id: text(info.albumId), name: text(info.albumName), ...(info.img ? { coverUrl: text(info.img) } : {}) },
        sourceRef: { kind: 'online', providerId: 'lxmusic', mediaId: id, providerData: { musicInfo: toJson(info) } },
    };
}

export function lxMusicInfoOf(song: SongResult): LxMusicInfo {
    const source = getPlaybackSourceRef(song);
    if (source.kind !== 'online' || source.providerId !== 'lxmusic') {
        throw new OnlineProviderError('unsupported', 'Song does not belong to LX Music', 'lxmusic');
    }
    const info = record(source.providerData?.musicInfo) as LxMusicInfo;
    if (!info.source || info.songmid == null) {
        throw new OnlineProviderError('invalid-response', 'LX Music song information is missing', 'lxmusic');
    }
    return info;
}

export function normalizeLxMusicCollection(raw: unknown): ProviderCollection {
    const list = record(raw);
    if (list.providerId === 'lxmusic') return list as ProviderCollection;
    if (!list.id) throw new OnlineProviderError('invalid-response', 'LX Music list id is missing', 'lxmusic');
    return {
        providerId: 'lxmusic',
        id: text(list.id),
        type: 'playlist',
        name: text(list.name),
        isOwned: true,
        ...(Number.isFinite(Number(list.count)) ? { trackCount: Number(list.count) } : {}),
    };
}

export function normalizeLxMusicUser(raw: unknown): ProviderUser {
    const status = record(raw);
    return { id: 'lx-music-local', nickname: status.sourceName ? `LX Music · ${text(status.sourceName)}` : 'LX Music' };
}

export const lxSongPage = (page: { items: unknown[]; total?: number; hasMore: boolean; nextOffset: number }): ProviderPage<UnifiedSong> => {
    const items: UnifiedSong[] = [];
    for (const item of page.items) {
        try { items.push(normalizeLxMusicSong(item)); } catch (error) { console.warn('[LX Music] Song left out', error); }
    }
    return { items, hasMore: page.hasMore, nextOffset: page.nextOffset, ...(page.total === undefined ? {} : { total: page.total }) };
};
