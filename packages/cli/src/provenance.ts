/**
 * Where a shared file comes from, so it can be traced back to git: the domain folder's commit,
 * branch, and what of the shared files is not committed (or not pushed); and the platform's
 * commit — from the build (dist/build.json), from this repo's git, or from the domain's lockfile.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The paths of a domain folder a shared file carries (domains.ts reads the same). */
export const SHARED = ["model.yaml", "scenarios", "drawings"];

export interface Source {
  /** The commit the domain folder is at; undefined outside git. */
  commit?: string;
  branch?: string;
  /** Shared files changed, added or removed since that commit — what the commit does not hold. */
  uncommitted: string[];
  /** Whether any remote branch has the commit — whether someone else can find it. */
  pushed?: boolean;
}

const gitRaw = (dir: string, ...args: string[]) => {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  return r.status === 0 ? r.stdout : undefined;
};
const git = (dir: string, ...args: string[]) => gitRaw(dir, ...args)?.trim();

export function sourceOf(dir: string): Source {
  const commit = git(dir, "rev-parse", "HEAD");
  if (!commit) return { uncommitted: [] };
  const top = git(dir, "rev-parse", "--show-toplevel") ?? dir;
  // Untrimmed: a porcelain line starts with its two status columns, the first maybe a space.
  const status = gitRaw(dir, "status", "--porcelain", "--untracked-files=all", "--", ...SHARED) ?? "";
  // Porcelain paths are the repository's; say them from the domain folder.
  const prefix = resolve(dir).slice(resolve(top).length + 1);
  const uncommitted = status.split("\n").filter(Boolean).map((l) => {
    const path = l.slice(3).replace(/^"|"$/g, "").replace(/^.* -> /, "");
    return prefix && path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : path;
  });
  const branch = git(dir, "rev-parse", "--abbrev-ref", "HEAD");
  const remotes = git(dir, "branch", "-r", "--contains", commit);
  return { commit, ...(branch ? { branch } : {}), uncommitted, ...(remotes !== undefined ? { pushed: remotes.length > 0 } : {}) };
}

/** Whether git ignores `path` (relative to the domain folder) there. */
export function ignored(dir: string, path: string): boolean {
  return spawnSync("git", ["-C", dir, "check-ignore", "-q", `${path}/`]).status === 0;
}

// The platform: the bundled CLI's build record, or this repo when run from its TypeScript.
const RUNNING_FROM_SOURCE = import.meta.url.endsWith(".ts");
const BUILD = fileURLToPath(new URL("./build.json", import.meta.url));
const REPO = fileURLToPath(new URL("../../../", import.meta.url));

/** The platform's commit: as built, as checked out here, or as the domain's lockfile pins it. */
export function platformCommit(domainDir?: string): string | undefined {
  if (RUNNING_FROM_SOURCE) return git(REPO, "rev-parse", "HEAD");
  if (existsSync(BUILD)) {
    const built = (JSON.parse(readFileSync(BUILD, "utf8")) as { commit?: string }).commit;
    if (built) return built;
  }
  // Installed as a git dependency the build may have had no .git: the lockfile names the commit.
  const lock = domainDir ? join(domainDir, "pnpm-lock.yaml") : undefined;
  if (lock && existsSync(lock)) return /statestorm@[^\n]*?#([0-9a-f]{40})/.exec(readFileSync(lock, "utf8"))?.[1];
  return undefined;
}

/** `202611031542` — the local time a file is shared, for its name. */
export function stamp(at = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}${p(at.getHours())}${p(at.getMinutes())}`;
}
