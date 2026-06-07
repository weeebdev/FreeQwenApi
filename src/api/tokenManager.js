import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logError, logInfo } from '../logger/index.js';
import { SESSION_DIR, ACCOUNTS_DIR } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SESSION_PATH = path.resolve(__dirname, '..', '..', SESSION_DIR);
const ACCOUNTS_PATH = path.join(SESSION_PATH, ACCOUNTS_DIR);
const TOKENS_FILE = path.join(SESSION_PATH, 'tokens.json');

let pointer = 0;

function ensureSessionDir() {
    if (!fs.existsSync(SESSION_PATH)) fs.mkdirSync(SESSION_PATH, { recursive: true });
    if (!fs.existsSync(ACCOUNTS_PATH)) fs.mkdirSync(ACCOUNTS_PATH, { recursive: true });
}

export function loadTokens() {
    ensureSessionDir();
    if (!fs.existsSync(TOKENS_FILE)) return [];
    try {
        return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    } catch (e) {
        logError('TokenManager: ошибка чтения tokens.json', e);
        return [];
    }
}

export function saveTokens(tokens) {
    ensureSessionDir();
    try {
        fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2), 'utf8');
    } catch (e) {
        logError('TokenManager: ошибка сохранения tokens.json', e);
    }
}

function writeAccountTokenFile(id, token) {
    const accountDir = path.join(ACCOUNTS_PATH, id);
    if (!fs.existsSync(accountDir)) fs.mkdirSync(accountDir, { recursive: true });
    fs.writeFileSync(path.join(accountDir, 'token.txt'), token, 'utf8');
}

/**
 * Seed session/tokens.json from env (Coolify-friendly).
 * QWEN_ACCOUNTS_JSON: [{"id":"acc_1","token":"..."},{"token":"..."}]
 * QWEN_TOKENS: comma-separated bearer tokens (auto ids acc_env_1, acc_env_2, ...)
 * Existing file tokens are kept unless QWEN_ACCOUNTS_OVERWRITE=true.
 */
export function bootstrapTokensFromEnv() {
    const overwrite = ['1', 'true', 'yes', 'on'].includes(
        (process.env.QWEN_ACCOUNTS_OVERWRITE || '').trim().toLowerCase()
    );
    const existing = loadTokens();
    if (existing.length && !overwrite) return false;

    let entries = [];

    const jsonRaw = process.env.QWEN_ACCOUNTS_JSON?.trim();
    if (jsonRaw) {
        try {
            const parsed = JSON.parse(jsonRaw);
            if (!Array.isArray(parsed) || !parsed.length) {
                logError('QWEN_ACCOUNTS_JSON: expected a non-empty JSON array');
                return false;
            }
            entries = parsed;
        } catch (e) {
            logError('QWEN_ACCOUNTS_JSON: invalid JSON', e);
            return false;
        }
    } else {
        const csv = process.env.QWEN_TOKENS?.trim();
        if (csv) entries = csv.split(',').map(t => t.trim()).filter(Boolean);
    }

    if (!entries.length) return false;

    let tokens;
    try {
        tokens = entries.map((entry, index) => {
            const token = typeof entry === 'string' ? entry : entry?.token;
            if (!token || typeof token !== 'string') {
                throw new Error(`Account at index ${index} is missing a token string`);
            }
            const id = (typeof entry === 'object' && entry?.id) ? entry.id : `acc_env_${index + 1}`;
            return { id, token, resetAt: null, invalid: false };
        });
    } catch (e) {
        logError('Failed to parse account tokens from environment', e);
        return false;
    }

    ensureSessionDir();
    saveTokens(tokens);
    for (const { id, token } of tokens) writeAccountTokenFile(id, token);
    logInfo(`Bootstrapped ${tokens.length} account(s) from environment`);
    return true;
}

export async function getAvailableToken() {
    const tokens = loadTokens();
    const now = Date.now();
    const valid = tokens.filter(t => (!t.resetAt || new Date(t.resetAt).getTime() <= now) && !t.invalid);
    if (!valid.length) return null;
    const token = valid[pointer % valid.length];
    pointer = (pointer + 1) % valid.length;
    return token;
}

export function hasValidTokens() {
    const tokens = loadTokens();
    const now = Date.now();
    return tokens.some(t => (!t.resetAt || new Date(t.resetAt).getTime() <= now) && !t.invalid);
}

export function markRateLimited(id, hours = 24) {
    const tokens = loadTokens();
    const idx = tokens.findIndex(t => t.id === id);
    if (idx !== -1) {
        tokens[idx].resetAt = new Date(Date.now() + hours * 3600 * 1000).toISOString();
        saveTokens(tokens);
    }
}

export function removeToken(id) {
    saveTokens(loadTokens().filter(t => t.id !== id));
}

export { removeToken as removeInvalidToken };

export function markInvalid(id) {
    const tokens = loadTokens();
    const idx = tokens.findIndex(t => t.id === id);
    if (idx !== -1) { tokens[idx].invalid = true; saveTokens(tokens); }
}

export function markValid(id, newToken) {
    const tokens = loadTokens();
    const idx = tokens.findIndex(t => t.id === id);
    if (idx !== -1) {
        tokens[idx].invalid = false;
        tokens[idx].resetAt = null;
        if (newToken) tokens[idx].token = newToken;
        saveTokens(tokens);
    }
}

export function listTokens() {
    return loadTokens();
}
