"use client";

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";

const API = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8000";

type Project = {
  id: string;
  name: string;
  status: string;
  error?: string | null;
};

type TabKey = "projects" | "recent" | "templates" | "settings";

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "projects", label: "My Projects" },
  { key: "recent", label: "Recent" },
  { key: "templates", label: "Templates" },
  { key: "settings", label: "Settings" },
];

export default function Home() {
  const [activeTab, setActiveTab] = useState<TabKey>("projects");
  const [name, setName] = useState("New Building");
  const [projects, setProjects] = useState<Project[]>([]);
  const [isCreating, setIsCreating] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadProjects() {
    setIsLoading(true);
    try {
      const response = await fetch(`${API}/api/projects`);
      if (!response.ok) throw new Error("Unable to load projects");
      const rows: Project[] = await response.json();
      setProjects(rows);
    } catch {
      setError("Could not load projects right now. Please try again.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadProjects();
  }, []);

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
      setProjects((prev: Project[]) => [j, ...prev]);
      setName("New Building");
      setActiveTab("projects");
    } catch {
      setError("Could not create project right now. Please try again.");
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <main style={styles.workspace}>
      <div style={styles.backgroundGlowTop} />
      <div style={styles.backgroundGlowBottom} />

      <aside style={styles.sidebar}>
        <div style={styles.logo}>FireCAD Drive</div>

        <button onClick={createProject} style={styles.createPrimary} disabled={isCreating}>
          {isCreating ? "Creating…" : "+ Create Project"}
        </button>

        <nav style={styles.nav}>
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              style={navTabStyle(activeTab === tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <div style={styles.sidebarFooter}>
          <div style={styles.metaLabel}>Workspace</div>
          <div style={styles.metaValue}>{projects.length} projects</div>
        </div>
      </aside>

      <section style={styles.main}>
        <header style={styles.mainHeader}>
          <div>
            <h1 style={styles.heading}>Dashboard</h1>
            <p style={styles.subHeading}>Manage your fire CAD projects from one workspace.</p>
          </div>

          <div style={styles.headerActions}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Project name"
              style={styles.input}
            />
            <button onClick={createProject} style={styles.button} disabled={isCreating}>
              {isCreating ? "Creating…" : "Create"}
            </button>
            <button onClick={loadProjects} style={styles.secondaryBtn} disabled={isLoading}>
              {isLoading ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </header>

        {error ? <p style={styles.error}>{error}</p> : null}

        {activeTab !== "projects" ? (
          <div style={styles.placeholderCard}>
            <h3 style={styles.placeholderTitle}>{TABS.find((t) => t.key === activeTab)?.label}</h3>
            <p style={styles.placeholderText}>This tab is ready. Use My Projects to create and open project workspaces.</p>
          </div>
        ) : (
          <div style={styles.tableCard}>
            <div style={styles.tableHead}>
              <span>Name</span>
              <span>Status</span>
              <span>Action</span>
            </div>

            {projects.length === 0 ? (
              <div style={styles.emptyRow}>No projects yet. Create your first project to get started.</div>
            ) : (
              projects.map((p) => (
                <div key={p.id} style={styles.tableRow}>
                  <div>
                    <div style={styles.projectName}>{p.name}</div>
                    <div style={styles.projectMeta}>{p.id}</div>
                  </div>
                  <div style={statusChipStyle(p.status)}>{p.status}</div>
                  <a href={`/p/${p.id}`} style={styles.openLink}>Open</a>
                </div>
              ))
            )}
          </div>
        )}
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
  workspace: {
    minHeight: "100vh",
    padding: "16px",
    display: "grid",
    gridTemplateColumns: "280px 1fr",
    gap: "14px",
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
  sidebar: {
    zIndex: 1,
    borderRadius: "20px",
    border: "1px solid rgba(255,255,255,0.16)",
    background: "linear-gradient(160deg, rgba(255,255,255,0.14), rgba(255,255,255,0.05))",
    backdropFilter: "blur(10px)",
    boxShadow: "0 20px 56px rgba(0, 0, 0, 0.35)",
    padding: "14px",
    display: "flex",
    flexDirection: "column",
    gap: "14px",
    color: "#f4f7ff"
  },
  logo: {
    fontSize: "16px",
    fontWeight: 600
  },
  createPrimary: {
    borderRadius: "12px",
    border: "1px solid rgba(127, 148, 255, 0.75)",
    background: "linear-gradient(180deg, #697bff 0%, #5668f1 100%)",
    color: "#ffffff",
    padding: "10px 12px",
    fontSize: "14px",
    fontWeight: 600,
    cursor: "pointer",
    textAlign: "left"
  },
  nav: {
    display: "flex",
    flexDirection: "column",
    gap: "8px"
  },
  sidebarFooter: {
    marginTop: "auto",
    borderTop: "1px solid rgba(255,255,255,0.16)",
    paddingTop: "12px"
  },
  metaLabel: {
    fontSize: "11px",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    color: "rgba(244,247,255,0.68)"
  },
  metaValue: {
    marginTop: "4px",
    fontSize: "14px"
  },
  main: {
    zIndex: 1,
    borderRadius: "20px",
    border: "1px solid rgba(255,255,255,0.16)",
    background: "rgba(10, 14, 26, 0.72)",
    backdropFilter: "blur(8px)",
    boxShadow: "0 20px 56px rgba(0,0,0,0.34)",
    padding: "16px",
    color: "#f4f7ff"
  },
  mainHeader: {
    display: "flex",
    justifyContent: "space-between",
    gap: "12px",
    flexWrap: "wrap",
    alignItems: "center"
  },
  heading: {
    margin: 0,
    fontSize: "26px"
  },
  subHeading: {
    margin: "4px 0 0",
    color: "rgba(244,247,255,0.76)",
    fontSize: "14px"
  },
  headerActions: {
    display: "flex",
    gap: "8px",
    alignItems: "center",
    flexWrap: "wrap"
  },
  input: {
    minWidth: "220px",
    borderRadius: "12px",
    border: "1px solid rgba(255,255,255,0.24)",
    background: "rgba(10, 14, 27, 0.68)",
    color: "#f4f7ff",
    padding: "10px 12px",
    fontSize: "14px",
    outline: "none"
  },
  button: {
    borderRadius: "12px",
    border: "1px solid rgba(255,255,255,0.22)",
    background: "linear-gradient(180deg, #697bff 0%, #5668f1 100%)",
    color: "white",
    padding: "10px 12px",
    fontSize: "14px",
    fontWeight: 600,
    cursor: "pointer",
    boxShadow: "0 10px 20px rgba(93, 109, 241, 0.35)"
  },
  secondaryBtn: {
    borderRadius: "12px",
    border: "1px solid rgba(255,255,255,0.22)",
    background: "rgba(14, 19, 36, 0.86)",
    color: "#f4f7ff",
    padding: "10px 12px",
    fontSize: "14px",
    cursor: "pointer"
  },
  error: {
    marginTop: "12px",
    marginBottom: 0,
    color: "#ffb6b6",
    fontSize: "14px"
  },
  tableCard: {
    marginTop: "14px",
    border: "1px solid rgba(255,255,255,0.14)",
    borderRadius: "14px",
    overflow: "hidden",
    background: "rgba(9, 14, 27, 0.58)"
  },
  tableHead: {
    display: "flex",
    justifyContent: "space-between",
    padding: "10px 14px",
    background: "rgba(255,255,255,0.08)",
    borderBottom: "1px solid rgba(255,255,255,0.12)",
    fontSize: "12px",
    color: "rgba(244,247,255,0.76)",
    textTransform: "uppercase",
    letterSpacing: "0.05em"
  },
  tableRow: {
    display: "grid",
    gridTemplateColumns: "1fr 180px 90px",
    alignItems: "center",
    gap: "12px",
    padding: "12px 14px",
    borderBottom: "1px solid rgba(255,255,255,0.09)"
  },
  emptyRow: {
    padding: "22px 14px",
    color: "rgba(244,247,255,0.74)",
    textAlign: "center"
  },
  projectName: {
    fontSize: "14px",
    fontWeight: 600
  },
  projectMeta: {
    marginTop: "2px",
    fontSize: "12px",
    color: "rgba(244,247,255,0.64)"
  },
  openLink: {
    textDecoration: "none",
    border: "1px solid rgba(127,148,255,0.72)",
    borderRadius: "10px",
    color: "#dbe4ff",
    padding: "8px 10px",
    textAlign: "center",
    background: "rgba(93,109,241,0.18)",
    fontSize: "13px",
    fontWeight: 600
  },
  placeholderCard: {
    marginTop: "14px",
    borderRadius: "14px",
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(9, 14, 27, 0.58)",
    padding: "20px"
  },
  placeholderTitle: {
    margin: 0,
    fontSize: "18px"
  },
  placeholderText: {
    margin: "8px 0 0",
    color: "rgba(244,247,255,0.74)",
    lineHeight: 1.5,
    fontSize: "14px"
  }
};

function navTabStyle(active: boolean): CSSProperties {
  return {
    borderRadius: 12,
    border: active ? "1px solid rgba(127, 148, 255, 0.72)" : "1px solid rgba(255,255,255,0.14)",
    background: active ? "rgba(93,109,241,0.22)" : "rgba(14, 19, 36, 0.76)",
    color: "#f4f7ff",
    padding: "10px 12px",
    textAlign: "left",
    cursor: "pointer",
    fontSize: "14px",
    fontWeight: active ? 600 : 500
  };
}

function statusChipStyle(status: string): CSSProperties {
  const normalized = (status || "").toLowerCase();
  const isReady = normalized === "ready";
  const isRunning = normalized === "running";
  const isFailed = normalized === "failed";

  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "999px",
    border: "1px solid rgba(255,255,255,0.16)",
    padding: "6px 10px",
    fontSize: "12px",
    fontWeight: 600,
    textTransform: "capitalize",
    width: "fit-content",
    background: isReady
      ? "rgba(72, 199, 142, 0.22)"
      : isRunning
      ? "rgba(99, 179, 237, 0.22)"
      : isFailed
      ? "rgba(245, 101, 101, 0.24)"
      : "rgba(160, 174, 192, 0.22)",
    color: isReady ? "#9ef3c7" : isRunning ? "#a8d9ff" : isFailed ? "#ffc2c2" : "#d6def0"
  };
}
