const path = require('path');
const zlib = require('zlib');
const { createCipheriv, publicEncrypt, constants, randomBytes, createHash } = require('crypto');

// electron/lxmusic/userApiHost.cjs
// Runs the listener's LX Music custom source the way LX Music desktop does: in a hidden window of
// its own, with the `lx` object from userApiPreload.cjs. Differences from LX Music: the window is
// sandboxed, its session is in memory and refuses every request of its own; the script's requests
// go out through `fetchFn` here in the main process, without cookies.

const CHANNEL = 'lxmusic-userapi';
const INIT_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 25_000;
const HTTP_TIMEOUT_MS = 60_000;

const HTML = '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"><title>LX Music custom source</title></head><body></body></html>';

const asBuffer = value => Buffer.isBuffer(value) ? value : Buffer.from(value instanceof Uint8Array ? value : (value ?? []));

// The script's lx.request: needle's way of sending a body (lx-music-desktop uses needle).
async function scriptHttp(fetchFn, url, options = {}) {
    if (!/^https?:\/\//i.test(url)) throw new Error('Only http and https requests are allowed');
    const headers = {};
    for (const [key, value] of Object.entries(options.headers || {})) {
        if (value != null) headers[key] = String(value);
    }
    const header = name => Object.keys(headers).find(key => key.toLowerCase() === name);
    const init = { method: String(options.method || 'get').toUpperCase(), headers, redirect: 'follow' };
    const { body, form, formData } = options;
    if (body != null && body !== '') {
        if (typeof body === 'string' || body instanceof Uint8Array) init.body = body;
        else if (/json/i.test(headers[header('content-type')] || '')) init.body = JSON.stringify(body);
        else {
            init.body = new URLSearchParams(body).toString();
            if (!header('content-type')) headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }
    } else if (form && typeof form === 'object') {
        init.body = new URLSearchParams(form).toString();
        if (!header('content-type')) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (formData && typeof formData === 'object') {
        const data = new FormData();
        for (const [key, value] of Object.entries(formData)) data.append(key, String(value));
        init.body = data;
    }
    const timeout = typeof options.timeout === 'number' && options.timeout > 0 ? Math.min(options.timeout, HTTP_TIMEOUT_MS) : HTTP_TIMEOUT_MS;
    init.signal = AbortSignal.timeout(timeout);
    const response = await fetchFn(url, init);
    const raw = Buffer.from(await response.arrayBuffer());
    const responseHeaders = {};
    response.headers.forEach((value, key) => { responseHeaders[key] = value; });
    return { statusCode: response.status, statusMessage: response.statusText, headers: responseHeaders, raw };
}

const cryptoOps = {
    aesEncrypt(buffer, mode, key, iv) {
        const cipher = createCipheriv(mode, typeof key === 'string' ? key : asBuffer(key), typeof iv === 'string' ? iv : asBuffer(iv));
        return Buffer.concat([cipher.update(asBuffer(buffer)), cipher.final()]);
    },
    rsaEncrypt(buffer, key) {
        const data = asBuffer(buffer);
        return publicEncrypt({ key, padding: constants.RSA_NO_PADDING }, Buffer.concat([Buffer.alloc(Math.max(0, 128 - data.length)), data]));
    },
    randomBytes: size => randomBytes(Math.max(0, Math.min(Number(size) || 0, 4096))),
    md5: str => createHash('md5').update(typeof str === 'string' ? str : asBuffer(str)).digest('hex'),
};

function createLxUserApiHost({ BrowserWindow, session, ipcMain, fetchFn, log = console.info, warn = console.warn }) {
    let win = null;
    let loadedId = null;
    let loading = null;
    let sources = null;
    let lastError = null;
    let nextKey = 1;
    const pending = new Map();
    let initWaiter = null;

    const isHostSender = event => Boolean(win && !win.isDestroyed() && event.sender === win.webContents);

    // One in-memory session for the hidden window. The script has no network of its own:
    // everything it asks for goes through lx.request.
    let ownSession = null;
    const hostSession = () => {
        if (ownSession) return ownSession;
        ownSession = session.fromPartition('lxmusic-userapi');
        ownSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(data|devtools):/.test(details.url) }));
        ownSession.setPermissionRequestHandler((_webContents, _permission, resolve) => resolve(false));
        return ownSession;
    };

    ipcMain.on(`${CHANNEL}:ready`, (event) => {
        if (!isHostSender(event) || !initWaiter) return;
        event.sender.send(`${CHANNEL}:env`, initWaiter.userApi);
    });
    ipcMain.on(`${CHANNEL}:inited`, (event, payload) => {
        if (!isHostSender(event) || !initWaiter) return;
        const waiter = initWaiter;
        initWaiter = null;
        clearTimeout(waiter.timer);
        if (payload?.status) waiter.resolve(payload.sources || {});
        else waiter.reject(new Error(payload?.message || 'The custom source failed to start'));
    });
    ipcMain.on(`${CHANNEL}:response`, (event, payload) => {
        if (!isHostSender(event)) return;
        const request = pending.get(payload?.requestKey);
        if (!request) return;
        pending.delete(payload.requestKey);
        clearTimeout(request.timer);
        if (payload.status) request.resolve(payload.result);
        else request.reject(new Error(payload.message || 'The custom source refused the request'));
    });
    ipcMain.handle(`${CHANNEL}:http`, async (event, url, options) => {
        if (!isHostSender(event)) return { error: 'Untrusted request' };
        try { return await scriptHttp(fetchFn, url, options); }
        catch (error) { return { error: String(error?.message || error) }; }
    });
    ipcMain.handle(`${CHANNEL}:zlib`, async (event, op, data) => {
        if (!isHostSender(event)) return { error: 'Untrusted request' };
        try {
            const input = typeof data === 'string' ? Buffer.from(data) : asBuffer(data);
            return { value: op === 'deflate' ? zlib.deflateSync(input) : zlib.inflateSync(input) };
        } catch (error) { return { error: String(error?.message || error) }; }
    });
    ipcMain.on(`${CHANNEL}:crypto`, (event, op, args) => {
        if (!isHostSender(event) || typeof cryptoOps[op] !== 'function') {
            event.returnValue = { error: 'Unsupported crypto operation' };
            return;
        }
        try { event.returnValue = { value: cryptoOps[op](...(Array.isArray(args) ? args : [])) }; }
        catch (error) { event.returnValue = { error: String(error?.message || error) }; }
    });

    function close() {
        for (const [key, request] of pending) {
            clearTimeout(request.timer);
            request.reject(new Error('The custom source was closed'));
            pending.delete(key);
        }
        if (initWaiter) {
            clearTimeout(initWaiter.timer);
            initWaiter.reject(new Error('The custom source was closed'));
            initWaiter = null;
        }
        if (win && !win.isDestroyed()) win.destroy();
        win = null;
        loadedId = null;
        sources = null;
    }

    async function start(userApi) {
        close();
        lastError = null;
        const ses = hostSession();
        win = new BrowserWindow({
            show: false,
            width: 200,
            height: 200,
            webPreferences: {
                session: ses,
                preload: path.join(__dirname, 'userApiPreload.cjs'),
                sandbox: true,
                contextIsolation: true,
                nodeIntegration: false,
                spellcheck: false,
                webgl: false,
                images: false,
                disableDialogs: true,
                autoplayPolicy: 'document-user-activation-required',
            },
        });
        for (const name of ['will-navigate', 'will-redirect', 'will-attach-webview', 'will-prevent-unload']) {
            win.webContents.on(name, event => event.preventDefault());
        }
        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        const owner = win;
        win.on('closed', () => { if (win === owner) win = null; });
        const inited = new Promise((resolve, reject) => {
            initWaiter = {
                userApi: {
                    name: userApi.name, description: userApi.description, version: userApi.version,
                    author: userApi.author, homepage: userApi.homepage, script: userApi.script,
                },
                resolve,
                reject,
                timer: setTimeout(() => {
                    if (!initWaiter) return;
                    initWaiter = null;
                    reject(new Error('The custom source did not start in time'));
                }, INIT_TIMEOUT_MS),
            };
        });
        await win.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(HTML)}`);
        sources = await inited;
        loadedId = userApi.id;
        log('[LX Music] Custom source started', { name: userApi.name, sources: Object.keys(sources) });
        return sources;
    }

    // Starts `userApi` unless it is the one running; resolves to the sources it serves.
    async function ensure(userApi) {
        if (loadedId === userApi.id && sources && win && !win.isDestroyed()) return sources;
        if (loading?.id === userApi.id) return loading.promise;
        const promise = start(userApi).catch(error => {
            lastError = String(error?.message || error);
            warn('[LX Music] Custom source failed to start', { name: userApi.name, error: lastError });
            close();
            throw error;
        }).finally(() => { if (loading?.promise === promise) loading = null; });
        loading = { id: userApi.id, promise };
        return promise;
    }

    function request(source, action, info) {
        if (!win || win.isDestroyed() || !sources) return Promise.reject(new Error('The custom source is not running'));
        const requestKey = `r${nextKey++}`;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(requestKey);
                reject(new Error('The custom source did not answer in time'));
            }, REQUEST_TIMEOUT_MS);
            pending.set(requestKey, { resolve, reject, timer });
            win.webContents.send(`${CHANNEL}:request`, { requestKey, data: { source, action, info } });
        });
    }

    return {
        ensure,
        request,
        close,
        getSources: () => sources,
        getLastError: () => lastError,
        getLoadedId: () => loadedId,
    };
}

module.exports = { createLxUserApiHost, scriptHttp };
