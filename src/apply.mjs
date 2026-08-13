import { loadConfig, loadSecret } from "./config.mjs";
import {
  cacheNativeCatalog,
  captureNativeCatalog,
  writeMergedCatalog,
} from "./catalog.mjs";
import { applyConfig, MERGED_CATALOG_PATH } from "./codex-config.mjs";

const config = loadConfig();
const secret = loadSecret();
const alias = process.argv[2] || (config.models[0] && config.models[0].alias);
const native = captureNativeCatalog();
cacheNativeCatalog(native);
writeMergedCatalog(config, MERGED_CATALOG_PATH);
const result = applyConfig(config, secret, alias);
console.log(JSON.stringify(result));
