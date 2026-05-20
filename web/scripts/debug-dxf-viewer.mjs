/* Debug harness: runs dxf-viewer's real pipeline against a local DXF and
 * prints exactly where (and on what entity) it spends time / stalls.
 *
 * Usage (from repo root):
 *   node web/scripts/debug-dxf-viewer.mjs "C:/path/to/file.dxf" [--fonts]
 *
 * --fonts          : also fetch + use Noto Sans (default: skip, so we isolate
 *                    parser/scene cost from glyph tessellation).
 * --max-entity N   : stop after N entities (default: no limit).
 *
 * The script monkey-patches DxfScene._ProcessDxfEntity to:
 *   - count entities per type
 *   - record cumulative ms per type
 *   - record the current entity being processed
 * A 2-second watchdog prints the in-flight entity if no progress occurs.
 */

import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import path from "node:path";

// ── Args ──
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: node debug-dxf-viewer.mjs <path-to.dxf> [--fonts] [--max-entity N]");
  process.exit(1);
}
const dxfPath = path.resolve(args[0]);
const useFonts = args.includes("--fonts");
const maxIdx = args.indexOf("--max-entity");
const maxEntity = maxIdx >= 0 ? parseInt(args[maxIdx + 1], 10) : Infinity;

const FAKE_URL = "http://debug.local/file.dxf";

// ── Stub global fetch so DxfFetcher loads from disk ──
const fileBytes = await readFile(dxfPath);
console.log(`[harness] file ${dxfPath} = ${(fileBytes.length / 1024 / 1024).toFixed(2)} MB`);

globalThis.fetch = async (url) => {
  console.log(`[harness] fetch ${url}`);
  if (url === FAKE_URL) {
    return new Response(fileBytes, {
      status: 200,
      headers: { "content-type": "application/dxf", "content-length": String(fileBytes.length) },
    });
  }
  // Pass-through for font URLs.
  return await import("node:https").then((h) =>
    new Promise((res, rej) => {
      const req = h.get(url, (r) => {
        const chunks = [];
        r.on("data", (c) => chunks.push(c));
        r.on("end", () => res(new Response(Buffer.concat(chunks), { status: r.statusCode })));
        r.on("error", rej);
      });
      req.on("error", rej);
    }),
  );
};

// ── Import dxf-viewer internals ──
const moduleRoot = path.resolve("web/node_modules/dxf-viewer/src");
const { DxfWorker } = await import(pathToFileURL(path.join(moduleRoot, "DxfWorker.js")).href);
const { DxfScene } = await import(pathToFileURL(path.join(moduleRoot, "DxfScene.js")).href);

// ── Instrument DxfScene._ProcessDxfEntity ──
const stats = new Map(); // type -> { count, ms }
let currentEntity = null;
let entityIndex = 0;
let lastProgressAt = performance.now();

const hatchProfile = (entity) => {
  const loops = entity?.boundaryPaths ?? entity?.boundaries ?? [];
  let edges = 0;
  const types = {};
  for (const loop of loops) {
    if (loop.edges) {
      for (const e of loop.edges) {
        edges++;
        const k = e.type ?? "?";
        types[k] = (types[k] ?? 0) + 1;
      }
    } else if (loop.vertices) {
      edges += loop.vertices.length;
      types.poly = (types.poly ?? 0) + loop.vertices.length;
    }
  }
  return {
    solidFill: !!(entity?.solidFill ?? entity?.fillType),
    patternName: entity?.patternName,
    loops: loops.length,
    edges,
    types,
  };
};

const origProcess = DxfScene.prototype._ProcessDxfEntity;
DxfScene.prototype._ProcessDxfEntity = function patched(entity, blockCtx = null) {
  const t = entity?.type || "UNKNOWN";
  entityIndex++;
  currentEntity = { idx: entityIndex, type: t, handle: entity?.handle, layer: entity?.layer, blockName: blockCtx?.name };
  const start = performance.now();
  let _profile = null;
  if (t === "HATCH") {
    _profile = hatchProfile(entity);
  }
  try {
    return origProcess.call(this, entity, blockCtx);
  } catch (e) {
    console.error(`[harness] EXCEPTION on entity #${entityIndex} ${t} (handle=${entity?.handle}):`, e?.message || e);
    throw e;
  } finally {
    const dt = performance.now() - start;
    let s = stats.get(t);
    if (!s) { s = { count: 0, ms: 0, maxMs: 0, maxHandle: null }; stats.set(t, s); }
    s.count++;
    s.ms += dt;
    if (dt > s.maxMs) { s.maxMs = dt; s.maxHandle = entity?.handle; }
    if (dt > 100) {
      const extra = _profile
        ? ` solid=${_profile.solidFill} pat=${_profile.patternName} loops=${_profile.loops} edges=${_profile.edges} types=${JSON.stringify(_profile.types)}`
        : "";
      console.log(`[harness] slow entity #${entityIndex} ${t} handle=${entity?.handle} layer=${entity?.layer} took ${dt.toFixed(0)}ms${extra}`);
    }
    lastProgressAt = performance.now();
    if (entityIndex >= maxEntity) {
      throw new Error(`harness: --max-entity ${maxEntity} reached`);
    }
  }
};

// Periodic stats + watchdog
const watchdog = setInterval(() => {
  const idleMs = (performance.now() - lastProgressAt) | 0;
  const top = [...stats.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 5)
    .map(([k, v]) => `${k}=${v.count}/${v.ms.toFixed(0)}ms`).join(" ");
  console.log(`[watchdog] idle=${idleMs}ms entityIdx=${entityIndex} current=${currentEntity?.type}(handle=${currentEntity?.handle}) top: ${top}`);
}, 2000).unref?.();

// ── Run ──
const worker = new DxfWorker(null);
const overallStart = performance.now();
try {
  const result = await worker.Load(
    FAKE_URL,
    useFonts
      ? [
          "https://cdn.jsdelivr.net/fontsource/fonts/noto-sans@latest/latin-400-normal.ttf",
          "https://cdn.jsdelivr.net/fontsource/fonts/noto-sans@latest/latin-700-normal.ttf",
        ]
      : null,
    Object.assign(Object.create(DxfScene.DefaultOptions ?? {}), {
      fileEncoding: "utf-8",
      retainParsedDxf: false,
    }),
    (phase, processed, total) => {
      const ts = ((performance.now() - overallStart) / 1000).toFixed(2);
      console.log(`[progress +${ts}s] ${phase} ${processed}/${total ?? "?"}`);
      lastProgressAt = performance.now();
    },
  );
  const totalMs = performance.now() - overallStart;
  console.log(`[harness] ✓ DONE in ${(totalMs / 1000).toFixed(2)}s`);
  console.log(`[harness] scene batches=${result.scene.batches.length} layers=${result.scene.layers.length} hasMissingChars=${result.scene.hasMissingChars}`);
} catch (e) {
  console.error(`[harness] ✗ FAILED at entity #${entityIndex} (${currentEntity?.type} handle=${currentEntity?.handle}):`, e);
} finally {
  clearInterval(watchdog);
  console.log("\n[harness] per-entity-type cost:");
  const rows = [...stats.entries()].sort((a, b) => b[1].ms - a[1].ms);
  for (const [t, s] of rows) {
    console.log(`  ${t.padEnd(14)} count=${String(s.count).padStart(6)}  total=${s.ms.toFixed(0).padStart(8)}ms  avg=${(s.ms / s.count).toFixed(2).padStart(7)}ms  max=${s.maxMs.toFixed(0).padStart(6)}ms (handle=${s.maxHandle})`);
  }
}
