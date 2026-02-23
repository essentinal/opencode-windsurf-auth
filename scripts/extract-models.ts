#!/usr/bin/env bun
/**
 * Extract model enum values from Windsurf's extension.js and/or runtime
 * state.vscdb and compare against the current types.ts to find missing models.
 *
 * Usage:
 *   bun run scripts/extract-models.ts [--path /path/to/extension.js] [--update] [--json]
 *   bun run scripts/extract-models.ts --state-db   # also read runtime models from state.vscdb
 *
 * Without --update, prints a diff report. With --update, patches types.ts
 * and models.ts in place (review changes before committing).
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const EXTENSION_PATHS = [
  "/Applications/Windsurf.app/Contents/Resources/app/extensions/windsurf/dist/extension.js",
  path.join(os.homedir(), "Applications/Windsurf.app/Contents/Resources/app/extensions/windsurf/dist/extension.js"),
  "/usr/share/windsurf/resources/app/extensions/windsurf/dist/extension.js",
  path.join(os.homedir(), ".local/share/windsurf/resources/app/extensions/windsurf/dist/extension.js"),
  "C:\\Program Files\\Windsurf\\resources\\app\\extensions\\windsurf\\dist\\extension.js",
  path.join(os.homedir(), "AppData\\Local\\Programs\\Windsurf\\resources\\app\\extensions\\windsurf\\dist\\extension.js"),
];

const SKIP_PREFIXES = [
  "MODEL_UNSPECIFIED",
  "MODEL_EMBED_",
  "MODEL_TEXT_EMBEDDING_",
  "MODEL_TOGETHERAI_",
  "MODEL_HUGGING_FACE_",
  "MODEL_NOMIC_",
  "MODEL_TEI_",
  "MODEL_SALESFORCE_",
  "MODEL_TAB_",
  "MODEL_SGLANG_",
  "MODEL_CUSTOM_",
  "MODEL_OPENAI_COMPATIBLE",
  "MODEL_ANTHROPIC_COMPATIBLE",
  "MODEL_VERTEX_COMPATIBLE",
  "MODEL_BEDROCK_COMPATIBLE",
  "MODEL_AZURE_COMPATIBLE",
  "MODEL_CASCADE_",
  "MODEL_DRAFT_",
  "MODEL_QUERY_",
  "MODEL_PRIVATE_",
  "MODEL_CODEMAP_",
  "MODEL_COGNITION_",
  "MODEL_LLAMA_FT_",
  "MODEL_SERVER_SIDE",
  "MODEL_ID",
  "MODEL_GPT_OSS_",
];

const SKIP_PATTERNS = [
  /^MODEL_CHAT_\d+/,   // internal numbered chat models
  /^MODEL_\d+$/,       // pure numeric models
  /^MODEL_\d{4,}/,     // numeric-prefixed models
  /_BYOK$/,            // bring-your-own-key variants
  /_OPEN_ROUTER_BYOK$/,
  /_DATABRICKS$/,
  /_INTERNAL$/,
  /_CRUSOE$/,
  /WINDSURF_RESEARCH/,
  /_REDIRECT$/,        // internal redirect entries
  /_HERMES_\d/,        // deprecated Hermes fine-tunes
  /LONG_CONTEXT$/,     // deprecated long-context variants
  /_PREVIEW_\d/,       // preview models (superseded by GA)
  /GEMINI_EXP_/,       // experimental Gemini models
];

interface ExtractedModel {
  name: string;
  value: number;
}

function findExtensionJs(overridePath?: string): string {
  if (overridePath) {
    if (!fs.existsSync(overridePath)) {
      console.error(`Extension file not found: ${overridePath}`);
      process.exit(1);
    }
    return overridePath;
  }
  for (const p of EXTENSION_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  console.error("Could not find Windsurf extension.js. Use --path to specify location.");
  process.exit(1);
}

function extractModelEnum(content: string): ExtractedModel[] {
  const match = content.match(
    /setEnumType\(\w+,"exa\.codeium_common_pb\.Model",\[(.*?)\]\)/
  );
  if (!match) {
    console.error("Could not find Model enum in extension.js");
    process.exit(1);
  }

  const entries: ExtractedModel[] = [];
  const fieldRegex = /\{no:(\d+),name:"([^"]+)"\}/g;
  let m: RegExpExecArray | null;
  while ((m = fieldRegex.exec(match[1])) !== null) {
    entries.push({ name: m[2], value: parseInt(m[1], 10) });
  }
  return entries;
}

function isUserFacing(model: ExtractedModel): boolean {
  for (const prefix of SKIP_PREFIXES) {
    if (model.name.startsWith(prefix)) return false;
  }
  for (const pattern of SKIP_PATTERNS) {
    if (pattern.test(model.name)) return false;
  }
  return true;
}

function protoNameToTsKey(name: string): string {
  return name
    .replace(/^MODEL_/, "")
    .replace(/^CHAT_/, "")
    .replace(/^GOOGLE_/, "");
}

function protoNameToFriendly(name: string): string {
  return protoNameToTsKey(name)
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/^gemini-/, "gemini-")
    .replace(/(\d)-(\d)/g, "$1.$2");
}

function readCurrentEnums(typesPath: string): Map<string, number> {
  const content = fs.readFileSync(typesPath, "utf8");
  const map = new Map<string, number>();
  const re = /^\s+(\w+):\s*(\d+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    map.set(m[1], parseInt(m[2], 10));
  }
  return map;
}

// ─── State DB extraction ────────────────────────────────────────────────

interface RuntimeModel {
  label: string;
  modelUid: string;
  isStringUid: boolean;
}

const STATE_DB_PATHS = [
  path.join(os.homedir(), "Library/Application Support/Windsurf/User/globalStorage/state.vscdb"),
  path.join(os.homedir(), ".config/Windsurf/User/globalStorage/state.vscdb"),
  path.join(os.homedir(), "AppData/Roaming/Windsurf/User/globalStorage/state.vscdb"),
];

function extractRuntimeModels(): RuntimeModel[] {
  let dbPath: string | undefined;
  for (const p of STATE_DB_PATHS) {
    if (fs.existsSync(p)) { dbPath = p; break; }
  }
  if (!dbPath) {
    console.error("Could not find state.vscdb. Is Windsurf installed?");
    return [];
  }

  try {
    const Database = require("bun:sqlite").Database ?? require("better-sqlite3");
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'windsurfAuthStatus'").get() as { value: string } | undefined;
    db.close();
    if (!row) return [];

    const data = JSON.parse(row.value);
    const raw = Buffer.from(data.userStatusProtoBinaryBase64 ?? "", "base64");

    const strings: Array<{ offset: number; text: string }> = [];
    let j = 0;
    while (j < raw.length) {
      if (raw[j] >= 32 && raw[j] <= 126) {
        const start = j;
        while (j < raw.length && raw[j] >= 32 && raw[j] <= 126) j++;
        const s = raw.subarray(start, j).toString("ascii");
        if (s.length >= 3) strings.push({ offset: start, text: s });
      } else {
        j++;
      }
    }

    const models: RuntimeModel[] = [];
    for (let i = 0; i < strings.length; i++) {
      const { text } = strings[i];
      if (!text.startsWith("MODEL_") && !text.match(/^[a-z][\w.-]+-[a-z0-9-]+$/)) continue;
      const isUid = !text.startsWith("MODEL_");
      const isModelEnum = text.startsWith("MODEL_") && !text.startsWith("MODEL_UNSPECIFIED");

      if (isUid || isModelEnum) {
        for (let k = i - 1; k >= Math.max(i - 5, 0); k--) {
          const prev = strings[k].text;
          if (!prev.startsWith("MODEL_") && !prev.startsWith("http") && prev.length > 3
            && strings[i].offset - strings[k].offset < 200) {
            models.push({
              label: prev,
              modelUid: text,
              isStringUid: isUid,
            });
            break;
          }
        }
      }
    }

    return models;
  } catch {
    console.error("Failed to read state.vscdb (need bun:sqlite or better-sqlite3)");
    return [];
  }
}

// ─── Main ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const pathIdx = args.indexOf("--path");
const overridePath = pathIdx !== -1 ? args[pathIdx + 1] : undefined;
const doUpdate = args.includes("--update");
const jsonOutput = args.includes("--json");
const readStateDb = args.includes("--state-db");

const extPath = findExtensionJs(overridePath);
const content = fs.readFileSync(extPath, "utf8");
const allModels = extractModelEnum(content);
const userFacing = allModels.filter(isUserFacing);

const rootDir = path.resolve(import.meta.dirname ?? ".", "..");
const typesPath = path.join(rootDir, "src/plugin/types.ts");
const currentEnums = readCurrentEnums(typesPath);

const currentValues = new Set(currentEnums.values());
const currentKeys = new Set(currentEnums.keys());

const missing: Array<{ tsKey: string; value: number; protoName: string; friendly: string }> = [];

for (const model of userFacing) {
  const tsKey = protoNameToTsKey(model.name);
  if (!currentKeys.has(tsKey) && !currentValues.has(model.value)) {
    missing.push({
      tsKey,
      value: model.value,
      protoName: model.name,
      friendly: protoNameToFriendly(model.name),
    });
  }
}

missing.sort((a, b) => a.value - b.value);

if (jsonOutput) {
  console.log(JSON.stringify({ total: userFacing.length, existing: currentEnums.size, missing }, null, 2));
  process.exit(0);
}

console.log(`Extension: ${extPath}`);
console.log(`Total model enums (all):        ${allModels.length}`);
console.log(`Total model enums (user-facing): ${userFacing.length}`);
console.log(`Currently in types.ts:           ${currentEnums.size}`);
console.log(`Missing from types.ts:           ${missing.length}`);
console.log();

if (missing.length === 0) {
  console.log("All user-facing models are already present.");
  process.exit(0);
}

console.log("Missing models:");
console.log("─".repeat(70));
for (const m of missing) {
  console.log(`  ${m.tsKey.padEnd(40)} = ${String(m.value).padStart(4)}  (${m.friendly})`);
}
console.log();

if (readStateDb) {
  console.log("─".repeat(70));
  console.log("Runtime models from state.vscdb:");
  console.log("─".repeat(70));
  const runtimeModels = extractRuntimeModels();
  const seen = new Set<string>();
  for (const m of runtimeModels) {
    const key = `${m.label}|${m.modelUid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const tag = m.isStringUid ? "string-uid" : "enum";
    console.log(`  ${m.label.padEnd(35)} -> ${m.modelUid.padEnd(40)} [${tag}]`);
  }
  console.log(`\n  Total unique: ${seen.size}`);
  console.log();
}

if (!doUpdate) {
  console.log("Run with --update to patch types.ts and models.ts automatically.");
  console.log("Review the changes and verify with `bun run typecheck` before committing.");
  process.exit(0);
}

// ─── Auto-patch types.ts ────────────────────────────────────────────────
console.log("Patching types.ts...");
let typesContent = fs.readFileSync(typesPath, "utf8");

const insertAnchor = "} as const;";
const anchorIdx = typesContent.indexOf(insertAnchor);
if (anchorIdx === -1) {
  console.error("Could not find insertion point in types.ts");
  process.exit(1);
}

const newEnumLines = missing.map((m) => `  ${m.tsKey}: ${m.value},`).join("\n");
const block = `\n  // ── Auto-extracted ${new Date().toISOString().slice(0, 10)} ──\n${newEnumLines}\n`;
typesContent = typesContent.slice(0, anchorIdx) + block + typesContent.slice(anchorIdx);
fs.writeFileSync(typesPath, typesContent);
console.log(`  Added ${missing.length} enums to types.ts`);

// ─── Auto-patch models.ts (legacy map only) ─────────────────────────────
console.log("Patching models.ts (MODEL_NAME_TO_ENUM + ENUM_TO_MODEL_NAME)...");
const modelsPath = path.join(rootDir, "src/plugin/models.ts");
let modelsContent = fs.readFileSync(modelsPath, "utf8");

const legacyMapEnd = /\n\};\n\n\/\*\*\n \* Reverse mapping/;
const legacyMatch = legacyMapEnd.exec(modelsContent);
if (!legacyMatch) {
  console.error("Could not find MODEL_NAME_TO_ENUM end in models.ts");
  process.exit(1);
}

const fwdLines = missing
  .map((m) => `  '${m.friendly}': ModelEnum.${m.tsKey},`)
  .join("\n");
const fwdBlock = `\n\n  // ── Auto-extracted ${new Date().toISOString().slice(0, 10)} ──\n${fwdLines}`;
modelsContent =
  modelsContent.slice(0, legacyMatch.index) +
  fwdBlock +
  modelsContent.slice(legacyMatch.index);

const reverseMapEnd = /\n\};\n\n\/\/ =+\n\/\/ Public API/;
const reverseMatch = reverseMapEnd.exec(modelsContent);
if (!reverseMatch) {
  console.error("Could not find ENUM_TO_MODEL_NAME end in models.ts");
  process.exit(1);
}

const revLines = missing
  .map((m) => `  [ModelEnum.${m.tsKey}]: '${m.friendly}',`)
  .join("\n");
const revBlock = `\n\n  // ── Auto-extracted ${new Date().toISOString().slice(0, 10)} ──\n${revLines}`;
modelsContent =
  modelsContent.slice(0, reverseMatch.index) +
  revBlock +
  modelsContent.slice(reverseMatch.index);

fs.writeFileSync(modelsPath, modelsContent);
console.log(`  Added ${missing.length} entries to both maps`);
console.log();
console.log("Done. Run `bun run typecheck` to verify, then review the diff.");
console.log("You may want to add VARIANT_CATALOG entries for models with thinking/low/high variants.");
