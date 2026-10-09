// Shared helpers for the deploy scripts. Node 22+, no dependencies.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CORE_CONFIG = join(ROOT, "apps/core/wrangler.jsonc");
export const API_CONFIG = join(ROOT, "apps/api/wrangler.jsonc");
export const STATE_DIR = join(ROOT, ".tower");

export const ENVS = {
  staging: {
    db: "tower-db-staging", kv: "tower-cache-staging", r2: "tower-archive-staging", queue: "tower-jobs-staging",
    core: "tower-core-staging", api: "tower-api-staging",
  },
  production: {
    db: "tower-db", kv: "tower-cache", r2: "tower-archive", queue: "tower-jobs", core: "tower-core", api: "tower-api",
  },
};

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      if (v !== undefined) out[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

export function requireEnv(args) {
  const env = args.env ?? args._[0];
  if (!ENVS[env]) {
    console.error(`--env must be one of: ${Object.keys(ENVS).join(", ")}`);
    process.exit(1);
  }
  return env;
}

const color = (c, s) => (process.stdout.isTTY ? `\x1b[${c}m${s}\x1b[0m` : s);
export const step = (s) => console.log(color("1;36", `\n▸ ${s}`));
export const ok = (s) => console.log(color("32", `  ✓ ${s}`));
export const warn = (s) => console.log(color("33", `  ! ${s}`));
export const fail = (s) => {
  console.error(color("31", `  ✗ ${s}`));
  process.exit(1);
};

/** Run wrangler; returns stdout. Throws (or returns null with allowFail) on a non-zero exit. */
export function wrangler(args, { allowFail = false, input, quiet = false } = {}) {
  const r = spawnSync("npx", ["wrangler", ...args], {
    cwd: ROOT, encoding: "utf8", input, stdio: [input === undefined ? "inherit" : "pipe", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  if (r.status !== 0) {
    if (allowFail) return null;
    console.error(out);
    fail(`wrangler ${args.join(" ")} failed`);
  }
  if (!quiet && process.env.VERBOSE) console.log(out);
  return r.stdout ?? "";
}

export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", ...opts });
  if (r.status !== 0) fail(`${cmd} ${args.join(" ")} failed`);
}

/** Extract the first JSON value from wrangler output (which may include banners). */
export function parseJsonOutput(text) {
  const start = text.search(/[[{]/);
  if (start < 0) throw new Error("no JSON in output");
  return JSON.parse(text.slice(start));
}

export function readText(path) {
  return readFileSync(path, "utf8");
}
export function writeText(path, text) {
  writeFileSync(path, text);
}

export function saveState(env, data) {
  mkdirSync(STATE_DIR, { recursive: true });
  const path = join(STATE_DIR, `${env}.json`);
  const prev = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  writeFileSync(path, JSON.stringify({ ...prev, ...data, updated_at: new Date().toISOString() }, null, 2));
  return path;
}

export function loadState(env) {
  const path = join(STATE_DIR, `${env}.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

export async function prompt(question, { hidden = false, def } = {}) {
  if (!process.stdin.isTTY) return def ?? "";
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    const write = rl._writeToOutput?.bind(rl);
    rl._writeToOutput = (s) => (s.includes(question) ? write(s) : write("*"));
  }
  const answer = await new Promise((res) => rl.question(`${question}${def ? ` [${def}]` : ""}: `, res));
  rl.close();
  if (hidden) process.stdout.write("\n");
  return answer.trim() || def || "";
}

export function checkLogin() {
  if (process.env.CLOUDFLARE_API_TOKEN) return ok("using CLOUDFLARE_API_TOKEN");
  const who = wrangler(["whoami"], { allowFail: true, quiet: true });
  if (!who || /not authenticated/i.test(who)) fail("not logged in: run `npx wrangler login` or set CLOUDFLARE_API_TOKEN");
  const account = who.match(/│\s*([^│]+?)\s*│\s*([0-9a-f]{32})\s*│/);
  ok(`logged in${account ? ` (${account[1]})` : ""}`);
}
