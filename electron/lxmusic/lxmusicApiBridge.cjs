const { createLxMusicData } = require('./lxmusicData.cjs');
const { createLxSources, SOURCE_NAMES, SEARCHABLE } = require('./sources.cjs');
const { createLxUserApiHost } = require('./userApiHost.cjs');

// electron/lxmusic/lxmusicApiBridge.cjs
// The LX Music platform's main-process side. It reads the custom source the listener imported in
// LX Music on this computer, runs it (userApiHost.cjs) to get songs' audio, searches and reads
// lyrics from the sources LX Music uses (sources.cjs), and reads LX Music's song lists. The
// renderer reaches it through `request(operation, params)` only.

const OPERATIONS = ['status', 'connect', 'disconnect', 'search', 'audio', 'lyrics', 'pic', 'playlists', 'playlist_tracks'];
const DISCONNECTED_KEY = 'LXMUSIC_DISCONNECTED';
const QUALITY_TO_TYPE = { standard: '128k', high: '320k', ultra: '320k', lossless: 'flac', hires: 'flac24bit' };
const TYPE_TO_QUALITY = { '128k': 'standard', '320k': 'high', flac: 'lossless', flac24bit: 'hires' };
const TYPE_ORDER = ['128k', '320k', 'flac', 'flac24bit'];
// How long an audio address from a custom source is used before it is asked for again.
const AUDIO_TTL_MS = 20 * 60 * 1000;

class LxBridgeError extends Error {
    constructor(code, message) { super(message); this.code = code; }
}

const normalizeText = value => String(value || '').toLowerCase().replace(/[\s·・,，、&/()（）[\]【】'"‘’“”!！?？.。-]/g, '');
const durationSeconds = (info) => {
    if (Number(info?._interval) > 0) return Number(info._interval);
    const parts = String(info?.interval || '').split(':').map(Number);
    return parts.every(Number.isFinite) ? parts.reduce((sum, part) => sum * 60 + part, 0) : 0;
};

function createLxMusicApiBridge({ store, app, BrowserWindow, session, ipcMain, fetchFn,
    onAudioSource = () => {}, log = console.info, warn = console.warn, now = Date.now,
    data = createLxMusicData({ appDataDir: app.getPath('appData'), warn }),
    sources = createLxSources({ fetchFn }),
    host = createLxUserApiHost({ BrowserWindow, session, ipcMain, fetchFn, log, warn }) }) {

    const connected = () => store.get(DISCONNECTED_KEY) !== true;

    // The custom source, started; throws where there is none to start.
    async function runningSource() {
        const read = data.readUserApi();
        if (!read.api) {
            const message = read.reason === 'no-lx-music'
                ? 'LX Music is not installed on this computer, or has never been opened'
                : read.reason === 'unreadable-custom-source'
                    ? 'The custom source in LX Music could not be read'
                    : 'No custom source has been imported in LX Music';
            throw new LxBridgeError('unavailable', message);
        }
        try {
            const served = await host.ensure(read.api);
            return { api: read.api, served };
        } catch (error) {
            throw new LxBridgeError('unavailable', `The custom source "${read.api.name}" failed to start: ${error?.message || error}`);
        }
    }

    function status() {
        const read = data.readUserApi();
        return {
            connected: connected(),
            lxFound: read.found,
            reason: read.reason,
            sourceName: read.api?.name || null,
            sourceCount: read.count || 0,
            served: host.getLoadedId() && host.getLoadedId() === read.api?.id ? host.getSources() : null,
            error: host.getLastError(),
        };
    }

    async function searchSources() {
        try {
            const { served } = await runningSource();
            const playable = SEARCHABLE.filter(source => served[source]?.actions?.includes('musicUrl'));
            if (playable.length) return playable;
        } catch (error) {
            warn('[LX Music] Searching without a custom source', { reason: error?.message });
        }
        return SEARCHABLE;
    }

    async function search({ query, limit = 30, offset = 0 }) {
        const text = String(query || '').trim();
        const size = Math.max(1, Math.min(Number(limit) || 30, 60));
        if (!text) return { items: [], hasMore: false, nextOffset: Number(offset) || 0 };
        const page = Math.floor((Number(offset) || 0) / size) + 1;
        const used = await searchSources();
        const perSource = Math.max(5, Math.ceil(size / used.length));
        const results = await Promise.allSettled(used.map(source => sources.search(source, text, page, perSource)));
        const lists = [];
        let total = 0;
        let failures = 0;
        let hasMore = false;
        results.forEach((result, index) => {
            if (result.status !== 'fulfilled') {
                failures += 1;
                warn('[LX Music] Search failed at one source', { source: used[index], error: result.reason?.message });
                return;
            }
            lists.push(result.value.list);
            total += result.value.total || 0;
            if (page * perSource < (result.value.total || 0) && result.value.list.length) hasMore = true;
        });
        if (failures === used.length) throw new LxBridgeError('network', 'Every LX Music source failed to search');
        // One of each source in turn, as LX Music's combined search shows them; the same song from a
        // second source is left out.
        const seen = new Set();
        const items = [];
        for (let row = 0; lists.some(list => row < list.length); row++) {
            for (const list of lists) {
                const info = list[row];
                if (!info) continue;
                const key = `${normalizeText(info.name)}|${normalizeText(info.singer)}`;
                if (seen.has(key)) continue;
                seen.add(key);
                items.push(info);
            }
        }
        return { items, total, hasMore, nextOffset: page * size };
    }

    const pickType = (wanted, available, info) => {
        const songTypes = new Set((Array.isArray(info?.types) ? info.types : []).map(type => type?.type).filter(Boolean));
        const offered = TYPE_ORDER.filter(type => available.includes(type) && (!songTypes.size || songTypes.has(type)));
        const fallback = TYPE_ORDER.filter(type => available.includes(type));
        const list = offered.length ? offered : fallback;
        if (!list.length) return null;
        const at = TYPE_ORDER.indexOf(wanted);
        const atOrBelow = list.filter(type => TYPE_ORDER.indexOf(type) <= at);
        return atOrBelow.length ? atOrBelow[atOrBelow.length - 1] : list[0];
    };

    async function urlFrom(served, info, wanted) {
        const offer = served[info.source];
        if (!offer?.actions?.includes('musicUrl')) throw new LxBridgeError('not-playable', `The custom source does not play ${SOURCE_NAMES[info.source] || info.source}`);
        const type = pickType(wanted, offer.qualitys || [], info);
        if (!type) throw new LxBridgeError('not-playable', 'The custom source offers no quality for this song');
        const result = await host.request(info.source, 'musicUrl', { type, musicInfo: info });
        const url = result?.data?.url;
        if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new LxBridgeError('not-playable', 'The custom source gave no address for this song');
        return { url, type };
    }

    // Another source's copy of the same song, as LX Music's "switch source" finds one.
    async function otherCopies(served, info) {
        const name = normalizeText(info.name);
        const singer = normalizeText(String(info.singer || '').split('、')[0]);
        const seconds = durationSeconds(info);
        const others = SEARCHABLE.filter(source => source !== info.source && served[source]?.actions?.includes('musicUrl'));
        const found = await Promise.allSettled(others.map(source => sources.search(source, `${info.name} ${info.singer}`, 1, 5)));
        return found.flatMap(result => (result.status === 'fulfilled' ? result.value.list : [])).filter(other => (
            normalizeText(other.name) === name
            && (!singer || normalizeText(other.singer).includes(singer))
            && (!seconds || !durationSeconds(other) || Math.abs(durationSeconds(other) - seconds) <= 5)
        )).slice(0, 2);
    }

    async function audio({ musicInfo, quality }) {
        if (!musicInfo || typeof musicInfo !== 'object' || !musicInfo.source || musicInfo.songmid == null) {
            throw new LxBridgeError('invalid-response', 'The song has no LX Music information');
        }
        const { served } = await runningSource();
        const wanted = QUALITY_TO_TYPE[quality] || '320k';
        let found;
        try {
            found = await urlFrom(served, musicInfo, wanted);
        } catch (error) {
            warn('[LX Music] Custom source gave no audio; trying other sources', { source: musicInfo.source, error: error?.message });
            for (const other of await otherCopies(served, musicInfo)) {
                try {
                    found = await urlFrom(served, other, wanted);
                    log('[LX Music] Audio found at another source', { from: musicInfo.source, to: other.source });
                    break;
                } catch { /* try the next copy */ }
            }
            if (!found) throw error instanceof LxBridgeError ? error : new LxBridgeError('not-playable', String(error?.message || error));
        }
        onAudioSource(found.url);
        const fetchedAt = now();
        return { url: found.url, fetchedAt, expiresAt: fetchedAt + AUDIO_TTL_MS, quality: TYPE_TO_QUALITY[found.type] || 'high' };
    }

    async function lyrics({ musicInfo }) {
        try {
            return await sources.lyric(musicInfo);
        } catch (error) {
            warn('[LX Music] Lyrics could not be read', { source: musicInfo?.source, error: error?.message });
            return null;
        }
    }

    const operations = {
        status: async () => status(),
        connect: async () => { store.delete(DISCONNECTED_KEY); return status(); },
        disconnect: async () => { store.set(DISCONNECTED_KEY, true); host.close(); return status(); },
        search,
        audio,
        lyrics,
        pic: async ({ musicInfo }) => ({ url: await sources.pic(musicInfo).catch(() => '') }),
        playlists: async () => (connected() ? data.readLists() : []),
        playlist_tracks: async ({ id, limit = 100, offset = 0 }) => {
            if (!connected()) throw new LxBridgeError('auth-required', 'LX Music is not connected');
            const size = Math.max(1, Math.min(Number(limit) || 100, 1000));
            const start = Math.max(0, Number(offset) || 0);
            const page = data.readListSongs(String(id), size, start);
            return { items: page.items, total: page.total, hasMore: start + page.items.length < page.total, nextOffset: start + page.items.length };
        },
    };

    return {
        async request(operation, params = {}) {
            if (!OPERATIONS.includes(operation)) return { ok: false, error: { code: 'unsupported', message: 'Unsupported LX Music operation' } };
            try {
                return { ok: true, data: await operations[operation](params && typeof params === 'object' ? params : {}) };
            } catch (error) {
                if (error instanceof LxBridgeError) return { ok: false, error: { code: error.code, message: error.message } };
                warn('[LX Music] Bridge request failed', { operation }, error);
                return { ok: false, error: { code: 'network', message: String(error?.message || 'LX Music request failed') } };
            }
        },
        close: () => host.close(),
    };
}

module.exports = { createLxMusicApiBridge, OPERATIONS };
