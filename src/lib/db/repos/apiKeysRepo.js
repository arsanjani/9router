import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { countKeyRequestsSince, sumKeySpendSince } from "./usageRepo.js";
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

export async function createApiKey(name, machineId, limitsOrExpires = {}, maybeLimits = {}) {
  if (!machineId) throw new Error("machineId is required");
  const limits = (limitsOrExpires && typeof limitsOrExpires === "object")
    ? limitsOrExpires
    : (maybeLimits && typeof maybeLimits === "object" ? maybeLimits : {});
  const limitCols = limitsToColumns(limits); // validates before anything is generated
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
    limitMode: limitCols.limitMode || "count",
    limit5h: limitCols.limit5h ?? null,
    limit7d: limitCols.limit7d ?? null,
    limit30d: limitCols.limit30d ?? null,
    access: { restricted: false, allow: [] },
  };
  const cols = keyAccessToColumns(KEY_ACCESS_UNRESTRICTED);
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, limitMode, limit5h, limit7d, limit30d, accessRestricted, accessAllow) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [apiKey.id, apiKey.key, apiKey.name, apiKey.machineId, 1, apiKey.createdAt, apiKey.limitMode, apiKey.limit5h, apiKey.limit7d, apiKey.limit30d, cols.accessRestricted, cols.accessAllow]
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
      `UPDATE apiKeys SET key = ?, name = ?, machineId = ?, isActive = ?, limitMode = ?, limit5h = ?, limit7d = ?, limit30d = ?, accessRestricted = ?, accessAllow = ? WHERE id = ?`,
      [merged.key, merged.name, merged.machineId, merged.isActive ? 1 : 0, merged.limitMode, merged.limit5h ?? null, merged.limit7d ?? null, merged.limit30d ?? null, cols.accessRestricted, cols.accessAllow, id]
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
  const row = db.get(`SELECT isActive FROM apiKeys WHERE key = ?`, [key]);
  if (!row) return false;
  return row.isActive === 1 || row.isActive === true;
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
      } else if (await countKeyRequestsSince(apiKey, since) >= limit) {
        return { ok: false, window: label, limit, spend: false };
      }
    }
    return { ok: true };
  } catch (e) {
    console.error("window limit check failed-open", e);
    return { ok: true };
  }
}

export function limitStateMessage(state) {
  return state.spend
    ? `API key spend limit exceeded (${state.window}: max $${state.limit.toFixed(2)}, used $${state.used.toFixed(2)})`
    : `API key request limit exceeded (${state.window}: max ${state.limit} requests)`;
}
