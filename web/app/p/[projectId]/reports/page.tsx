"use client";

import { use, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { useRouter } from "next/navigation";

const API = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8000";

type Project = {
  id: string;
  name: string;
  status: string;
  error?: string | null;
  files: Record<string, string | null>;
};

type ArtifactKey = "output" | "base" | "input";
type FormatKey = "dxf" | "dwg" | "png" | "pdf";

const FORMATS: Array<{ key: FormatKey; label: string; hint: string }> = [
  { key: "dxf", label: "DXF", hint: "Best for CAD + downstream edits" },
  { key: "dwg", label: "DWG", hint: "Requires ODA_PATH on server" },
  { key: "png", label: "PNG", hint: "Fast preview image" },
  { key: "pdf", label: "PDF", hint: "Shareable print" },
];

export default function ReportsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = use(params);
  const router = useRouter();
  const [project, setProject] = useState<Project | null>(null);
  const [artifact, setArtifact] = useState<ArtifactKey>("output");
  const [format, setFormat] = useState<FormatKey>("dxf");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function refresh() {
    const p: Project = await (await fetch(`${API}/api/projects/${projectId}`)).json();
    setProject(p);
  }

  useEffect(() => {
    refresh();
  }, []);

  const availability = useMemo(() => {
    const p = project;
    const outputReady = Boolean(p?.files?.output_dxf);
    const baseReady = Boolean(p?.files?.dxf);
    const inputReady = Boolean(p?.files?.input);
    return { outputReady, baseReady, inputReady };
  }, [project]);

  function canDownload(art: ArtifactKey, fmt: FormatKey) {
    if (art === "output") {
      if (!availability.outputReady) return false;
      return true;
    }
    if (art === "base") {
      if (!availability.baseReady) return false;
      return true;
    }
    // input
    if (!availability.inputReady) return false;
    // for input we only allow original type (dxf or dwg). But we can't know which one without file extension.
    const inputPath = project?.files?.input || "";
    const isDwg = inputPath.toLowerCase().endsWith(".dwg");
    const isDxf = inputPath.toLowerCase().endsWith(".dxf");
    if (fmt === "dxf") return isDxf;
    if (fmt === "dwg") return isDwg;
    return false;
  }

  async function download(art: ArtifactKey, fmt: FormatKey) {
    setMessage(null);
    setBusy(true);
    try {
      // Use a plain navigation download (server returns Content-Disposition: attachment)
      const url = `${API}/api/projects/${projectId}/download?artifact=${art}&format=${fmt}`;
      window.location.href = url;
    } catch (e: any) {
      setMessage(e?.message || "Download failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={styles.shell}>
      <div style={styles.bgGlow1} />
      <div style={styles.bgGlow2} />
      <header style={styles.header}>
        <div>
          <div style={styles.kicker}>Reports</div>
          <div style={styles.title}>{project?.name || "Loading…"}</div>
          <div style={styles.sub}>
            Choose a file type and download the exact artifact you need.
          </div>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={() => router.push(`/p/${projectId}`)} style={btn(false)}>
            Back to workspace
          </button>
          <button onClick={refresh} style={btn(false)}>
            Refresh
          </button>
        </div>
      </header>

      <section style={styles.card}>
        <div style={styles.row}>
          <div>
            <div style={styles.sectionTitle}>Download</div>
            <div style={styles.sectionHint}>
              Output = detectors overlay • Base = normalized DXF used by pipeline • Input = your original upload
            </div>
          </div>
        </div>

        <div style={styles.controls}>
          <div style={styles.controlCol}>
            <label style={styles.label}>Artifact</label>
            <select
              value={artifact}
              onChange={(e) => setArtifact(e.target.value as ArtifactKey)}
              style={styles.select}
            >
              <option value="output">Output (Detectors overlay)</option>
              <option value="base">Base (Normalized DXF)</option>
              <option value="input">Input (Original upload)</option>
            </select>
          </div>

          <div style={styles.controlCol}>
            <label style={styles.label}>Format</label>
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value as FormatKey)}
              style={styles.select}
            >
              {FORMATS.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>

          <div style={{ display: "flex", alignItems: "end" }}>
            <button
              disabled={busy || !canDownload(artifact, format)}
              onClick={() => download(artifact, format)}
              style={btn(true, busy || !canDownload(artifact, format))}
            >
              {busy ? "Preparing…" : "Download"}
            </button>
          </div>
        </div>

        <div style={styles.divider} />

        <div style={styles.quickGrid}>
          {(["output", "base", "input"] as ArtifactKey[]).map((art) => (
            <div key={art} style={styles.quickCard}>
              <div style={styles.quickTitle}>
                {art === "output" ? "Output" : art === "base" ? "Base" : "Input"}
              </div>
              <div style={styles.quickSub}>
                {art === "output"
                  ? availability.outputReady
                    ? "Detectors overlay files"
                    : "Run auto-placement or click Save in editor"
                  : art === "base"
                    ? availability.baseReady
                      ? "Pipeline DXF and render"
                      : "Upload a DWG/DXF and run the pipeline"
                    : availability.inputReady
                      ? "Your original DWG/DXF"
                      : "Upload a DWG/DXF"}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
                {FORMATS.map((f) => {
                  const ok = canDownload(art, f.key);
                  return (
                    <button
                      key={f.key}
                      onClick={() => download(art, f.key)}
                      disabled={!ok || busy}
                      style={chip(ok && !busy)}
                      title={f.hint}
                    >
                      {f.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {project?.error ? (
          <pre style={styles.errorBox}>{project.error}</pre>
        ) : null}

        {message ? <div style={styles.message}>{message}</div> : null}
      </section>
    </main>
  );
}

function btn(primary = false, disabled = false): CSSProperties {
  return {
    padding: "10px 12px",
    borderRadius: 12,
    border: primary
      ? "1px solid rgba(127, 148, 255, 0.75)"
      : "1px solid rgba(255,255,255,0.2)",
    background: primary
      ? "linear-gradient(180deg, #697bff 0%, #5668f1 100%)"
      : "rgba(14, 19, 36, 0.86)",
    color: "#f4f7ff",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.55 : 1,
    boxShadow: primary ? "0 10px 24px rgba(93, 109, 241, 0.42)" : undefined,
  };
}

function chip(enabled = true): CSSProperties {
  return {
    padding: "8px 10px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.18)",
    background: enabled ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.04)",
    color: "#dbe4ff",
    cursor: enabled ? "pointer" : "not-allowed",
    opacity: enabled ? 1 : 0.45,
    fontSize: 12,
  };
}

const styles: Record<string, CSSProperties> = {
  shell: {
    minHeight: "100vh",
    padding: "18px",
    background:
      "radial-gradient(circle at 10% 20%, rgba(89, 110, 255, 0.22) 0%, transparent 35%), radial-gradient(circle at 86% 76%, rgba(33, 190, 170, 0.16) 0%, transparent 34%), linear-gradient(130deg, #090d17 0%, #0f1628 45%, #141c31 100%)",
    position: "relative",
    overflow: "hidden",
  },
  bgGlow1: {
    position: "absolute",
    top: "-180px",
    right: "-140px",
    width: "420px",
    height: "420px",
    borderRadius: "999px",
    background: "rgba(112, 126, 255, 0.20)",
    filter: "blur(90px)",
    pointerEvents: "none",
  },
  bgGlow2: {
    position: "absolute",
    bottom: "-210px",
    left: "-150px",
    width: "460px",
    height: "460px",
    borderRadius: "999px",
    background: "rgba(68, 224, 199, 0.16)",
    filter: "blur(96px)",
    pointerEvents: "none",
  },
  header: {
    position: "relative",
    zIndex: 1,
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 16,
    padding: "16px",
    borderRadius: 20,
    border: "1px solid rgba(255,255,255,0.18)",
    background: "linear-gradient(160deg, rgba(255,255,255,0.13), rgba(255,255,255,0.05))",
    backdropFilter: "blur(10px)",
    boxShadow: "0 20px 56px rgba(0,0,0,0.34)",
  },
  kicker: {
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    color: "rgba(244, 247, 255, 0.66)",
    marginBottom: 4,
  },
  title: {
    fontSize: 22,
    fontWeight: 700,
    color: "#f4f7ff",
  },
  sub: {
    marginTop: 6,
    fontSize: 13,
    color: "rgba(244, 247, 255, 0.72)",
    maxWidth: 760,
  },
  card: {
    position: "relative",
    zIndex: 1,
    marginTop: 14,
    padding: "16px",
    borderRadius: 20,
    border: "1px solid rgba(255,255,255,0.16)",
    background: "rgba(10, 14, 26, 0.68)",
    backdropFilter: "blur(10px)",
    boxShadow: "0 20px 56px rgba(0,0,0,0.34)",
  },
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: 700,
    color: "#f4f7ff",
  },
  sectionHint: {
    marginTop: 6,
    fontSize: 12,
    color: "rgba(244, 247, 255, 0.68)",
  },
  controls: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr auto",
    gap: 12,
    marginTop: 12,
  },
  controlCol: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  label: {
    fontSize: 12,
    color: "rgba(244, 247, 255, 0.76)",
  },
  select: {
    width: "100%",
    borderRadius: 12,
    border: "1px solid rgba(255, 255, 255, 0.2)",
    background: "rgba(14, 19, 36, 0.85)",
    color: "#f4f7ff",
    padding: "10px 12px",
    outline: "none",
  },
  divider: {
    height: 1,
    margin: "16px 0",
    background: "rgba(255,255,255,0.14)",
  },
  quickGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))",
    gap: 12,
  },
  quickCard: {
    borderRadius: 16,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(255,255,255,0.06)",
    padding: 14,
  },
  quickTitle: {
    fontSize: 14,
    fontWeight: 700,
    color: "#f4f7ff",
  },
  quickSub: {
    marginTop: 6,
    fontSize: 12,
    color: "rgba(244, 247, 255, 0.72)",
    lineHeight: 1.45,
  },
  errorBox: {
    marginTop: 14,
    whiteSpace: "pre-wrap",
    background: "rgba(255, 102, 102, 0.12)",
    border: "1px solid rgba(255, 136, 136, 0.35)",
    color: "#ffd7d7",
    padding: "10px",
    borderRadius: "12px",
    fontSize: "12px",
  },
  message: {
    marginTop: 12,
    padding: "10px 12px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.16)",
    background: "rgba(255,255,255,0.06)",
    color: "#dbe4ff",
    fontSize: 13,
  },
};
