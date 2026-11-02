// electron/lxmusic/mediaCors.cjs
// Scope CORS to the audio URLs the LX Music custom source issued (and where they redirect), and
// to the cover hosts of the sources LX Music searches, for Web Audio and canvas/WebGL.

function createLxMusicMediaPolicy({ now = Date.now } = {}) {
    const issued = new Map();
    const ttl = 2 * 60 * 60 * 1000;
    const normalize = value => {
        try {
            const url = new URL(value);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
            url.hash = '';
            return url;
        } catch { return null; }
    };
    const register = value => {
        const url = normalize(value);
        if (!url) return;
        issued.delete(url.href);
        issued.set(url.href, now() + ttl);
        while (issued.size > 2048) issued.delete(issued.keys().next().value);
    };
    const coverHost = hostname => /^img\d*\.(?:kwcdn\.)?kuwo\.cn$/.test(hostname)
        || /(?:^|\.)music\.126\.net$/.test(hostname);
    const allows = details => {
        if (!['media', 'xhr', 'image'].includes(details.resourceType) || !['GET', 'HEAD', 'OPTIONS'].includes(details.method)) return false;
        const url = normalize(details.url);
        if (!url) return false;
        const expiry = issued.get(url.href);
        if (expiry > now()) return true;
        if (expiry !== undefined) issued.delete(url.href);
        return ['image', 'xhr'].includes(details.resourceType) && coverHost(url.hostname);
    };
    return {
        register,
        allows,
        followRedirect(details) {
            if (allows(details)) register(details.redirectURL);
        },
    };
}

module.exports = { createLxMusicMediaPolicy };
