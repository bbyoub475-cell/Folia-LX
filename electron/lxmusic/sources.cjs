const zlib = require('zlib');
const { createCipheriv, createHash } = require('crypto');

// electron/lxmusic/sources.cjs
// Search, lyrics and covers of the sources LX Music plays from: kw (酷我), kg (酷狗), tx (QQ 音乐)
// and wy (网易云). The requests are the ones lx-music-desktop makes (src/renderer/utils/musicSdk),
// and every song comes out in LX Music's own music info shape, which is what a custom source
// is handed to find the song's audio.

const SOURCE_NAMES = { kw: '酷我', kg: '酷狗', tx: 'QQ', wy: '网易云', mg: '咪咕' };
const SEARCHABLE = ['kw', 'kg', 'tx', 'wy'];
const TIMEOUT_MS = 12_000;

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': '\'', '&#039;': '\'', '&#39;': '\'', '&nbsp;': ' ' };
const decodeName = (value) => String(value ?? '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#039|#39);/g, entity => ENTITIES[entity] || entity);
const numFix = n => String(n).padStart(2, '0');
const formatPlayTime = (seconds) => {
    const time = Number(seconds) || 0;
    const m = Math.trunc(time / 60);
    const s = Math.trunc(time % 60);
    return m === 0 && s === 0 ? '--/--' : `${numFix(m)}:${numFix(s)}`;
};
const sizeFormate = (size) => {
    if (!size) return '0 B';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    const number = Math.floor(Math.log(size) / Math.log(1024));
    return `${(size / Math.pow(1024, number)).toFixed(2)} ${units[number]}`;
};
const joinSingers = (singers, key = 'name') => (Array.isArray(singers)
    ? decodeName(singers.map(item => item?.[key]).filter(Boolean).join('、'))
    : decodeName(singers));

function createLxSources({ fetchFn }) {
    async function get(url, { headers = {}, method = 'GET', body, as = 'json' } = {}) {
        const response = await fetchFn(url, { method, headers, body, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (as === 'buffer') return Buffer.from(await response.arrayBuffer());
        const text = await response.text();
        if (as === 'text') return text;
        return JSON.parse(text);
    }

    // ---- kw 酷我 ----
    const kwMinfo = /level:(\w+),bitrate:(\d+),format:(\w+),size:([\w.]+)/;
    async function searchKw(query, page, limit) {
        const body = await get(`http://search.kuwo.cn/r.s?client=kt&all=${encodeURIComponent(query)}&pn=${page - 1}&rn=${limit}&uid=794762570&ver=kwplayer_ar_9.2.2.1&vipver=1&show_copyright_off=1&newver=1&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&vermerge=1&mobi=1&issubtitle=1`);
        const list = (Array.isArray(body?.abslist) ? body.abslist : []).flatMap(info => {
            if (!info?.MUSICRID || !info.N_MINFO) return [];
            const types = [];
            const _types = {};
            for (const part of String(info.N_MINFO).split(';')) {
                const match = part.match(kwMinfo);
                if (!match) continue;
                const type = { 4000: 'flac24bit', 2000: 'flac', 320: '320k', 128: '128k' }[match[2]];
                if (!type || _types[type]) continue;
                types.push({ type, size: match[4] });
                _types[type] = { size: match[4].toLocaleUpperCase() };
            }
            types.reverse();
            const interval = parseInt(info.DURATION, 10);
            const pic = String(info.web_albumpic_short || '').match(/^\d+\/(.+)$/);
            return [{
                name: decodeName(info.SONGNAME),
                singer: decodeName(info.ARTIST).replace(/&/g, '、'),
                source: 'kw',
                songmid: String(info.MUSICRID).replace('MUSIC_', ''),
                albumId: decodeName(info.ALBUMID || ''),
                interval: Number.isNaN(interval) ? 0 : formatPlayTime(interval),
                albumName: info.ALBUM ? decodeName(info.ALBUM) : '',
                img: pic ? `https://img4.kuwo.cn/star/albumcover/500/${pic[1]}` : '',
                lrc: null,
                otherSource: null,
                types,
                _types,
                typeUrl: {},
            }];
        });
        return { list, total: parseInt(body?.TOTAL, 10) || list.length };
    }
    async function lyricKw(info) {
        const body = await get(`http://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=${encodeURIComponent(info.songmid)}&httpsStatus=1`);
        const rows = Array.isArray(body?.data?.lrclist) ? body.data.lrclist : [];
        const stamp = (time) => {
            const value = Number(time) || 0;
            return `[${numFix(Math.trunc(value / 60))}:${(value % 60).toFixed(2).padStart(5, '0')}]`;
        };
        const lines = [];
        const translations = [];
        let previous = null;
        for (const row of rows) {
            const text = decodeName(row.lineLyric);
            // A line that repeats the time of the line before it is that line's translation.
            if (previous !== null && row.time === previous) translations.push(`${stamp(row.time)}${text}`);
            else lines.push(`${stamp(row.time)}${text}`);
            previous = row.time;
        }
        return { format: 'lrc', lyric: lines.join('\n'), tlyric: translations.join('\n') };
    }
    async function picKw(info) {
        const text = await get(`http://artistpicserver.kuwo.cn/pic.web?corp=kuwo&type=rid_pic&pictype=500&size=500&rid=${encodeURIComponent(info.songmid)}`, { as: 'text' });
        return /^https?:/.test(text.trim()) ? text.trim() : '';
    }

    // ---- kg 酷狗 ----
    function kgSong(raw) {
        const types = [];
        const _types = {};
        const add = (type, size, hash) => {
            if (!size) return;
            const formatted = sizeFormate(size);
            types.push({ type, size: formatted, hash });
            _types[type] = { size: formatted, hash };
        };
        add('128k', raw.FileSize, raw.FileHash);
        add('320k', raw.HQFileSize, raw.HQFileHash);
        add('flac', raw.SQFileSize, raw.SQFileHash);
        add('flac24bit', raw.ResFileSize, raw.ResFileHash);
        return {
            singer: joinSingers(raw.Singers),
            name: decodeName(`${raw.OriSongName}${raw.Suffix ? ` ${raw.Suffix}` : ''}`),
            albumName: decodeName(raw.AlbumName),
            albumId: raw.AlbumID,
            songmid: raw.Audioid,
            albumAudioId: raw.MixSongID,
            source: 'kg',
            interval: formatPlayTime(raw.Duration),
            _interval: raw.Duration,
            img: typeof raw.Image === 'string' ? raw.Image.replace('{size}', '480').replace(/^http:/, 'https:') : '',
            lrc: null,
            otherSource: null,
            hash: raw.FileHash,
            types,
            _types,
            typeUrl: {},
        };
    }
    async function searchKg(query, page, limit) {
        const body = await get(`http://songsearch.kugou.com/song_search_v2?platform=AndroidFilter&iscorrection=1&keyword=${encodeURIComponent(query)}&hifiquality=0&pagesize=${limit}&PrivilegeFilter=0&page=${page}`);
        if (!body || body.error_code !== 0) throw new Error('KuGou search failed');
        const seen = new Set();
        const list = [];
        for (const item of body.data?.lists || []) {
            for (const row of [item, ...(Array.isArray(item.Grp) ? item.Grp : [])]) {
                const key = `${row.Audioid}${row.FileHash}`;
                if (seen.has(key)) continue;
                seen.add(key);
                list.push(kgSong(row));
            }
        }
        return { list, total: Number(body.data?.total) || list.length };
    }
    const KG_HEADERS = { 'KG-RC': '1', 'KG-THash': 'expand_search_manager.cpp:852736169:451', 'User-Agent': 'KuGou2012-9020-ExpandSearchManager' };
    const KRC_KEY = Buffer.from([0x40, 0x47, 0x61, 0x77, 0x5e, 0x32, 0x74, 0x47, 0x51, 0x36, 0x31, 0x2d, 0xce, 0xd2, 0x6e, 0x69]);
    async function lyricKg(info) {
        const seconds = Number(info._interval) || String(info.interval || '').split(':').reduce((sum, part) => sum * 60 + (Number(part) || 0), 0);
        const search = await get(`http://lyrics.kugou.com/search?ver=1&man=yes&client=pc&keyword=${encodeURIComponent(info.name)}&hash=${encodeURIComponent(info.hash || '')}&timelength=${seconds}&lrctxt=1`, { headers: KG_HEADERS });
        const candidate = search?.candidates?.[0];
        if (!candidate) return null;
        const fmt = (candidate.krctype == 1 && candidate.contenttype != 1) ? 'krc' : 'lrc';
        const body = await get(`http://lyrics.kugou.com/download?ver=1&client=pc&id=${encodeURIComponent(candidate.id)}&accesskey=${encodeURIComponent(candidate.accesskey)}&fmt=${fmt}&charset=utf8`, { headers: KG_HEADERS });
        if (!body?.content) return null;
        if (body.fmt === 'krc') {
            const data = Buffer.from(body.content, 'base64').subarray(4);
            for (let i = 0; i < data.length; i++) data[i] ^= KRC_KEY[i % 16];
            return { format: 'krc', lyric: zlib.inflateSync(data).toString('utf8'), tlyric: '' };
        }
        return { format: 'lrc', lyric: Buffer.from(body.content, 'base64').toString('utf8'), tlyric: '' };
    }

    // ---- tx QQ 音乐 ----
    const PART_1 = [23, 14, 6, 36, 16, 40, 7, 19];
    const PART_2 = [16, 1, 32, 12, 19, 27, 8, 5];
    const SCRAMBLE = [89, 39, 179, 150, 218, 82, 58, 252, 177, 52, 186, 123, 120, 64, 242, 133, 143, 161, 121, 179];
    const zzcSign = (text) => {
        const hash = createHash('sha1').update(text).digest('hex');
        const part1 = PART_1.map(i => hash[i]).join('');
        const part2 = PART_2.map(i => hash[i]).join('');
        const part3 = SCRAMBLE.map((value, i) => value ^ parseInt(hash.slice(i * 2, i * 2 + 2), 16));
        const b64 = Buffer.from(part3).toString('base64').replace(/[\\/+=]/g, '');
        return `zzc${part1}${b64}${part2}`.toLowerCase();
    };
    const searchId = () => {
        let guid = '';
        for (let i = 0; i < 32; i++) guid += Math.floor(Math.random() * 16).toString(16);
        return guid.toUpperCase() + String(Math.floor(Math.random() * 100000)).padStart(5, '0');
    };
    async function searchTx(query, page, limit) {
        const data = {
            comm: {
                _channelid: '0', _os_version: '6.2.9200-2', ct: '19', cv: '2151', guid: '1F70E520B2EAA7D25E11760783C53CA9',
                patch: '118', psrf_access_token_expiresAt: 0, psrf_qqaccess_token: '', psrf_qqopenid: '', psrf_qqunionid: '',
                tmeAppID: 'qqmusic', tmeLoginType: 0, uin: '0', wid: '7223299733393904640',
            },
            'music.search.SearchCgiService': {
                module: 'music.search.SearchCgiService',
                method: 'DoSearchForQQMusicDesktop',
                param: { grp: 1, num_per_page: limit, page_num: page, query, remoteplace: 'txt.newclient.top', search_type: 0, searchid: searchId() },
            },
        };
        const text = JSON.stringify(data);
        const body = await get(`https://u.y.qq.com/cgi-bin/musics.fcg?sign=${zzcSign(text)}`, {
            method: 'POST',
            headers: { 'User-Agent': 'QQMusic 14090508(android 12)', 'Content-Type': 'application/json' },
            body: text,
        });
        const req = body?.['music.search.SearchCgiService'] ?? body?.req;
        if (!req || body.code != 0 || req.code != 0) throw new Error('QQ Music search failed');
        const list = (req.data?.body?.song?.list || []).flatMap(item => {
            const file = item.file;
            if (!file?.media_mid) return [];
            const types = [];
            const _types = {};
            const add = (type, size) => {
                if (!size) return;
                const formatted = sizeFormate(size);
                types.push({ type, size: formatted });
                _types[type] = { size: formatted };
            };
            add('128k', file.size_128mp3);
            add('320k', file.size_320mp3);
            add('flac', file.size_flac);
            add('flac24bit', file.size_hires);
            const albumId = item.album?.mid || '';
            return [{
                singer: joinSingers(item.singer),
                name: decodeName(item.title),
                albumName: decodeName(item.album?.name || ''),
                albumId,
                source: 'tx',
                interval: item.interval ? formatPlayTime(item.interval) : null,
                songId: item.id,
                albumMid: albumId,
                strMediaMid: file.media_mid,
                songmid: item.mid,
                img: albumId && albumId !== '空'
                    ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumId}.jpg`
                    : item.singer?.length ? `https://y.gtimg.cn/music/photo_new/T001R500x500M000${item.singer[0].mid}.jpg` : '',
                types,
                _types,
                typeUrl: {},
            }];
        });
        return { list, total: Number(req.data?.meta?.sum) || list.length };
    }
    async function lyricTx(info) {
        const text = await get(`https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${encodeURIComponent(info.songmid)}&g_tk=5381&loginUin=0&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq&needNewCode=0&nobase64=1`, {
            headers: { Referer: 'https://y.qq.com/portal/player.html' },
            as: 'text',
        });
        const body = JSON.parse(text.replace(/^[^{]*\(/, '').replace(/\)\s*;?\s*$/, ''));
        const readText = (value) => {
            if (typeof value !== 'string' || !value) return '';
            const plain = /^[A-Za-z0-9+/=\s]+$/.test(value) && !value.includes('[') ? Buffer.from(value, 'base64').toString('utf8') : value;
            return decodeName(plain);
        };
        return { format: 'lrc', lyric: readText(body?.lyric), tlyric: readText(body?.trans) };
    }

    // ---- wy 网易云 ----
    const EAPI_KEY = 'e82ckenh8dichen8';
    const eapi = (url, object) => {
        const text = JSON.stringify(object);
        const digest = createHash('md5').update(`nobody${url}use${text}md5forencrypt`).digest('hex');
        const data = `${url}-36cd479b6b5-${text}-36cd479b6b5-${digest}`;
        const cipher = createCipheriv('aes-128-ecb', EAPI_KEY, '');
        return Buffer.concat([cipher.update(Buffer.from(data)), cipher.final()]).toString('hex').toUpperCase();
    };
    async function searchWy(query, page, limit) {
        const body = await get('http://interface.music.163.com/eapi/batch', {
            method: 'POST',
            headers: {
                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36',
                origin: 'https://music.163.com',
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({ params: eapi('/api/search/song/list/page', {
                keyword: query, needCorrect: '1', channel: 'typing', offset: limit * (page - 1), scene: 'normal', total: page == 1, limit,
            }) }).toString(),
        });
        if (!body || body.code !== 200) throw new Error('NetEase search failed');
        const list = (body.data?.resources || []).flatMap(resource => {
            const item = resource?.baseInfo?.simpleSongData;
            if (!item?.id) return [];
            const types = [];
            const _types = {};
            const add = (type, part) => {
                const size = part?.size ? sizeFormate(part.size) : null;
                types.push({ type, size });
                _types[type] = { size };
            };
            if (item.privilege?.maxBrLevel === 'hires') add('flac24bit', item.hr);
            const maxbr = Number(item.privilege?.maxbr) || 0;
            if (maxbr >= 999000) add('flac', item.sq);
            if (maxbr >= 320000) add('320k', item.h);
            if (maxbr >= 128000) add('128k', item.l);
            types.reverse();
            return [{
                singer: joinSingers(item.ar),
                name: decodeName(item.name),
                albumName: decodeName(item.al?.name || ''),
                albumId: item.al?.id ?? '',
                source: 'wy',
                interval: formatPlayTime((Number(item.dt) || 0) / 1000),
                songmid: item.id,
                img: item.al?.picUrl || '',
                lrc: null,
                types,
                _types,
                typeUrl: {},
            }];
        });
        return { list, total: Number(body.data?.totalCount) || list.length };
    }
    async function lyricWy(info) {
        const body = await get(`https://music.163.com/api/song/lyric?id=${encodeURIComponent(info.songmid)}&lv=-1&kv=-1&tv=-1&rv=-1`, {
            headers: { Referer: 'https://music.163.com/' },
        });
        return { format: 'lrc', lyric: String(body?.lrc?.lyric || ''), tlyric: String(body?.tlyric?.lyric || '') };
    }

    const searchers = { kw: searchKw, kg: searchKg, tx: searchTx, wy: searchWy };
    const lyricReaders = { kw: lyricKw, kg: lyricKg, tx: lyricTx, wy: lyricWy };

    return {
        async search(source, query, page, limit) {
            const searcher = searchers[source];
            if (!searcher) throw new Error(`Search is not supported for source ${source}`);
            return searcher(query, page, limit);
        },
        async lyric(info) {
            const reader = lyricReaders[info?.source];
            return reader ? reader(info) : null;
        },
        async pic(info) {
            if (info?.img) return info.img;
            return info?.source === 'kw' ? picKw(info) : '';
        },
    };
}

module.exports = { createLxSources, SOURCE_NAMES, SEARCHABLE };
