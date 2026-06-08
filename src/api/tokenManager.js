import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logError, logInfo, logWarn } from '../logger/index.js';
import { SESSION_DIR, ACCOUNTS_DIR } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SESSION_PATH = path.resolve(__dirname, '..', '..', SESSION_DIR);
const ACCOUNTS_PATH = path.join(SESSION_PATH, ACCOUNTS_DIR);
const TOKENS_FILE = path.join(SESSION_PATH, 'tokens.json');

// ─── In-memory load-balancer state ───────────────────────────────────────────
// Resets on restart — that's intentional. Cold-start distributes evenly.

/** @type {Map<string, { lastUsedAt: number, requestCount: number }>} */
const accountStats = new Map();

/** @type {Map<string, { accountId: string, assignedAt: number }>} */
const chatAccountMap = new Map();

// Configurable via env — read once at module load so they're hot during requests.
const CHAT_STICKY_TTL_MS = Number(process.env.CHAT_STICKY_TTL_MS) || 60 * 60 * 1000; // 1h
const ACCOUNT_COOLDOWN_MS = Number(process.env.ACCOUNT_COOLDOWN_MS) || 500; // ms gap before reusing same account

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

// ─── Load balancer internals ─────────────────────────────────────────────────

function getStats(id) {
    if (!accountStats.has(id)) accountStats.set(id, { lastUsedAt: 0, requestCount: 0 });
    return accountStats.get(id);
}

/**
 * Pick the best account from `valid` using LRU + cooldown preference + jitter.
 * Jitter (±200ms noise on the lastUsedAt score) prevents synchronised patterns
 * when multiple requests arrive at the same moment.
 */
function pickAccount(valid) {
    if (valid.length === 1) return valid[0];

    const now = Date.now();

    const scored = valid.map(t => {
        const stats = getStats(t.id);
        const idleMs = now - stats.lastUsedAt;
        const cooledDown = ACCOUNT_COOLDOWN_MS === 0 || idleMs >= ACCOUNT_COOLDOWN_MS;
        // Jitter range: 0–200ms added to lastUsedAt — keeps distribution fuzzy
        const jitter = Math.random() * 200;
        return { token: t, cooledDown, score: stats.lastUsedAt + jitter };
    });

    // Prefer accounts that have sat idle longer than ACCOUNT_COOLDOWN_MS
    const cooled = scored.filter(s => s.cooledDown);
    const pool = cooled.length > 0 ? cooled : scored;
    pool.sort((a, b) => a.score - b.score);
    return pool[0].token;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Get the next available token.
 *
 * @param {string|null} chatId - When provided, the same account is reused for
 *   the lifetime of the conversation (sticky routing). Falls back to LRU if the
 *   sticky account is no longer valid.
 */
export async function getAvailableToken(chatId = null) {
    const now = Date.now();
    const tokens = loadTokens();
    const valid = tokens.filter(t => (!t.resetAt || new Date(t.resetAt).getTime() <= now) && !t.invalid);
    if (!valid.length) return null;

    // Sticky routing: reuse the account that was assigned to this chatId.
    if (chatId) {
        const sticky = chatAccountMap.get(chatId);
        if (sticky && (now - sticky.assignedAt) < CHAT_STICKY_TTL_MS) {
            const stickyToken = valid.find(t => t.id === sticky.accountId);
            if (stickyToken) {
                const stats = getStats(stickyToken.id);
                stats.lastUsedAt = now;
                stats.requestCount++;
                return stickyToken;
            }
            // Sticky account is no longer valid; re-assign.
            chatAccountMap.delete(chatId);
            logWarn(`Sticky account for chat ${chatId} unavailable, reassigning`);
        }
    }

    const selected = pickAccount(valid);
    const stats = getStats(selected.id);
    stats.lastUsedAt = now;
    stats.requestCount++;
    logInfo(`LB selected account: ${selected.id} (requestCount=${stats.requestCount})`);

    if (chatId) {
        chatAccountMap.set(chatId, { accountId: selected.id, assignedAt: now });
    }

    return selected;
}

/**
 * Explicitly bind a chatId to an account after chat creation.
 * Call this right after createChatV2 succeeds so subsequent messages in the
 * same conversation always land on the account that owns the Qwen chat.
 */
export function assignChatAccount(chatId, accountId) {
    if (chatId && accountId) {
        chatAccountMap.set(chatId, { accountId, assignedAt: Date.now() });
    }
}

/** Remove a chatId → account binding (e.g. on explicit new-chat). */
export function releaseChatAccount(chatId) {
    if (chatId) chatAccountMap.delete(chatId);
}

/** Return per-account request counts for the /status endpoint. */
export function getAccountUsageStats() {
    const result = {};
    for (const [id, stats] of accountStats.entries()) {
        result[id] = { requestCount: stats.requestCount, lastUsedAt: stats.lastUsedAt };
    }
    return result;
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
