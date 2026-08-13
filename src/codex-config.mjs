import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { STATE_DIR } from "./config.mjs";

export const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
export const CONFIG_PATH = path.join(CODEX_HOME, "config.toml");
export const BACKUP_PATH = path.join(CODEX_HOME, "config.toml.pre-codextras");
export const MERGED_CATALOG_PATH = path.join(STATE_DIR, "merged-models.json");

const START_MARKER = "# BEGIN codextras-managed";
const END_MARKER = "# END codextras-managed";

const MARKER_LINES = new Set([
  "# BEGIN codex-router-managed",
  "# END codex-router-managed",
  "# BEGIN codex-router-provider-managed",
  "# END codex-router-provider-managed",
  "# BEGIN codex-router-agent-concurrency-managed",
  "# END codex-router-agent-concurrency-managed",
  "# BEGIN codex-router-multi-agent-v2-managed",
  "# END codex-router-multi-agent-v2-managed",
  START_MARKER,
  END_MARKER,
]);

const MANAGED_ROOT_KEYS = /^(openai_base_url|model_catalog_json|service_tier|model)\s*=/;
const ROUTER_PROVIDER_TABLE = /^\[model_providers\.codex-router\]$/;

export function routerBaseUrl(config, secret) {
  return (
    "http://127.0.0.1:" +
    config.gateway.port +
    config.gateway.pathPrefix +
    "/" +
    secret +
    "/v1"
  );
}

// Remove only router/codextras-managed lines: markers, the managed root keys,
// and the [model_providers.codex-router] table (header + its three keys).
// Everything else in the user's config.toml is preserved verbatim. The
// router's own managed block in real installs can lack an END marker, so this
// must not depend on marker pairs.
function cleanManagedLines(text) {
  const lines = String(text || "").split("\n");
  const out = [];
  let inRouterProviderTable = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (MARKER_LINES.has(trimmed)) continue;
    if (ROUTER_PROVIDER_TABLE.test(trimmed)) {
      inRouterProviderTable = true;
      continue;
    }
    if (inRouterProviderTable) {
      if (trimmed === "" || trimmed.startsWith("[")) {
        inRouterProviderTable = false;
        out.push(line);
      }
      continue;
    }
    if (MANAGED_ROOT_KEYS.test(trimmed) && !trimmed.startsWith("[")) continue;
    out.push(line);
  }
  return out.join("\n");
}

export function renderManagedConfig(current, { baseUrl, catalogPath, modelAlias }) {
  const text = cleanManagedLines(current).replace(/\s+$/, "");
  const block = [
    START_MARKER,
    "openai_base_url = " + JSON.stringify(baseUrl),
    "model_catalog_json = " + JSON.stringify(catalogPath),
    ...(modelAlias ? ["model = " + JSON.stringify(modelAlias)] : []),
    END_MARKER,
  ].join("\n");
  return block + (text ? "\n\n" + text : "") + "\n";
}

export function dryRunConfig(config, secret, modelAlias) {
  const current = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : "";
  return renderManagedConfig(current, {
    baseUrl: routerBaseUrl(config, secret),
    catalogPath: MERGED_CATALOG_PATH,
    modelAlias,
  });
}

export function applyConfig(config, secret, modelAlias) {
  const current = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : "";
  if (existsSync(CONFIG_PATH) && !existsSync(BACKUP_PATH)) {
    copyFileSync(CONFIG_PATH, BACKUP_PATH);
  }
  const next = renderManagedConfig(current, {
    baseUrl: routerBaseUrl(config, secret),
    catalogPath: MERGED_CATALOG_PATH,
    modelAlias,
  });
  mkdirSync(path.dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  const temporary = CONFIG_PATH + ".tmp." + process.pid;
  writeFileSync(temporary, next, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, CONFIG_PATH);
  return { path: CONFIG_PATH, backup: BACKUP_PATH };
}

export function restoreConfig() {
  if (!existsSync(BACKUP_PATH)) {
    throw new Error("No backup at " + BACKUP_PATH);
  }
  copyFileSync(BACKUP_PATH, CONFIG_PATH);
  return BACKUP_PATH;
}
