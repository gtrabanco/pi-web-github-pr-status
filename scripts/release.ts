/**
 * Release tooling for @gtrabanco/pi-web-github-pr-status.
 *
 * Strict semver policy (see RELEASE-POLICY.md): the kind of the NEXT release
 * is registered in package.json (`nextRelease`), and `bun run publish`
 * applies it: check → bump → build → changelog → commit → tag → publish.
 *
 * Commands (all wired as bun scripts):
 *   bun run release:status            show version state
 *   bun run release:patch|minor|major register the next release kind
 *   bun run publish                   full release flow
 */
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { computeNextVersion, normalizeNextRelease, parseVersion, RELEASE_KINDS, type ReleaseKind } from "./semver.ts";

const PACKAGE_JSON_PATH = new URL("../package.json", import.meta.url);
const CHANGELOG_PATH = new URL("../CHANGELOG.md", import.meta.url);
const MAIN_BRANCH = "main";

interface PackageJson {
  name: string;
  version: string;
  nextRelease?: unknown;
  [key: string]: unknown;
}

async function readPackageJson(): Promise<PackageJson> {
  return JSON.parse(await readFile(PACKAGE_JSON_PATH, "utf8")) as PackageJson;
}

function git(args: string[], options: { allowFailure?: boolean } = {}): { ok: boolean; output: string } {
  const result = spawnSync("git", args, { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.status !== 0 && options.allowFailure !== true) {
    throw new Error(`git ${args.join(" ")} failed: ${output}`);
  }
  return { ok: result.status === 0, output };
}

function npmViewIsPublished(name: string, version: string): boolean {
  const result = spawnSync("npm", ["view", `${name}@${version}`, "version"], { encoding: "utf8" });
  return result.status === 0 && (result.stdout ?? "").trim() !== "";
}

function runCheck(): void {
  for (const command of ["bun run typecheck", "bun run test", "bun run build", "bun run scripts/validate-package.ts"]) {
    const [file, ...args] = command.split(" ");
    if (file === undefined) throw new Error("empty check command");
    console.log(`▶ ${command}`);
    const result = spawnSync(file, args, { stdio: "inherit" });
    if (result.status !== 0) throw new Error(`check failed: ${command}`);
  }
}

function assertReleasable(): void {
  git(["rev-parse", "--git-dir"]);
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).output;
  if (branch !== MAIN_BRANCH) {
    throw new Error(`Releases run from ${MAIN_BRANCH} only (current branch: ${branch}).`);
  }
  const status = git(["status", "--porcelain"]).output;
  if (status !== "") {
    throw new Error("Worktree is not clean. Commit or stash your changes before releasing.");
  }
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function changelogEntry(version: string, kind: ReleaseKind): string {
  const title = kind === "major" ? "Breaking release" : kind === "minor" ? "Feature release" : "Patch release";
  return `## ${version} — ${todayIso()} (${title})\n\n- See commit history for details.\n`;
}

async function prependChangelog(version: string, kind: ReleaseKind): Promise<void> {
  const existing = await readFile(CHANGELOG_PATH, "utf8").catch(() => "# Changelog\n");
  const lines = existing.split("\n");
  const headerEnd = lines.findIndex((line, index) => index > 0 && line.startsWith("## "));
  const header = headerEnd === -1 ? `${existing.trimEnd()}\n` : `${lines.slice(0, headerEnd).join("\n").trimEnd()}\n`;
  const body = headerEnd === -1 ? "" : `${lines.slice(headerEnd).join("\n").trimEnd()}\n`;
  const entry = changelogEntry(version, kind);
  await writeFile(CHANGELOG_PATH, `${header}\n${entry}${body.length > 0 ? `\n${body}` : ""}`);
}

async function savePackageJson(pkg: PackageJson, version: string, nextRelease: ReleaseKind): Promise<void> {
  const updated = { ...pkg, version, nextRelease };
  await writeFile(PACKAGE_JSON_PATH, `${JSON.stringify(updated, null, 2)}\n`);
}

async function status(): Promise<void> {
  const pkg = await readPackageJson();
  const nextRelease = normalizeNextRelease(pkg.nextRelease);
  const nextVersion = computeNextVersion(pkg.version, nextRelease);
  const published = npmViewIsPublished(pkg.name, pkg.version);
  console.log(`package:      ${pkg.name}`);
  console.log(`version:      ${pkg.version}${published ? " (published)" : " (not published yet)"}`);
  console.log(`nextRelease:  ${nextRelease}`);
  console.log(`planned next: ${nextVersion}`);
  if (!published) console.log("publish plan: publish the current version as-is (first release)");
}

async function setNext(kind: string): Promise<void> {
  const nextRelease = normalizeNextRelease(kind);
  const pkg = await readPackageJson();
  parseVersion(pkg.version);
  await savePackageJson(pkg, pkg.version, nextRelease);
  console.log(`nextRelease registered: ${nextRelease}. Run \`bun run publish\` to release.`);
}

async function publish(): Promise<void> {
  assertReleasable();
  const pkg = await readPackageJson();
  const current = pkg.version;
  const publishedAlready = npmViewIsPublished(pkg.name, current);
  let releaseVersion = current;
  let kind: ReleaseKind | undefined;

  if (publishedAlready) {
    kind = normalizeNextRelease(pkg.nextRelease);
    releaseVersion = computeNextVersion(current, kind);
    console.log(`▶ releasing ${current} → ${releaseVersion} (${kind})`);
  } else {
    normalizeNextRelease(pkg.nextRelease);
    console.log(`▶ first release: publishing ${current} as-is`);
  }

  runCheck();

  if (kind !== undefined) {
    await savePackageJson(pkg, releaseVersion, "patch");
    await prependChangelog(releaseVersion, kind);
    git(["add", "package.json", "CHANGELOG.md"]);
    git(["commit", "-m", `chore(release): v${releaseVersion}`]);
  }
  git(["tag", "-f", `v${releaseVersion}`]);

  console.log("▶ bun publish");
  const publish = spawnSync("bun", ["publish"], { stdio: "inherit" });
  if (publish.status !== 0) {
    console.error("bun publish failed; the release commit/tag exist locally — fix the issue and publish manually with `bun publish`.");
    process.exit(1);
  }

  const push = spawnSync("git", ["push", "origin", `v${releaseVersion}`], { encoding: "utf8" });
  if (push.status !== 0) {
    console.warn(`⚠ could not push the tag: ${(push.stderr ?? "").trim()}`);
  }
  console.log(`✔ released ${pkg.name}@${releaseVersion}`);
}

async function main(): Promise<void> {
  const [flag, value] = process.argv.slice(2);
  if (flag === "--status") return await status();
  if (flag === "--set-next") return await setNext(value ?? "");
  if (flag === "--publish") return await publish();
  console.error("usage: release.ts [--status | --set-next <major|minor|patch> | --publish]");
  process.exit(2);
}

if (import.meta.main) await main();

export { RELEASE_KINDS };
