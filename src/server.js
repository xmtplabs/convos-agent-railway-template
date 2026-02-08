import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import express from "express";
import httpProxy from "http-proxy";
import * as tar from "tar";

// Railway deployments sometimes inject PORT=3000 by default. We want the wrapper to
// reliably listen on 8080 unless explicitly overridden.
//
// Prefer OPENCLAW_PUBLIC_PORT (set in the Dockerfile / template) over PORT.
// Keep CLAWDBOT_PUBLIC_PORT as a backward-compat alias for older templates.
const PORT = Number.parseInt(
  process.env.OPENCLAW_PUBLIC_PORT ?? process.env.CLAWDBOT_PUBLIC_PORT ?? process.env.PORT ?? "8080",
  10,
);

// State/workspace
// OpenClaw defaults to ~/.openclaw. Keep CLAWDBOT_* as backward-compat aliases.
const STATE_DIR =
  process.env.OPENCLAW_STATE_DIR?.trim() ||
  process.env.CLAWDBOT_STATE_DIR?.trim() ||
  path.join(os.homedir(), ".openclaw");

const WORKSPACE_DIR =
  process.env.OPENCLAW_WORKSPACE_DIR?.trim() ||
  process.env.CLAWDBOT_WORKSPACE_DIR?.trim() ||
  path.join(STATE_DIR, "workspace");

// Protect /setup with a user-provided password.
const SETUP_PASSWORD = process.env.SETUP_PASSWORD?.trim();

// Gateway admin token (protects OpenClaw gateway + Control UI).
// Must be stable across restarts. If not provided via env, persist it in the state dir.
function resolveGatewayToken() {
  const envTok = process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || process.env.CLAWDBOT_GATEWAY_TOKEN?.trim();
  if (envTok) return envTok;

  const tokenPath = path.join(STATE_DIR, "gateway.token");
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch {
    // ignore
  }

  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(tokenPath, generated, { encoding: "utf8", mode: 0o600 });
  } catch {
    // best-effort
  }
  return generated;
}

const OPENCLAW_GATEWAY_TOKEN = resolveGatewayToken();
process.env.OPENCLAW_GATEWAY_TOKEN = OPENCLAW_GATEWAY_TOKEN;
// Backward-compat: some older flows expect CLAWDBOT_GATEWAY_TOKEN.
process.env.CLAWDBOT_GATEWAY_TOKEN = process.env.CLAWDBOT_GATEWAY_TOKEN || OPENCLAW_GATEWAY_TOKEN;

// Persist auth credentials across container restarts.
// Saved to STATE_DIR/auth.json with restricted permissions.
function saveAuthCredentials(authChoice, envVar, secret) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(STATE_DIR, "auth.json"),
      JSON.stringify({ authChoice, envVar, secret }),
      { encoding: "utf8", mode: 0o600 }
    );
    console.log(`[convos] Persisted auth credentials to ${STATE_DIR}/auth.json`);
  } catch (err) {
    console.warn("[convos] Failed to persist auth credentials:", err.message);
  }
}

function restoreAuthCredentials() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(STATE_DIR, "auth.json"), "utf8"));
    if (data.envVar && data.secret && !process.env[data.envVar]) {
      process.env[data.envVar] = data.secret;
      console.log(`[convos] Restored ${data.envVar} from saved auth credentials`);
    }
  } catch {
    // No saved credentials — nothing to restore.
  }
}

restoreAuthCredentials();

// Where the gateway will listen internally (we proxy to it).
const INTERNAL_GATEWAY_PORT = Number.parseInt(process.env.INTERNAL_GATEWAY_PORT ?? "18789", 10);
const INTERNAL_GATEWAY_HOST = process.env.INTERNAL_GATEWAY_HOST ?? "127.0.0.1";
const GATEWAY_TARGET = `http://${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}`;

// XMTP environment (production or dev) - controlled via Railway env var
const XMTP_ENV = process.env.XMTP_ENV || "production";

// --- Pool Mode ---
// When POOL_MODE=true, the instance auto-onboards on boot and exposes
// /pool/status and /pool/provision endpoints for machine-to-machine use.
const POOL_MODE = process.env.POOL_MODE === "true";
const POOL_API_KEY = process.env.POOL_API_KEY?.trim();
const POOL_AUTH_CHOICE = process.env.POOL_AUTH_CHOICE?.trim() || "openai-api-key";

let poolReady = false;
let poolProvisioned = false;
let poolConversationId = null;
let poolInviteUrl = null;
let poolQrDataUrl = null;

// Helper for calling Convos HTTP endpoints on the gateway.
// The Convos plugin exposes REST routes at /convos/setup, /convos/setup/status, /convos/setup/complete.
async function convosHttp(path, { method = "GET", body } = {}) {
  const url = `${GATEWAY_TARGET}${path}`;
  const headers = { Authorization: `Bearer ${OPENCLAW_GATEWAY_TOKEN}` };
  const opts = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${method} ${path}: ${text}`);
  }
  return res.json();
}

// Always run the built-from-source CLI entry directly to avoid PATH/global-install mismatches.
const OPENCLAW_ENTRY = process.env.OPENCLAW_ENTRY?.trim() || "/openclaw/dist/entry.js";
const OPENCLAW_NODE = process.env.OPENCLAW_NODE?.trim() || "node";

function clawArgs(args) {
  return [OPENCLAW_ENTRY, ...args];
}

function configPath() {
  return (
    process.env.OPENCLAW_CONFIG_PATH?.trim() ||
    process.env.CLAWDBOT_CONFIG_PATH?.trim() ||
    path.join(STATE_DIR, "openclaw.json")
  );
}

function isConfigured() {
  try {
    return fs.existsSync(configPath());
  } catch {
    return false;
  }
}

// Check if Convos channel is actually configured (not just that a config file exists).
// A config file can exist from onboarding without Convos being set up.
function isConvosConfigured() {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    const cfg = JSON.parse(raw);
    return !!(cfg?.channels?.convos);
  } catch {
    return false;
  }
}

let gatewayProc = null;
let gatewayStarting = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForGatewayReady(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      // Try the default Control UI base path, then fall back to legacy or root.
      const paths = ["/openclaw", "/clawdbot", "/"]; 
      for (const p of paths) {
        try {
          const res = await fetch(`${GATEWAY_TARGET}${p}`, { method: "GET" });
          // Any HTTP response means the port is open.
          if (res) return true;
        } catch {
          // try next
        }
      }
    } catch {
      // not ready
    }
    await sleep(250);
  }
  return false;
}

async function startGateway() {
  if (gatewayProc) return;
  if (!isConfigured()) throw new Error("Gateway cannot start: not configured");

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  const args = [
    "gateway",
    "run",
    "--bind",
    "loopback",
    "--port",
    String(INTERNAL_GATEWAY_PORT),
    "--auth",
    "token",
    "--token",
    OPENCLAW_GATEWAY_TOKEN,
  ];

  const proc = childProcess.spawn(OPENCLAW_NODE, clawArgs(args), {
    stdio: "inherit",
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: STATE_DIR,
      OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
      // Backward-compat aliases
      CLAWDBOT_STATE_DIR: process.env.CLAWDBOT_STATE_DIR || STATE_DIR,
      CLAWDBOT_WORKSPACE_DIR: process.env.CLAWDBOT_WORKSPACE_DIR || WORKSPACE_DIR,
    },
  });
  gatewayProc = proc;

  // Only clear gatewayProc if THIS process is still the current one.
  // Prevents a stale exit handler from wiping a newly spawned gateway reference.
  proc.on("error", (err) => {
    console.error(`[gateway] spawn error: ${String(err)}`);
    if (gatewayProc === proc) gatewayProc = null;
  });

  proc.on("exit", (code, signal) => {
    console.error(`[gateway] exited code=${code} signal=${signal}`);
    if (gatewayProc === proc) gatewayProc = null;
  });
}

async function ensureGatewayRunning(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  if (!isConfigured()) return { ok: false, reason: "not configured" };
  if (gatewayProc) return { ok: true };
  if (!gatewayStarting) {
    gatewayStarting = (async () => {
      await startGateway();
      const ready = await waitForGatewayReady({ timeoutMs });
      if (!ready) {
        throw new Error("Gateway did not become ready in time");
      }
    })().finally(() => {
      gatewayStarting = null;
    });
  }
  await gatewayStarting;
  return { ok: true };
}

async function restartGateway() {
  if (gatewayProc) {
    try {
      gatewayProc.kill("SIGTERM");
    } catch {
      // ignore
    }
    // Give it a moment to exit and release the port.
    await sleep(750);
    gatewayProc = null;
  }
  gatewayStarting = null;
  return ensureGatewayRunning({ timeoutMs: 60_000 });
}

function requireSetupAuth(req, res, next) {
  if (!SETUP_PASSWORD) {
    return res
      .status(500)
      .type("text/plain")
      .send("SETUP_PASSWORD is not set. Set it in Railway Variables before using /setup.");
  }

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    return res.status(401).send("Auth required");
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const password = idx >= 0 ? decoded.slice(idx + 1) : "";
  if (password !== SETUP_PASSWORD) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    return res.status(401).send("Invalid password");
  }
  return next();
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

// Minimal health endpoint for Railway.
app.get("/setup/healthz", (_req, res) => res.json({ ok: true }));

// Build version info — baked into Docker image at build time.
let _versionInfo;
app.get("/version", (_req, res) => {
  if (!_versionInfo) {
    try {
      _versionInfo = JSON.parse(fs.readFileSync(path.join(process.cwd(), "version.json"), "utf8"));
    } catch {
      _versionInfo = { error: "version.json not found" };
    }
  }
  res.json(_versionInfo);
});

// --- Pool Mode Endpoints ---

function requirePoolAuth(req, res, next) {
  if (!POOL_API_KEY) {
    return res.status(500).json({ error: "POOL_API_KEY is not set" });
  }
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match || match[1] !== POOL_API_KEY) {
    return res.status(401).json({ error: "Invalid or missing pool API key" });
  }
  return next();
}

app.get("/pool/status", requirePoolAuth, (_req, res) => {
  res.json({
    ready: poolReady,
    provisioned: poolProvisioned,
    conversationId: poolConversationId,
    inviteUrl: poolInviteUrl,
  });
});

app.post("/pool/provision", requirePoolAuth, async (req, res) => {
  if (!poolReady) {
    return res.status(503).json({ error: "Instance not ready yet" });
  }
  if (poolProvisioned) {
    return res.status(409).json({
      error: "Already provisioned",
      conversationId: poolConversationId,
      inviteUrl: poolInviteUrl,
      qrDataUrl: poolQrDataUrl,
    });
  }

  const { instructions, name } = req.body || {};
  if (!instructions || typeof instructions !== "string") {
    return res.status(400).json({ error: "instructions (string) is required" });
  }

  const agentName = (typeof name === "string" && name.trim()) || "Agent";

  try {
    // Write instructions to INSTRUCTIONS.md in the workspace directory.
    // OpenClaw reads INSTRUCTIONS.md at runtime as operator-provided directives.
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    fs.writeFileSync(path.join(WORKSPACE_DIR, "INSTRUCTIONS.md"), instructions);
    console.log("[pool] Wrote instructions to INSTRUCTIONS.md");

    // Create XMTP conversation via the Convos plugin.
    // Fast path: use the running channel client (pre-warmed) to create a conversation.
    // Fallback: use the setup flow (creates a temporary client, slower).
    let result;
    let usedFastPath = false;
    try {
      result = await convosHttp("/convos/conversation", {
        method: "POST",
        body: { name: agentName },
      });
      usedFastPath = true;
      console.log("[pool] Fast path: conversation created via running client");
    } catch (fastErr) {
      console.log(`[pool] Fast path unavailable (${fastErr.message}), falling back to setup...`);
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          result = await convosHttp("/convos/setup", {
            method: "POST",
            body: { env: XMTP_ENV, name: agentName, force: true },
          });
          break;
        } catch (err) {
          if (attempt === 5) throw err;
          console.log(`[pool] Setup attempt ${attempt} failed, retrying in 2s...`);
          await sleep(2000);
        }
      }
    }

    poolProvisioned = true;
    poolConversationId = result.conversationId;
    poolInviteUrl = result.inviteUrl;
    poolQrDataUrl = result.qrDataUrl;

    console.log(`[pool] Provisioned. conversationId=${result.conversationId}`);
    console.log(`[pool] Invite URL: ${result.inviteUrl}`);

    // Only need join polling for the slow (setup) path — the setup agent
    // must be cleaned up after the user joins.  With the fast path, the
    // runtime client is already running and auto-accepts invites.
    if (!usedFastPath) {
      pollForJoinAndComplete();
    }

    res.json({
      inviteUrl: result.inviteUrl,
      qrDataUrl: result.qrDataUrl,
      conversationId: result.conversationId,
    });
  } catch (err) {
    console.error("[pool] Provision failed:", err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// After provision, poll /convos/setup/status until someone joins,
// then auto-call /convos/setup/complete so the concierge starts responding.
function pollForJoinAndComplete() {
  const pollInterval = 1000;
  const maxPollTime = 10 * 60 * 1000; // 10 minutes (matches plugin timeout)
  const start = Date.now();

  const timer = setInterval(async () => {
    if (Date.now() - start > maxPollTime) {
      console.log("[pool] Join polling timed out after 10 minutes");
      clearInterval(timer);
      return;
    }

    try {
      const status = await convosHttp("/convos/setup/status");
      if (status.joined) {
        console.log(`[pool] User joined! inboxId=${status.joinerInboxId}`);
        clearInterval(timer);

        // Complete the setup to persist config and start the channel.
        try {
          await convosHttp("/convos/setup/complete", { method: "POST" });
          console.log("[pool] Setup completed — agent is live");
        } catch (err) {
          console.error("[pool] Failed to complete setup:", err);
        }
      }
    } catch {
      // Gateway might be restarting, ignore transient errors.
    }
  }, pollInterval);
}

app.get("/setup/app.js", requireSetupAuth, (_req, res) => {
  // Serve JS for /setup (kept external to avoid inline encoding/template issues)
  res.type("application/javascript");
  res.send(fs.readFileSync(path.join(process.cwd(), "src", "setup-app.js"), "utf8"));
});

app.get("/setup", requireSetupAuth, (_req, res) => {
  // Pass XMTP_ENV to the page for display
  const envBadgeClass = XMTP_ENV === "dev" ? "env-dev" : "env-production";
  const envLabel = XMTP_ENV === "dev" ? "dev" : "production";

  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenClaw Setup</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
      background: #FFF;
      min-height: 100vh;
      padding: 32px;
      color: #000;
      -webkit-font-smoothing: antialiased;
    }

    .container {
      max-width: 900px;
      width: 100%;
      margin: 0 auto;
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 32px;
    }

    .logo-container {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .logo-text {
      font-size: 20px;
      font-weight: 700;
      letter-spacing: -0.5px;
    }

    .header-right {
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .status-badge {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
      color: #666;
      padding: 8px 14px;
      background: #F5F5F5;
      border-radius: 20px;
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #34C759;
    }

    .status-dot.pending {
      background: #FF9500;
    }

    .status-dot.error {
      background: #FF3B30;
    }

    .env-badge {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 4px 10px;
      border-radius: 6px;
    }

    .env-badge.env-dev {
      color: #007AFF;
      background: #E5F1FF;
    }

    .env-badge.env-production {
      color: #FC4F37;
      background: #FFE8E5;
    }

    .main-content {
      display: grid;
      grid-template-columns: 1fr 340px;
      gap: 24px;
      margin-bottom: 24px;
    }

    @media (max-width: 768px) {
      .main-content {
        grid-template-columns: 1fr;
      }
    }

    .card {
      background: #FFF;
      border: 1px solid #EBEBEB;
      border-radius: 24px;
      padding: 32px;
    }

    .card h3 {
      font-size: 16px;
      font-weight: 700;
      margin-bottom: 20px;
      letter-spacing: -0.08px;
    }

    .qr-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 350px;
    }

    .qr-placeholder {
      color: #999;
      font-size: 16px;
      text-align: center;
    }

    .qr-placeholder p {
      margin-top: 8px;
      font-size: 14px;
      color: #666;
    }

    #convos-qr {
      border-radius: 16px;
    }

    .qr-info {
      margin-top: 24px;
      padding: 16px 20px;
      background: #F5F5F5;
      border-radius: 16px;
      width: 100%;
      max-width: 300px;
    }

    .qr-info-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 0;
      border-bottom: 1px solid #EBEBEB;
    }

    .qr-info-row:last-child {
      border-bottom: none;
    }

    .qr-info-label {
      font-size: 12px;
      color: #666;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .qr-info-value {
      font-size: 14px;
      font-weight: 500;
      color: #000;
    }

    .qr-info-value.status {
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 600;
    }

    .qr-info-value.status.waiting {
      background: #FFF3CD;
      color: #856404;
    }

    .qr-info-value.status.joined {
      background: #D4EDDA;
      color: #155724;
    }

    .invite-url {
      margin-top: 16px;
      padding: 12px 16px;
      background: #F5F5F5;
      border-radius: 12px;
      font-family: 'SF Mono', 'Monaco', 'Courier New', monospace;
      font-size: 11px;
      word-break: break-all;
      color: #666;
      cursor: pointer;
      transition: background 0.2s;
      width: 100%;
      max-width: 300px;
      text-align: center;
    }

    .invite-url:hover {
      background: #EBEBEB;
    }

    .setting-group {
      margin-bottom: 20px;
    }

    .setting-group:last-child {
      margin-bottom: 0;
    }

    .setting-label {
      display: block;
      color: #666;
      font-size: 14px;
      font-weight: 500;
      margin-bottom: 8px;
    }

    .setting-input {
      width: 100%;
      background: #FFF;
      border: 1px solid #EBEBEB;
      border-radius: 12px;
      padding: 12px 16px;
      font-size: 15px;
      color: #000;
      font-family: inherit;
      transition: all 0.2s ease;
    }

    .setting-input:focus {
      outline: none;
      border-color: #000;
    }

    .setting-input::placeholder {
      color: #B2B2B2;
    }

    .btn-primary {
      background: #FC4F37;
      color: #FFF;
      border: none;
      border-radius: 40px;
      padding: 18px 32px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
      letter-spacing: -0.08px;
      width: 100%;
    }

    .btn-primary:hover {
      opacity: 0.9;
    }

    .btn-primary:active {
      transform: scale(0.98);
    }

    .btn-primary:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .btn-primary.success {
      background: #34C759;
    }

    .btn-secondary {
      background: #F5F5F5;
      color: #000;
      border: none;
      border-radius: 12px;
      padding: 10px 16px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .btn-secondary:hover {
      background: #EBEBEB;
    }

    .error-message {
      color: #DC2626;
      font-size: 14px;
      margin-top: 12px;
      padding: 12px 16px;
      background: #FEE2E2;
      border-radius: 12px;
      display: none;
    }

    .setup-log {
      margin-top: 16px;
      padding: 16px;
      background: #F5F5F5;
      border-radius: 12px;
      font-family: 'SF Mono', 'Monaco', 'Courier New', monospace;
      font-size: 12px;
      white-space: pre-wrap;
      max-height: 200px;
      overflow-y: auto;
      display: none;
    }

    details {
      margin-top: 24px;
    }

    details summary {
      cursor: pointer;
      font-size: 14px;
      font-weight: 600;
      color: #666;
      padding: 12px 0;
    }

    details summary:hover {
      color: #000;
    }

    .advanced-section {
      margin-top: 16px;
      padding: 24px;
      background: #FAFAFA;
      border-radius: 16px;
    }

    .advanced-section h4 {
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 16px;
      color: #333;
    }

    .advanced-buttons {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 16px;
    }

    .advanced-card {
      margin-top: 16px;
      padding: 16px;
      background: #FFF;
      border: 1px solid #EBEBEB;
      border-radius: 12px;
    }

    .advanced-card h5 {
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 12px;
    }

    .console-row {
      display: flex;
      gap: 8px;
      align-items: center;
    }

    .console-output {
      margin-top: 12px;
      padding: 12px;
      background: #1a1a1a;
      color: #00ff00;
      border-radius: 8px;
      font-family: 'SF Mono', 'Monaco', 'Courier New', monospace;
      font-size: 12px;
      white-space: pre-wrap;
      max-height: 200px;
      overflow-y: auto;
    }

    .config-textarea {
      width: 100%;
      height: 200px;
      font-family: 'SF Mono', 'Monaco', 'Courier New', monospace;
      font-size: 12px;
      padding: 12px;
      border: 1px solid #EBEBEB;
      border-radius: 8px;
      resize: vertical;
    }

    .config-actions {
      display: flex;
      gap: 8px;
      margin-top: 12px;
    }

    .muted {
      color: #666;
      font-size: 13px;
    }

    code {
      background: #F5F5F5;
      padding: 2px 6px;
      border-radius: 4px;
      font-family: 'SF Mono', 'Monaco', 'Courier New', monospace;
      font-size: 12px;
    }

    .hidden {
      display: none !important;
    }
  </style>
</head>
<body>
  <div class="container">
    <header class="header">
      <div class="logo-container">
        <span class="logo-text">OpenClaw</span>
      </div>
      <div class="header-right">
        <div class="status-badge">
          <span class="status-dot pending" id="status-dot"></span>
          <span id="status-text">Loading...</span>
        </div>
        <span class="env-badge ${envBadgeClass}">${envLabel}</span>
      </div>
    </header>

    <div class="main-content">
      <div class="card">
        <h3>Connect via Convos</h3>
        <div class="qr-container">
          <img id="convos-qr" style="display: none; border-radius: 16px; width: 256px; height: 256px;" alt="Scan to connect" />
          <div id="convos-loading" class="qr-placeholder">
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#ccc" stroke-width="1.5">
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
              <rect x="14" y="14" width="3" height="3" />
              <rect x="18" y="14" width="3" height="3" />
              <rect x="14" y="18" width="3" height="3" />
              <rect x="18" y="18" width="3" height="3" />
            </svg>
            <p>Click "Start Setup" to begin</p>
          </div>
          <div class="qr-info" id="qr-info" style="display: none;">
            <div class="qr-info-row">
              <span class="qr-info-label">Status</span>
              <span class="qr-info-value status waiting" id="join-status">Waiting</span>
            </div>
          </div>
          <div class="invite-url" id="convos-invite-url" style="display: none;" onclick="copyInvite(this)" title="Click to copy"></div>
        </div>
      </div>

      <div class="card">
        <h3>Model Configuration</h3>

        <div class="setting-group">
          <label class="setting-label" for="authGroup">Provider</label>
          <select id="authGroup" class="setting-input"></select>
        </div>

        <div class="setting-group">
          <label class="setting-label" for="authChoice">Auth Method</label>
          <select id="authChoice" class="setting-input"></select>
        </div>

        <div class="setting-group">
          <label class="setting-label" for="authSecret">API Key / Token</label>
          <input id="authSecret" type="password" class="setting-input" placeholder="Paste API key or token" />
        </div>

        <div class="setting-group">
          <label class="setting-label" for="flow">Setup Flow</label>
          <select id="flow" class="setting-input">
            <option value="quickstart">Quickstart</option>
            <option value="advanced">Advanced</option>
            <option value="manual">Manual</option>
          </select>
        </div>
      </div>
    </div>

    <button id="startSetup" class="btn-primary">
      Start Setup
    </button>
    <button id="completeSetup" class="btn-primary" style="display: none;">
      Finish Setup
    </button>

    <div id="setup-error" class="error-message"></div>
    <pre id="log" class="setup-log"></pre>

    <details>
      <summary>Advanced Options</summary>
      <div class="advanced-section">
        <div class="advanced-buttons">
          <button id="reset" class="btn-secondary">Reset Setup</button>
          <button id="pairingApprove" class="btn-secondary">Approve Pairing Manually</button>
          <a href="/openclaw" target="_blank" class="btn-secondary" style="text-decoration: none;">Open OpenClaw UI</a>
          <a href="/setup/export" target="_blank" class="btn-secondary" style="text-decoration: none;">Download Backup</a>
        </div>

        <div class="advanced-card">
          <h5>Debug Console</h5>
          <div class="console-row">
            <select id="consoleCmd" class="setting-input" style="flex: 1;">
              <option value="gateway.restart">gateway.restart</option>
              <option value="gateway.stop">gateway.stop</option>
              <option value="gateway.start">gateway.start</option>
              <option value="openclaw.status">openclaw status</option>
              <option value="openclaw.health">openclaw health</option>
              <option value="openclaw.doctor">openclaw doctor</option>
              <option value="openclaw.logs.tail">openclaw logs --tail N</option>
              <option value="openclaw.config.get">openclaw config get</option>
              <option value="openclaw.version">openclaw --version</option>
            </select>
            <input id="consoleArg" class="setting-input" placeholder="Arg" style="width: 100px;" />
            <button id="consoleRun" class="btn-secondary">Run</button>
          </div>
          <pre id="consoleOut" class="console-output" style="display: none;"></pre>
        </div>

        <div class="advanced-card">
          <h5>Config Editor</h5>
          <p class="muted" style="margin-bottom: 12px;">Path: <code id="configPath"></code></p>
          <textarea id="configText" class="config-textarea" placeholder="Loading config..."></textarea>
          <div class="config-actions">
            <button id="configReload" class="btn-secondary">Reload</button>
            <button id="configSave" class="btn-secondary">Save</button>
          </div>
          <pre id="configOut" class="console-output" style="display: none;"></pre>
        </div>

        <div class="advanced-card">
          <h5>Import Backup</h5>
          <p class="muted" style="margin-bottom: 12px;">Restore from a <code>.tar.gz</code> backup file.</p>
          <input id="importFile" type="file" accept=".tar.gz,application/gzip" class="setting-input" />
          <button id="importRun" class="btn-secondary" style="margin-top: 12px;">Import</button>
          <pre id="importOut" class="console-output" style="display: none;"></pre>
        </div>
      </div>
    </details>
  </div>

  <script>
    function copyInvite(el) {
      var text = el.textContent.trim();
      navigator.clipboard.writeText(text).then(function() {
        var original = el.textContent;
        el.textContent = 'Copied!';
        el.style.background = '#D4EDDA';
        el.style.color = '#155724';
        setTimeout(function() {
          el.textContent = original;
          el.style.background = '';
          el.style.color = '';
        }, 1500);
      });
    }
  </script>
  <script src="/setup/app.js"></script>
</body>
</html>`);
});

app.get("/setup/api/status", requireSetupAuth, async (_req, res) => {
  const version = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
  const channelsHelp = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"]));

  // We reuse OpenClaw's own auth-choice grouping logic indirectly by hardcoding the same group defs.
  // This is intentionally minimal; later we can parse the CLI help output to stay perfectly in sync.
  const authGroups = [
    { value: "openai", label: "OpenAI", hint: "Codex OAuth + API key", options: [
      { value: "openai-api-key", label: "OpenAI API key" },
      { value: "codex-cli", label: "OpenAI Codex OAuth (Codex CLI)" },
      { value: "openai-codex", label: "OpenAI Codex (ChatGPT OAuth)" }
    ]},
    { value: "anthropic", label: "Anthropic", hint: "Claude Code CLI + API key", options: [
      { value: "claude-cli", label: "Anthropic token (Claude Code CLI)" },
      { value: "token", label: "Anthropic token (paste setup-token)" },
      { value: "apiKey", label: "Anthropic API key" }
    ]},
    { value: "google", label: "Google", hint: "Gemini API key + OAuth", options: [
      { value: "gemini-api-key", label: "Google Gemini API key" },
      { value: "google-antigravity", label: "Google Antigravity OAuth" },
      { value: "google-gemini-cli", label: "Google Gemini CLI OAuth" }
    ]},
    { value: "openrouter", label: "OpenRouter", hint: "API key", options: [
      { value: "openrouter-api-key", label: "OpenRouter API key" }
    ]},
    { value: "ai-gateway", label: "Vercel AI Gateway", hint: "API key", options: [
      { value: "ai-gateway-api-key", label: "Vercel AI Gateway API key" }
    ]},
    { value: "moonshot", label: "Moonshot AI", hint: "Kimi K2 + Kimi Code", options: [
      { value: "moonshot-api-key", label: "Moonshot AI API key" },
      { value: "kimi-code-api-key", label: "Kimi Code API key" }
    ]},
    { value: "zai", label: "Z.AI (GLM 4.7)", hint: "API key", options: [
      { value: "zai-api-key", label: "Z.AI (GLM 4.7) API key" }
    ]},
    { value: "minimax", label: "MiniMax", hint: "M2.1 (recommended)", options: [
      { value: "minimax-api", label: "MiniMax M2.1" },
      { value: "minimax-api-lightning", label: "MiniMax M2.1 Lightning" }
    ]},
    { value: "qwen", label: "Qwen", hint: "OAuth", options: [
      { value: "qwen-portal", label: "Qwen OAuth" }
    ]},
    { value: "copilot", label: "Copilot", hint: "GitHub + local proxy", options: [
      { value: "github-copilot", label: "GitHub Copilot (GitHub device login)" },
      { value: "copilot-proxy", label: "Copilot Proxy (local)" }
    ]},
    { value: "synthetic", label: "Synthetic", hint: "Anthropic-compatible (multi-model)", options: [
      { value: "synthetic-api-key", label: "Synthetic API key" }
    ]},
    { value: "opencode-zen", label: "OpenCode Zen", hint: "API key", options: [
      { value: "opencode-zen", label: "OpenCode Zen (multi-model proxy)" }
    ]}
  ];

  res.json({
    configured: isConfigured(),
    convosConfigured: isConvosConfigured(),
    gatewayTarget: GATEWAY_TARGET,
    openclawVersion: version.output.trim(),
    channelsAddHelp: channelsHelp.output,
    authGroups,
  });
});

// Per-auth-choice configuration: model name, env var, and optional custom provider config.
// Model names and env vars sourced from OpenClaw docs/concepts/model-providers.md.
// Config path: agents.defaults.model.primary = "provider/model-id"
const AUTH_PROVIDER_CONFIG = {
  // Anthropic
  "apiKey":       { model: "anthropic/claude-opus-4-5", envVar: "ANTHROPIC_API_KEY" },
  "token":        { model: "anthropic/claude-opus-4-5" }, // setup-token, pasted via auth flow
  "claude-cli":   { model: "anthropic/claude-opus-4-5" }, // OAuth
  // OpenAI
  "openai-api-key": { model: "openai/gpt-5.2", envVar: "OPENAI_API_KEY" },
  "codex-cli":      { model: "openai-codex/gpt-5.2" },   // OAuth (Codex CLI)
  "openai-codex":   { model: "openai-codex/gpt-5.2" },   // OAuth (ChatGPT)
  // Google
  "gemini-api-key":    { model: "google/gemini-3-pro-preview", envVar: "GEMINI_API_KEY" },
  "google-antigravity": { model: "google-antigravity/gemini-3-pro-preview" }, // OAuth + plugin
  "google-gemini-cli":  { model: "google-gemini-cli/gemini-3-pro-preview" },  // OAuth + plugin
  // OpenRouter
  "openrouter-api-key": { model: "openrouter/anthropic/claude-sonnet-4-5", envVar: "OPENROUTER_API_KEY" },
  // Vercel AI Gateway
  "ai-gateway-api-key": { model: "vercel-ai-gateway/anthropic/claude-opus-4.5", envVar: "AI_GATEWAY_API_KEY" },
  // Moonshot
  "moonshot-api-key": {
    model: "moonshot/kimi-k2.5",
    envVar: "MOONSHOT_API_KEY",
    customProvider: {
      moonshot: {
        baseUrl: "https://api.moonshot.ai/v1",
        apiKey: "${MOONSHOT_API_KEY}",
        api: "openai-completions",
        models: [{ id: "kimi-k2.5", name: "Kimi K2.5" }],
      },
    },
  },
  // Kimi Coding
  "kimi-code-api-key": { model: "kimi-coding/k2p5", envVar: "KIMI_API_KEY" },
  // Z.AI
  "zai-api-key": { model: "zai/glm-4.7", envVar: "ZAI_API_KEY" },
  // MiniMax
  "minimax-api":           { model: "minimax/MiniMax-M2.1", envVar: "MINIMAX_API_KEY" },
  "minimax-api-lightning":  { model: "minimax/MiniMax-M2.1", envVar: "MINIMAX_API_KEY" },
  // Qwen
  "qwen-portal": { model: "qwen-portal/coder-model" }, // OAuth + plugin
  // Copilot
  "github-copilot": { model: "github-copilot/gpt-4o" }, // device login
  "copilot-proxy":  { model: "github-copilot/gpt-4o" }, // local proxy
  // Multi-model proxies
  "synthetic-api-key": {
    model: "synthetic/hf:MiniMaxAI/MiniMax-M2.1",
    envVar: "SYNTHETIC_API_KEY",
    customProvider: {
      synthetic: {
        baseUrl: "https://api.synthetic.new/anthropic",
        apiKey: "${SYNTHETIC_API_KEY}",
        api: "anthropic-messages",
        models: [{ id: "hf:MiniMaxAI/MiniMax-M2.1", name: "MiniMax M2.1" }],
      },
    },
  },
  "opencode-zen": { model: "opencode/claude-opus-4-5", envVar: "OPENCODE_ZEN_API_KEY" },
};

// Convos setup endpoint — writes config directly, starts gateway, calls POST /convos/setup
app.post("/setup/api/convos/setup", requireSetupAuth, async (req, res) => {
  try {
    const payload = req.body || {};

    if (!payload.authChoice) {
      return res.status(400).json({ success: false, error: "No auth provider selected" });
    }

    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

    // Stop any running gateway before rewriting config.
    if (gatewayProc) {
      console.log("[convos] Stopping existing gateway...");
      try { gatewayProc.kill("SIGTERM"); } catch {}
      await sleep(750);
      gatewayProc = null;
    }
    // Cancel any pending startup promise so ensureGatewayRunning() starts fresh.
    gatewayStarting = null;

    // Write config JSON directly — no onboarding, no config set calls, no restart cascade.
    console.log("[convos] Writing gateway config...");
    const authChoice = payload.authChoice || "";
    const providerCfg = AUTH_PROVIDER_CONFIG[authChoice];
    const secret = (payload.authSecret || "").trim();

    const config = {
      gateway: {
        mode: "local",
        port: INTERNAL_GATEWAY_PORT,
        bind: "loopback",
        auth: { mode: "token", token: OPENCLAW_GATEWAY_TOKEN },
        controlUi: { allowInsecureAuth: true },
      },
      plugins: {
        load: { paths: ["/openclaw/extensions"] },
      },
    };

    // Set the agent model (agents.defaults.model.primary = "provider/model-id").
    if (providerCfg?.model) {
      config.agents = { defaults: { model: { primary: providerCfg.model } } };
      console.log(`[convos] Setting agent model: ${providerCfg.model}`);
    } else if (authChoice) {
      console.warn(`[convos] No default model mapped for authChoice="${authChoice}"`);
    }

    // Set the API key as an env var — the gateway reads provider keys from env vars
    // at startup (e.g., OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY).
    if (secret && providerCfg?.envVar) {
      process.env[providerCfg.envVar] = secret;
      console.log(`[convos] Set ${providerCfg.envVar} from setup form`);
      saveAuthCredentials(authChoice, providerCfg.envVar, secret);
    }

    // Some providers need custom models.providers config (e.g., Moonshot, Synthetic).
    if (providerCfg?.customProvider) {
      config.models = { mode: "merge", providers: providerCfg.customProvider };
      console.log(`[convos] Added custom provider config for ${authChoice}`);
    }

    fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));

    // Start gateway (config is already written — single clean start)
    console.log("[convos] Starting gateway...");
    await ensureGatewayRunning();

    // Call POST /convos/setup on the running gateway
    console.log("[convos] Calling POST /convos/setup...");
    let result;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        result = await convosHttp("/convos/setup", {
          method: "POST",
          body: { env: XMTP_ENV, name: "OpenClaw" },
        });
        break;
      } catch (err) {
        if (attempt === 5) throw err;
        console.log(`[convos] Setup attempt ${attempt} failed, retrying...`);
        await sleep(2000);
      }
    }

    res.json({
      success: true,
      qrDataUrl: result.qrDataUrl,
      inviteUrl: result.inviteUrl,
      conversationId: result.conversationId,
    });
  } catch (err) {
    console.error("[convos] Setup failed:", err);
    res.status(500).json({
      success: false,
      error: err.message || String(err),
    });
  }
});

// Convos join status endpoint - passthrough to GET /convos/setup/status
app.get("/setup/api/convos/join-status", requireSetupAuth, async (req, res) => {
  try {
    const result = await convosHttp("/convos/setup/status");
    res.json({
      joined: result.joined,
      joinerInboxId: result.joinerInboxId || null,
      active: result.active,
    });
  } catch (err) {
    // If gateway is not running or endpoint fails, return not-joined state
    res.json({ joined: false, joinerInboxId: null, error: err.message });
  }
});

// Convos complete-setup endpoint - calls POST /convos/setup/complete
app.post("/setup/api/convos/complete-setup", requireSetupAuth, async (req, res) => {
  try {
    const result = await convosHttp("/convos/setup/complete", { method: "POST" });
    console.log("[convos] Setup complete:", result);

    res.json({
      ok: true,
      conversationId: result.conversationId,
    });
  } catch (err) {
    console.error("[/setup/api/convos/complete-setup] error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

function buildOnboardArgs(payload) {
  const args = [
    "onboard",
    "--non-interactive",
    "--accept-risk",
    "--json",
    "--no-install-daemon",
    "--skip-health",
    "--workspace",
    WORKSPACE_DIR,
    // The wrapper owns public networking; keep the gateway internal.
    "--gateway-bind",
    "loopback",
    "--gateway-port",
    String(INTERNAL_GATEWAY_PORT),
    "--gateway-auth",
    "token",
    "--gateway-token",
    OPENCLAW_GATEWAY_TOKEN,
    "--flow",
    payload.flow || "quickstart"
  ];

  if (payload.authChoice) {
    args.push("--auth-choice", payload.authChoice);

    // Map secret to correct flag for common choices.
    const secret = (payload.authSecret || "").trim();
    const map = {
      "openai-api-key": "--openai-api-key",
      "apiKey": "--anthropic-api-key",
      "openrouter-api-key": "--openrouter-api-key",
      "ai-gateway-api-key": "--ai-gateway-api-key",
      "moonshot-api-key": "--moonshot-api-key",
      "kimi-code-api-key": "--kimi-code-api-key",
      "gemini-api-key": "--gemini-api-key",
      "zai-api-key": "--zai-api-key",
      "minimax-api": "--minimax-api-key",
      "minimax-api-lightning": "--minimax-api-key",
      "synthetic-api-key": "--synthetic-api-key",
      "opencode-zen": "--opencode-zen-api-key"
    };
    const flag = map[payload.authChoice];
    if (flag && secret) {
      args.push(flag, secret);
    }

    if (payload.authChoice === "token" && secret) {
      // This is the Anthropics setup-token flow.
      args.push("--token-provider", "anthropic", "--token", secret);
    }
  }

  return args;
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const proc = childProcess.spawn(cmd, args, {
      ...opts,
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: STATE_DIR,
        OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
        // Backward-compat aliases
        CLAWDBOT_STATE_DIR: process.env.CLAWDBOT_STATE_DIR || STATE_DIR,
        CLAWDBOT_WORKSPACE_DIR: process.env.CLAWDBOT_WORKSPACE_DIR || WORKSPACE_DIR,
      },
    });

    let out = "";
    proc.stdout?.on("data", (d) => (out += d.toString("utf8")));
    proc.stderr?.on("data", (d) => (out += d.toString("utf8")));

    proc.on("error", (err) => {
      out += `\n[spawn error] ${String(err)}\n`;
      resolve({ code: 127, output: out });
    });

    proc.on("close", (code) => resolve({ code: code ?? 0, output: out }));
  });
}

app.post("/setup/api/run", requireSetupAuth, async (req, res) => {
  try {
    if (isConfigured()) {
      await ensureGatewayRunning();
      return res.json({ ok: true, output: "Already configured.\nUse Reset setup if you want to rerun onboarding.\n" });
    }

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  const payload = req.body || {};
  const onboardArgs = buildOnboardArgs(payload);
  const onboard = await runCmd(OPENCLAW_NODE, clawArgs(onboardArgs));

  let extra = "";

  const ok = onboard.code === 0 && isConfigured();

  // Optional channel setup (only after successful onboarding, and only if the installed CLI supports it).
  if (ok) {
    // Ensure gateway config is set so it can start properly.
    // (We enforce loopback bind since the wrapper proxies externally.)
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.mode", "local"]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.mode", "token"]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.token", OPENCLAW_GATEWAY_TOKEN]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.bind", "loopback"]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.port", String(INTERNAL_GATEWAY_PORT)]));

    const channelsHelp = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"]));
    const helpText = channelsHelp.output || "";

    const supports = (name) => helpText.includes(name);

    if (payload.telegramToken?.trim()) {
      if (!supports("telegram")) {
        extra += "\n[telegram] skipped (this openclaw build does not list telegram in `channels add --help`)\n";
      } else {
        // Avoid `channels add` here (it has proven flaky across builds); write config directly.
        const token = payload.telegramToken.trim();
        const cfgObj = {
          enabled: true,
          dmPolicy: "pairing",
          botToken: token,
          groupPolicy: "allowlist",
          streamMode: "partial",
        };
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "--json", "channels.telegram", JSON.stringify(cfgObj)]),
        );
        const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.telegram"]));
        extra += `\n[telegram config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
        extra += `\n[telegram verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
      }
    }

    if (payload.discordToken?.trim()) {
      if (!supports("discord")) {
        extra += "\n[discord] skipped (this openclaw build does not list discord in `channels add --help`)\n";
      } else {
        const token = payload.discordToken.trim();
        const cfgObj = {
          enabled: true,
          token,
          groupPolicy: "allowlist",
          dm: {
            policy: "pairing",
          },
        };
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "--json", "channels.discord", JSON.stringify(cfgObj)]),
        );
        const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.discord"]));
        extra += `\n[discord config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
        extra += `\n[discord verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
      }
    }

    if (payload.slackBotToken?.trim() || payload.slackAppToken?.trim()) {
      if (!supports("slack")) {
        extra += "\n[slack] skipped (this openclaw build does not list slack in `channels add --help`)\n";
      } else {
        const cfgObj = {
          enabled: true,
          botToken: payload.slackBotToken?.trim() || undefined,
          appToken: payload.slackAppToken?.trim() || undefined,
        };
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "--json", "channels.slack", JSON.stringify(cfgObj)]),
        );
        const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.slack"]));
        extra += `\n[slack config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
        extra += `\n[slack verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
      }
    }

    // Apply changes immediately.
    await restartGateway();
  }

  return res.status(ok ? 200 : 500).json({
    ok,
    output: `${onboard.output}${extra}`,
  });
  } catch (err) {
    console.error("[/setup/api/run] error:", err);
    return res.status(500).json({ ok: false, output: `Internal error: ${String(err)}` });
  }
});

app.get("/setup/api/debug", requireSetupAuth, async (_req, res) => {
  const v = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
  const help = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"]));
  res.json({
    wrapper: {
      node: process.version,
      port: PORT,
      stateDir: STATE_DIR,
      workspaceDir: WORKSPACE_DIR,
      configPath: configPath(),
      gatewayTokenFromEnv: Boolean(process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || process.env.CLAWDBOT_GATEWAY_TOKEN?.trim()),
      gatewayTokenPersisted: fs.existsSync(path.join(STATE_DIR, "gateway.token")),
      railwayCommit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    },
    openclaw: {
      entry: OPENCLAW_ENTRY,
      node: OPENCLAW_NODE,
      version: v.output.trim(),
      channelsAddHelpIncludesTelegram: help.output.includes("telegram"),
    },
  });
});

// --- Debug console (Option A: allowlisted commands + config editor) ---

function redactSecrets(text) {
  if (!text) return text;
  // Very small best-effort redaction. (Config paths/values may still contain secrets.)
  return String(text)
    .replace(/(sk-[A-Za-z0-9_-]{10,})/g, "[REDACTED]")
    .replace(/(gho_[A-Za-z0-9_]{10,})/g, "[REDACTED]")
    .replace(/(xox[baprs]-[A-Za-z0-9-]{10,})/g, "[REDACTED]")
    .replace(/(AA[A-Za-z0-9_-]{10,}:\S{10,})/g, "[REDACTED]");
}

const ALLOWED_CONSOLE_COMMANDS = new Set([
  // Wrapper-managed lifecycle
  "gateway.restart",
  "gateway.stop",
  "gateway.start",

  // OpenClaw CLI helpers
  "openclaw.version",
  "openclaw.status",
  "openclaw.health",
  "openclaw.doctor",
  "openclaw.logs.tail",
  "openclaw.config.get",
]);

app.post("/setup/api/console/run", requireSetupAuth, async (req, res) => {
  const payload = req.body || {};
  const cmd = String(payload.cmd || "").trim();
  const arg = String(payload.arg || "").trim();

  if (!ALLOWED_CONSOLE_COMMANDS.has(cmd)) {
    return res.status(400).json({ ok: false, error: "Command not allowed" });
  }

  try {
    if (cmd === "gateway.restart") {
      await restartGateway();
      return res.json({ ok: true, output: "Gateway restarted (wrapper-managed).\n" });
    }
    if (cmd === "gateway.stop") {
      if (gatewayProc) {
        try { gatewayProc.kill("SIGTERM"); } catch {}
        await sleep(750);
        gatewayProc = null;
      }
      return res.json({ ok: true, output: "Gateway stopped (wrapper-managed).\n" });
    }
    if (cmd === "gateway.start") {
      const r = await ensureGatewayRunning();
      return res.json({ ok: Boolean(r.ok), output: r.ok ? "Gateway started.\n" : `Gateway not started: ${r.reason}\n` });
    }

    if (cmd === "openclaw.version") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.status") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["status"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.health") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["health"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.doctor") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["doctor"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.logs.tail") {
      const lines = Math.max(50, Math.min(1000, Number.parseInt(arg || "200", 10) || 200));
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["logs", "--tail", String(lines)]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.config.get") {
      if (!arg) return res.status(400).json({ ok: false, error: "Missing config path" });
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", arg]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }

    return res.status(400).json({ ok: false, error: "Unhandled command" });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

app.get("/setup/api/config/raw", requireSetupAuth, async (_req, res) => {
  try {
    const p = configPath();
    const exists = fs.existsSync(p);
    const content = exists ? fs.readFileSync(p, "utf8") : "";
    res.json({ ok: true, path: p, exists, content });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.post("/setup/api/config/raw", requireSetupAuth, async (req, res) => {
  try {
    const content = String((req.body && req.body.content) || "");
    if (content.length > 500_000) {
      return res.status(413).json({ ok: false, error: "Config too large" });
    }

    fs.mkdirSync(STATE_DIR, { recursive: true });

    const p = configPath();
    // Backup
    if (fs.existsSync(p)) {
      const backupPath = `${p}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      fs.copyFileSync(p, backupPath);
    }

    fs.writeFileSync(p, content, { encoding: "utf8", mode: 0o600 });

    // Apply immediately.
    if (isConfigured()) {
      await restartGateway();
    }

    res.json({ ok: true, path: p });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.post("/setup/api/pairing/approve", requireSetupAuth, async (req, res) => {
  const { channel, code } = req.body || {};
  if (!channel || !code) {
    return res.status(400).json({ ok: false, error: "Missing channel or code" });
  }
  const r = await runCmd(OPENCLAW_NODE, clawArgs(["pairing", "approve", String(channel), String(code)]));
  return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: r.output });
});

app.post("/setup/api/reset", requireSetupAuth, async (_req, res) => {
  // Stop gateway so it doesn't hold stale config or recreate files.
  if (gatewayProc) {
    try { gatewayProc.kill("SIGTERM"); } catch {}
    await sleep(750);
    gatewayProc = null;
  }
  // Minimal reset: delete the config file so /setup can rerun.
  // Keep credentials/sessions/workspace by default.
  try {
    fs.rmSync(configPath(), { force: true });
    res.type("text/plain").send("OK - deleted config file. You can rerun setup now.");
  } catch (err) {
    res.status(500).type("text/plain").send(String(err));
  }
});

app.get("/setup/export", requireSetupAuth, async (_req, res) => {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  res.setHeader("content-type", "application/gzip");
  res.setHeader(
    "content-disposition",
    `attachment; filename="openclaw-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz"`,
  );

  // Prefer exporting from a common /data root so archives are easy to inspect and restore.
  // This preserves dotfiles like /data/.openclaw/openclaw.json.
  const stateAbs = path.resolve(STATE_DIR);
  const workspaceAbs = path.resolve(WORKSPACE_DIR);

  const dataRoot = "/data";
  const underData = (p) => p === dataRoot || p.startsWith(dataRoot + path.sep);

  let cwd = "/";
  let paths = [stateAbs, workspaceAbs].map((p) => p.replace(/^\//, ""));

  if (underData(stateAbs) && underData(workspaceAbs)) {
    cwd = dataRoot;
    // We export relative to /data so the archive contains: .openclaw/... and workspace/...
    paths = [
      path.relative(dataRoot, stateAbs) || ".",
      path.relative(dataRoot, workspaceAbs) || ".",
    ];
  }

  const stream = tar.c(
    {
      gzip: true,
      portable: true,
      noMtime: true,
      cwd,
      onwarn: () => {},
    },
    paths,
  );

  stream.on("error", (err) => {
    console.error("[export]", err);
    if (!res.headersSent) res.status(500);
    res.end(String(err));
  });

  stream.pipe(res);
});

function isUnderDir(p, root) {
  const abs = path.resolve(p);
  const r = path.resolve(root);
  return abs === r || abs.startsWith(r + path.sep);
}

function looksSafeTarPath(p) {
  if (!p) return false;
  // tar paths always use / separators
  if (p.startsWith("/") || p.startsWith("\\")) return false;
  // windows drive letters
  if (/^[A-Za-z]:[\\/]/.test(p)) return false;
  // path traversal
  if (p.split("/").includes("..")) return false;
  return true;
}

async function readBodyBuffer(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Import a backup created by /setup/export.
// This is intentionally limited to restoring into /data to avoid overwriting arbitrary host paths.
app.post("/setup/import", requireSetupAuth, async (req, res) => {
  try {
    const dataRoot = "/data";
    if (!isUnderDir(STATE_DIR, dataRoot) || !isUnderDir(WORKSPACE_DIR, dataRoot)) {
      return res
        .status(400)
        .type("text/plain")
        .send("Import is only supported when OPENCLAW_STATE_DIR and OPENCLAW_WORKSPACE_DIR are under /data (Railway volume).\n");
    }

    // Stop gateway before restore so we don't overwrite live files.
    if (gatewayProc) {
      try { gatewayProc.kill("SIGTERM"); } catch {}
      await sleep(750);
      gatewayProc = null;
    }

    const buf = await readBodyBuffer(req, 250 * 1024 * 1024); // 250MB max
    if (!buf.length) return res.status(400).type("text/plain").send("Empty body\n");

    // Extract into /data.
    // We only allow safe relative paths, and we intentionally do NOT delete existing files.
    // (Users can reset/redeploy or manually clean the volume if desired.)
    const tmpPath = path.join(os.tmpdir(), `openclaw-import-${Date.now()}.tar.gz`);
    fs.writeFileSync(tmpPath, buf);

    await tar.x({
      file: tmpPath,
      cwd: dataRoot,
      gzip: true,
      strict: true,
      onwarn: () => {},
      filter: (p) => {
        // Allow only paths that look safe.
        return looksSafeTarPath(p);
      },
    });

    try { fs.rmSync(tmpPath, { force: true }); } catch {}

    // Restart gateway after restore.
    if (isConfigured()) {
      await restartGateway();
    }

    res.type("text/plain").send("OK - imported backup into /data and restarted gateway.\n");
  } catch (err) {
    console.error("[import]", err);
    res.status(500).type("text/plain").send(String(err));
  }
});

// Proxy everything else to the gateway.
const proxy = httpProxy.createProxyServer({
  target: GATEWAY_TARGET,
  ws: true,
  xfwd: true,
});

proxy.on("error", (err, _req, _res) => {
  console.error("[proxy]", err);
});

app.use(async (req, res) => {
  // If not configured, force users to /setup for any non-setup routes.
  // In pool mode, skip the redirect — the auto-boot will handle config.
  if (!POOL_MODE && !isConfigured() && !req.path.startsWith("/setup")) {
    return res.redirect("/setup");
  }

  if (isConfigured()) {
    try {
      await ensureGatewayRunning();
    } catch (err) {
      return res.status(503).type("text/plain").send(`Gateway not ready: ${String(err)}`);
    }
  }

  return proxy.web(req, res, { target: GATEWAY_TARGET });
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`[wrapper] listening on :${PORT}`);
  console.log(`[wrapper] state dir: ${STATE_DIR}`);
  console.log(`[wrapper] workspace dir: ${WORKSPACE_DIR}`);
  console.log(`[wrapper] gateway token: ${OPENCLAW_GATEWAY_TOKEN ? "(set)" : "(missing)"}`);
  console.log(`[wrapper] gateway target: ${GATEWAY_TARGET}`);
  if (POOL_MODE) {
    console.log(`[wrapper] POOL MODE enabled (auth choice: ${POOL_AUTH_CHOICE})`);
  } else if (!SETUP_PASSWORD) {
    console.warn("[wrapper] WARNING: SETUP_PASSWORD is not set; /setup will error.");
  }
  // Don't start gateway unless configured; proxy will ensure it starts.
});

server.on("upgrade", async (req, socket, head) => {
  if (!isConfigured()) {
    socket.destroy();
    return;
  }
  try {
    await ensureGatewayRunning();
  } catch {
    socket.destroy();
    return;
  }
  proxy.ws(req, socket, head, { target: GATEWAY_TARGET });
});

process.on("SIGTERM", () => {
  // Best-effort shutdown
  try {
    if (gatewayProc) gatewayProc.kill("SIGTERM");
  } catch {
    // ignore
  }
  process.exit(0);
});

// --- Pool Mode: Auto-Boot ---
// When POOL_MODE=true, auto-write config and start the gateway on container startup.
// The instance will be marked as ready once the gateway is up.
if (POOL_MODE) {
  (async () => {
    console.log("[pool] Pool mode enabled — auto-booting...");

    if (!POOL_API_KEY) {
      console.error("[pool] ERROR: POOL_API_KEY must be set in pool mode");
      return;
    }

    const providerCfg = AUTH_PROVIDER_CONFIG[POOL_AUTH_CHOICE];
    if (!providerCfg) {
      console.error(`[pool] ERROR: Unknown POOL_AUTH_CHOICE="${POOL_AUTH_CHOICE}"`);
      return;
    }

    // Verify the API key env var is set for the chosen provider.
    if (providerCfg.envVar && !process.env[providerCfg.envVar]) {
      console.error(`[pool] ERROR: ${providerCfg.envVar} must be set for auth choice "${POOL_AUTH_CHOICE}"`);
      return;
    }

    // Write base config (same structure as the interactive setup).
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

    const config = {
      gateway: {
        mode: "local",
        port: INTERNAL_GATEWAY_PORT,
        bind: "loopback",
        auth: { mode: "token", token: OPENCLAW_GATEWAY_TOKEN },
        controlUi: { allowInsecureAuth: true },
      },
      plugins: {
        load: { paths: ["/openclaw/extensions"] },
      },
    };

    if (providerCfg.model) {
      config.agents = { defaults: { model: { primary: providerCfg.model } } };
      console.log(`[pool] Model: ${providerCfg.model}`);
    }

    if (providerCfg.customProvider) {
      config.models = { mode: "merge", providers: providerCfg.customProvider };
    }

    fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
    console.log("[pool] Config written");

    // Start the gateway — pool mode gets a longer timeout since this is cold boot.
    try {
      await startGateway();
      const ready = await waitForGatewayReady({ timeoutMs: 120_000 });
      if (!ready) {
        throw new Error("Gateway did not become ready within 120s");
      }
      // Pre-warm XMTP identity: create an identity + runtime client now so that
      // provision later only needs to create a new conversation (fast path).
      try {
        console.log("[pool] Pre-warming XMTP identity...");

        // 1. Call /convos/setup to create XMTP identity + temporary conversation
        let setupResult;
        for (let attempt = 1; attempt <= 5; attempt++) {
          try {
            setupResult = await convosHttp("/convos/setup", {
              method: "POST",
              body: { env: XMTP_ENV, name: "Agent" },
            });
            break;
          } catch (err) {
            if (attempt === 5) throw err;
            console.log(`[pool] Pre-warm setup attempt ${attempt} failed, retrying in 2s...`);
            await sleep(2000);
          }
        }
        console.log(`[pool] Pre-warm: XMTP identity created (conversationId=${setupResult.conversationId})`);

        // 2. Immediately complete setup to persist privateKey + config
        await convosHttp("/convos/setup/complete", { method: "POST" });
        console.log("[pool] Pre-warm: setup completed, config persisted");

        // 3. Gateway file-watcher detects convos channel config change and
        //    hot-reloads → starts the runtime ConvosSDKClient with persistent DB.
        //    No explicit restart needed — hot-reload is less disruptive and
        //    keeps the XMTP connection alive for faster message delivery.
        console.log("[pool] Pre-warm: config persisted, gateway will hot-reload");
      } catch (err) {
        // Pre-warm is best-effort — instance is still usable without it,
        // provision will just take longer (cold XMTP identity creation).
        console.warn("[pool] Pre-warm failed (non-fatal):", err.message || err);
      }

      poolReady = true;
      console.log("[pool] Gateway is up — instance is READY for provision");
    } catch (err) {
      console.error("[pool] Failed to start gateway:", err);
    }
  })();
}
