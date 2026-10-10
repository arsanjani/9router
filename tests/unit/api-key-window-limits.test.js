// Window limits (limitMode + 5h/7d/30d caps): schema migration + repo passthrough.
// Mirrors api-key-expiration.test.js — boots a pre-limit DB and reads it back.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

function writeV2Db(dir) {
  fs.mkdirSync(path.join(dir, "db"), { recursive: true });
  const db = new DatabaseSync(path.join(dir, "db", "data.sqlite"));
  db.exec(`CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.exec(`INSERT INTO _meta(key, value) VALUES ('schemaVersion', '2'), ('backupSchemaVersion', '2')`);
  db.exec(`CREATE TABLE apiKeys (
    id TEXT PRIMARY KEY,
    key TEXT UNIQUE NOT NULL,
    name TEXT,
    machineId TEXT,
    isActive INTEGER DEFAULT 1,
    createdAt TEXT NOT NULL,
    accessRestricted INTEGER DEFAULT 0,
    accessAllow TEXT
  )`);
  const ins = db.prepare(`INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, accessRestricted, accessAllow) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  ins.run("k1", "sk-existing-one", "Existing Key", "m", 1, "2026-09-01T00:00:00.000Z", 0, null);
  db.close();
}

async function boot() {
  delete global._dbAdapter;
  vi.resetModules();
  const db = await import("@/lib/db/index.js");
  const { getAdapter } = await import("@/lib/db/driver.js");
  return { db, adapter: await getAdapter() };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-key-limits-"));
  process.env.DATA_DIR = tempDir;
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("API key window limits: migration and repository behavior", () => {
  it("migrates existing keys to NULL limits + count mode (unlimited, unchanged)", async () => {
    writeV2Db(tempDir);
    const { db, adapter } = await boot();

    const cols = adapter.all(`PRAGMA table_info(apiKeys)`).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["limitMode", "limit5h", "limit7d", "limit30d"]));

    const idx = adapter.all(`PRAGMA index_list(usageHistory)`).map((i) => i.name);
    expect(idx).toContain("idx_uh_apikey_ts");

    const key = await db.getApiKeyById("k1");
    expect(key.limitMode).toBe("count");
    expect(key.limit5h).toBeNull();
    expect(key.limit7d).toBeNull();
    expect(key.limit30d).toBeNull();

    const byKey = await db.getApiKeyByKey("sk-existing-one");
    expect(byKey.limitMode).toBe("count");
    expect(byKey.limit5h).toBeNull();
  });

  it("creates keys with mode + caps; empty/undefined coerce to null", async () => {
    writeV2Db(tempDir);
    const { db } = await boot();

    const spend = await db.createApiKey("Spend Key", "m", null, { limitMode: "spend", limit5h: 2.5, limit7d: "", limit30d: null });
    expect(spend.limitMode).toBe("spend");
    expect(spend.limit5h).toBe(2.5);
    expect(spend.limit7d).toBeNull();
    expect(spend.limit30d).toBeNull();

    const read = await db.getApiKeyById(spend.id);
    expect(read.limitMode).toBe("spend");
    expect(read.limit5h).toBe(2.5);
    expect(read.limit7d).toBeNull();

    // No limits argument at all → count mode, unlimited (today's behavior).
    const bare = await db.createApiKey("Bare Key", "m");
    expect(bare.limitMode).toBe("count");
    expect(bare.limit5h).toBeNull();
    expect(bare.limit7d).toBeNull();
    expect(bare.limit30d).toBeNull();

    const blank = await db.createApiKey("Blank Key", "m", null, { limitMode: "", limit5h: undefined, limit7d: "", limit30d: "   " });
    expect(blank.limitMode).toBe("count");
    expect(blank.limit5h).toBeNull();
    expect(blank.limit7d).toBeNull();
    expect(blank.limit30d).toBeNull();
  });

  it("updates mode + caps, preserves untouched windows, clears with empty", async () => {
    writeV2Db(tempDir);
    const { db } = await boot();

    const set = await db.updateApiKey("k1", { limitMode: "spend", limit5h: 1.5, limit30d: 10 });
    expect(set.limitMode).toBe("spend");
    expect(set.limit5h).toBe(1.5);
    expect(set.limit30d).toBe(10);
    expect(set.limit7d).toBeNull();

    const cleared = await db.updateApiKey("k1", { limit5h: "" });
    expect(cleared.limit5h).toBeNull();
    expect(cleared.limit30d).toBe(10); // untouched field preserved
    expect(cleared.limitMode).toBe("spend");

    const toCount = await db.updateApiKey("k1", { limitMode: "count", limit7d: 500 });
    expect(toCount.limitMode).toBe("count");
    expect(toCount.limit7d).toBe(500);
    expect(toCount.limit30d).toBe(10);

    // Explicit undefined (a route forwarding an absent field) changes nothing.
    const untouched = await db.updateApiKey("k1", { limitMode: undefined, limit5h: undefined });
    expect(untouched.limitMode).toBe("count");
    expect(untouched.limit5h).toBeNull();
    expect(untouched.limit7d).toBe(500);
    expect(untouched.limit30d).toBe(10);
  });

  it("rejects unknown mode, negative and non-numeric caps without writing", async () => {
    writeV2Db(tempDir);
    const { db } = await boot();

    await expect(db.createApiKey("Bad Mode", "m", null, { limitMode: "points" })).rejects.toThrow(/limitMode/i);
    await expect(db.createApiKey("Negative", "m", null, { limit5h: -1 })).rejects.toThrow();
    await expect(db.createApiKey("Non Numeric", "m", null, { limit7d: "abc" })).rejects.toThrow();
    await expect(db.createApiKey("Garbage Type", "m", null, { limit30d: [] })).rejects.toThrow();
    await expect(db.createApiKey("NaN", "m", null, { limit5h: NaN })).rejects.toThrow();
    expect(await db.getApiKeys()).toHaveLength(1); // only the pre-existing key

    await expect(db.updateApiKey("k1", { limitMode: "weighted" })).rejects.toThrow(/limitMode/i);
    await expect(db.updateApiKey("k1", { limit30d: -0.5 })).rejects.toThrow();
    await expect(db.updateApiKey("k1", { limit5h: "abc" })).rejects.toThrow();
    await expect(db.updateApiKey("k1", { limit7d: {} })).rejects.toThrow();

    const after = await db.getApiKeyById("k1");
    expect(after.limitMode).toBe("count");
    expect(after.limit5h).toBeNull();
    expect(after.limit30d).toBeNull();
  });

  it("leaves validateApiKey boolean and limit-agnostic (enforcement lives elsewhere)", async () => {
    writeV2Db(tempDir);
    const { db } = await boot();

    const k = await db.createApiKey("Limited", "m", null, { limitMode: "count", limit5h: 0 });
    expect(await db.validateApiKey(k.key)).toBe(true);
    expect(await db.validateApiKey("sk-unknown")).toBe(false);
  });
});
