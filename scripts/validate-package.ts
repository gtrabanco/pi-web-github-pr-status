/**
 * Validate plugin package metadata against the PI WEB discovery contract:
 * https://pi-web.dev/plugins — one supported package.json metadata shape.
 *
 * Run via `bun run scripts/validate-package.ts` (part of `bun run check`),
 * or import `validatePluginPackage` from tests.
 */

interface PluginEntry {
  id?: unknown;
  browserRoot?: unknown;
  module?: unknown;
  serverModule?: unknown;
  machineSpecific?: unknown;
}

const ID_PATTERN = /^[a-z][a-z0-9.-]*$/u;
const RESERVED_IDS = new Set(["core", "themes"]);
const FORBIDDEN_SEGMENTS = new Set(["", ".", "..", ".git", "node_modules"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Check a package-relative path: canonical, safe, no traversal segments. */
function isSafeRelativePath(value: unknown, kind: string, pluginId: string, violations: string[]): value is string {
  if (typeof value !== "string" || value === "") {
    violations.push(`plugin ${pluginId}: ${kind} must be a non-empty relative path`);
    return false;
  }
  if (value.includes("\\") || value.startsWith("/") || /^[a-zA-Z]:/u.test(value)) {
    violations.push(`plugin ${pluginId}: ${kind} ${JSON.stringify(value)} must be a package-relative path`);
    return false;
  }
  const segments = value.split("/");
  if (segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment))) {
    violations.push(`plugin ${pluginId}: ${kind} ${JSON.stringify(value)} contains forbidden segments`);
    return false;
  }
  return true;
}

function isInside(parent: string, child: string): boolean {
  if (parent === ".") return true;
  return child === parent || child.startsWith(`${parent}/`);
}

export function validatePluginPackage(pkg: unknown): string[] {
  const violations: string[] = [];
  if (!isRecord(pkg)) return ["package.json must be an object"];
  const piWeb = pkg.piWeb;
  if (!isRecord(piWeb) || !Array.isArray(piWeb.plugins)) {
    return ["piWeb.plugins must be an array of objects"];
  }

  const seenIds = new Set<string>();
  const hasJsServerModule = piWeb.plugins.some(
    (entry) => isRecord(entry) && typeof entry.serverModule === "string" && entry.serverModule.endsWith(".js"),
  );
  if (hasJsServerModule && pkg.type !== "module") {
    violations.push("package type must be module when a .js serverModule is declared");
  }

  for (const rawEntry of piWeb.plugins) {
    if (!isRecord(rawEntry)) {
      violations.push("piWeb.plugins must be an array of objects");
      continue;
    }
    const entry = rawEntry as PluginEntry;
    const id = entry.id;
    if (typeof id !== "string" || !ID_PATTERN.test(id)) {
      violations.push(`invalid plugin id ${JSON.stringify(id)}: must match ${String(ID_PATTERN)}`);
      continue;
    }
    if (RESERVED_IDS.has(id) || id.startsWith("machine.")) {
      violations.push(`plugin id "${id}" is reserved for the host`);
      continue;
    }
    if (seenIds.has(id)) {
      violations.push(`duplicate plugin id "${id}": records are never merged`);
      continue;
    }
    seenIds.add(id);

    const hasModule = typeof entry.module === "string";
    const hasServerModule = typeof entry.serverModule === "string";
    if (!hasModule && !hasServerModule) {
      violations.push(`plugin ${id} must declare module or serverModule`);
      continue;
    }
    if (entry.browserRoot !== undefined && !hasModule) {
      violations.push(`plugin ${id}: server-only entry must not declare browserRoot`);
    }
    if (hasModule && entry.browserRoot === undefined) {
      violations.push(`plugin ${id}: browser entry must declare a browserRoot`);
    }
    if (hasModule && entry.browserRoot !== undefined) {
      const browserRoot: unknown = entry.browserRoot;
      const modulePath: unknown = entry.module;
      const rootOk = isSafeRelativePath(browserRoot, "browserRoot", id, violations);
      const moduleOk = isSafeRelativePath(modulePath, "module", id, violations);
      if (rootOk && moduleOk && !isInside(browserRoot, modulePath)) {
        violations.push(`plugin ${id}: module must live inside browserRoot`);
      }
    }
    if (hasServerModule) {
      isSafeRelativePath(entry.serverModule, "serverModule", id, violations);
    }
    if (entry.machineSpecific !== undefined && typeof entry.machineSpecific !== "boolean") {
      violations.push(`plugin ${id}: machineSpecific must be a boolean`);
    }
  }
  return violations;
}

async function main(): Promise<void> {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(new URL("../package.json", import.meta.url), "utf8");
  const pkg: unknown = JSON.parse(raw);
  const violations = validatePluginPackage(pkg);
  if (violations.length > 0) {
    console.error("Package metadata violates the PI WEB plugin discovery contract:");
    for (const violation of violations) console.error(`  - ${violation}`);
    process.exit(1);
  }
  console.log("package.json satisfies the PI WEB plugin discovery contract");
}

const invokedScript = process.argv[1];
const isDirectExecution = typeof invokedScript === "string" && import.meta.url.endsWith(invokedScript.split("/").pop() ?? "");
if (isDirectExecution) await main();
