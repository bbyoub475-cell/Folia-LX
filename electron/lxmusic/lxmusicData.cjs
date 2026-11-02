const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// electron/lxmusic/lxmusicData.cjs
// Reads what the LX Music desktop app on this computer keeps: the custom sources the listener
// imported there (user_api.json), which one is selected (config_v2.json), and the song lists
// (lx.data.db). Everything is read only; nothing here writes into LX Music's folder.

const LIST_NAMES = { default: '试听列表', love: '我的收藏' };

// LX Music keeps its data in <appData>/lx-music-desktop/LxDatas (electron app.getPath('userData')).
function defaultLxDataDirs(appDataDir) {
    return [path.join(appDataDir, 'lx-music-desktop', 'LxDatas')];
}

const readJson = (file) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};

// LX stores a script as 'gz_' + base64(deflate(script)); older entries are plain text.
function inflateScript(script) {
    if (typeof script !== 'string') return '';
    if (!script.startsWith('gz_')) return script;
    return zlib.inflateSync(Buffer.from(script.substring(3), 'base64')).toString('utf8');
}

// The old (v1) music info shape that LX hands to a custom source (common/utils/tools.ts toOldMusicInfo).
function toOldMusicInfo(row) {
    let meta = {};
    try { meta = typeof row.meta === 'string' ? JSON.parse(row.meta) : (row.meta || {}); } catch { meta = {}; }
    const info = {
        name: String(row.name || ''),
        singer: String(row.singer || ''),
        source: String(row.source || ''),
        songmid: meta.songId == null ? '' : String(meta.songId),
        interval: row.interval || null,
        albumName: String(meta.albumName || ''),
        img: meta.picUrl || '',
        typeUrl: {},
        albumId: meta.albumId == null ? '' : String(meta.albumId),
        types: Array.isArray(meta.qualitys) ? meta.qualitys : [],
        _types: meta._qualitys && typeof meta._qualitys === 'object' ? meta._qualitys : {},
    };
    switch (info.source) {
        case 'kg':
            info.hash = meta.hash || '';
            info.albumAudioId = meta.albumAudioId || '';
            break;
        case 'tx':
            info.strMediaMid = meta.strMediaMid || '';
            info.albumMid = meta.albumMid || '';
            info.songId = meta.id == null ? '' : meta.id;
            break;
        case 'mg':
            info.copyrightId = meta.copyrightId || '';
            info.lrcUrl = meta.lrcUrl || '';
            info.mrcUrl = meta.mrcUrl || '';
            info.trcUrl = meta.trcUrl || '';
            break;
        default:
    }
    return info;
}

function createLxMusicData({ appDataDir, dataDirs = defaultLxDataDirs(appDataDir), warn = console.warn, openDatabase }) {
    // node:sqlite is part of Node 24 (Electron 43). It is asked for lazily: without it there are no lists.
    const openDb = openDatabase || ((file) => {
        const { DatabaseSync } = require('node:sqlite');
        return new DatabaseSync(file, { readOnly: true, timeout: 2000 });
    });

    const findDir = () => dataDirs.find(dir => {
        try { return fs.statSync(dir).isDirectory(); } catch { return false; }
    }) || null;

    // The selected custom source: the one LX Music's setting names, else the first one imported.
    let scriptCache = { key: '', value: null };
    function readUserApi() {
        const dir = findDir();
        if (!dir) return { found: false, reason: 'no-lx-music', api: null };
        const apiFile = path.join(dir, 'user_api.json');
        let stamp = '';
        try { stamp = String(fs.statSync(apiFile).mtimeMs); } catch { return { found: true, reason: 'no-custom-source', api: null }; }
        const settingFile = path.join(dir, 'config_v2.json');
        try { stamp += `:${fs.statSync(settingFile).mtimeMs}`; } catch { /* no setting file */ }
        if (scriptCache.key === stamp && scriptCache.value) return scriptCache.value;
        const apis = (readJson(apiFile)?.userApis || []).filter(api => api && typeof api.id === 'string' && api.script);
        const selectedId = readJson(settingFile)?.setting?.['common.apiSource'];
        const picked = apis.find(api => api.id === selectedId) || apis[0] || null;
        let value;
        if (!picked) value = { found: true, reason: 'no-custom-source', api: null };
        else {
            try {
                value = {
                    found: true,
                    reason: null,
                    api: {
                        id: picked.id,
                        name: String(picked.name || picked.id),
                        description: String(picked.description || ''),
                        author: String(picked.author || ''),
                        homepage: String(picked.homepage || ''),
                        version: String(picked.version || ''),
                        script: inflateScript(picked.script),
                    },
                    selected: picked.id === selectedId,
                    count: apis.length,
                };
            } catch (error) {
                warn('[LX Music] Custom source could not be read', error);
                value = { found: true, reason: 'unreadable-custom-source', api: null };
            }
        }
        scriptCache = { key: stamp, value };
        return value;
    }

    function withDb(read) {
        const dir = findDir();
        if (!dir) return null;
        const file = path.join(dir, 'lx.data.db');
        if (!fs.existsSync(file)) return null;
        let db = null;
        try {
            db = openDb(file);
            return read(db);
        } catch (error) {
            warn('[LX Music] Song lists could not be read', error);
            return null;
        } finally {
            try { db?.close(); } catch { /* already closed */ }
        }
    }

    function readLists() {
        return withDb(db => {
            const counts = new Map(db.prepare('SELECT "listId" AS listId, COUNT(*) AS count FROM "my_list_music_info" GROUP BY "listId"').all()
                .map(row => [String(row.listId), Number(row.count)]));
            const lists = [
                { id: 'default', name: LIST_NAMES.default },
                { id: 'love', name: LIST_NAMES.love },
                ...db.prepare('SELECT "id", "name" FROM "my_list" ORDER BY "position" ASC').all()
                    .map(row => ({ id: String(row.id), name: String(row.name) })),
            ];
            return lists.map(list => ({ ...list, count: counts.get(list.id) || 0 }));
        }) || [];
    }

    function readListSongs(listId, limit, offset) {
        return withDb(db => {
            const total = Number(db.prepare('SELECT COUNT(*) AS count FROM "my_list_music_info" WHERE "listId" = ?').get(listId)?.count || 0);
            const rows = db.prepare(`SELECT i."id", i."name", i."singer", i."source", i."interval", i."meta"
                FROM "my_list_music_info" i
                LEFT JOIN "my_list_music_info_order" o ON o."listId" = i."listId" AND o."musicInfoId" = i."id"
                WHERE i."listId" = ?
                ORDER BY o."order" ASC
                LIMIT ? OFFSET ?`).all(listId, limit, offset);
            return { total, items: rows.map(toOldMusicInfo) };
        }) || { total: 0, items: [] };
    }

    return { findDir, readUserApi, readLists, readListSongs };
}

module.exports = { createLxMusicData, toOldMusicInfo, inflateScript, defaultLxDataDirs };
