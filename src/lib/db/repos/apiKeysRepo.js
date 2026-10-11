import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { countKeyRequestsSince, sumKeySpendSince, oldestKeyTimestampSince } from "./usageRepo.js";
import { keyAccessFromColumns, keyAccessToColumns } from "@/shared/utils/keyAccess.js";
import { KEY_ACCESS_UNRESTRICTED } from "@/shared/constants/keyAccess.js";

// Sliding-window caps: '' / undefined / null = unlimited; anything else must be a
// finite number >= 0. Garbage is rejected, never silently treated as unlimited.
const LIMIT_FIELDS = ["limit5h", "limit7d", "limit30d"];
const LIMIT_MODES = ["count", "spend"];

function coerceLimit(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null; // blank input from the form = unlimited
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid ${field} limit`);
    return n;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`Invalid ${field} limit`);
  return value;
}

function coerceMode(value) {
  if (value === undefined || value === null) return "count";
  const mode = typeof value === "string" ? value.trim() : value;
  if (mode === "") return "count";
  if (!LIMIT_MODES.includes(mode)) throw new Error(`Invalid limitMode: ${value}`);
  return mode;
}

// Maps a partial limits patch to stored columns; validates before anything is written.
function limitsToColumns(data) {
  const cols = {};
  if (data.limitMode !== undefined) cols.limitMode = coerceMode(data.limitMode);
  for (const field of LIMIT_FIELDS) {
    if (data[field] !== undefined) cols[field] = coerceLimit(data[field], field);
  }
  return cols;
}

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt || null,
    limitMode: row.limitMode || "count",
    limit5h: row.limit5h ?? null,
    limit7d: row.limit7d ?? null,
    limit30d: row.limit30d ?? null,
    access: keyAccessFromColumns(row.accessRestricted, row.accessAllow),
  };
}

export async function getApiKeys() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  return rows.map(rowToKey);
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

// Used by the /v1 handlers to read the presented key's access settings.
export async function getApiKeyByKey(key) {
  if (!key) return null;
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE key = ?`, [key]);
  return rowToKey(row);
}

export async function createApiKey(name, machineId, expiresAt = null, limits = {}) {
  if (!machineId) throw new Error("machineId is required");
  let finalExpiresAt = expiresAt;
  let finalLimits = limits;
  if (expiresAt && typeof expiresAt === "object" && !(expiresAt instanceof Date)) {
    finalLimits = expiresAt;
    finalExpiresAt = null;
  }
  const limitCols = limitsToColumns(finalLimits); // validates before anything is generated
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);
  const apiKey = {
    id: uuidv4(),
    name,
    key: result.key,
    machineId,
    isActive: true,
    createdAt: new Date().toISOString(),
    expiresAt: finalExpiresAt || null,
    limitMode: limitCols.limitMode || "count",
    limit5h: limitCols.limit5h ?? null,
    limit7d: limitCols.limit7d ?? null,
    limit30d: limitCols.limit30d ?? null,
    access: { restricted: false, allow: [] },
  };
  const cols = keyAccessToColumns(KEY_ACCESS_UNRESTRICTED);
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, expiresAt, limitMode, limit5h, limit7d, limit30d, accessRestricted, accessAllow) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [apiKey.id, apiKey.key, apiKey.name, apiKey.machineId, 1, apiKey.createdAt, apiKey.expiresAt, apiKey.limitMode, apiKey.limit5h, apiKey.limit7d, apiKey.limit30d, cols.accessRestricted, cols.accessAllow]
  );
  return apiKey;
}

export async function updateApiKey(id, data) {
  const limitCols = limitsToColumns(data); // validates before opening the transaction
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    // Absent fields (explicit undefined) must not clobber stored values.
    const patch = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
    const merged = { ...rowToKey(row), ...patch, ...limitCols };
    const cols = keyAccessToColumns(merged.access);
    db.run(
      `UPDATE apiKeys SET key = ?, name = ?, machineId = ?, isActive = ?, expiresAt = ?, limitMode = ?, limit5h = ?, limit7d = ?, limit30d = ?, accessRestricted = ?, accessAllow = ? WHERE id = ?`,
      [merged.key, merged.name, merged.machineId, merged.isActive ? 1 : 0, merged.expiresAt || null, merged.limitMode, merged.limit5h ?? null, merged.limit7d ?? null, merged.limit30d ?? null, cols.accessRestricted, cols.accessAllow, id]
    );
    result = rowToKey(db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]));
  });
  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

export async function validateApiKey(key) {
  const db = await getAdapter();
  const row = db.get(`SELECT isActive, expiresAt FROM apiKeys WHERE key = ?`, [key]);
  if (!row) return false;
  if (row.isActive !== 1 && row.isActive !== true) return false;
  if (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) return false;
  return true;
}

// Sliding-window enforcement. validateApiKey stays a boolean (expiration only);
// this is its limit-checking sibling, called beside it at every /v1 gate.
const WINDOWS = [
  ["limit5h", 5 * 3600e3, "5h"],
  ["limit7d", 7 * 86400e3, "7d"],
  ["limit30d", 30 * 86400e3, "30d"],
];

/**
 * @returns {Promise<{ok: true} | {ok: false, window: string, limit: number, used?: number, spend: boolean}>}
 * Fail-open: an unreadable counter or key row allows the request (never throws).
 */
export async function getKeyLimitState(apiKey) {
  try {
    const db = await getAdapter();
    const row = db.get(`SELECT limitMode, limit5h, limit7d, limit30d FROM apiKeys WHERE key = ?`, [apiKey]);
    if (!row) return { ok: true };
    const spend = (row.limitMode || "count") === "spend"; // unknown values fail safe into count
    for (const [field, ms, label] of WINDOWS) {
      const limit = row[field];
      if (limit == null) continue; // NULL = unlimited
      const since = new Date(Date.now() - ms).toISOString();
      if (spend) {
        const used = await sumKeySpendSince(apiKey, since);
        if (used >= limit) return { ok: false, window: label, limit, used, spend: true };
      } else {
        const used = await countKeyRequestsSince(apiKey, since);
        if (used >= limit) return { ok: false, window: label, limit, used, spend: false };
      }
    }
    return { ok: true };
  } catch (e) {
    console.error("window limit check failed-open", e);
    return { ok: true };
  }
}

/**
 * Returns window usage metrics for an API key.
 * @param {string|object} keyOrRow Raw API key string or key row object
 * @returns {Promise<{id?: string, name?: string, limitMode: string, windows: Array<{window: string, limit: number, used: number, remaining: number, resetAt: string|null}>}>}
 */
export async function getKeyWindowUsage(keyOrRow) {
  const db = await getAdapter();
  let row = keyOrRow;
  let apiKey = keyOrRow?.key;
  if (typeof keyOrRow === "string") {
    apiKey = keyOrRow;
    row = db.get(`SELECT id, name, limitMode, limit5h, limit7d, limit30d FROM apiKeys WHERE key = ?`, [apiKey]);
  } else if (keyOrRow && !apiKey && keyOrRow.id) {
    const full = db.get(`SELECT key, id, name, limitMode, limit5h, limit7d, limit30d FROM apiKeys WHERE id = ?`, [keyOrRow.id]);
    if (full) {
      row = full;
      apiKey = full.key;
    }
  }
  if (!row) return { windows: [] };

  const mode = (row.limitMode || "count") === "spend" ? "spend" : "count";
  const windows = [];
  for (const [field, ms, label] of WINDOWS) {
    const limit = row[field];
    if (limit == null) continue;
    const since = new Date(Date.now() - ms).toISOString();
    let used = 0;
    if (mode === "spend") {
      used = await sumKeySpendSince(apiKey, since);
    } else {
      used = await countKeyRequestsSince(apiKey, since);
    }
    const minTs = await oldestKeyTimestampSince(apiKey, since);
    const resetAt = minTs ? new Date(new Date(minTs).getTime() + ms).toISOString() : null;
    const remaining = Math.max(0, mode === "spend" ? Number((limit - used).toFixed(4)) : limit - used);
    windows.push({
      window: label,
      limit,
      used,
      remaining,
      resetAt,
    });
  }
  return {
    id: row.id,
    name: row.name,
    limitMode: mode,
    windows,
  };
}

export async function getKeysWindowUsage(keyOrRow) {
  if (keyOrRow) {
    return getKeyWindowUsage(keyOrRow);
  }
  const keys = await getApiKeys();
  const results = [];
  for (const key of keys) {
    try {
      const u = await getKeyWindowUsage(key);
      results.push({
        id: key.id,
        name: key.name,
        limitMode: u.limitMode || "count", // normalized by singular; garbage fails safe to count
        windows: u.windows,
      });
    } catch (e) {
      console.error("getKeysWindowUsage failed for key", key.id, e);
      results.push({
        id: key.id,
        name: key.name,
        limitMode: key.limitMode || "count",
        windows: [],
      });
    }
  }
  return results;
}

export function limitStateMessage(state) {
  return state.spend
    ? `API key spend limit exceeded (${state.window}: max $${state.limit.toFixed(2)}, used $${state.used.toFixed(2)})`
    : `API key request limit exceeded (${state.window}: max ${state.limit} requests)`;
}
