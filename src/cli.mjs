import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  LOG_PATH,
  PID_PATH,
  STATE_DIR,
  findModel,
  isCompiledBinary,
  loadConfig,
  loadSecret,
  providerFor,
} from "./config.mjs";
import { catalogFor, createServer } from "./server.mjs";
import {
  cacheNativeCatalog,
  captureNativeCatalog,
  writeMergedCatalog,
} from "./catalog.mjs";
import {
  applyConfig,
  dryRunConfig,
  restoreConfig,
  MERGED_CATALOG_PATH,
} from "./codex-config.mjs";

function readPid() {
  if (!existsSync(PID_PATH)) return undefined;
  const pid = Number(String(readFileSync(PID_PATH, "utf8")).trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Compiled: the binary re-executes itself. Source: re-run this file via bun so
// the daemon works in both modes.
function serverCommand() {
  if (isCompiledBinary()) {
    return { command: process.execPath, args: ["server"] };
  }
  return { command: process.execPath, args: ["run", import.meta.filename, "server"] };
}

function cmdStart() {
  const pid = readPid();
  if (pid && isAlive(pid)) {
    console.log(`codextras already running (pid ${pid})`);
    return;
  }
  mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  const fd = openSync(LOG_PATH, "a");
  const { command, args } = serverCommand();
  const child = spawn(command, args, {
    stdio: ["ignore", fd, fd],
    detached: true,
  });
  child.unref();
  closeSync(fd);
  child.on("error", (error) => {
    console.error("failed to start: " + (error && error.message ? error.message : error));
  });
  if (child.pid) {
    writeFileSync(PID_PATH, String(child.pid), { mode: 0o600 });
  }
  console.log(`codextras started (pid ${child.pid}); log: ${LOG_PATH}`);
}

function cmdStop() {
  const pid = readPid();
  if (!pid || !isAlive(pid)) {
    console.log("codextras not running");
    return;
  }
  try {
    process.kill(pid);
  } catch {
    // Process is already gone; the pidfile cleanup below still runs.
  }
  unlinkSync(PID_PATH);
  console.log("codextras stopped");
}

function cmdStatus() {
  const pid = readPid();
  if (pid && isAlive(pid)) {
    console.log(`running (pid ${pid})`);
    return;
  }
  console.log("not running");
  process.exitCode = 1;
}

function cmdCatalog() {
  console.log(JSON.stringify(catalogFor(loadConfig()), null, 2));
}

function cmdCatalogMerged(target) {
  const config = loadConfig();
  const native = captureNativeCatalog();
  cacheNativeCatalog(native);
  const resolved = target || MERGED_CATALOG_PATH;
  writeMergedCatalog(config, resolved);
  console.log(
    JSON.stringify({
      path: resolved,
      nativeModels: Array.isArray(native.models) ? native.models.length : 0,
      declaredModels: config.models.length,
    }),
  );
}

function cmdDryRun(alias) {
  const config = loadConfig();
  const resolved = alias || (config.models[0] && config.models[0].alias);
  process.stdout.write(dryRunConfig(config, loadSecret(), resolved));
}

function cmdApply(alias) {
  const config = loadConfig();
  const secret = loadSecret();
  const resolved = alias || (config.models[0] && config.models[0].alias);
  const native = captureNativeCatalog();
  cacheNativeCatalog(native);
  writeMergedCatalog(config, MERGED_CATALOG_PATH);
  const result = applyConfig(config, secret, resolved);
  console.log(JSON.stringify(result));
}

function cmdRestore() {
  console.log("restored from", restoreConfig());
}

function cmdServer() {
  const config = loadConfig();
  const secret = loadSecret();
  const server = createServer(config, secret);
  console.log(
    "codextras listening on http://127.0.0.1:" +
      server.port +
      config.gateway.pathPrefix +
      "/<secret>/v1",
  );
}

function usage() {
  console.log(
    "usage: codextras start|stop|status|catalog|catalog-merged|dry-run|apply|restore",
  );
  process.exitCode = 2;
}

const [command, arg] = process.argv.slice(2);
switch (command) {
  case "start":
    cmdStart();
    break;
  case "stop":
    cmdStop();
    break;
  case "status":
    cmdStatus();
    break;
  case "catalog":
    cmdCatalog();
    break;
  case "catalog-merged":
    cmdCatalogMerged(arg);
    break;
  case "dry-run":
    cmdDryRun(arg);
    break;
  case "apply":
    cmdApply(arg);
    break;
  case "restore":
    cmdRestore();
    break;
  case "server":
    cmdServer();
    break;
  default:
    usage();
    break;
}
