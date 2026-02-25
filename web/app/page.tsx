"use client";

import { useState } from "react";
import type { CSSProperties } from "react";

const API = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8000";

export default function Home() {
  const [name, setName] = useState("My Building");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createProject() {
    setError(null);
    setIsCreating(true);
    try {
      const r = await fetch(`${API}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
      });

      if (!r.ok) {
        throw new Error("Unable to create project.");
      }

      const j = await r.json();
      setProjectId(j.id);
    } catch {
      setError("Could not create project right now. Please try again.");
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <main style={styles.page}>
      <div style={styles.backgroundGlowTop} />
      <div style={styles.backgroundGlowBottom} />

      <section style={styles.card}>
        <div style={styles.badge}>FireCAD Studio</div>

        <h1 style={styles.title}>Design fire safety plans with precision.</h1>
        <p style={styles.subtitle}>
          Upload DXF/DWG, auto-place detectors, fine-tune placement, and export production-ready DXF.
        </p>

        <div style={styles.formRow}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Project name"
            style={styles.input}
          />
          <button onClick={createProject} style={styles.button} disabled={isCreating}>
            {isCreating ? "Creating…" : "Create project"}
          </button>
        </div>

        {error && <p style={styles.error}>{error}</p>}

        {projectId && (
          <a href={`/p/${projectId}`} style={styles.projectLink}>
            Open project → {projectId}
          </a>
        )}

        <div style={styles.footerMeta}>
          <span>Fast previews</span>
          <span>•</span>
          <span>Editable overlays</span>
          <span>•</span>
          <span>DXF export</span>
        </div>
      </section>

      <style jsx>{`
        input::placeholder {
          color: rgba(255, 255, 255, 0.6);
        }

        a:hover {
          opacity: 0.92;
        }
      `}</style>
    </main>
  );
}

const styles: Record<string, CSSProperties> = {
  page: {
    minHeight: "100vh",
    padding: "24px",
    display: "grid",
    placeItems: "center",
    background:
      "radial-gradient(circle at 15% 20%, #1f2f6d 0%, rgba(31,47,109,0.1) 30%), radial-gradient(circle at 85% 75%, #2f6d64 0%, rgba(47,109,100,0.08) 26%), linear-gradient(135deg, #090c16 0%, #101828 45%, #17182a 100%)",
    position: "relative",
    overflow: "hidden"
  },
  backgroundGlowTop: {
    position: "absolute",
    top: "-160px",
    right: "-130px",
    width: "420px",
    height: "420px",
    borderRadius: "999px",
    background: "rgba(103, 119, 255, 0.24)",
    filter: "blur(90px)",
    pointerEvents: "none"
  },
  backgroundGlowBottom: {
    position: "absolute",
    bottom: "-180px",
    left: "-100px",
    width: "420px",
    height: "420px",
    borderRadius: "999px",
    background: "rgba(69, 214, 194, 0.18)",
    filter: "blur(100px)",
    pointerEvents: "none"
  },
  card: {
    width: "min(920px, 100%)",
    borderRadius: "24px",
    border: "1px solid rgba(255,255,255,0.16)",
    background: "linear-gradient(160deg, rgba(255,255,255,0.12), rgba(255,255,255,0.04))",
    backdropFilter: "blur(10px)",
    padding: "32px",
    boxShadow: "0 24px 80px rgba(0, 0, 0, 0.35)",
    position: "relative",
    zIndex: 1,
    color: "#f4f7ff"
  },
  badge: {
    display: "inline-flex",
    alignItems: "center",
    padding: "6px 12px",
    borderRadius: "999px",
    background: "rgba(255,255,255,0.12)",
    border: "1px solid rgba(255,255,255,0.18)",
    fontSize: "12px",
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    fontWeight: 600
  },
  title: {
    margin: "16px 0 8px",
    fontSize: "clamp(30px, 5vw, 48px)",
    lineHeight: 1.08,
    letterSpacing: "-0.02em"
  },
  subtitle: {
    margin: 0,
    maxWidth: "760px",
    color: "rgba(244, 247, 255, 0.82)",
    fontSize: "16px",
    lineHeight: 1.6
  },
  formRow: {
    marginTop: "26px",
    display: "flex",
    gap: "12px",
    alignItems: "center",
    flexWrap: "wrap"
  },
  input: {
    flex: 1,
    minWidth: "240px",
    borderRadius: "14px",
    border: "1px solid rgba(255,255,255,0.24)",
    background: "rgba(10, 14, 27, 0.68)",
    color: "#f4f7ff",
    padding: "14px 16px",
    fontSize: "15px",
    outline: "none"
  },
  button: {
    borderRadius: "14px",
    border: "1px solid rgba(255,255,255,0.22)",
    background: "linear-gradient(180deg, #697bff 0%, #5668f1 100%)",
    color: "white",
    padding: "14px 18px",
    fontSize: "15px",
    fontWeight: 600,
    cursor: "pointer",
    boxShadow: "0 10px 26px rgba(93, 109, 241, 0.42)",
    transition: "transform 0.15s ease, opacity 0.15s ease"
  },
  error: {
    marginTop: "12px",
    marginBottom: 0,
    color: "#ffb6b6",
    fontSize: "14px"
  },
  projectLink: {
    marginTop: "16px",
    display: "inline-flex",
    textDecoration: "none",
    color: "#d7e0ff",
    padding: "8px 0",
    fontWeight: 500
  },
  footerMeta: {
    marginTop: "22px",
    display: "flex",
    gap: "10px",
    flexWrap: "wrap",
    color: "rgba(244, 247, 255, 0.72)",
    fontSize: "13px"
  }
};
