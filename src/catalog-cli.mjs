import path from "node:path";
import { loadConfig, STATE_DIR } from "./config.mjs";
import {
  cacheNativeCatalog,
  captureNativeCatalog,
  writeMergedCatalog,
} from "./catalog.mjs";

const config = loadConfig();
const native = captureNativeCatalog();
cacheNativeCatalog(native);
const target = process.argv[2] || path.join(STATE_DIR, "merged-models.json");
writeMergedCatalog(config, target);
console.log(
  JSON.stringify({
    path: target,
    nativeModels: Array.isArray(native.models) ? native.models.length : 0,
    declaredModels: config.models.length,
  }),
);
