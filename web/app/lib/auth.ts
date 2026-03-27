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

const TOKEN_KEY = "firecad_token";
const NAME_KEY = "firecad_name";
const TENANT_KEY = "firecad_tenant";
const TENANT_ROLE_KEY = "firecad_tenant_role";

function setCookie(name: string, value: string, maxAgeSec = 60 * 60 * 24 * 7) {
  if (typeof document === "undefined") return;
  document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSec}; SameSite=Lax`;
}

function getCookie(name: string) {
  if (typeof document === "undefined") return null;
  const parts = document.cookie.split(";").map((p) => p.trim());
  for (const p of parts) {
    if (p.startsWith(name + "=")) return decodeURIComponent(p.slice(name.length + 1));
  }
  return null;
}

function clearCookie(name: string) {
  if (typeof document === "undefined") return;
  document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
}

export function setAuth(token: string, name?: string, tenantName?: string, tenantRole?: string) {
  setCookie(TOKEN_KEY, token);
  if (name) setCookie(NAME_KEY, name);
  if (tenantName) setCookie(TENANT_KEY, tenantName);
  if (tenantRole) setCookie(TENANT_ROLE_KEY, tenantRole);

  // optional localStorage fallback (not used by middleware)
  if (typeof window !== "undefined") {
    localStorage.setItem(TOKEN_KEY, token);
    if (name) localStorage.setItem(NAME_KEY, name);
    if (tenantName) localStorage.setItem(TENANT_KEY, tenantName);
    if (tenantRole) localStorage.setItem(TENANT_ROLE_KEY, tenantRole);
  }
}

export function getToken() {
  return (
    getCookie(TOKEN_KEY) ||
    (typeof window !== "undefined" ? localStorage.getItem(TOKEN_KEY) : null)
  );
}

export function getName() {
  return (
    getCookie(NAME_KEY) ||
    (typeof window !== "undefined" ? localStorage.getItem(NAME_KEY) : null)
  );
}

export function getTenantName() {
  return (
    getCookie(TENANT_KEY) ||
    (typeof window !== "undefined" ? localStorage.getItem(TENANT_KEY) : null)
  );
}

export function getTenantRole() {
  return (
    getCookie(TENANT_ROLE_KEY) ||
    (typeof window !== "undefined" ? localStorage.getItem(TENANT_ROLE_KEY) : null)
  );
}

export function clearAuth() {
  clearCookie(TOKEN_KEY);
  clearCookie(NAME_KEY);
  clearCookie(TENANT_KEY);
  clearCookie(TENANT_ROLE_KEY);
  if (typeof window !== "undefined") {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(NAME_KEY);
    localStorage.removeItem(TENANT_KEY);
    localStorage.removeItem(TENANT_ROLE_KEY);
  }
}

async function apiJson(path: string, init?: RequestInit) {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init?.headers as any),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(apiUrl(path), { ...init, headers });

  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    const msg =
      (json && (json.detail || json.message || json.error)) ||
      text ||
      `Request failed (${res.status})`;
    throw new Error(msg);
  }

  return json;
}

function extractToken(payload: any): string | null {
  if (!payload) return null;
  return (
    payload.token ||
    payload.access_token ||
    payload.jwt ||
    payload?.data?.token ||
    null
  );
}

function extractName(payload: any): string | null {
  if (!payload) return null;
  return payload.name || payload?.user?.name || payload?.data?.user?.name || null;
}

export async function apiRegister(name: string, email: string, password: string) {
  const payload = await apiJson("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name, email, password }),
  });

  const token = extractToken(payload);
  const uname = extractName(payload) || name;
  const tenantName = payload?.tenant?.name;
  const tenantRole = payload?.tenant?.role;

  if (token) setAuth(token, uname, tenantName, tenantRole);
  return payload;
}

export async function apiLogin(email: string, password: string) {
  const payload = await apiJson("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });

  const token = extractToken(payload);
  const uname = extractName(payload);
  const tenantName = payload?.tenant?.name;
  const tenantRole = payload?.tenant?.role;

  if (token) setAuth(token, uname || undefined, tenantName, tenantRole);
  return payload;
}

export async function apiFetch(path: string, init?: RequestInit) {
  return apiJson(path, init);
}

export async function apiUpload(path: string, formData: FormData) {
  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(apiUrl(path), { method: "POST", headers, body: formData });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Upload failed (${res.status})`);
  }
  const text = await res.text();
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}
