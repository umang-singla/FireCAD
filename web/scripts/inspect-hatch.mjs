/* Dump structural info for HATCH entities in a DXF file.
 *
 * Usage:
 *   node web/scripts/inspect-hatch.mjs <path-to.dxf> [handle1 handle2 ...]
 *
 * If handles are provided, prints details only for those.
 * Otherwise prints a summary of all hatches sorted by total edge count.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: node inspect-hatch.mjs <path-to.dxf> [handle ...]");
  process.exit(1);
}
const dxfPath = path.resolve(args[0]);
const wanted = new Set(args.slice(1).map(h => h.toUpperCase()));

const { default: DxfParser } = await import(
  "file:///" + path.resolve("web/node_modules/dxf-parser/dist/index.js").replace(/\\/g, "/")
);

const text = await readFile(dxfPath, "utf8");
console.log(`[inspect] parsing ${(text.length / 1024 / 1024).toFixed(2)} MB DXF…`);
const t0 = Date.now();
const parser = new DxfParser();
const dxf = parser.parseSync(text);
console.log(`[inspect] parsed in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${dxf.entities.length} top-level entities`);

const summarize = (hatch) => {
  const loops = hatch.boundaryPaths ?? hatch.boundaries ?? [];
  let edgeCount = 0;
  const edgeTypes = {};
  for (const loop of loops) {
    if (loop.edges) {
      for (const e of loop.edges) {
        edgeCount++;
        const t = e.type ?? "unknown";
        edgeTypes[t] = (edgeTypes[t] ?? 0) + 1;
      }
    } else if (loop.vertices) {
      edgeCount += loop.vertices.length;
      edgeTypes.poly = (edgeTypes.poly ?? 0) + loop.vertices.length;
    }
  }
  return {
    handle: hatch.handle,
    layer: hatch.layer,
    solidFill: !!hatch.fillType || hatch.solidFill,
    patternName: hatch.patternName,
    patternType: hatch.patternType,
    loops: loops.length,
    edgeCount,
    edgeTypes,
  };
};

// Walk all entities including BLOCK contents.
const allHatches = [];
const walk = (entities) => {
  for (const e of entities ?? []) {
    if (e.type === "HATCH") allHatches.push(e);
    if (e.entities) walk(e.entities);
  }
};
walk(dxf.entities);
for (const blkName of Object.keys(dxf.blocks ?? {})) {
  walk(dxf.blocks[blkName].entities);
}
console.log(`[inspect] total HATCH entities (incl. blocks): ${allHatches.length}`);

if (wanted.size > 0) {
  for (const h of allHatches) {
    if (wanted.has((h.handle ?? "").toUpperCase())) {
      console.log("---", h.handle, "---");
      console.log(JSON.stringify(summarize(h), null, 2));
      // Dump first loop's first few edges raw for shape clues
      const loops = h.boundaryPaths ?? h.boundaries ?? [];
      if (loops[0]?.edges) {
        console.log("first-loop edges sample:", JSON.stringify(loops[0].edges.slice(0, 3), null, 2));
      } else if (loops[0]?.vertices) {
        console.log("first-loop vertex count:", loops[0].vertices.length);
        console.log("first 3 vertices:", JSON.stringify(loops[0].vertices.slice(0, 3)));
      }
    }
  }
} else {
  const summaries = allHatches.map(summarize).sort((a, b) => b.edgeCount - a.edgeCount);
  console.log("[inspect] top 15 hatches by edge count:");
  for (const s of summaries.slice(0, 15)) {
    console.log(`  handle=${s.handle} layer=${s.layer} loops=${s.loops} edges=${s.edgeCount} solid=${s.solidFill} pat=${s.patternName} types=${JSON.stringify(s.edgeTypes)}`);
  }
}
