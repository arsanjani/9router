import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { makeKv } from "../helpers/kvStore.js";

const pricingKv = makeKv("pricing");
const CACHE_TTL_MS = 5000;

let cache = { value: null, expiresAt: 0 };

function invalidate() {
  cache = { value: null, expiresAt: 0 };
}

async function getUserPricing() {
  return await pricingKv.getAll();
}

export function getCanonicalProvider(modelId) {
  if (!modelId) return "misc";
  const lower = String(modelId).toLowerCase();
  if (lower.startsWith("claude-")) return "anthropic";
  if (lower.startsWith("gpt-") || lower.startsWith("o1") || lower.startsWith("o3") || lower.startsWith("o4")) return "openai";
  if (lower.startsWith("gemini-")) return "gemini";
  if (lower.startsWith("deepseek-")) return "deepseek";
  if (lower.startsWith("qwen")) return "qwen";
  if (lower.startsWith("kimi-") || lower === "k3") return "kimi";
  if (lower.startsWith("glm-")) return "glm";
  if (lower.startsWith("minimax-")) return "minimax";
  if (lower.startsWith("grok-")) return "xai";
  if (lower.startsWith("muse-")) return "muse";
  if (lower === "auto") return "openrouter";
  if (lower.includes("/")) return lower.split("/")[0];
  return "misc";
}

export async function getPricing() {
  const now = Date.now();
  if (cache.value && cache.expiresAt > now) return cache.value;

  const userPricing = await getUserPricing();
  const { PROVIDER_PRICING, MODEL_PRICING } = await import("open-sse/providers/pricing.js");
  const merged = {};

  // 1. Canonical models grouped by canonical provider (gemini, anthropic, openai, etc.)
  if (MODEL_PRICING) {
    for (const [model, pricing] of Object.entries(MODEL_PRICING)) {
      const provider = getCanonicalProvider(model);
      merged[provider] ||= {};
      merged[provider][model] = { ...pricing };
    }
  }

  // 2. Provider-specific overrides (e.g. gh, tokenrouter)
  for (const [provider, models] of Object.entries(PROVIDER_PRICING || {})) {
    merged[provider] ||= {};
    for (const [model, pricing] of Object.entries(models)) {
      merged[provider][model] = { ...pricing };
    }
  }

  // 3. User pricing overlays
  for (const [provider, models] of Object.entries(userPricing || {})) {
    merged[provider] ||= {};
    for (const [model, pricing] of Object.entries(models)) {
      merged[provider][model] = merged[provider][model]
        ? { ...merged[provider][model], ...pricing }
        : pricing;
    }
  }

  cache = { value: merged, expiresAt: now + CACHE_TTL_MS };
  return merged;
}

export async function getPricingForModel(provider, model) {
  if (!model) return null;
  const userPricing = await getUserPricing();
  if (provider && userPricing[provider]?.[model]) return userPricing[provider][model];

  const canonical = getCanonicalProvider(model);
  if (canonical && userPricing[canonical]?.[model]) return userPricing[canonical][model];
  if (userPricing["global"]?.[model] || userPricing["*"]?.[model]) {
    return userPricing["global"]?.[model] || userPricing["*"]?.[model];
  }

  const { getPricingForModel: resolveConst } = await import("open-sse/providers/pricing.js");
  return resolveConst(provider, model);
}

// Atomic merge inside transaction (per-provider read-modify-write)
export async function updatePricing(pricingData) {
  const db = await getAdapter();
  db.transaction(() => {
    for (const [provider, models] of Object.entries(pricingData)) {
      const row = db.get(`SELECT value FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
      const current = row ? (parseJson(row.value, {}) || {}) : {};
      const merged = { ...current };
      for (const [model, pricing] of Object.entries(models)) {
        merged[model] = pricing;
      }
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES('pricing', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [provider, stringifyJson(merged)]
      );
    }
  });
  invalidate();
  return await getUserPricing();
}

export async function resetPricing(provider, model) {
  if (!provider) return await getUserPricing();
  const db = await getAdapter();
  db.transaction(() => {
    if (!model) {
      db.run(`DELETE FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
      return;
    }
    const row = db.get(`SELECT value FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
    const current = row ? (parseJson(row.value, {}) || {}) : {};
    delete current[model];
    if (Object.keys(current).length === 0) {
      db.run(`DELETE FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
    } else {
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES('pricing', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [provider, stringifyJson(current)]
      );
    }
  });
  invalidate();
  return await getUserPricing();
}

export async function resetAllPricing() {
  await pricingKv.clear();
  invalidate();
  return {};
}
