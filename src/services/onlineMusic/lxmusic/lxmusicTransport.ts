import { OnlineProviderError } from '../../../types/onlineMusic';
import type { ProviderErrorCode } from '../../../types/onlineMusic';

// src/services/onlineMusic/lxmusic/lxmusicTransport.ts
// The renderer's only way to LX Music: the main process bridge (electron/lxmusic/lxmusicApiBridge.cjs).

export type LxMusicOperation =
    | 'status' | 'connect' | 'disconnect' | 'search' | 'audio' | 'lyrics' | 'pic' | 'playlists' | 'playlist_tracks';

export type LxMusicBridgeResult =
    | { ok: true; data: unknown }
    | { ok: false; error: { code: ProviderErrorCode; message: string } };

// What a request fails with where this page has no desktop bridge (the web build), and where the
// bridge itself failed (the main process threw).
export const LXMUSIC_NEEDS_DESKTOP = 'LX Music requires the desktop app';
export const LXMUSIC_BRIDGE_FAILED = 'LX Music desktop request failed';

const ERROR_CODES: readonly ProviderErrorCode[] = [
    'auth-required', 'unsupported', 'not-public', 'unavailable', 'not-playable', 'preview-only',
    'subscription-required', 'region-restricted', 'network', 'invalid-response',
];

export const getLxMusicAvailability = () => (
    typeof window !== 'undefined' && typeof window.electron?.lxmusicRequest === 'function'
        ? { configured: true } as const
        : { configured: false, reason: 'runtime-unavailable' } as const
);

export async function requestLxMusic<T = unknown>(operation: LxMusicOperation, params: Record<string, unknown> = {}): Promise<T> {
    if (!getLxMusicAvailability().configured) throw new OnlineProviderError('unavailable', LXMUSIC_NEEDS_DESKTOP, 'lxmusic');
    let result: LxMusicBridgeResult;
    try { result = await window.electron!.lxmusicRequest!(operation, params); }
    catch (error) { throw new OnlineProviderError('network', LXMUSIC_BRIDGE_FAILED, 'lxmusic', error); }
    if (!result.ok) {
        const code = ERROR_CODES.includes(result.error.code) ? result.error.code : 'invalid-response';
        throw new OnlineProviderError(code, result.error.message, 'lxmusic');
    }
    return result.data as T;
}
