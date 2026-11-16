import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * `--mode standalone`: the whole site in one HTML file — scripts and styles inline, no chunk to
 * load — so it opens straight from disk (browsers refuse a module script file from file://).
 * `statestorm share` puts the domains into it.
 */
function inlineIntoHtml(): Plugin {
  // A `</script` inside the code would end the inline script early. With nothing split off,
  // Vite leaves its preload list unfilled: nothing to preload.
  const safe = (code: string) => code.replace(/<\/script/gi, "<\\/script").replaceAll("__VITE_PRELOAD__", "void 0");
  return {
    name: "statestorm-inline",
    enforce: "post",
    generateBundle(_, bundle) {
      const html = Object.values(bundle).find((f) => f.fileName === "index.html");
      if (!html || html.type !== "asset") return;
      let page = String(html.source);
      for (const f of Object.values(bundle)) {
        if (f.type === "chunk" && f.isEntry) {
          page = page.replace(new RegExp(`<script[^>]*src="[^"]*${f.fileName}"[^>]*></script>`), () => `<script type="module">${safe(f.code)}</script>`);
          delete bundle[f.fileName];
        } else if (f.type === "asset" && f.fileName.endsWith(".css")) {
          page = page.replace(new RegExp(`<link[^>]*href="[^"]*${f.fileName}"[^>]*>`), () => `<style>${String(f.source)}</style>`);
          delete bundle[f.fileName];
        }
      }
      html.source = page;
    },
  };
}

// Relative base so the built app runs from any path, or straight off a file share (R35).
export default defineConfig(({ mode }) => mode === "standalone"
  ? {
    base: "./",
    plugins: [react(), inlineIntoHtml()],
    build: {
      outDir: "dist-standalone",
      cssCodeSplit: false,
      assetsInlineLimit: Number.MAX_SAFE_INTEGER,
      chunkSizeWarningLimit: 5000,
      rollupOptions: { output: { codeSplitting: false } },
    },
  }
  : {
    base: "./",
    plugins: [react()],
    server: { host: true, port: 5180 },
    // The one big chunk is ELK, already split out and loaded on first layout; it cannot shrink.
    build: { chunkSizeWarningLimit: 1500 },
  });
