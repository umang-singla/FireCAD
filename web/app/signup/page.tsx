"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiRegister } from "../lib/auth";

export default function SignupPage() {
  const router = useRouter();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setLoading(true);
    try {
      await apiRegister(name, email, password);
      router.push("/");
    } catch (e: any) {
      setErr(e?.message || "Signup failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={styles.bg}>
      <div style={styles.card}>
        <div style={styles.brand}>FIRECAD</div>
        <h1 style={styles.title}>Create account</h1>
        <p style={styles.sub}>Automate MEP drawings with FireCAD.</p>

        <form onSubmit={onSubmit} style={{ width: "100%" }}>
          <label style={styles.label}>Name</label>
          <input
            style={styles.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            required
          />

          <label style={styles.label}>Email</label>
          <input
            style={styles.input}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@example.com"
            type="email"
            required
          />

          <label style={styles.label}>Password (min 8 chars)</label>
          <input
            style={styles.input}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="********"
            type="password"
            minLength={8}
            required
          />

          {err ? <div style={styles.error}>{err}</div> : null}

          <button type="submit" style={styles.btn} disabled={loading}>
            {loading ? "Creating…" : "Create account →"}
          </button>
        </form>

        <div style={styles.footer}>
          Already have an account?{" "}
          <a href="/login" style={styles.link}>Sign in</a>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bg: {
    minHeight: "100vh",
    display: "grid",
    placeItems: "center",
    background: "linear-gradient(135deg, #eef2ff 0%, #f7f9ff 55%, #eefaf6 100%)",
    padding: 18,
  },
  card: {
    width: "min(560px, 92vw)",
    borderRadius: 18,
    background: "rgba(255,255,255,0.86)",
    border: "1px solid rgba(20, 33, 61, 0.10)",
    boxShadow: "0 18px 40px rgba(20, 33, 61, 0.10)",
    padding: 22,
    textAlign: "center",
  },
  brand: {
    fontWeight: 900,
    letterSpacing: "0.28em",
    color: "#2563eb",
    fontSize: 13,
    marginBottom: 10,
  },
  title: { margin: 0, fontSize: 34, fontWeight: 900, color: "#111827" },
  sub: { marginTop: 10, marginBottom: 18, color: "rgba(27,36,64,0.70)", fontWeight: 600 },
  label: { display: "block", textAlign: "left", fontWeight: 800, color: "#111827", marginTop: 10, marginBottom: 6 },
  input: {
    width: "100%",
    borderRadius: 12,
    border: "1px solid rgba(20,33,61,0.14)",
    background: "rgba(255,255,255,0.92)",
    padding: "12px 12px",
    outline: "none",
    fontSize: 14,
  },
  btn: {
    width: "100%",
    marginTop: 16,
    borderRadius: 14,
    border: "1px solid rgba(37,99,235,0.30)",
    background: "linear-gradient(180deg, rgba(37,99,235,0.95), rgba(29,78,216,0.92))",
    color: "white",
    padding: "12px 14px",
    fontSize: 14,
    fontWeight: 900,
    cursor: "pointer",
    boxShadow: "0 10px 22px rgba(37,99,235,0.22)",
  },
  error: {
    marginTop: 12,
    borderRadius: 12,
    border: "1px solid rgba(239,68,68,0.18)",
    background: "rgba(239,68,68,0.08)",
    padding: "10px 12px",
    color: "#7f1d1d",
    fontWeight: 700,
    textAlign: "left",
  },
  footer: { marginTop: 14, color: "rgba(27,36,64,0.70)", fontWeight: 700 },
  link: { color: "#2563eb", textDecoration: "none", fontWeight: 900 },
};
