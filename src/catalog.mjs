const EFFORT_DESCRIPTIONS = {
  minimal: "Fastest responses",
  low: "Quick reasoning",
  medium: "Balanced reasoning",
  high: "Deep reasoning",
  xhigh: "Extended reasoning",
  max: "Maximum reasoning",
};

function instructionsTemplate(model) {
  return (
    "You are Codex, a coding agent based on " + (model.displayName || model.alias) + ". " +
    "You and the user share one workspace, and your job is to collaborate with them until their goal is genuinely handled.\n\n" +
    "You have access to shell, file editing, and browser tooling. Read the codebase first, keep edits scoped, " +
    "parallelize independent reads, and verify your work. Keep the user updated with concise commentary, and end " +
    "each turn with a self-contained final answer."
  );
}

export function modelToCatalogEntry(model) {
  const efforts = Array.isArray(model.efforts) && model.efforts.length ? model.efforts : ["low", "high", "max"];
  const defaultEffort = model.defaultEffort || efforts[efforts.length - 1] || "high";
  const instructions = instructionsTemplate(model);
  const reasoningSummary = typeof model.reasoningSummary === "string" ? model.reasoningSummary : "none";
  const supportsSummaries =
    typeof model.supportsReasoningSummaries === "boolean"
      ? model.supportsReasoningSummaries
      : reasoningSummary !== "none";
  return {
    slug: model.alias,
    display_name: model.displayName || model.alias,
    description: model.description || "",
    default_reasoning_level: defaultEffort,
    supported_reasoning_levels: efforts.map((effort) => ({
      effort,
      description: EFFORT_DESCRIPTIONS[effort] || effort,
    })),
    context_window: Number(model.contextWindow) || 1048576,
    max_context_window: Number(model.contextWindow) || 1048576,
    effective_context_window_percent: 95,
    auto_compact_token_limit: Number(model.autoCompact) || 900000,
    input_modalities: Array.isArray(model.inputModalities) ? model.inputModalities : ["text"],
    supports_image_detail_original: false,
    truncation_policy: { mode: "tokens", limit: 10000 },
    supports_parallel_tool_calls: true,
    tool_mode: "code_mode_only",
    multi_agent_version: "v2",
    use_responses_lite: false,
    prefer_websockets: false,
    include_skills_usage_instructions: false,
    include_plugin_usage_instructions: false,
    include_apps_usage_instructions: true,
    support_verbosity: false,
    default_verbosity: null,
    default_reasoning_summary: reasoningSummary,
    supports_reasoning_summaries: supportsSummaries,
    supports_search_tool: false,
    experimental_supported_tools: [],
    additional_speed_tiers: [],
    service_tiers: [],
    comp_hash: model.alias + "-v1",
    base_instructions: instructions,
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text",
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: 1,
    availability_nux: null,
    upgrade: null,
    model_messages: { instructions_template: instructions },
  };
}

export function generateCatalog(models) {
  return { models: models.map(modelToCatalogEntry) };
}

// Native model catalog: captured from the bundled Codex CLI, pinned via env
// for tests, and merged with declared routed models. Declared aliases win.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { STATE_DIR } from "./config.mjs";

export const NATIVE_CATALOG_PATH = path.join(STATE_DIR, "native-models.json");
export const MERGED_CATALOG_PATH = path.join(STATE_DIR, "merged-models.json");

function codexBinary() {
  return (
    process.env.CODEXTRAS_CODEX_BIN ||
    "/Applications/ChatGPT.app/Contents/Resources/codex"
  );
}

function pinnedNativeCatalog() {
  const pinned = process.env.CODEXTRAS_NATIVE_CATALOG;
  if (!pinned || !existsSync(pinned)) return undefined;
  try {
    return JSON.parse(readFileSync(pinned, "utf8"));
  } catch {
    return undefined;
  }
}

export function captureNativeCatalog() {
  const pinned = pinnedNativeCatalog();
  if (pinned) return pinned;
  const binary = codexBinary();
  const run = (args) =>
    execFileSync(binary, args, {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 32 * 1024 * 1024,
    });
  let output;
  try {
    output = run(["debug", "models"]);
  } catch {
    output = run(["debug", "models", "--bundled"]);
  }
  const parsed = JSON.parse(output);
  if (!parsed || !Array.isArray(parsed.models) || parsed.models.length === 0) {
    throw new Error("Codex returned an empty model catalog.");
  }
  return parsed;
}

export function cacheNativeCatalog(parsed) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(
    NATIVE_CATALOG_PATH,
    JSON.stringify(parsed, null, 2) + "\n",
    { mode: 0o600 },
  );
}

export function cachedNativeCatalog() {
  if (!existsSync(NATIVE_CATALOG_PATH)) return undefined;
  try {
    return JSON.parse(readFileSync(NATIVE_CATALOG_PATH, "utf8"));
  } catch {
    return undefined;
  }
}

export function mergeCatalog(config, nativeOverride) {
  const declared = generateCatalog(config.models).models;
  const declaredSlugs = new Set(declared.map((m) => m.slug));
  const native = nativeOverride || cachedNativeCatalog();
  const overrides = config.catalogOverrides || {};
  const models = [];
  for (const model of Array.isArray(native && native.models) ? native.models : []) {
    if (model && typeof model.slug === "string" && !declaredSlugs.has(model.slug)) {
      const override = overrides[model.slug];
      models.push(override && typeof override === "object" ? { ...model, ...override } : model);
    }
  }
  models.push(...declared);
  return { models };
}

export function writeMergedCatalog(config, target) {
  const merged = mergeCatalog(config);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
  return target;
}
