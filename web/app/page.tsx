"use client";

import { useState } from "react";

const API = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8000";

export default function Home() {
  const [name, setName] = useState("My Building");
  const [projectId, setProjectId] = useState<string | null>(null);

  async function createProject() {
    const r = await fetch(`${API}/api/projects`, {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ name })
    });
    const j = await r.json();
    setProjectId(j.id);
  }

  return (
    <div style={{ padding: 16, maxWidth: 900 }}>
      <h2 style={{ marginTop: 0 }}>FireCAD</h2>
      <p style={{ marginTop: 4, opacity: 0.8 }}>
        Upload DXF/DWG → auto-place (optional) → edit detectors → export DXF
      </p>

      <div style={{ display:"flex", gap: 8, alignItems:"center", marginTop: 12 }}>
        <input
          value={name}
          onChange={(e)=>setName(e.target.value)}
          style={{ padding: 10, borderRadius: 10, border:"1px solid #ddd", flex: 1 }}
        />
        <button onClick={createProject} style={{ padding:"10px 14px", borderRadius: 10, border:"1px solid #ddd" }}>
          Create project
        </button>
      </div>

      {projectId && (
        <div style={{ marginTop: 14 }}>
          <a href={`/p/${projectId}`} style={{ textDecoration:"none" }}>
            Open project → {projectId}
          </a>
        </div>
      )}
    </div>
  );
}
