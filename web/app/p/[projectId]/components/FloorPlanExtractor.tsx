"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Status = "idle" | "loading" | "rendering" | "done" | "error";

type Rect = { minX: number; minY: number; maxX: number; maxY: number };
type FloorPlanPayload = {
  world_bbox: { xmin: number; ymin: number; xmax: number; ymax: number };
  height_m?: number;
  render_blob?: Blob;
};

const FONTS = [
  "https://cdn.jsdelivr.net/fontsource/fonts/noto-sans@latest/latin-400-normal.ttf",
  "https://cdn.jsdelivr.net/fontsource/fonts/noto-sans@latest/latin-700-normal.ttf",
];

// ---------- Geometry helpers ----------

function emptyRect(): Rect {
  return {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  };
}

function unionRect(a: Rect, b: Rect): Rect {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

function unionAll(rects: Rect[]): Rect {
  let r = emptyRect();
  for (const x of rects) r = unionRect(r, x);
  return r;
}

function rectArea(r: Rect): number {
  return Math.max(0, r.maxX - r.minX) * Math.max(0, r.maxY - r.minY);
}

// Extract one rectangle per renderable object directly from the dxf-viewer
// scene that is displayed on screen. This keeps extraction aligned with what
// the user actually sees in the canvas.
function getElementRectsFromViewerScene(
  scene: any,
  t: any,
  origin: { x: number; y: number }
): Rect[] {
  if (!scene || !t) return [];
  const root = scene?.traverse
    ? scene
    : scene?.scene?.traverse
      ? scene.scene
      : null;
  if (!root) return [];
  root.updateMatrixWorld?.(true);

  const rects: Rect[] = [];
  const v = new t.Vector3();

  root.traverse((obj: any) => {
    if (!obj?.visible) return;
    const geom = obj.geometry as any;
    const pos = geom?.attributes?.position as any;
    if (!pos || pos.count === 0) return;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      v.applyMatrix4(obj.matrixWorld);
      if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) continue;
      if (v.x < minX) minX = v.x;
      if (v.y < minY) minY = v.y;
      if (v.x > maxX) maxX = v.x;
      if (v.y > maxY) maxY = v.y;
    }

    if (
      Number.isFinite(minX) &&
      Number.isFinite(maxX) &&
      Number.isFinite(minY) &&
      Number.isFinite(maxY) &&
      maxX >= minX &&
      maxY >= minY
    ) {
      // Convert scene-space back to world-space by re-applying viewer origin.
      rects.push({
        minX: minX + origin.x,
        minY: minY + origin.y,
        maxX: maxX + origin.x,
        maxY: maxY + origin.y,
      });
    }
  });

  return rects;
}

// ---------- Gutter / floor-plan detection ----------

function mergeIntervals(
  intervals: [number, number][]
): [number, number][] {
  if (intervals.length === 0) return [];
  const sorted = intervals
    .map((p) => [p[0], p[1]] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const cur = sorted[i];
    if (cur[0] <= last[1]) {
      last[1] = Math.max(last[1], cur[1]);
    } else {
      merged.push(cur);
    }
  }
  return merged;
}

function findGutters(
  intervals: [number, number][],
  minWidth: number
): [number, number][] {
  const merged = mergeIntervals(intervals);
  const gutters: [number, number][] = [];
  for (let i = 0; i < merged.length - 1; i++) {
    const gapStart = merged[i][1];
    const gapEnd = merged[i + 1][0];
    if (gapEnd - gapStart >= minWidth) {
      gutters.push([gapStart, gapEnd]);
    }
  }
  return gutters;
}

function findAxisGutters(
  rects: Rect[],
  bounds: Rect,
  axis: "x" | "y",
  minGutterWidth: number,
  wideFraction: number
): [number, number][] {
  if (axis === "x") {
    const W = Math.max(bounds.maxX - bounds.minX, 1e-9);
    const intervals = rects
      .filter((r) => r.maxX - r.minX < W * wideFraction)
      .map((r) => [r.minX, r.maxX] as [number, number]);
    return findGutters(intervals, minGutterWidth);
  }
  const H = Math.max(bounds.maxY - bounds.minY, 1e-9);
  const intervals = rects
    .filter((r) => r.maxY - r.minY < H * wideFraction)
    .map((r) => [r.minY, r.maxY] as [number, number]);
  return findGutters(intervals, minGutterWidth);
}

function dropBorderRects(rects: Rect[], bounds: Rect, frac = 0.7): Rect[] {
  const W = bounds.maxX - bounds.minX;
  const H = bounds.maxY - bounds.minY;
  return rects.filter((r) => {
    const rw = r.maxX - r.minX;
    const rh = r.maxY - r.minY;
    return !(rw >= W * frac && rh >= H * frac);
  });
}

function partitionRecursive(
  rects: Rect[],
  minGutterFraction: number,
  wideFraction: number,
  depth = 0,
  maxDepth = 12
): Rect[] {
  if (rects.length === 0) return [];
  if (rects.length === 1) return [rects[0]];
  if (depth >= maxDepth) return [unionAll(rects)];

  const bounds = unionAll(rects);
  const W = bounds.maxX - bounds.minX;
  const H = bounds.maxY - bounds.minY;
  const minGX = Math.max(W * minGutterFraction, 1e-6);
  const minGY = Math.max(H * minGutterFraction, 1e-6);

  const xGutters = findAxisGutters(rects, bounds, "x", minGX, wideFraction);
  const yGutters = findAxisGutters(rects, bounds, "y", minGY, wideFraction);

  if (xGutters.length === 0 && yGutters.length === 0) {
    return [bounds];
  }

  // Build column / row bands induced by the gutters.
  const xBands: [number, number][] = [];
  {
    let xs = bounds.minX;
    for (const [gs, ge] of xGutters) {
      xBands.push([xs, gs]);
      xs = ge;
    }
    xBands.push([xs, bounds.maxX]);
  }
  const yBands: [number, number][] = [];
  {
    let ys = bounds.minY;
    for (const [gs, ge] of yGutters) {
      yBands.push([ys, gs]);
      ys = ge;
    }
    yBands.push([ys, bounds.maxY]);
  }

  const out: Rect[] = [];
  for (const [xMin, xMax] of xBands) {
    for (const [yMin, yMax] of yBands) {
      const cellRects: Rect[] = [];
      for (const r of rects) {
        if (
          r.minX < xMax &&
          r.maxX > xMin &&
          r.minY < yMax &&
          r.maxY > yMin
        ) {
          cellRects.push({
            minX: Math.max(r.minX, xMin),
            maxX: Math.min(r.maxX, xMax),
            minY: Math.max(r.minY, yMin),
            maxY: Math.min(r.maxY, yMax),
          });
        }
      }
      if (cellRects.length === 0) continue;
      const subs = partitionRecursive(
        cellRects,
        minGutterFraction,
        wideFraction,
        depth + 1,
        maxDepth
      );
      for (const s of subs) {
        if (rectArea(s) > 0) out.push(s);
      }
    }
  }
  return out;
}

function detectFloorPlans(rects: Rect[]): { plans: Rect[]; overall: Rect } {
  if (rects.length === 0) return { plans: [], overall: emptyRect() };
  const overall = unionAll(rects);
  const filtered = dropBorderRects(rects, overall, 0.7);
  // minGutterFraction = 1% of local extent; wideFraction = 70% — a rect
  // spanning ≥70% of the cell along an axis is ignored when looking for
  // gutters along that axis.
  const plans = partitionRecursive(filtered, 0.01, 0.7);
  return { plans, overall };
}

// ---------- Component ----------

type ViewerInstance = {
  Subscribe(event: string, cb: (...args: unknown[]) => void): void;
  Load(opts: {
    url: string;
    fonts?: string[] | null;
    progressCbk?: ((phase: string, p: number, t: number) => void) | null;
    workerFactory?: unknown;
  }): Promise<void>;
  GetScene(): { add: (o: unknown) => void; remove: (o: unknown) => void };
  GetBounds():
    | { minX: number; maxX: number; minY: number; maxY: number }
    | null;
  GetOrigin(): { x: number; y: number };
  GetCamera(): unknown;
  FitView(
    minX: number,
    maxX: number,
    minY: number,
    maxY: number,
    padding?: number
  ): void;
  Render(): void;
  Destroy(): void;
};

export default function FloorPlanExtractor({
  dxfUrl,
  mapping,
  onFloorPlansDetected,
  onConfirm,
  canEdit = true,
}: {
  dxfUrl: string;
  mapping: any;
  onFloorPlansDetected?: (plans: Rect[]) => void;
  onConfirm: (plans: FloorPlanPayload[]) => Promise<void>;
  canEdit?: boolean;
}) {
  const [status, setStatus] = useState<Status>("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [floorPlans, setFloorPlans] = useState<Rect[]>([]);
  const [floorPlanHeights, setFloorPlanHeights] = useState<string[]>([]);
  const [mode, setMode] = useState<"view" | "draw">("view");

  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<ViewerInstance | null>(null);
  const threeRef = useRef<typeof import("three") | null>(null);
  const overlayGroupRef = useRef<unknown>(null);
  const draftRectRef = useRef<Rect | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const floorPlansRef = useRef<Rect[]>([]);

  useEffect(() => {
    floorPlansRef.current = floorPlans;
  }, [floorPlans]);

  useEffect(() => {
    setFloorPlanHeights((prev) => {
      const next = floorPlans.map((_, i) => prev[i] ?? "");
      return next;
    });
  }, [floorPlans]);

  const allHeightsFilled =
    floorPlans.length > 0 &&
    floorPlanHeights.length === floorPlans.length &&
    floorPlanHeights.every((value) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0;
    });

  const rebuildOverlay = useCallback(
    (plans: Rect[], draft: Rect | null = null) => {
      const viewer = viewerRef.current;
      const t = threeRef.current;
      if (!viewer || !t) return;
      const scene = viewer.GetScene?.();
      if (!scene) return;
      const origin = viewer.GetOrigin?.() || { x: 0, y: 0 };

      const prev = overlayGroupRef.current as any;
      if (prev) {
        scene.remove(prev);
        prev.traverse((o: any) => {
          const obj = o as any;
          obj.geometry?.dispose?.();
          const mat = obj.material;
          if (Array.isArray(mat)) mat.forEach((m: any) => m.dispose?.());
          else mat?.dispose?.();
        });
      }

      const group = new t.Group();

      const addRect = (
        r: Rect,
        color: any,
        opacity = 0.18
      ) => {
        const x0 = r.minX - origin.x;
        const y0 = r.minY - origin.y;
        const x1 = r.maxX - origin.x;
        const y1 = r.maxY - origin.y;
        const w = x1 - x0;
        const h = y1 - y0;
        if (!(w > 0 && h > 0)) return;

        const fill = new t.Mesh(
          new t.PlaneGeometry(w, h),
          new t.MeshBasicMaterial({
            color,
            transparent: true,
            opacity,
            depthTest: false,
            depthWrite: false,
            side: t.DoubleSide,
          })
        );
        fill.position.set(x0 + w / 2, y0 + h / 2, 0.5);
        fill.renderOrder = 999;
        group.add(fill);

        const outline = new t.Line(
          new t.BufferGeometry().setFromPoints([
            new t.Vector3(x0, y0, 0.6),
            new t.Vector3(x1, y0, 0.6),
            new t.Vector3(x1, y1, 0.6),
            new t.Vector3(x0, y1, 0.6),
            new t.Vector3(x0, y0, 0.6),
          ]),
          new t.LineBasicMaterial({
            color,
            transparent: true,
            opacity: 1,
            depthTest: false,
            depthWrite: false,
          })
        );
        outline.renderOrder = 1000;
        group.add(outline);
      };

      const planColor = new t.Color("#22d3ee");
      const draftColor = new t.Color("#facc15");
      for (const p of plans) addRect(p, planColor, 0.18);
      if (draft) addRect(draft, draftColor, 0.25);

      scene.add(group);
      overlayGroupRef.current = group;
      viewer.Render?.();
    },
    []
  );

  const screenToWorld = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const viewer = viewerRef.current;
      const t = threeRef.current;
      const container = containerRef.current;
      if (!viewer || !t || !container) return null;
      const camera = viewer.GetCamera?.();
      if (!camera) return null;
      const origin = viewer.GetOrigin?.() || { x: 0, y: 0 };
      const rect = container.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      const ndc = new t.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1
      );
      const raycaster = new t.Raycaster();
      raycaster.setFromCamera(ndc, camera as any);
      const plane = new t.Plane(new t.Vector3(0, 0, 1), 0);
      const out = new t.Vector3();
      if (!raycaster.ray.intersectPlane(plane, out)) return null;
      return { x: out.x + origin.x, y: out.y + origin.y };
    },
    []
  );

  const capturePlanBlob = useCallback(async (plan: Rect): Promise<Blob | null> => {
    const viewer = viewerRef.current;
    const t = threeRef.current;
    if (!viewer || !t) return null;

    const scene = viewer.GetScene?.() as any;
    if (!scene) return null;
    const origin = viewer.GetOrigin?.() || { x: 0, y: 0 };

    const w = plan.maxX - plan.minX;
    const h = plan.maxY - plan.minY;
    if (!(w > 0 && h > 0)) return null;

    // Temporarily hide the overlay so bounding boxes don't appear in the export.
    const overlay = overlayGroupRef.current as any;
    const hadOverlay = !!(overlay && overlay.parent);
    if (hadOverlay) scene.remove(overlay);

    // Create an offscreen renderer using dxf-viewer's bundled three so class
    // identities match. preserveDrawingBuffer:true avoids blank capture.
    const offscreenCanvas = document.createElement("canvas");
    const MAX_DIM = 2048;
    let imgW: number, imgH: number;
    if (w >= h) {
      imgW = MAX_DIM;
      imgH = Math.max(1, Math.round((MAX_DIM * h) / w));
    } else {
      imgH = MAX_DIM;
      imgW = Math.max(1, Math.round((MAX_DIM * w) / h));
    }

    const renderer = new t.WebGLRenderer({
      canvas: offscreenCanvas,
      antialias: true,
      preserveDrawingBuffer: true,
      alpha: false,
    });
    renderer.setPixelRatio(1);
    renderer.setSize(imgW, imgH, false);
    renderer.setClearColor(new t.Color("#1e1e1e"), 1);
    (renderer as any).sortObjects = false;

    // Orthographic camera scoped exactly to this floor plan's bounding box.
    const left   = plan.minX - origin.x;
    const right  = plan.maxX - origin.x;
    const bottom = plan.minY - origin.y;
    const top    = plan.maxY - origin.y;
    const cam = new t.OrthographicCamera(left, right, top, bottom, -1000, 1000);
    cam.position.set(0, 0, 1);
    cam.lookAt(new t.Vector3(0, 0, 0));
    cam.updateProjectionMatrix();

    renderer.render(scene, cam);

    const blob: Blob | null = await new Promise((resolve) =>
      offscreenCanvas.toBlob((b) => resolve(b), "image/png")
    );

    // Clean up offscreen renderer.
    renderer.dispose();

    // Restore overlay.
    if (hadOverlay && overlay) scene.add(overlay);
    viewer.Render?.();

    return blob;
  }, []);

  useEffect(() => {
    if (status === "done") rebuildOverlay(floorPlans, draftRectRef.current);
  }, [floorPlans, status, rebuildOverlay]);

  useEffect(() => {
    return () => {
      const v = viewerRef.current;
      try {
        v?.Destroy?.();
      } catch {
        /* ignore */
      }
      viewerRef.current = null;
      threeRef.current = null;
      overlayGroupRef.current = null;
    };
  }, []);

  useEffect(() => {
    const loadDxf = async () => {
      setStatus("loading");
      setErrorMsg("");
      setFloorPlans([]);

      try {
        // Fetch DXF file
        const response = await fetch(dxfUrl);
        if (!response.ok) throw new Error("Failed to fetch DXF file");
        const buffer = await response.arrayBuffer();
        const blob = new Blob([buffer], { type: "application/dxf" });

        const [{ DxfViewer }, three] = await Promise.all([
          import("dxf-viewer"),
          import("dxf-viewer/node_modules/three"),
        ]);
        threeRef.current = three as any;

        if (!containerRef.current) {
          throw new Error("Viewer container not mounted yet.");
        }

        const prev = viewerRef.current;
        try {
          prev?.Destroy?.();
        } catch {
          /* ignore */
        }
        overlayGroupRef.current = null;

        const ViewerCtor = DxfViewer as any;
        const viewer = new ViewerCtor(containerRef.current, {
          clearColor: new (three as any).Color(
            "#1e1e1e"
          ),
          autoResize: true,
          colorCorrection: true,
          blackWhiteInversion: true,
          antialias: true,
          retainParsedDxf: true,
          sceneOptions: {
            wireframeMesh: true,
            suppressPaperSpace: false,
          },
        });
        viewerRef.current = viewer;

        setStatus("rendering");

        viewer.Subscribe("loaded", async () => {
          try {
            const scene = viewer.GetScene?.() as any;
            const origin = viewer.GetOrigin?.() || { x: 0, y: 0 };
            const rects = getElementRectsFromViewerScene(scene, three, origin);
            if (rects.length === 0) {
              const b = viewer.GetBounds?.();
              if (b) {
                rects.push({ minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY });
              } else {
                setErrorMsg("DXF contains no renderable geometry.");
                setStatus("error");
                return;
              }
            }
            const { plans, overall } = detectFloorPlans(rects);

            const fitTo = plans.length > 0 ? unionAll(plans) : overall;
            viewer.FitView?.(
              fitTo.minX - origin.x,
              fitTo.maxX - origin.x,
              fitTo.minY - origin.y,
              fitTo.maxY - origin.y,
              0.05
            );

            setFloorPlans(plans);
            onFloorPlansDetected?.(plans);
            setStatus("done");
          } catch (err) {
            console.error("Overlay error:", err);
            setErrorMsg(err instanceof Error ? err.message : String(err));
            setStatus("error");
          }
        });

        viewer.Subscribe("message", (...args: unknown[]) => {
          const e = args[0] as { level?: string; message?: string };
          if (e?.level === "warn" || e?.level === "error") {
            console.warn("[dxf-viewer]", e.message || e);
          }
        });

        const blobUrl = URL.createObjectURL(blob);
        await viewer.Load({
          url: blobUrl,
          fonts: FONTS,
          workerFactory: null,
        });

        if (blobUrl) {
          const url = blobUrl;
          setTimeout(() => URL.revokeObjectURL(url), 5000);
        }
      } catch (err) {
        console.error("DXF processing error:", err);
        setErrorMsg(err instanceof Error ? err.message : String(err));
        setStatus("error");
      }
    };

    loadDxf();
  }, [dxfUrl, onFloorPlansDetected]);

  const removePlan = useCallback((index: number) => {
    setFloorPlans((prev) => prev.filter((_, i) => i !== index));
    setFloorPlanHeights((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const clearAllPlans = useCallback(() => {
    setFloorPlans([]);
    setFloorPlanHeights([]);
  }, []);

  const toggleDrawMode = useCallback(() => {
    setMode((m) => (m === "draw" ? "view" : "draw"));
  }, []);

  const handleDrawMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (mode !== "draw") return;
      if (e.button !== 0) return;
      const w = screenToWorld(e.clientX, e.clientY);
      if (!w) return;
      e.preventDefault();
      dragStartRef.current = w;
      draftRectRef.current = {
        minX: w.x,
        minY: w.y,
        maxX: w.x,
        maxY: w.y,
      };
    },
    [mode, screenToWorld]
  );

  const handleDrawMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (mode !== "draw") return;
      if (!dragStartRef.current) return;
      const w = screenToWorld(e.clientX, e.clientY);
      if (!w) return;
      const start = dragStartRef.current;
      draftRectRef.current = {
        minX: Math.min(start.x, w.x),
        minY: Math.min(start.y, w.y),
        maxX: Math.max(start.x, w.x),
        maxY: Math.max(start.y, w.y),
      };
      rebuildOverlay(floorPlansRef.current, draftRectRef.current);
    },
    [mode, screenToWorld, rebuildOverlay]
  );

  const finishDraw = useCallback(() => {
    if (!dragStartRef.current) return;
    const draft = draftRectRef.current;
    dragStartRef.current = null;
    draftRectRef.current = null;
    if (!draft) {
      rebuildOverlay(floorPlansRef.current, null);
      return;
    }
    const w = draft.maxX - draft.minX;
    const h = draft.maxY - draft.minY;
    if (w < 1e-6 || h < 1e-6) {
      rebuildOverlay(floorPlansRef.current, null);
      return;
    }
    setFloorPlans((prev) => [...prev, draft]);
  }, [rebuildOverlay]);

  const [confirming, setConfirming] = useState(false);

  const handleConfirm = useCallback(async () => {
    if (floorPlans.length === 0) return;
    if (!allHeightsFilled) {
      setErrorMsg("Please enter a valid height for every floor plan before continuing.");
      return;
    }
    setConfirming(true);
    try {
      const floorPlanPayloads: FloorPlanPayload[] = [];
      for (let i = 0; i < floorPlans.length; i++) {
        const plan = floorPlans[i];
        const render_blob = await capturePlanBlob(plan);
        if (!render_blob) {
          setErrorMsg(`Could not capture image for Floor Plan ${i + 1}.`);
          return;
        }
        floorPlanPayloads.push({
          world_bbox: {
            xmin: plan.minX,
            ymin: plan.minY,
            xmax: plan.maxX,
            ymax: plan.maxY,
          },
          height_m: Number(floorPlanHeights[i]),
          render_blob,
        });
      }
      await onConfirm(floorPlanPayloads);
    } finally {
      setConfirming(false);
    }
  }, [allHeightsFilled, capturePlanBlob, floorPlans, floorPlanHeights, onConfirm]);

  const showCanvas = status === "rendering" || status === "done";

  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      height: "100%",
      position: "absolute",
      inset: 0,
    }}>
      {/* Toolbar */}
      {showCanvas && (
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 14px",
          borderBottom: "1px solid #E8EAED",
          background: "#FAFBFC",
          flexShrink: 0,
          flexWrap: "wrap",
        }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: "#1A1A2E" }}>
            Detect Floor Plans
          </span>
          <span style={{ fontSize: 12, color: "#6B7280" }}>
            {floorPlans.length} detected
          </span>
          <div style={{ flex: 1 }} />
          {canEdit && (
            <button
              onClick={toggleDrawMode}
              disabled={confirming}
              style={{
                padding: "7px 14px",
                borderRadius: 10,
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
                border: mode === "draw" ? "2px solid #2D6A4F" : "1px solid #E8EAED",
                background: mode === "draw" ? "#D8F3DC" : "#FFFFFF",
                color: mode === "draw" ? "#1A3C34" : "#1A1A2E",
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              {mode === "draw" ? "Stop Drawing" : "Draw Box"}
            </button>
          )}
          {canEdit && (
            <button
              onClick={clearAllPlans}
              disabled={floorPlans.length === 0 || confirming}
              style={{
                padding: "7px 14px",
                borderRadius: 10,
                border: "1px solid #E8EAED",
                background: "#FFFFFF",
                color: "#1A1A2E",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 600,
                opacity: floorPlans.length === 0 || confirming ? 0.5 : 1,
              }}
            >
              Clear All
            </button>
          )}
          {canEdit && (
            <button
              onClick={handleConfirm}
              disabled={floorPlans.length === 0 || confirming || !allHeightsFilled}
              style={{
                padding: "7px 18px",
                borderRadius: 10,
                border: "none",
                background: "#2D6A4F",
                color: "#fff",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 700,
                boxShadow: "0 4px 12px rgba(45,106,79,0.3)",
                opacity: floorPlans.length === 0 || confirming || !allHeightsFilled ? 0.6 : 1,
              }}
            >
              {confirming ? "Confirming..." : "Confirm & Continue"}
            </button>
          )}
        </div>
      )}

      {/* Status / Error Messages */}
      {(status === "loading" || status === "rendering") && (
        <div style={{
          padding: 16,
          background: "#EFF6FF",
          border: "1px solid rgba(37,99,235,0.2)",
          color: "#1E40AF",
          fontSize: 12,
        }}>
          {status === "loading" ? "Loading DXF…" : "Rendering & detecting floor plans…"}
        </div>
      )}
      {status === "error" && (
        <div style={{
          padding: 16,
          background: "#FEF2F2",
          border: "1px solid rgba(220,38,38,0.2)",
          color: "#991B1B",
          fontSize: 12,
        }}>
          {errorMsg || "An unknown error occurred."}
        </div>
      )}

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* Viewer Container */}
        <div
          ref={containerRef}
          style={{
            flex: 1,
            position: "relative",
            border: "1px solid #E8EAED",
            background: "#1e1e1e",
            overflow: "hidden",
          }}
        >

          {/* Draw-mode overlay (canvas only, so toolbar buttons stay clickable) */}
          {showCanvas && mode === "draw" && (
            <div
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                cursor: "crosshair",
                zIndex: 10,
              }}
              onMouseDown={handleDrawMouseDown}
              onMouseMove={handleDrawMouseMove}
              onMouseUp={finishDraw}
              onMouseLeave={finishDraw}
            >
              <div style={{
                position: "absolute",
                top: 12,
                left: 14,
                padding: "6px 10px",
                background: "rgba(250,204,21,0.9)",
                color: "#000",
                borderRadius: 6,
                fontWeight: 500,
                pointerEvents: "none",
                fontSize: "12px",
              }}>
                Draw mode - click and drag to add a bounding box
              </div>
            </div>
          )}
        </div>

        {/* Floor plans panel */}
        <div
          style={{
            width: 300,
            borderLeft: "1px solid #E8EAED",
            background: "#F8FAFC",
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
          }}
        >
          <div style={{
            padding: "12px 14px",
            borderBottom: "1px solid #E8EAED",
            fontSize: 13,
            fontWeight: 700,
            color: "#111827",
          }}>
            Floor Plans
          </div>
          <div style={{ flex: 1, overflow: "auto", padding: 10 }}>
            {floorPlans.length === 0 ? (
              <div style={{ fontSize: 12, color: "#6B7280", padding: 8 }}>
                No floor plans yet. Use Draw Box or auto-detection.
              </div>
            ) : (
              <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
                {floorPlans.map((_, i) => (
                  <li
                    key={i}
                    style={{
                      padding: "10px",
                      marginBottom: 8,
                      borderRadius: 8,
                      background: "#FFFFFF",
                      border: "1px solid #E5E7EB",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "#1F2937" }}>
                        Floor Plan {i + 1}
                      </span>
                      {canEdit && (
                        <button
                          onClick={() => removePlan(i)}
                          style={{
                            background: "none",
                            border: "none",
                            color: "#DC2626",
                            cursor: "pointer",
                            fontSize: 16,
                            lineHeight: 1,
                            padding: "0 4px",
                          }}
                          title="Remove floor plan"
                        >
                          ×
                        </button>
                      )}
                    </div>
                    <div style={{ marginTop: 8 }}>
                      <label style={{ fontSize: 11, color: "#6B7280", display: "block", marginBottom: 4 }}>
                        Height (m)
                      </label>
                      <input
                        type="number"
                        min={0.1}
                        step={0.1}
                        value={floorPlanHeights[i] ?? ""}
                        placeholder="Enter height"
                        onChange={(e) => {
                          const val = e.target.value;
                          setFloorPlanHeights((prev) => {
                            const next = [...prev];
                            next[i] = val;
                            return next;
                          });
                        }}
                        style={{
                          width: "100%",
                          boxSizing: "border-box",
                          border: "1px solid #D1D5DB",
                          borderRadius: 6,
                          padding: "7px 8px",
                          fontSize: 12,
                          color: "#111827",
                          background: "#FFFFFF",
                        }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
