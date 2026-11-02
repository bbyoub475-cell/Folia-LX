const { contextBridge, ipcRenderer, webFrame } = require('electron');

// electron/lxmusic/userApiPreload.cjs
// Preload of the hidden window that runs the listener's LX Music custom source. It gives the
// script the same `lx` object LX Music desktop gives it (src/main/modules/userApi/renderer/preload.js
// in lx-music-desktop): request, send/on, utils. The window is sandboxed and has no network of its
// own; requests, crypto and zlib are done by the main process (userApiHost.cjs).

const CHANNEL = 'lxmusic-userapi';
const EVENT_NAMES = { request: 'request', inited: 'inited', updateAlert: 'updateAlert' };
const eventNames = Object.values(EVENT_NAMES);
const allSources = ['kw', 'kg', 'tx', 'wy', 'mg', 'local'];
const supportQualitys = {
    kw: ['128k', '320k', 'flac', 'flac24bit'],
    kg: ['128k', '320k', 'flac', 'flac24bit'],
    tx: ['128k', '320k', 'flac', 'flac24bit'],
    wy: ['128k', '320k', 'flac', 'flac24bit'],
    mg: ['128k', '320k', 'flac', 'flac24bit'],
    local: [],
};
const supportActions = {
    kw: ['musicUrl'], kg: ['musicUrl'], tx: ['musicUrl'], wy: ['musicUrl'], mg: ['musicUrl'], xm: ['musicUrl'],
    local: ['musicUrl', 'lyric', 'pic'],
};

let isInited = false;
let isShowedUpdateAlert = false;
let requestHandler = null;

const send = (name, payload) => ipcRenderer.send(`${CHANNEL}:${name}`, payload);
const toBuffer = value => Buffer.from(value instanceof Uint8Array ? value : new Uint8Array(value || []));
const crypto = (op, ...args) => {
    const result = ipcRenderer.sendSync(`${CHANNEL}:crypto`, op, args);
    if (result && result.error) throw new Error(result.error);
    return result.value;
};

const verifyLyricInfo = (info) => {
    if (typeof info != 'object' || typeof info.lyric != 'string') throw new Error('failed');
    if (info.lyric.length > 51200) throw new Error('failed');
    return {
        lyric: info.lyric,
        tlyric: (typeof info.tlyric == 'string' && info.tlyric.length < 5120) ? info.tlyric : null,
        rlyric: (typeof info.rlyric == 'string' && info.rlyric.length < 5120) ? info.rlyric : null,
        lxlyric: (typeof info.lxlyric == 'string' && info.lxlyric.length < 8192) ? info.lxlyric : null,
    };
};

const handleRequest = (context, { requestKey, data }) => {
    if (!requestHandler) return send('response', { requestKey, status: false, message: 'Request event is not defined' });
    try {
        Promise.resolve(requestHandler.call(context, { source: data.source, action: data.action, info: data.info })).then(response => {
            let result;
            switch (data.action) {
                case 'musicUrl':
                    if (typeof response != 'string' || response.length > 2048 || !/^https?:/.test(response)) throw new Error('failed');
                    result = { source: data.source, action: data.action, data: { type: data.info.type, url: response } };
                    break;
                case 'lyric':
                    result = { source: data.source, action: data.action, data: verifyLyricInfo(response) };
                    break;
                case 'pic':
                    if (typeof response != 'string' || response.length > 2048 || !/^https?:/.test(response)) throw new Error('failed');
                    result = { source: data.source, action: data.action, data: response };
                    break;
                default:
                    throw new Error('Unknown action');
            }
            send('response', { requestKey, status: true, result });
        }).catch(error => {
            send('response', { requestKey, status: false, message: String(error?.message ?? error) });
        });
    } catch (error) {
        send('response', { requestKey, status: false, message: String(error?.message ?? error) });
    }
};

const handleInit = (context, info) => {
    if (!info || typeof info !== 'object' || !info.sources) {
        send('inited', { status: false, message: 'Missing required parameter init info' });
        return;
    }
    const sources = {};
    try {
        for (const source of allSources) {
            const userSource = info.sources[source];
            if (!userSource || userSource.type !== 'music') continue;
            sources[source] = {
                type: 'music',
                actions: supportActions[source].filter(action => (userSource.actions || []).includes(action)),
                qualitys: supportQualitys[source].filter(quality => (userSource.qualitys || []).includes(quality)),
            };
        }
    } catch (error) {
        send('inited', { status: false, message: String(error?.message ?? error) });
        return;
    }
    send('inited', { status: true, sources });
    ipcRenderer.on(`${CHANNEL}:request`, (_event, payload) => handleRequest(context, payload));
};

const onError = (message) => {
    if (isInited) return;
    isInited = true;
    send('inited', { status: false, message: String(message).slice(0, 1024) });
};

const initEnv = (userApi) => {
    const lx = {
        EVENT_NAMES,
        request(url, { method = 'get', timeout, headers, body, form, formData } = {}, callback) {
            let aborted = false;
            ipcRenderer.invoke(`${CHANNEL}:http`, String(url), { method, timeout, headers, body, form, formData }).then(response => {
                if (aborted) return;
                if (response.error) {
                    callback.call(this, new Error(response.error), null, null);
                    return;
                }
                const raw = toBuffer(response.raw);
                let parsed = raw.toString();
                try { parsed = JSON.parse(parsed); } catch { /* not JSON */ }
                callback.call(this, null, {
                    statusCode: response.statusCode,
                    statusMessage: response.statusMessage,
                    headers: response.headers,
                    bytes: raw.length,
                    raw,
                    body: parsed,
                }, parsed);
            }).catch(error => {
                if (!aborted) callback.call(this, error, null, null);
            });
            return () => { aborted = true; };
        },
        send(eventName, data) {
            return new Promise((resolve, reject) => {
                if (!eventNames.includes(eventName)) return reject(new Error('The event is not supported: ' + eventName));
                switch (eventName) {
                    case EVENT_NAMES.inited:
                        if (isInited) return reject(new Error('Script is inited'));
                        isInited = true;
                        handleInit(this, data);
                        resolve();
                        break;
                    case EVENT_NAMES.updateAlert:
                        // Folia does not show a custom source's update notice; LX Music itself does.
                        if (isShowedUpdateAlert) return reject(new Error('The update alert can only be called once.'));
                        isShowedUpdateAlert = true;
                        resolve();
                        break;
                    default:
                        reject(new Error('Unknown event name: ' + eventName));
                }
            });
        },
        on(eventName, handler) {
            if (!eventNames.includes(eventName)) return Promise.reject(new Error('The event is not supported: ' + eventName));
            if (eventName !== EVENT_NAMES.request) return Promise.reject(new Error('The event is not supported: ' + eventName));
            requestHandler = handler;
            return Promise.resolve();
        },
        utils: {
            crypto: {
                aesEncrypt: (buffer, mode, key, iv) => toBuffer(crypto('aesEncrypt', toBuffer(buffer), mode, typeof key === 'string' ? key : toBuffer(key), typeof iv === 'string' ? iv : toBuffer(iv))),
                rsaEncrypt: (buffer, key) => toBuffer(crypto('rsaEncrypt', toBuffer(buffer), key)),
                randomBytes: size => toBuffer(crypto('randomBytes', size)),
                md5: str => crypto('md5', typeof str === 'string' ? str : toBuffer(str)),
            },
            buffer: {
                from: (...args) => Buffer.from(...args),
                bufToString: (buf, format) => Buffer.from(buf, 'binary').toString(format),
            },
            zlib: {
                inflate: buf => ipcRenderer.invoke(`${CHANNEL}:zlib`, 'inflate', toBuffer(buf)).then(result => {
                    if (result.error) throw new Error(result.error);
                    return toBuffer(result.value);
                }),
                deflate: data => ipcRenderer.invoke(`${CHANNEL}:zlib`, 'deflate', typeof data === 'string' ? data : toBuffer(data)).then(result => {
                    if (result.error) throw new Error(result.error);
                    return toBuffer(result.value);
                }),
            },
        },
        currentScriptInfo: {
            name: userApi.name,
            description: userApi.description,
            version: userApi.version,
            author: userApi.author,
            homepage: userApi.homepage,
            rawScript: userApi.script,
        },
        version: '2.0.0',
        env: 'desktop',
    };
    contextBridge.exposeInMainWorld('lx', lx);
    contextBridge.exposeInMainWorld('__lx_init_error_handler__', { sendError: message => onError(message) });

    webFrame.executeJavaScript(`(() => {
window.addEventListener('error', (event) => {
  if (event.isTrusted) globalThis.__lx_init_error_handler__.sendError(event.message.replace(/^Uncaught\\sError:\\s/, ''))
})
window.addEventListener('unhandledrejection', (event) => {
  if (!event.isTrusted) return
  const message = typeof event.reason === 'string' ? event.reason : event.reason?.message ?? String(event.reason)
  globalThis.__lx_init_error_handler__.sendError(message.replace(/^Error:\\s/, ''))
})
})()`);
    webFrame.executeJavaScript(userApi.script).catch(error => onError(String(error?.message ?? error)));
};

ipcRenderer.once(`${CHANNEL}:env`, (_event, userApi) => initEnv(userApi));
send('ready', null);
