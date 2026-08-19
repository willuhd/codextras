import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// In a compiled binary, import.meta.dir is a baked-in build-time path that
// does not exist at runtime; the codextras root is then the binary's own
// directory, so state/, logs/, codextras.json and relative apiKeyFile paths
// resolve next to the executable no matter where it is installed.
export function isCompiledBinary() {
  const execBase = path.basename(process.execPath || "");
  return execBase !== "bun" && execBase !== "bun.exe" && !/^bun[.-]/.test(execBase);
}

export const ROOT = path.resolve(
  isCompiledBinary() ? path.dirname(process.execPath) : path.join(import.meta.dir, ".."),
);
export const CONFIG_PATH =
  process.env.CODEXTRAS_CONFIG || path.join(ROOT, "codextras.json");
export const STATE_DIR = path.join(ROOT, "state");
export const SECRET_PATH = path.join(STATE_DIR, "secret");
export const LOG_PATH = path.join(ROOT, "logs", "codextras.log");
export const PID_PATH = path.join(STATE_DIR, "codextras.pid");

function loadJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function loadConfig() {
  const raw = loadJson(CONFIG_PATH);
  const gateway = raw.gateway || {};
  const port = Number(gateway.port ?? 4200);
  const pathPrefix = String(gateway.pathPrefix || "/_codextras").replace(/\/$/, "");
  return {
    gateway: { port, pathPrefix },
    providers: (Array.isArray(raw.providers) ? raw.providers : []).map((provider) => ({
      ...provider,
      // Relative apiKeyFile paths are resolved against the codextras root so
      // they work regardless of the gateway's working directory.
      apiKeyFile:
        provider &&
        typeof provider.apiKeyFile === "string" &&
        !path.isAbsolute(provider.apiKeyFile)
          ? path.resolve(ROOT, provider.apiKeyFile)
          : provider && provider.apiKeyFile,
    })),
    models: Array.isArray(raw.models) ? raw.models : [],
    catalogOverrides:
      raw.catalogOverrides && typeof raw.catalogOverrides === "object"
        ? raw.catalogOverrides
        : {},
  };
}

export function loadSecret() {
  if (existsSync(SECRET_PATH)) {
    return readFileSync(SECRET_PATH, "utf8").trim();
  }
  mkdirSync(STATE_DIR, { recursive: true });
  const secret = requireSecret();
  writeFileSync(SECRET_PATH, secret, { mode: 0o600 });
  return secret;
}

function requireSecret() {
  const bytes = new Uint8Array(24);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return Buffer.from(bytes).toString("base64url");
}

export function providerFor(model, config) {
  if (!model) return undefined;
  return config.providers.find((p) => p.id === model.provider);
}

export function findModel(alias, config) {
  if (typeof alias !== "string") return undefined;
  return config.models.find((m) => m.alias === alias);
}

export function effortFor(model, requested) {
  const levels = Array.isArray(model.efforts) && model.efforts.length ? model.efforts : ["low", "high", "max"];
  if (requested && levels.includes(requested)) return requested;
  return model.defaultEffort || levels[levels.length - 1] || "high";
}
