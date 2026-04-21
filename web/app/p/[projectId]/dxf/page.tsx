"use client";

import { use, useEffect, useRef, useState } from "react";
import { getToken } from "../../../lib/auth";

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE || "").replace(/\/$/, "");

function resolveApiBase() {
  if (API_BASE) return API_BASE;
  if (typeof window !== "undefined") {
    const host = window.location.hostname;
    if (host === "localhost" || host === "127.0.0.1") {
      return "http://localhost:8000";
    }
  }
  return "";
}

const apiUrl = (path: string) => `${resolveApiBase()}${path}`;

const FONTS = [
  "https://cdn.jsdelivr.net/fontsource/fonts/noto-sans@latest/latin-400-normal.ttf",
  "https://cdn.jsdelivr.net/fontsource/fonts/noto-sans@latest/latin-700-normal.ttf",
];

type LayerInfo = { name: string; displayName: string; color: number; visible: boolean };
type BlockInfo = { name: string; count: number; insertions: Array<{ x: number; y: number }> };
type FloorPlanInfo = {
  id: string;
  block_index: number;
  status: string;
  world_bbox: { xmin: number; ymin: number; xmax: number; ymax: number } | null;
};

type Detector = {
  id: string;
  x: number;
  y: number;
  z?: number;
  dtype: string;
  floor_plan_id?: string | null;
};

const EQUIPMENT_BUTTONS: { key: string; label: string; color: string }[] = [
  { key: "smoke",      label: "Smoke Detectors", color: "#ef4444" },
  { key: "sprinkler",  label: "Sprinklers",      color: "#3b82f6" },
  { key: "fire_hose",  label: "External Hydrant",color: "#f59e0b" },
  { key: "mcp_hooter", label: "MCP + Hooter",    color: "#a855f7" },
];

const DTYPE_COLORS: Record<string, string> = {
  smoke:      "#ef4444",
  sprinkler:  "#3b82f6",
  fire_hose:  "#f59e0b",
  internal_hydrant: "#f97316",
  mcb:        "#a855f7",
  hooter:     "#ec4899",
  panel:      "#14b8a6",
};

// Real-world symbol radius (meters) per detector type. Converted to drawing
// units at render time using the project's world_to_m (from settings).
// Smoke/MCP/hooter symbols are small (~1 cm), while a sprinkler's circle
// represents its coverage radius (~1.8 m) as is standard on fire plans.
const DTYPE_RADIUS_M: Record<string, number> = {
  smoke:            0.10,
  sprinkler:        0.40,
  fire_hose:        0.50,
  internal_hydrant: 0.50,
  mcb:              0.50,
  hooter:           0.50,
  panel:            0.50,
};
const DEFAULT_RADIUS_M = 0.05;

const UNIT_TO_M: Record<string, number> = {
  mm: 0.001, cm: 0.01, m: 1.0, inch: 0.0254, in: 0.0254, ft: 0.3048,
};

function resolveWorldToM(settings: any): number {
  const w = Number(settings?.world_to_m);
  if (Number.isFinite(w) && w > 0) return w;
  const d = Number(settings?.dxf_to_world);
  if (Number.isFinite(d) && d > 0) return d;
  const key = String(settings?.unit || settings?.units || "mm").trim().toLowerCase();
  return UNIT_TO_M[key] ?? 0.001;
}

export default function DxfViewerPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<any>(null);
  const threeRef = useRef<any>(null);
  const highlightGroupRef = useRef<any>(null);
  const detectorsGroupRef = useRef<any>(null);

  const [dxfUrl, setDxfUrl] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState<{ phase: string; pct: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [layers, setLayers] = useState<LayerInfo[]>([]);
  const [showLayers, setShowLayers] = useState(false);
  const [blocks, setBlocks] = useState<BlockInfo[]>([]);
  const [showBlocks, setShowBlocks] = useState(false);
  const [selectedBlock, setSelectedBlock] = useState<string | null>(null);
  const [floorPlans, setFloorPlans] = useState<FloorPlanInfo[]>([]);
  const [showFloors, setShowFloors] = useState(true);
  const [selectedFloorId, setSelectedFloorId] = useState<string | null>(null);
  const [floorOpacity, setFloorOpacity] = useState<number>(0.28);
  const [detectors, setDetectors] = useState<Detector[]>([]);
  const [isAutoPlacing, setIsAutoPlacing] = useState<string | null>(null);
  const [autoPlaceMsg, setAutoPlaceMsg] = useState<string | null>(null);
  const [worldToM, setWorldToM] = useState<number>(0.001);
  const [bgIdx, setBgIdx] = useState(0);

  const bgColors = ["#2d2d2d", "#ffffff", "#181825", "#000000"];

  // Fetch project and determine input DXF URL
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = getToken();
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (token) headers.Authorization = `Bearer ${token}`;
        const res = await fetch(apiUrl(`/api/projects/${projectId}`), { headers });
        if (!res.ok) throw new Error(`Project fetch failed (${res.status})`);
        const proj = await res.json();
        if (cancelled) return;

        setProjectName(proj?.name || "");

        // Resolve world_to_m from project settings/units so equipment radii
        // drawn on screen reflect true physical sizes.
        try {
          setWorldToM(resolveWorldToM(proj?.settings || {}));
        } catch { /* keep default */ }

        const inputDxf = proj?.files?.dxf;
        if (!inputDxf) {
          throw new Error("This project has no input DXF.");
        }
        setDxfUrl(apiUrl(inputDxf));

        // Fetch pipeline-extracted floor plan blocks (if any).
        if (proj?.floor_plans_count && proj.floor_plans_count > 0) {
          try {
            const fpRes = await fetch(apiUrl(`/api/projects/${projectId}/floor_plans`), { headers });
            if (fpRes.ok) {
              const fps = await fpRes.json();
              if (!cancelled && Array.isArray(fps)) {
                setFloorPlans(
                  fps.map((fp: any) => ({
                    id: String(fp.id),
                    block_index: Number(fp.block_index) || 0,
                    status: String(fp.status || ""),
                    world_bbox: fp.world_bbox || null,
                  })),
                );
              }
            }
          } catch { /* non-fatal */ }
        }

        // Fetch any already-placed detectors so they're drawn on first load.
        try {
          const detRes = await fetch(apiUrl(`/api/projects/${projectId}/detectors`), { headers });
          if (detRes.ok) {
            const ds = await detRes.json();
            if (!cancelled && Array.isArray(ds)) {
              setDetectors(ds as Detector[]);
            }
          }
        } catch { /* non-fatal */ }
      } catch (err: any) {
        if (!cancelled) setError(err?.message || "Failed to load project.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Create viewer and load DXF when URL becomes available
  useEffect(() => {
    if (!dxfUrl) return;
    let cancelled = false;
    (async () => {
      if (!containerRef.current) return;
      setError(null);
      setProgress({ phase: "Fetching…", pct: 0 });

      // IMPORTANT: dxf-viewer bundles its own nested copy of three (^0.161)
      // while the app depends on three ^0.181. If we create objects from the
      // app's three and add them to the viewer's scene, they render as
      // invisible black geometry (different class identities / shader pipeline).
      // Import three from dxf-viewer's nested copy so all objects share the
      // exact same three instance the viewer uses.
      const [{ DxfViewer }, three] = await Promise.all([
        import("dxf-viewer"),
        import("dxf-viewer/node_modules/three"),
      ]);
      if (cancelled || !containerRef.current) return;
      threeRef.current = three;

      if (viewerRef.current) {
        try { viewerRef.current.Destroy?.(); } catch {}
        viewerRef.current = null;
      }

      const viewer = new (DxfViewer as any)(containerRef.current, {
        clearColor: new three.Color(bgColors[bgIdx]),
        autoResize: true,
        colorCorrection: true,
        blackWhiteInversion: true,
        antialias: true,
        // Required so GetDxf() returns the parsed DXF (blocks, entities, …).
        // Without this the Blocks panel always reports 0.
        retainParsedDxf: true,
        sceneOptions: {
          wireframeMesh: true,
          suppressPaperSpace: false,
        },
      });
      viewerRef.current = viewer;

      viewer.Subscribe("loaded", () => {
        const raw = viewer.GetLayers?.();
        if (raw && Array.isArray(raw)) {
          const sorted = [...raw].sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));
          const next: LayerInfo[] = sorted.map((l: any) => ({
            name: String(l.name),
            displayName: String(l.displayName || l.name),
            color: Number(l.color) || 0xffffff,
            visible: true,
          }));
          setLayers(next);
        } else {
          setLayers([]);
        }

        // Extract block definitions and gather all INSERT positions across the DXF.
        try {
          const dxf = viewer.GetDxf?.();
          const blockDefs: Record<string, any> = dxf?.blocks || {};
          const topEntities: any[] = Array.isArray(dxf?.entities) ? dxf.entities : [];

          // Recursively walk entities collecting INSERTs by block name, resolving
          // nested block references so we get world-space positions for each leaf.
          const byName = new Map<string, { x: number; y: number }[]>();
          const visited = new Set<string>();

          function addInsert(name: string, x: number, y: number) {
            if (!name) return;
            const arr = byName.get(name) || [];
            arr.push({ x, y });
            byName.set(name, arr);
          }

          function walk(entities: any[], ox: number, oy: number, depth: number) {
            if (!entities || depth > 8) return;
            for (const e of entities) {
              if (!e || typeof e !== "object") continue;
              const type = String(e.type || "").toUpperCase();
              if (type === "INSERT" && e.name && e.position) {
                const ix = (Number(e.position.x) || 0) + ox;
                const iy = (Number(e.position.y) || 0) + oy;
                addInsert(String(e.name), ix, iy);
                // Recurse into referenced block so nested INSERTs inside it also count.
                const def = blockDefs[e.name];
                if (def && Array.isArray(def.entities) && !visited.has(e.name)) {
                  visited.add(e.name);
                  walk(def.entities, ix, iy, depth + 1);
                  visited.delete(e.name);
                }
              }
            }
          }

          walk(topEntities, 0, 0, 0);

          // Build list from all known block definitions so blocks with zero
          // top-level inserts still appear (e.g. nested-only or unused blocks).
          const names = new Set<string>([
            ...Object.keys(blockDefs),
            ...byName.keys(),
          ]);
          const list: BlockInfo[] = [...names]
            .filter((n) => !!n && !n.startsWith("*"))
            .map((name) => {
              const insertions = byName.get(name) || [];
              return { name, count: insertions.length, insertions };
            })
            .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
          setBlocks(list);
        } catch {
          setBlocks([]);
        }
        setSelectedBlock(null);

        const bounds = viewer.GetBounds?.();
        const origin = viewer.GetOrigin?.() || { x: 0, y: 0 };
        if (bounds) {
          // FitView expects scene-local coordinates (origin already subtracted).
          viewer.FitView?.(
            bounds.minX - origin.x, bounds.maxX - origin.x,
            bounds.minY - origin.y, bounds.maxY - origin.y,
            0.08,
          );
        }
      });

      viewer.Subscribe("message", (e: any) => {
        if (e?.level === "warn" || e?.level === "error") {
          console.warn("[dxf-viewer]", e?.message || e);
        }
      });

      try {
        await viewer.Load({
          url: dxfUrl,
          fonts: FONTS,
          progressCbk: (phase: string, processed: number, total: number) => {
            if (cancelled) return;
            const label =
              phase === "fetch" ? "Fetching…" :
              phase === "parse" ? "Parsing…" :
              phase === "prepare" ? "Preparing…" :
              phase === "font" ? "Loading fonts…" : phase;
            const pct = total && total > 0 ? Math.round((processed / total) * 100) : 100;
            setProgress({ phase: label, pct });
          },
          workerFactory: null,
        });
      } catch (err: any) {
        if (!cancelled) setError(err?.message || "Failed to load DXF.");
      } finally {
        if (!cancelled) setProgress(null);
      }
    })();
    return () => {
      cancelled = true;
      if (viewerRef.current) {
        try { viewerRef.current.Destroy?.(); } catch {}
        viewerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dxfUrl]);

  // Background color
  useEffect(() => {
    const viewer = viewerRef.current;
    const three = threeRef.current;
    if (!viewer || !three) return;
    const renderer = viewer.GetRenderer?.();
    if (renderer) {
      renderer.setClearColor(new three.Color(bgColors[bgIdx]));
      viewer.Render?.();
    }
  }, [bgIdx]);

  function fitView() {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const bounds = viewer.GetBounds?.();
    const origin = viewer.GetOrigin?.() || { x: 0, y: 0 };
    if (bounds) {
      viewer.FitView?.(
        bounds.minX - origin.x, bounds.maxX - origin.x,
        bounds.minY - origin.y, bounds.maxY - origin.y,
        0.08,
      );
    }
  }

  // Live-update floor-plan highlight opacity when the slider changes.
  useEffect(() => {
    const viewer = viewerRef.current;
    const group = highlightGroupRef.current;
    if (!viewer || !group) return;
    try {
      group.traverse?.((obj: any) => {
        if (obj?.userData?.kind === "floor-fill" && obj.material && !obj.material.disposed) {
          obj.material.opacity = floorOpacity;
          obj.material.transparent = true;
        }
      });
      viewer.Render?.();
    } catch (err) {
      // Ignore transient errors (e.g. group disposed mid-update).
      console.warn("[dxf-viewer] opacity update skipped:", err);
    }
  }, [floorOpacity]);

  function toggleLayer(name: string, visible: boolean) {
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.ShowLayer?.(name, visible);
    setLayers((prev) => prev.map((l) => (l.name === name ? { ...l, visible } : l)));
  }

  function clearHighlight() {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const scene = viewer.GetScene?.();
    const group = highlightGroupRef.current;
    if (group && scene) {
      scene.remove(group);
      group.traverse((obj: any) => {
        if (obj.geometry) obj.geometry.dispose?.();
        if (obj.material) {
          if (Array.isArray(obj.material)) obj.material.forEach((m: any) => m.dispose?.());
          else obj.material.dispose?.();
        }
      });
    }
    highlightGroupRef.current = null;
    viewer.Render?.();
  }

  function highlightBlock(blockName: string) {
    const viewer = viewerRef.current;
    const three = threeRef.current;
    if (!viewer || !three) return;
    const block = blocks.find((b) => b.name === blockName);
    if (!block) return;

    clearHighlight();

    const origin = viewer.GetOrigin?.() || { x: 0, y: 0 };
    const bounds = viewer.GetBounds?.();
    let radius = 50;
    if (bounds) {
      const dx = bounds.maxX - bounds.minX;
      const dy = bounds.maxY - bounds.minY;
      radius = Math.max(dx, dy) * 0.008;
    }

    // Fall back to the block definition's own entities if there are no INSERTs
    // (happens when the viewer flattens/inlines blocks).
    let points = block.insertions;
    if (points.length === 0) {
      try {
        const dxf = viewer.GetDxf?.();
        const def = dxf?.blocks?.[block.name];
        const xs: number[] = [];
        const ys: number[] = [];
        const push = (x: any, y: any) => {
          const nx = Number(x); const ny = Number(y);
          if (Number.isFinite(nx) && Number.isFinite(ny)) { xs.push(nx); ys.push(ny); }
        };
        const visit = (ents: any[]) => {
          if (!Array.isArray(ents)) return;
          for (const e of ents) {
            if (!e) continue;
            if (e.position) push(e.position.x, e.position.y);
            if (e.startPoint) push(e.startPoint.x, e.startPoint.y);
            if (e.endPoint) push(e.endPoint.x, e.endPoint.y);
            if (e.center) push(e.center.x, e.center.y);
            if (Array.isArray(e.vertices)) {
              for (const v of e.vertices) push(v.x, v.y);
            }
          }
        };
        visit(def?.entities);
        if (xs.length) {
          const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
          const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
          const bx = Number(def?.position?.x) || 0;
          const by = Number(def?.position?.y) || 0;
          points = [{ x: cx + bx, y: cy + by }];
        }
      } catch {}
    }

    if (points.length === 0) return;

    const group = new three.Group();
    const color = new three.Color("#ff3b30");

    for (const ins of points) {
      const x = ins.x - origin.x;
      const y = ins.y - origin.y;

      const disc = new three.Mesh(
        new three.CircleGeometry(radius, 48),
        new three.MeshBasicMaterial({ color, transparent: true, opacity: 0.25, depthTest: false }),
      );
      disc.position.set(x, y, 0);
      disc.renderOrder = 999;
      group.add(disc);

      const ringGeom = new three.RingGeometry(radius * 0.95, radius * 1.1, 48);
      const ring = new three.Mesh(
        ringGeom,
        new three.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false }),
      );
      ring.position.set(x, y, 0);
      ring.renderOrder = 1000;
      group.add(ring);
    }

    const scene = viewer.GetScene?.();
    if (scene) scene.add(group);
    highlightGroupRef.current = group;
    viewer.Render?.();
  }

  function selectBlock(name: string) {
    if (selectedBlock === name) {
      setSelectedBlock(null);
      clearHighlight();
    } else {
      setSelectedFloorId(null);
      setSelectedBlock(name);
      highlightBlock(name);
    }
  }

  function highlightFloorPlan(fp: FloorPlanInfo) {
    const viewer = viewerRef.current;
    const three = threeRef.current;
    if (!viewer || !three) return;
    const bb = fp.world_bbox;
    if (!bb) return;

    clearHighlight();

    const origin = viewer.GetOrigin?.() || { x: 0, y: 0 };
    const x0 = bb.xmin - origin.x;
    const y0 = bb.ymin - origin.y;
    const x1 = bb.xmax - origin.x;
    const y1 = bb.ymax - origin.y;
    const w = x1 - x0;
    const h = y1 - y0;
    if (!(w > 0 && h > 0)) return;

    const group = new three.Group();
    const color = new three.Color("#22d3ee");

    // Translucent filled rectangle. Use DoubleSide so it shows regardless of
    // the camera orientation, and push it slightly in +Z so it sits on top of
    // the drawing geometry.
    const fill = new three.Mesh(
      new three.PlaneGeometry(w, h),
      new three.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: floorOpacity,
        depthTest: false,
        depthWrite: false,
        side: three.DoubleSide,
      }),
    );
    fill.position.set(x0 + w / 2, y0 + h / 2, 0.5);
    fill.renderOrder = 999;
    (fill as any).userData = { kind: "floor-fill" };
    group.add(fill);

    // Outline (thicker / brighter for visibility).
    const outlineGeom = new three.BufferGeometry().setFromPoints([
      new three.Vector3(x0, y0, 0.6),
      new three.Vector3(x1, y0, 0.6),
      new three.Vector3(x1, y1, 0.6),
      new three.Vector3(x0, y1, 0.6),
      new three.Vector3(x0, y0, 0.6),
    ]);
    const outline = new three.Line(
      outlineGeom,
      new three.LineBasicMaterial({
        color,
        transparent: true,
        opacity: 1.0,
        depthTest: false,
        depthWrite: false,
        linewidth: 3,
      }),
    );
    outline.renderOrder = 1000;
    group.add(outline);

    const scene = viewer.GetScene?.();
    if (scene) scene.add(group);
    highlightGroupRef.current = group;

    // Zoom to the block with a small padding. FitView expects scene-local
    // coordinates (origin already subtracted).
    viewer.FitView?.(
      bb.xmin - origin.x, bb.xmax - origin.x,
      bb.ymin - origin.y, bb.ymax - origin.y,
      0.1,
    );
    viewer.Render?.();
  }

  function selectFloorPlan(fp: FloorPlanInfo) {
    if (selectedFloorId === fp.id) {
      setSelectedFloorId(null);
      clearHighlight();
      return;
    }
    setSelectedBlock(null);
    setSelectedFloorId(fp.id);
    highlightFloorPlan(fp);
  }

  // ── Detector rendering ──

  function clearDetectorMarkers() {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const scene = viewer.GetScene?.();
    const group = detectorsGroupRef.current;
    if (group && scene) {
      scene.remove(group);
      group.traverse?.((obj: any) => {
        if (obj.geometry) obj.geometry.dispose?.();
        if (obj.material) {
          if (Array.isArray(obj.material)) obj.material.forEach((m: any) => m.dispose?.());
          else obj.material.dispose?.();
        }
      });
    }
    detectorsGroupRef.current = null;
  }

  function renderDetectors() {
    const viewer = viewerRef.current;
    const three = threeRef.current;
    if (!viewer || !three) return;

    clearDetectorMarkers();
    if (detectors.length === 0) { viewer.Render?.(); return; }

    const origin = viewer.GetOrigin?.() || { x: 0, y: 0 };

    // Use the project's configured scale directly:
    //   drawing_units × world_to_m = meters  ⇒  units_per_m = 1 / world_to_m
    // e.g. world_to_m = 1   (meters)      → 1 unit/m
    //      world_to_m = 0.001 (mm)        → 1000 units/m
    const wtm = Number.isFinite(worldToM) && worldToM > 0 ? worldToM : 1.0;
    const unitsPerMeter = 1.0 / wtm;

    function radiusFor(dtype: string): number {
      const rMeters = DTYPE_RADIUS_M[dtype] ?? DEFAULT_RADIUS_M;
      return rMeters * unitsPerMeter;
    }

    const group = new three.Group();
    for (const d of detectors) {
      const x = Number(d.x) - origin.x;
      const y = Number(d.y) - origin.y;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

      const radius = radiusFor(d.dtype);
      const color = new three.Color(DTYPE_COLORS[d.dtype] || "#22d3ee");

      // Sprinklers: draw a translucent coverage disc so the 1.8 m radius is
      // visually meaningful, plus a smaller solid core dot.
      if (d.dtype === "sprinkler") {
        const coverage = new three.Mesh(
          new three.CircleGeometry(radius, 48),
          new three.MeshBasicMaterial({
            color, transparent: true, opacity: 0.18,
            depthTest: false, depthWrite: false, side: three.DoubleSide,
          }),
        );
        coverage.position.set(x, y, 0.68);
        coverage.renderOrder = 1099;
        group.add(coverage);

        const coreR = Math.max(radius * 0.12, radius * 0.08);
        const core = new three.Mesh(
          new three.CircleGeometry(coreR, 24),
          new three.MeshBasicMaterial({
            color, transparent: true, opacity: 0.95,
            depthTest: false, depthWrite: false, side: three.DoubleSide,
          }),
        );
        core.position.set(x, y, 0.70);
        core.renderOrder = 1100;
        group.add(core);

        // Thin outline ring at the coverage radius.
        const outlineR = radius;
        const outlinePts: any[] = [];
        for (let i = 0; i <= 64; i++) {
          const t = (i / 64) * Math.PI * 2;
          outlinePts.push(new three.Vector3(x + outlineR * Math.cos(t), y + outlineR * Math.sin(t), 0.71));
        }
        const outlineGeom = new three.BufferGeometry().setFromPoints(outlinePts);
        const outline = new three.Line(
          outlineGeom,
          new three.LineBasicMaterial({
            color, transparent: true, opacity: 0.85,
            depthTest: false, depthWrite: false,
          }),
        );
        outline.renderOrder = 1101;
        group.add(outline);
        continue;
      }

      // Other dtypes: solid disc at physical size + white ring outline.
      const disc = new three.Mesh(
        new three.CircleGeometry(radius, 32),
        new three.MeshBasicMaterial({
          color, transparent: true, opacity: 0.9,
          depthTest: false, depthWrite: false, side: three.DoubleSide,
        }),
      );
      disc.position.set(x, y, 0.7);
      disc.renderOrder = 1100;
      group.add(disc);

      const ring = new three.Mesh(
        new three.RingGeometry(radius, radius * 1.2, 32),
        new three.MeshBasicMaterial({
          color: new three.Color("#ffffff"),
          transparent: true, opacity: 0.9,
          depthTest: false, depthWrite: false, side: three.DoubleSide,
        }),
      );
      ring.position.set(x, y, 0.71);
      ring.renderOrder = 1101;
      group.add(ring);
    }

    const scene = viewer.GetScene?.();
    if (scene) scene.add(group);
    detectorsGroupRef.current = group;
    viewer.Render?.();
  }

  // Re-render detector markers whenever the list or scale changes.
  useEffect(() => {
    renderDetectors();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detectors, dxfUrl, worldToM]);

  async function autoPlaceEquipment(dtype: string) {
    if (!selectedFloorId) {
      setAutoPlaceMsg("Select a floor plan first.");
      return;
    }
    setIsAutoPlacing(dtype);
    setAutoPlaceMsg(null);
    try {
      const token = getToken();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;

      const res = await fetch(
        apiUrl(`/api/projects/${projectId}/floor_plans/${selectedFloorId}/auto_place`),
        { method: "POST", headers, body: JSON.stringify({ equipment_type: dtype }) },
      );
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Auto-place failed (${res.status})`);
      }
      const placed: Detector[] = await res.json();

      // Merge like the editor: replace this type's detectors with the new results.
      setDetectors(prev => {
        if (dtype === "mcp_hooter") {
          return [
            ...prev.filter(d => d.dtype !== "mcb" && d.dtype !== "hooter"),
            ...placed.filter(d => d.dtype === "mcb" || d.dtype === "hooter"),
          ];
        }
        return [
          ...prev.filter(d => d.dtype !== dtype),
          ...placed.filter(d => d.dtype === dtype),
        ];
      });
      const count = dtype === "mcp_hooter"
        ? placed.filter(d => d.dtype === "mcb" || d.dtype === "hooter").length
        : placed.filter(d => d.dtype === dtype).length;
      setAutoPlaceMsg(`Placed ${count} ${dtype === "mcp_hooter" ? "MCP/Hooter" : dtype} item${count === 1 ? "" : "s"}.`);
    } catch (e: any) {
      console.error("Auto-place failed", e);
      setAutoPlaceMsg(e?.message || "Auto-place failed.");
    } finally {
      setIsAutoPlacing(null);
    }
  }

  function colorToHex(c: number) {
    const three = threeRef.current;
    if (three) {
      return "#" + new three.Color(c).getHexString();
    }
    return "#ffffff";
  }

  return (
    <main
      style={{
        position: "fixed", inset: 0,
        display: "flex", flexDirection: "column",
        fontFamily: "'Segoe UI', system-ui, sans-serif",
        background: "#1e1e2e", color: "#cdd6f4",
        overflow: "hidden",
      }}
    >
      <header
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "10px 16px", borderBottom: "1px solid #313244",
          background: "#181825", flexShrink: 0, zIndex: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <a
            href={`/p/${projectId}`}
            style={{ color: "#cba6f7", textDecoration: "none", fontSize: 13 }}
          >
            ← Back to editor
          </a>
          <h1 style={{ fontSize: 15, fontWeight: 600, color: "#cba6f7", margin: 0 }}>
            📐 DXF Viewer
          </h1>
          {projectName ? (
            <span style={{ fontSize: 12, color: "#a6adc8" }}>— {projectName}</span>
          ) : null}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={fitView} style={btnStyle}>⊡ Fit</button>
          <button onClick={() => setShowLayers((v) => !v)} style={btnStyle}>
            ☰ Layers ({layers.length})
          </button>
          <button onClick={() => setShowBlocks((v) => !v)} style={btnStyle}>
            ▦ Blocks ({blocks.length})
          </button>
          {floorPlans.length > 0 ? (
            <button
              onClick={() => setShowFloors((v) => !v)}
              style={{
                ...btnStyle,
                background: showFloors ? "#3a3a5c" : btnStyle.background,
                borderColor: showFloors ? "#89b4fa" : "#45475a",
              }}
            >
              🏢 Floors ({floorPlans.length})
            </button>
          ) : null}
          <button onClick={() => setBgIdx((i) => (i + 1) % bgColors.length)} style={btnStyle}>
            ◑ BG
          </button>
        </div>
      </header>

      <div
        ref={containerRef}
        style={{ flex: 1, position: "relative", overflow: "hidden" }}
      >

        {loading ? (
          <div style={overlayStyle}>
            <div style={spinnerStyle} />
            <div style={{ marginTop: 12, fontSize: 13 }}>Loading project…</div>
          </div>
        ) : null}

        {progress ? (
          <div style={overlayStyle}>
            <div style={spinnerStyle} />
            <div style={{ marginTop: 12, fontSize: 13 }}>{progress.phase}</div>
            <div style={{ marginTop: 10, width: 280, height: 6, background: "#313244", borderRadius: 3, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${progress.pct}%`, background: "#cba6f7", transition: "width 0.2s" }} />
            </div>
          </div>
        ) : null}

        {error ? (
          <div
            style={{
              position: "absolute", bottom: 16, left: "50%", transform: "translateX(-50%)",
              background: "#45273a", border: "1px solid #f38ba8", borderRadius: 8,
              padding: "8px 16px", fontSize: 13, color: "#f38ba8", zIndex: 20,
              maxWidth: "80%",
            }}
          >
            {error}
          </div>
        ) : null}

        {showLayers ? (
          <div
            style={{
              position: "absolute", top: 8, right: 8,
              background: "#181825", border: "1px solid #313244",
              borderRadius: 8, maxHeight: "70vh", overflowY: "auto",
              minWidth: 220, maxWidth: 300, zIndex: 15,
            }}
          >
            <h3 style={{
              padding: "10px 12px", fontSize: 13, color: "#cba6f7",
              borderBottom: "1px solid #313244", margin: 0,
              position: "sticky", top: 0, background: "#181825",
            }}>
              Layers
            </h3>
            <div>
              {layers.map((l) => (
                <label
                  key={l.name}
                  style={{
                    display: "flex", alignItems: "center", gap: 8,
                    padding: "5px 12px", fontSize: 12, cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={l.visible}
                    onChange={(e) => toggleLayer(l.name, e.target.checked)}
                    style={{ accentColor: "#cba6f7" }}
                  />
                  <span
                    style={{
                      width: 14, height: 14, borderRadius: 3,
                      border: "1px solid #45475a", flexShrink: 0,
                      background: colorToHex(l.color),
                    }}
                  />
                  <span
                    style={{
                      overflow: "hidden", textOverflow: "ellipsis",
                      whiteSpace: "nowrap", color: "#cdd6f4",
                    }}
                    title={l.displayName}
                  >
                    {l.displayName}
                  </span>
                </label>
              ))}
            </div>
          </div>
        ) : null}

        {showBlocks ? (
          <div
            style={{
              position: "absolute", top: 8,
              right: showLayers ? 316 : 8,
              background: "#181825", border: "1px solid #313244",
              borderRadius: 8, maxHeight: "70vh", overflowY: "auto",
              minWidth: 240, maxWidth: 320, zIndex: 15,
            }}
          >
            <div style={{
              padding: "10px 12px", fontSize: 13, color: "#cba6f7",
              borderBottom: "1px solid #313244",
              position: "sticky", top: 0, background: "#181825",
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
            }}>
              <span>Blocks</span>
              {selectedBlock ? (
                <button
                  onClick={() => { setSelectedBlock(null); clearHighlight(); }}
                  style={{
                    background: "transparent", color: "#f38ba8",
                    border: "1px solid #45475a", borderRadius: 4,
                    padding: "2px 8px", fontSize: 11, cursor: "pointer",
                  }}
                >
                  Clear
                </button>
              ) : null}
            </div>
            <div>
              {blocks.length === 0 ? (
                <div style={{ padding: "10px 12px", fontSize: 12, color: "#6c7086" }}>
                  No blocks defined in this drawing.
                </div>
              ) : blocks.map((b) => {
                const active = selectedBlock === b.name;
                return (
                  <button
                    key={b.name}
                    onClick={() => selectBlock(b.name)}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      gap: 8, width: "100%",
                      padding: "6px 12px", fontSize: 12, cursor: "pointer",
                      background: active ? "#45475a" : "transparent",
                      color: active ? "#f9e2af" : "#cdd6f4",
                      border: "none", borderBottom: "1px solid #1e1e2e",
                      textAlign: "left",
                    }}
                    title={b.name}
                  >
                    <span style={{
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      flex: 1,
                    }}>
                      {b.name}
                    </span>
                    <span style={{
                      fontSize: 11, color: active ? "#f9e2af" : "#6c7086",
                      flexShrink: 0,
                    }}>
                      ×{b.count}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        {showFloors && floorPlans.length > 0 ? (
          <div
            style={{
              position: "absolute", top: 8, left: 8,
              background: "#181825", border: "1px solid #313244",
              borderRadius: 8, maxHeight: "70vh", overflowY: "auto",
              minWidth: 220, maxWidth: 280, zIndex: 15,
            }}
          >
            <div style={{
              padding: "10px 12px", fontSize: 13, color: "#89b4fa",
              borderBottom: "1px solid #313244",
              position: "sticky", top: 0, background: "#181825",
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
            }}>
              <span>Floor Plans</span>
              {selectedFloorId ? (
                <button
                  onClick={() => { setSelectedFloorId(null); clearHighlight(); fitView(); }}
                  style={{
                    background: "transparent", color: "#f38ba8",
                    border: "1px solid #45475a", borderRadius: 4,
                    padding: "2px 8px", fontSize: 11, cursor: "pointer",
                  }}
                >
                  Clear
                </button>
              ) : null}
            </div>
            <div style={{
              padding: "8px 12px", borderBottom: "1px solid #313244",
              display: "flex", flexDirection: "column", gap: 4,
              background: "#181825",
            }}>
              <div style={{
                display: "flex", justifyContent: "space-between",
                fontSize: 11, color: "#a6adc8",
              }}>
                <span>Highlight opacity</span>
                <span style={{ color: "#89b4fa", fontVariantNumeric: "tabular-nums" }}>
                  {Math.round(floorOpacity * 100)}%
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={floorOpacity}
                onChange={(e) => setFloorOpacity(Number(e.target.value))}
                style={{ width: "100%", accentColor: "#89b4fa" }}
              />
            </div>
            <div>
              {floorPlans.map((fp) => {
                const active = selectedFloorId === fp.id;
                const bb = fp.world_bbox;
                const dims = bb
                  ? `${Math.round(bb.xmax - bb.xmin)} × ${Math.round(bb.ymax - bb.ymin)}`
                  : "—";
                return (
                  <button
                    key={fp.id}
                    onClick={() => selectFloorPlan(fp)}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      gap: 8, width: "100%",
                      padding: "8px 12px", fontSize: 12, cursor: "pointer",
                      background: active ? "#3a3a5c" : "transparent",
                      color: active ? "#89b4fa" : "#cdd6f4",
                      border: "none", borderBottom: "1px solid #1e1e2e",
                      textAlign: "left",
                    }}
                    title={`Block ${fp.block_index + 1} — ${fp.status}`}
                  >
                    <span style={{ flex: 1, fontWeight: active ? 600 : 400 }}>
                      Block {fp.block_index + 1}
                    </span>
                    <span style={{
                      fontSize: 10, color: active ? "#89b4fa" : "#6c7086",
                      flexShrink: 0,
                    }}>
                      {dims}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Auto-place equipment for the selected floor plan. */}
            <div style={{
              padding: "10px 12px", borderTop: "1px solid #313244",
              display: "flex", flexDirection: "column", gap: 8,
              background: "#181825",
            }}>
              <div style={{ fontSize: 11, color: "#a6adc8", textTransform: "uppercase", letterSpacing: 0.5 }}>
                Auto-place
              </div>
              {!selectedFloorId ? (
                <div style={{ fontSize: 11, color: "#6c7086" }}>
                  Select a floor plan to place equipment.
                </div>
              ) : null}
              {(() => {
                const counts: Record<string, number> = {};
                for (const d of detectors) {
                  if (d.floor_plan_id === selectedFloorId) {
                    counts[d.dtype] = (counts[d.dtype] || 0) + 1;
                  }
                }
                return EQUIPMENT_BUTTONS.map((btn) => {
                  const placed = btn.key === "mcp_hooter"
                    ? (counts["mcb"] || 0) + (counts["hooter"] || 0)
                    : (counts[btn.key] || 0);
                  const isPlacing = isAutoPlacing === btn.key;
                  const disabled = !selectedFloorId || !!isAutoPlacing;
                  return (
                    <button
                      key={btn.key}
                      onClick={() => autoPlaceEquipment(btn.key)}
                      disabled={disabled}
                      title={selectedFloorId ? `Auto-place ${btn.label}` : "Select a floor plan first"}
                      style={{
                        display: "flex", alignItems: "center", gap: 8,
                        padding: "8px 10px", fontSize: 12,
                        borderRadius: 6,
                        border: "1px solid #45475a",
                        background: isPlacing ? "#3a3a5c" : "#1e1e2e",
                        color: disabled && !isPlacing ? "#6c7086" : "#cdd6f4",
                        cursor: disabled ? "not-allowed" : "pointer",
                        opacity: disabled && !isPlacing ? 0.6 : 1,
                        textAlign: "left",
                      }}
                    >
                      <span
                        style={{
                          width: 10, height: 10, borderRadius: "50%",
                          background: btn.color, flexShrink: 0,
                        }}
                      />
                      <span style={{ flex: 1 }}>{btn.label}</span>
                      <span style={{ fontSize: 10, color: "#6c7086" }}>
                        {isPlacing ? "Placing…" : placed > 0 ? `${placed} placed` : ""}
                      </span>
                    </button>
                  );
                });
              })()}
              {autoPlaceMsg ? (
                <div style={{
                  fontSize: 11, color: "#a6adc8",
                  padding: "4px 0 0", lineHeight: 1.4,
                }}>
                  {autoPlaceMsg}
                </div>
              ) : null}
              {detectors.length > 0 ? (
                <button
                  onClick={() => { clearDetectorMarkers(); setDetectors([]); }}
                  style={{
                    marginTop: 4,
                    padding: "4px 8px", fontSize: 11,
                    borderRadius: 4,
                    border: "1px solid #45475a",
                    background: "transparent", color: "#f38ba8",
                    cursor: "pointer",
                  }}
                  title="Hide all detector markers from the viewer (does not delete from server)"
                >
                  Hide markers
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </main>
  );
}

const btnStyle: React.CSSProperties = {
  background: "#313244", color: "#cdd6f4",
  border: "1px solid #45475a", borderRadius: 6,
  padding: "6px 14px", fontSize: 13, cursor: "pointer",
};

const overlayStyle: React.CSSProperties = {
  position: "absolute", inset: 0,
  display: "flex", flexDirection: "column",
  alignItems: "center", justifyContent: "center",
  background: "rgba(17,17,27,0.92)", zIndex: 15,
  color: "#a6adc8",
};

const spinnerStyle: React.CSSProperties = {
  width: 44, height: 44,
  border: "4px solid #313244",
  borderTopColor: "#cba6f7",
  borderRadius: "50%",
  animation: "dxfspin 0.8s linear infinite",
};

if (typeof document !== "undefined" && !document.getElementById("dxfspin-kf")) {
  const s = document.createElement("style");
  s.id = "dxfspin-kf";
  s.textContent = "@keyframes dxfspin { to { transform: rotate(360deg); } }";
  document.head.appendChild(s);
}
