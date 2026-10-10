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

// ---------------------------------------------------------------------------
// Task 3: enforcement at the validation gate (429, fail-open) + Task 1's
// data-quality matrix (cost > 0 / cached_tokens survive per provider shape).
// ---------------------------------------------------------------------------

let restoreFns = [];

// Windows keeps SQLite files locked: close the previous adapter before swapping DATA_DIR.
function resetAdapter() {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  vi.resetModules();
}

async function bootGate() {
  writeV2Db(tempDir);
  resetAdapter();
  const db = await import("@/lib/db/index.js");
  const { getAdapter } = await import("@/lib/db/driver.js");
  const adapter = await getAdapter();
  vi.spyOn(console, "error").mockImplementation(() => {});

  let now = new Date("2026-10-10T12:00:00.000Z").getTime();
  const realNow = Date.now;
  Date.now = () => now;
  restoreFns.push(() => { Date.now = realNow; });

  const repo = await import("@/lib/db/repos/apiKeysRepo.js");
  const usage = await import("@/lib/db/repos/usageRepo.js");
  const gate = async (apiKey) => repo.getKeyLimitState(apiKey);

  // Direct inserts: how a row's cost is produced is the data-quality matrix's
  // job; these tests only check the gate's read of it.
  const seed = (apiKey, { count = 0, cost = 0, ageMs = 0 } = {}) => {
    const at = new Date(Date.now() - ageMs).toISOString();
    for (let i = 0; i < count; i++) {
      adapter.run(
        `INSERT INTO usageHistory(timestamp, provider, model, apiKey, cost, status) VALUES(?, ?, ?, ?, ?, ?)`,
        [at, null, "seed", apiKey, cost, "ok"]
      );
    }
  };
  const advanceTime = (ms) => { now += ms; };

  return { db, adapter, usage, gate, seed, advanceTime };
}

afterEach(() => {
  for (const fn of restoreFns.splice(0)) {
    try { fn(); } catch {}
  }
  vi.restoreAllMocks();
});

describe("window-limit enforcement at the key gate", () => {
  it("count mode allows up to the cap, then blocks with the window and max", async () => {
    const { db, gate, seed } = await bootGate();
    const k = await db.createApiKey("rl", "m", null, { limitMode: "count", limit5h: 2 });

    expect((await gate(k.key)).ok).toBe(true); // 0 used
    seed(k.key, { count: 1 });
    expect((await gate(k.key)).ok).toBe(true); // 1 used < 2

    seed(k.key, { count: 1 });
    const state = await gate(k.key); // 2 used >= 2 → N+1th request
    expect(state.ok).toBe(false);
    expect(state.window).toBe("5h");
    expect(state.spend).toBe(false);

    const { limitStateMessage } = await import("@/lib/db/repos/apiKeysRepo.js");
    const msg = limitStateMessage(state);
    expect(msg).toMatch(/5h/);
    expect(msg).toMatch(/max 2 requests/);
    expect(msg).not.toContain(k.key);
  });

  it("spend mode blocks when SUM(cost) reaches the dollar cap, naming window, max and used", async () => {
    const { db, gate, seed } = await bootGate();
    const k = await db.createApiKey("sp", "m", null, { limitMode: "spend", limit7d: 0.01 });
    seed(k.key, { count: 2, cost: 0.006 });

    const state = await gate(k.key);
    expect(state.ok).toBe(false);
    expect(state.window).toBe("7d");
    expect(state.spend).toBe(true);
    expect(state.limit).toBe(0.01);
    expect(state.used).toBeCloseTo(0.012, 12);

    const { limitStateMessage } = await import("@/lib/db/repos/apiKeysRepo.js");
    const msg = limitStateMessage(state);
    expect(msg).toMatch(/7d/);
    expect(msg).toMatch(/max \$0\.01/);
    expect(msg).toMatch(/used \$0\.01/);
    expect(msg).not.toContain(k.key);
  });

  it("an unknown stored mode fails safe into count mode", async () => {
    const { db, adapter, gate, seed } = await bootGate();
    const k = await db.createApiKey("odd", "m", null, { limitMode: "count", limit5h: 1 });
    adapter.run(`UPDATE apiKeys SET limitMode = 'weighted' WHERE id = ?`, [k.id]); // legacy/foreign value

    expect((await gate(k.key)).ok).toBe(true);
    seed(k.key, { count: 1, cost: 5 }); // spend-mode would be under any sane cap; count-mode is not
    const state = await gate(k.key);
    expect(state.ok).toBe(false);
    expect(state.spend).toBe(false);
  });

  it("a NULL window never blocks; other keys are unaffected; the window slides", async () => {
    const { db, gate, seed, advanceTime } = await bootGate();
    const limited = await db.createApiKey("limited", "m", null, { limitMode: "count", limit5h: 2 });
    const unlimited = await db.createApiKey("unlimited", "m");
    const spend = await db.createApiKey("spend", "m", null, { limitMode: "spend", limit7d: 0.01 });

    seed(limited.key, { count: 2 });
    expect((await gate(limited.key)).ok).toBe(false);
    expect((await gate(unlimited.key)).ok).toBe(true); // all windows NULL → unlimited
    expect((await gate(spend.key)).ok).toBe(true); // no rows of its own

    advanceTime(5 * 3600 * 1000 + 1); // old rows fall out of the 5h window
    expect((await gate(limited.key)).ok).toBe(true);
  });

  it("a counter failure allows the request (fail-open) and logs", async () => {
    const { db, adapter, gate } = await bootGate();
    const k = await db.createApiKey("broken", "m", null, { limitMode: "count", limit5h: 0 });
    expect((await gate(k.key)).ok).toBe(false); // cap 0 blocks while the counter works

    // Break only the counter query; the key row still reads fine.
    const origGet = adapter.get;
    adapter.get = (sql, params) => {
      if (sql.includes("usageHistory")) throw new Error("counter unavailable");
      return origGet.call(adapter, sql, params);
    };
    try {
      expect((await gate(k.key)).ok).toBe(true);
    } finally {
      adapter.get = origGet;
    }
    expect(console.error).toHaveBeenCalled();
  });

  it("keeps validateApiKey's boolean contract while over limit", async () => {
    const { db, seed } = await bootGate();
    const k = await db.createApiKey("contract", "m", null, { limitMode: "count", limit5h: 1 });
    seed(k.key, { count: 1 });
    expect(await db.validateApiKey(k.key)).toBe(true); // enforcement lives in the new sibling
  });
});

describe("usageRepo window queries", () => {
  it("counts requests and sums spend per key since an ISO timestamp", async () => {
    const { adapter, usage, seed } = await bootGate();
    seed("sk-a", { count: 2, cost: 0.02 });
    seed("sk-a", { count: 1, cost: 0.01, ageMs: 6 * 3600 * 1000 }); // outside a 5h window
    seed("sk-b", { count: 1, cost: 0.5 });

    const since5h = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
    expect(await usage.countKeyRequestsSince("sk-a", since5h)).toBe(2);
    expect(await usage.sumKeySpendSince("sk-a", since5h)).toBeCloseTo(0.04, 12);
    expect(await usage.countKeyRequestsSince("sk-b", since5h)).toBe(1);
    expect(await usage.countKeyRequestsSince("sk-none", since5h)).toBe(0);
    expect(await usage.sumKeySpendSince("sk-none", since5h)).toBe(0);
    expect(adapter.all(`SELECT COUNT(*) AS n FROM usageHistory`)[0].n).toBe(4);
  });
});

describe("every /v1 validation gate returns 429 with the same message shape", () => {
  const auth = (k) => ({ Authorization: `Bearer ${k}` });
  const post = (path, body, k) => new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth(k) },
    body: JSON.stringify(body),
  });

  async function bootHandlers() {
    writeV2Db(tempDir);
    resetAdapter();
    const db = await import("@/lib/db/index.js");
    const { getAdapter } = await import("@/lib/db/driver.js");
    const adapter = await getAdapter();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { handleChat } = await import("@/sse/handlers/chat.js");
    const { handleEmbeddings } = await import("@/sse/handlers/embeddings.js");
    const { handleImageGeneration } = await import("@/sse/handlers/imageGeneration.js");
    const { handleTts } = await import("@/sse/handlers/tts.js");
    const { handleStt } = await import("@/sse/handlers/stt.js");
    const { handleSystemone } = await import("@/sse/handlers/systemone.js");
    const { handleVideoCreate } = await import("@/sse/handlers/videoGeneration.js");
    const { handleFetch } = await import("@/sse/handlers/fetch.js");
    const { handleSearch } = await import("@/sse/handlers/search.js");
    const geminiRoute = await import("../../src/app/api/v1beta/models/[...path]/route.js");
    return { db, adapter, handleChat, handleEmbeddings, handleImageGeneration, handleTts, handleStt, handleSystemone, handleVideoCreate, handleFetch, handleSearch, geminiRoute };
  }

  const seedFor = (adapter, apiKey) => adapter.run(
    `INSERT INTO usageHistory(timestamp, provider, model, apiKey, cost, status) VALUES(?, ?, ?, ?, ?, ?)`,
    [new Date().toISOString(), null, "seed", apiKey, 0.001, "ok"]
  );

  it("blocks chat plus every media handler at the auth gate", async () => {
    const h = await bootHandlers();
    const k = await h.db.createApiKey("wired", "m", null, { limitMode: "count", limit5h: 1 });
    await seedFor(h.adapter, k.key);

    const fd = new FormData();
    fd.set("model", "openai/whisper-1");
    fd.set("file", new Blob([new Uint8Array(4)], { type: "audio/wav" }), "a.wav");

    const calls = [
      ["chat", () => h.handleChat(post("/v1/chat/completions", { model: "openai/model-a", messages: [{ role: "user", content: "hi" }] }, k.key))],
      ["embeddings", () => h.handleEmbeddings(post("/v1/embeddings", { model: "openai/text-embedding-3-small", input: "x" }, k.key))],
      ["image", () => h.handleImageGeneration(post("/v1/images/generations", { model: "openai/dall-e-3", prompt: "x" }, k.key))],
      ["tts", () => h.handleTts(post("/v1/audio/speech", { model: "openai/tts-1", input: "x" }, k.key))],
      ["stt", () => h.handleStt(new Request("http://localhost/v1/audio/transcriptions", { method: "POST", headers: auth(k.key), body: fd }))],
      ["systemone", () => h.handleSystemone(post("/v1/systemone", { model: "openai/gpt-4o", state: {}, questions: { q: "?" } }, k.key))],
      ["video", () => h.handleVideoCreate(post("/v1/videos/generations", { model: "xai/grok-imagine-video", prompt: "x" }, k.key), "generations")],
      ["fetch", () => h.handleFetch(post("/v1/web/fetch", { model: "tavily", url: "https://example.com" }, k.key))],
      ["search", () => h.handleSearch(post("/v1/search", { model: "tavily", query: "x" }, k.key))],
      ["gemini-native", () => h.geminiRoute.POST(
        new Request("http://localhost/v1beta/models/gemini-2.5-flash-preview-tts:generateContent", {
          method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": k.key },
          body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }], generationConfig: { responseModalities: ["AUDIO"] } }),
        }),
        { params: Promise.resolve({ path: ["gemini-2.5-flash-preview-tts:generateContent"] }) },
      )],
    ];

    for (const [name, call] of calls) {
      const res = await call();
      expect(res.status, `${name} status`).toBe(429);
      const body = await res.json();
      const message = body.error?.message ?? body.error;
      expect(message, name).toBe("API key request limit exceeded (5h: max 1 requests)");
      expect(JSON.stringify(body), `${name} leaks the key`).not.toContain(k.key);    }
  });

  it("lets a key below its cap through to normal processing", async () => {
    const h = await bootHandlers();
    const k = await h.db.createApiKey("roomy", "m", null, { limitMode: "count", limit5h: 10 });
    await seedFor(h.adapter, k.key);

    const res = await h.handleChat(post("/v1/chat/completions", { model: "openai/model-a", messages: [{ role: "user", content: "hi" }] }, k.key));
    expect(res.status).not.toBe(429);
    expect(res.status).not.toBe(401);
  });
});

// Task 1 Step 3: the matrix that gates spend mode. Each shape is the real
// extraction path for a provider response → canonicalizeUsage → saveRequestUsage
// → read back, asserting cost > 0 (spend mode counts the request) and that
// cached_tokens survives where the provider reports cache reads.
describe("data quality: cost and cached_tokens survive per provider shape", () => {
  async function readBack(shape) {
    writeV2Db(tempDir);
    resetAdapter();
    const db = await import("@/lib/db/index.js");
    const { canonicalizeUsage, extractUsage, mergeUsage, estimateUsage } = await import("../../open-sse/utils/usageTracking.js");
    const { extractUsageFromResponse } = await import("open-sse/handlers/chatCore/requestDetail.js");
    const { FORMATS } = await import("../../open-sse/translator/formats.js");
    const usageRepo = await import("@/lib/db/repos/usageRepo.js");

    const apiKey = `sk-shape-${shape.name}`;
    const save = (canonical, provider, model) => db.saveRequestUsage({
      provider, model, apiKey, tokens: canonical, endpoint: "/v1/chat/completions", status: "ok",
    });

    switch (shape.name) {
      case "claude-stream": {
        // Anthropic splits usage across SSE events; callers merge them.
        let u = null;
        u = mergeUsage(u, extractUsage({ type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 200, cache_creation_input_tokens: 30 } } }));
        u = mergeUsage(u, extractUsage({ type: "message_delta", usage: { output_tokens: 50 } }));
        await save(canonicalizeUsage(u), "anthropic", "claude-sonnet-4-6");
        break;
      }
      case "claude-single": {
        const u = extractUsageFromResponse({ usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 200, cache_creation_input_tokens: 30 } });
        await save(canonicalizeUsage(u), "anthropic", "claude-haiku-4-5-20251001");
        break;
      }
      case "openai-nested-cache": {
        const u = extractUsageFromResponse({ usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 600 } } });
        await save(canonicalizeUsage(u), "openai", "gpt-4o");
        break;
      }
      case "gemini": {
        const u = extractUsageFromResponse({ usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 200, cachedContentTokenCount: 300 } });
        await save(canonicalizeUsage(u), "gemini", "gemini-2.5-flash");
        break;
      }
      case "ollama": {
        const u = extractUsage({ model: "qwen3.5-9b", done: true, prompt_eval_count: 1000, eval_count: 200, prompt_eval_cached_count: 300 });
        await save(canonicalizeUsage(u), "ollama", "qwen3.5-9b");
        break;
      }
      case "estimated": {
        const body = { messages: [{ role: "user", content: "x".repeat(400) }] };
        const u = estimateUsage(body, 400, FORMATS.OPENAI);
        await save(canonicalizeUsage(u), "openai", "gpt-4o-mini");
        break;
      }
      default: throw new Error(`unknown shape ${shape.name}`);
    }

    const rows = await db.getUsageHistory({ model: shape.model });
    const since = new Date(Date.now() - 60 * 1000).toISOString();
    return { row: rows[rows.length - 1], spend: await usageRepo.sumKeySpendSince(apiKey, since) };
  }

  const shapes = [
    { name: "claude-stream", model: "claude-sonnet-4-6", cache: true },
    { name: "claude-single", model: "claude-haiku-4-5-20251001", cache: true },
    { name: "openai-nested-cache", model: "gpt-4o", cache: true },
    { name: "gemini", model: "gemini-2.5-flash", cache: true },
    { name: "ollama", model: "qwen3.5-9b", cache: true },
    { name: "estimated", model: "gpt-4o-mini", cache: false },
  ];

  it.each(shapes)("$name: cost > 0 and cache counted only when reported", async (shape) => {
    const { row, spend } = await readBack(shape);
    expect(row, shape.name).toBeTruthy();
    expect(row.cost, shape.name).toBeGreaterThan(0);
    expect(spend, shape.name).toBeGreaterThan(0); // spend mode sees it
    if (shape.cache) {
      expect(row.tokens.cached_tokens, shape.name).toBeGreaterThan(0);
    } else {
      expect(row.tokens.prompt_tokens, shape.name).toBeGreaterThan(0);
    }
  });
});
