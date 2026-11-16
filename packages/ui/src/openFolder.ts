/**
 * Open folder…: a domain folder read from the user's disk, in the browser — nothing is uploaded.
 * Where the browser has a directory picker (Chrome, Edge) only the domain's own files are read;
 * elsewhere a folder input lists the whole folder, and the domain's files are picked from it.
 * Either way the result is the folder's name and its files by path, as `domains.json` has them.
 */

/** Folders a model's parts are never in: the docs, what is built or shared, and anything hidden. */
const NOT_PARTS = new Set(["docs", "node_modules", "exports", "site", "dist"]);

/**
 * The files of a domain folder: `model.yaml`, the YAML directly in scenarios/ and drawings/, and any
 * other YAML a few folders deep — the parts `model.yaml` may include (ADR 0019); the loader takes
 * only those it does.
 */
export function isDomainFile(path: string): boolean {
  if (path === "model.yaml" || /^(scenarios|drawings|agendas)\/[^/]+\.yaml$/.test(path)) return true;
  if (DOCS.test(path)) return true;
  const segs = path.split("/");
  return path.endsWith(".yaml") && segs.length <= 4 && !["scenarios", "drawings", "agendas"].includes(segs[0]!)
    && segs.slice(0, -1).every((s) => !s.startsWith(".") && !NOT_PARTS.has(s));
}

/** The domain's docs (ADR 0016), for the Docs view: the sources, not the generated rulebook. */
const DOCS = /^docs\/(profile\.yaml|glossary\.yaml|questions\.yaml|rules\/[^/]+\.yaml|decisions\/[^/]+\.md)$/;

function walksInto(prefix: string, name: string): boolean {
  const path = `${prefix}${name}`;   // the prefix ends in a slash, or is empty
  if (path === "docs" || path === "docs/rules" || path === "docs/decisions") return true;
  if (name.startsWith(".") || NOT_PARTS.has(name)) return false;
  return prefix.split("/").length <= 3;
}

type Dir = { name: string; values(): AsyncIterable<{ kind: "file" | "directory"; name: string }>; getDirectoryHandle(n: string): Promise<Dir>; getFileHandle(n: string): Promise<{ getFile(): Promise<File> }> };

async function viaPicker(pick: () => Promise<Dir>): Promise<{ name: string; files: Record<string, string> } | undefined> {
  let root: Dir;
  try { root = await pick(); } catch { return undefined; }      // cancelled
  const files: Record<string, string> = {};
  const read = async (dir: Dir, prefix: string) => {
    for await (const entry of dir.values()) {
      const path = `${prefix}${entry.name}`;
      if (entry.kind === "file" && isDomainFile(path)) files[path] = await (await (await dir.getFileHandle(entry.name)).getFile()).text();
      else if (entry.kind === "directory" && walksInto(prefix, entry.name)) await read(await dir.getDirectoryHandle(entry.name), `${prefix}${entry.name}/`);
    }
  };
  await read(root, "");
  return { name: root.name, files };
}

function viaInput(): Promise<{ name: string; files: Record<string, string> } | undefined> {
  return new Promise((done) => {
    const input = document.createElement("input");
    input.type = "file";
    input.setAttribute("webkitdirectory", "");
    input.addEventListener("cancel", () => done(undefined));
    input.addEventListener("change", async () => {
      const all = [...(input.files ?? [])];
      if (all.length === 0) { done(undefined); return; }
      const name = all[0]!.webkitRelativePath.split("/")[0]!;
      const files: Record<string, string> = {};
      for (const f of all) {
        const path = f.webkitRelativePath.split("/").slice(1).join("/");
        if (isDomainFile(path)) files[path] = await f.text();
      }
      done({ name, files });
    });
    input.click();
  });
}

export function pickDomainFolder(): Promise<{ name: string; files: Record<string, string> } | undefined> {
  const picker = (window as unknown as { showDirectoryPicker?: (o?: object) => Promise<Dir> }).showDirectoryPicker;
  return picker ? viaPicker(() => picker({ mode: "read" })) : viaInput();
}
