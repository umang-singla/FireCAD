/**
 * Hatch overlay: renders dxf-viewer's per-hatch fill records as translucent
 * pattern-textured meshes added directly to viewer.scene.
 *
 * Why this exists:
 *  The original dxf-viewer CPU-tessellates every hatch pattern into thousands
 *  of LINE_SEGMENTS per HATCH entity. On CAD-converted DXFs (e.g. CloudConvert
 *  output) this is O(M · E · log E) per hatch and stalls the viewer for
 *  minutes. Our patched DxfScene now captures hatches with
 *  options.hatchStencilFill=true into scene.hatchFills (boundary triangulation
 *  + pattern definition). This module turns those records into proper visual
 *  fills using a shader that samples a pre-rendered pattern tile in OCS space.
 *
 * Prototype scope (this file):
 *  - One Mesh per hatch (no batching). Acceptable: museum file has 544 hatches,
 *    well under the WebGL draw-call ceiling.
 *  - Pattern texture: per unique (patternName · scale · angle), 256×256
 *    canvas-rendered, RepeatWrapping. Cached across hatches.
 *  - Fragment shader recovers OCS world position, rotates by -patternAngle,
 *    samples texture with NEAREST filter, outputs entity color where the
 *    texture pixel is opaque. Background is transparent (depthWrite off) so
 *    underlying line geometry shows through.
 *  - No real stencil ops yet. The shader-based approach gives an equivalent
 *    result without needing per-mesh stencil ref management and is simpler to
 *    reason about.
 *
 * Public API:
 *  attachHatchOverlay(viewer, three) → THREE.Group | null
 *    Reads viewer.GetScene().hatchFills, builds the overlay group, adds it as
 *    a child of viewer.scene, and triggers a render. Returns the group so the
 *    caller can dispose / hide it.
 *
 *  disposeHatchOverlay(group)
 *    Frees geometry, material, and texture resources.
 */

type HatchPatternLine = {
  angle: number;
  base: { x: number; y: number };
  offset: { x: number; y: number };
  dashes: number[];
};

type HatchPattern = {
  name: string | null;
  scale: number;
  angle: number;
  lines: HatchPatternLine[];
};

type HatchFillRecord = {
  handle: string | null;
  layer: string | null;
  color: number;
  vertices: Float32Array;
  indices: Uint16Array | Uint32Array;
  pattern: HatchPattern | null;
};

type ThreeNS = typeof import("three");

const TEX_SIZE = 256;
const DEFAULT_OPACITY = 0.85;
const DEFAULT_TILE_WORLD_UNITS = 25; // one canvas tile maps to this many world units when pattern.scale=1

type TexCacheKey = string;
const texCache = new WeakMap<ThreeNS, Map<TexCacheKey, any>>();

function getTexCache(three: ThreeNS): Map<TexCacheKey, any> {
  let m = texCache.get(three);
  if (!m) {
    m = new Map();
    texCache.set(three, m);
  }
  return m;
}

function patternCacheKey(p: HatchPattern): TexCacheKey {
  // Texture content depends on the line set + scale (pattern.angle is applied
  // per-mesh in the shader so does NOT affect the texture, allowing reuse
  // across hatches that share a pattern at different rotations).
  const linesKey = (p.lines ?? [])
    .map(
      (l) =>
        `${l.angle.toFixed(4)}|${l.offset.x.toFixed(4)},${l.offset.y.toFixed(4)}|${(l.dashes ?? []).join(",")}`,
    )
    .join(";");
  return `${p.name ?? "?"}|s=${p.scale.toFixed(4)}|${linesKey}`;
}

/**
 * Render a single pattern repeat to a transparent canvas. Black ink on
 * transparent ground. The shader uses RepeatWrapping so we only need one tile.
 *
 * Coordinate convention: canvas (0,0) maps to OCS (0,0); +x right, +y up
 * (we flip on draw because canvas y is down).
 *
 * For each pattern line we draw the line at its base+offset positions, tiled
 * within the canvas. Dashed patterns are simplified: we draw solid lines for
 * now (dash spacing is sub-pixel at this tile resolution anyway).
 */
function renderPatternToCanvas(p: HatchPattern): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = TEX_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  ctx.clearRect(0, 0, TEX_SIZE, TEX_SIZE);
  ctx.strokeStyle = "rgba(0,0,0,1)";
  ctx.lineWidth = 1;
  ctx.lineCap = "butt";

  // Map: one canvas pixel = (DEFAULT_TILE_WORLD_UNITS * p.scale) / TEX_SIZE world units.
  const worldPerPixel = (DEFAULT_TILE_WORLD_UNITS * (p.scale || 1)) / TEX_SIZE;
  const pixelPerWorld = 1 / worldPerPixel;

  // Translate so the tile center is at canvas center, flip y.
  ctx.save();
  ctx.translate(TEX_SIZE / 2, TEX_SIZE / 2);
  ctx.scale(1, -1);

  const halfDiag = TEX_SIZE; // pixels; line extends across the tile

  for (const line of p.lines ?? []) {
    const angle = line.angle ?? 0;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    // perpendicular spacing between parallel copies (in world units)
    const ox = line.offset?.x ?? 0;
    const oy = line.offset?.y ?? 0;
    const offsetLen = Math.hypot(ox, oy);
    if (offsetLen < 1e-9) {
      // single line through base
      const bx = (line.base?.x ?? 0) * pixelPerWorld;
      const by = (line.base?.y ?? 0) * pixelPerWorld;
      ctx.beginPath();
      ctx.moveTo(bx - c * halfDiag, by - s * halfDiag);
      ctx.lineTo(bx + c * halfDiag, by + s * halfDiag);
      ctx.stroke();
      continue;
    }
    // Perpendicular unit vector (in canvas-space, after our scale=1,-1 we still use math y-up)
    const perpLen = pixelPerWorld * offsetLen;
    // unit perpendicular to line direction (cos,sin):
    const px = -s;
    const py = c;
    // how many copies needed to cover ±halfDiag along the perpendicular?
    const copies = Math.ceil(halfDiag / Math.max(perpLen, 0.5)) + 1;
    const bx = (line.base?.x ?? 0) * pixelPerWorld;
    const by = (line.base?.y ?? 0) * pixelPerWorld;
    for (let k = -copies; k <= copies; k++) {
      const cx = bx + px * k * perpLen;
      const cy = by + py * k * perpLen;
      ctx.beginPath();
      ctx.moveTo(cx - c * halfDiag, cy - s * halfDiag);
      ctx.lineTo(cx + c * halfDiag, cy + s * halfDiag);
      ctx.stroke();
    }
  }

  ctx.restore();
  return canvas;
}

function getOrCreatePatternTexture(
  three: ThreeNS,
  pattern: HatchPattern,
): any {
  const cache = getTexCache(three);
  const key = patternCacheKey(pattern);
  const cached = cache.get(key);
  if (cached) return cached;
  const canvas = renderPatternToCanvas(pattern);
  const tex = new three.CanvasTexture(canvas);
  tex.wrapS = three.RepeatWrapping;
  tex.wrapT = three.RepeatWrapping;
  tex.magFilter = three.NearestFilter;
  tex.minFilter = three.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  cache.set(key, tex);
  return tex;
}

const HATCH_VERT_SHADER = `
  varying vec2 vScenePos;
  void main() {
    vScenePos = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// `worldOffset` is the scene origin in OCS world units (viewer subtracts it
// from vertex positions when building geometry; we add it back in the shader
// so pattern is anchored to OCS, not the camera).
const HATCH_FRAG_SHADER = `
  uniform sampler2D patTex;
  uniform vec2  worldOffset;
  uniform float patTileSize;  // world units per tile
  uniform float patAngle;     // radians
  uniform vec3  patColor;
  uniform float patAlpha;
  varying vec2 vScenePos;
  void main() {
    vec2 ocs = vScenePos + worldOffset;
    float c = cos(-patAngle);
    float s = sin(-patAngle);
    vec2 rot = vec2(ocs.x * c - ocs.y * s, ocs.x * s + ocs.y * c);
    vec2 uv = rot / patTileSize;
    vec4 t = texture2D(patTex, fract(uv));
    if (t.a < 0.1) discard;
    gl_FragColor = vec4(patColor, patAlpha * t.a);
  }
`;

function buildPatternMaterial(
  three: ThreeNS,
  fill: HatchFillRecord,
  origin: { x: number; y: number },
): any {
  const pattern = fill.pattern;
  /* Fall back to a flat translucent fill when:
   *  - the hatch has no pattern at all (solid hatches handled here too if a
   *    consumer ever pushes them), OR
   *  - the parser knew the pattern's NAME but never populated `definitionLines`
   *    (common for third-party-converted DXFs). Without this fallback the
   *    shader would sample a blank canvas and discard every fragment, making
   *    the hatch silently invisible. */
  if (!pattern || !pattern.lines || pattern.lines.length === 0) {
    return new three.MeshBasicMaterial({
      color: fill.color,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      side: three.DoubleSide,
    });
  }
  const tex = getOrCreatePatternTexture(three, pattern);
  return new three.ShaderMaterial({
    uniforms: {
      patTex: { value: tex },
      worldOffset: { value: new three.Vector2(origin.x, origin.y) },
      patTileSize: { value: DEFAULT_TILE_WORLD_UNITS * (pattern.scale || 1) },
      patAngle: { value: pattern.angle || 0 },
      patColor: { value: new three.Color(fill.color) },
      patAlpha: { value: DEFAULT_OPACITY },
    },
    vertexShader: HATCH_VERT_SHADER,
    fragmentShader: HATCH_FRAG_SHADER,
    transparent: true,
    depthWrite: false,
    side: three.DoubleSide,
  });
}

export function attachHatchOverlay(
  viewer: any,
  three: ThreeNS,
): any {
  const dxfScene = viewer?.GetScene?.();
  const fills: HatchFillRecord[] | undefined = dxfScene?.hatchFills;
  if (!fills || fills.length === 0) return null;
  const origin = viewer.GetOrigin?.() ?? { x: 0, y: 0 };

  const group = new three.Group();
  group.name = "__hatch_overlay";

  let attached = 0;
  for (const fill of fills) {
    if (!fill?.vertices || fill.vertices.length < 6) continue;
    // Build XYZ buffer with origin offset applied (scene vertices are stored
    // relative to origin elsewhere in dxf-viewer; do the same here so the
    // mesh aligns with the rest of the scene under viewer.scene).
    const nVerts = fill.vertices.length / 2;
    const pos = new Float32Array(nVerts * 3);
    for (let i = 0; i < nVerts; i++) {
      pos[i * 3]     = fill.vertices[i * 2]     - origin.x;
      pos[i * 3 + 1] = fill.vertices[i * 2 + 1] - origin.y;
      pos[i * 3 + 2] = 0;
    }
    const geom = new three.BufferGeometry();
    geom.setAttribute("position", new three.BufferAttribute(pos, 3));
    geom.setIndex(new three.BufferAttribute(fill.indices, 1));

    const material = buildPatternMaterial(three, fill, origin);
    const mesh = new three.Mesh(geom, material);
    mesh.renderOrder = -1; // draw before line geometry so lines overlay hatches
    /* Mirror dxf-viewer's per-layer visibility: the viewer toggles each batch's
     * material.visible when a layer is hidden in the layer panel. Our overlay
     * meshes live outside that system, so honor the same flag at attach time
     * AND expose the layer name on userData so a future hook can sync. */
    if (fill.layer) {
      const layerObj = viewer.GetLayers?.()?.find?.((l: any) => l?.name === fill.layer);
      if (layerObj && layerObj.displayName !== undefined && layerObj.visible === false) {
        mesh.visible = false;
      }
    }
    mesh.userData = {
      kind: "hatch-overlay",
      handle: fill.handle,
      layer: fill.layer,
    };
    group.add(mesh);
    attached++;
  }

  if (attached === 0) return null;
  viewer.scene.add(group);
  viewer.Render?.();
  // Per-layer breakdown helps diagnose "this layer isn't rendering" reports —
  // shows whether the layer made it into the overlay at all, and how many of
  // its hatches fell back to flat fills due to missing pattern.lines.
  const byLayer = new Map<string, { total: number; flat: number }>();
  for (const fill of fills) {
    const k = fill.layer ?? "(none)";
    const rec = byLayer.get(k) ?? { total: 0, flat: 0 };
    rec.total++;
    if (!fill.pattern || !fill.pattern.lines || fill.pattern.lines.length === 0) {
      rec.flat++;
    }
    byLayer.set(k, rec);
  }
  // eslint-disable-next-line no-console
  console.log(
    `[hatch-overlay] attached ${attached} pattern-fill meshes; per-layer:`,
    Object.fromEntries(byLayer),
  );
  return group;
}

/** Re-sync hatch-overlay mesh visibility against the viewer's current layer state.
 *  Call after the user toggles a layer in the dxf-viewer layer panel. */
export function syncHatchOverlayVisibility(viewer: any, group: any): void {
  if (!group || !viewer) return;
  const layers = viewer.GetLayers?.() ?? [];
  const visMap = new Map<string, boolean>();
  for (const l of layers) {
    if (l?.name) visMap.set(l.name, l.visible !== false);
  }
  group.traverse((obj: any) => {
    const layerName = obj?.userData?.layer;
    if (!layerName) return;
    const v = visMap.get(layerName);
    if (v !== undefined) obj.visible = v;
  });
  viewer.Render?.();
}

export function disposeHatchOverlay(group: any): void {
  if (!group) return;
  group.traverse((obj: any) => {
    if (obj.geometry?.dispose) obj.geometry.dispose();
    if (obj.material?.dispose) {
      const tex = obj.material.uniforms?.patTex?.value;
      // Don't dispose cached textures here — they may be shared. Cache lives
      // for the page session.
      void tex;
      obj.material.dispose();
    }
  });
  group.parent?.remove(group);
}
