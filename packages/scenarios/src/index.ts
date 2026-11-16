// What any reader may have, the browser included: the workbench imports this index, so nothing
// here may touch a file system. `files.ts` (a model read from disk) is `@statestorm/scenarios/files`
// — its `node:fs` reaches the browser as an externalized module, and the page stays blank.
export * from "./run.ts";
export * from "./narrate.ts";
