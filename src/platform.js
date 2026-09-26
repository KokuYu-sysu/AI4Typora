const OPENAI_OAUTH_PROVIDER = {
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  authorizeUrl: "https://auth.openai.com/oauth/authorize",
  tokenUrl: "https://auth.openai.com/oauth/token",
  redirectUri: "http://localhost:1455/auth/callback",
  scope: "openid profile email offline_access",
  jwtClaimPath: "https://api.openai.com/auth",
  accountIdClaim: "chatgpt_account_id",
  defaultOriginator: "nanobot",
  tokenFilename: "codex.json",
};

const TOKEN_REFRESH_MIN_TTL_SECONDS = 60;
const OAUTH_CALLBACK_TIMEOUT_MS = 120000;
const OAUTH_SUCCESS_HTML = `
<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>OAuth Success</title></head>
  <body style="font-family: -apple-system,Segoe UI,Arial,sans-serif; padding: 24px;">
    <h2>Login completed</h2>
    <p>You can close this page and return to Typora.</p>
  </body>
</html>
`.trim();

function getEnvValue(env, key) {
  if (env && env[key]) {
    return env[key];
  }
  try {
    if (typeof process !== "undefined" && process.env && process.env[key]) {
      return process.env[key];
    }
  } catch (_) {}
  return "";
}

function joinPath() {
  return Array.from(arguments)
    .filter(Boolean)
    .map((part, index) => {
      const normalized = String(part).replace(/\\/g, "/");
      return index === 0 ? normalized.replace(/\/+$/g, "") : normalized.replace(/^\/+|\/+$/g, "");
    })
    .filter(Boolean)
    .join("/");
}

function dedupePaths(paths) {
  const seen = new Set();
  const output = [];
  for (const value of paths) {
    if (!value) continue;
    const key = String(value).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  return output;
}

function getNodeModule(name) {
  try {
    if (typeof window !== "undefined" && window.reqnode) {
      return window.reqnode(name);
    }
  } catch (_) {}

  try {
    if (typeof process !== "undefined" && typeof process.getBuiltinModule === "function") {
      return process.getBuiltinModule(name);
    }
  } catch (_) {}

  try {
    if (typeof require === "function") {
      return require(name);
    }
  } catch (_) {}

  return null;
}

export function getChatDataDirectory(env = null) {
  const appData = env === null ? getEnvValue(null, "APPDATA") : String(env.APPDATA || "");
  if (!appData) {
    throw new Error("APPDATA is unavailable; chat history cannot be stored safely.");
  }
  const fs = getNodeModule("fs");
  const pathModule = getNodeModule("path");
  if (!fs || !pathModule?.join) {
    throw new Error("Node filesystem access is unavailable for chat history.");
  }
  return pathModule.join(appData, "typora-ai-edit");
}

function normalizeForFs(filePath) {
  return String(filePath || "").replace(/\//g, "\\");
}

function defaultOAuthCliKitTokenPath(env) {
  const appData = getEnvValue(env, "APPDATA");
  if (appData) {
    return joinPath(appData, "oauth-cli-kit", "auth", OPENAI_OAUTH_PROVIDER.tokenFilename);
  }

  const localAppData = getEnvValue(env, "LOCALAPPDATA");
  if (localAppData) {
    return joinPath(localAppData, "oauth-cli-kit", "auth", OPENAI_OAUTH_PROVIDER.tokenFilename);
  }

  const home = getEnvValue(env, "USERPROFILE") || getEnvValue(env, "HOME");
  if (home) {
    return joinPath(home, ".codex", OPENAI_OAUTH_PROVIDER.tokenFilename);
  }

  return OPENAI_OAUTH_PROVIDER.tokenFilename;
}

function defaultOAuthUserInfoPath(env) {
  const appData = getEnvValue(env, "APPDATA");
  if (appData) {
    return joinPath(appData, "oauth-cli-kit", "auth", "codex-user-info.json");
  }

  const home = getEnvValue(env, "USERPROFILE") || getEnvValue(env, "HOME");
  if (home) {
    return joinPath(home, ".codex", "codex-user-info.json");
  }

  return "codex-user-info.json";
}

function defaultPromptExportPath(env) {
  const appData = getEnvValue(env, "APPDATA");
  if (appData) {
    return joinPath(appData, "oauth-cli-kit", "exports", "ai-edit-prompts.json");
  }

  const home = getEnvValue(env, "USERPROFILE") || getEnvValue(env, "HOME");
  if (home) {
    return joinPath(home, ".codex", "ai-edit-prompts.json");
  }

  return "ai-edit-prompts.json";
}

function resolveTokenOutputPath(settings) {
  if (settings && settings.oauthTokenPath && String(settings.oauthTokenPath).trim()) {
    return String(settings.oauthTokenPath).trim();
  }
  return defaultOAuthCliKitTokenPath(null);
}

function resolveUserInfoPath(settings, status) {
  if (settings && settings.oauthUserInfoPath && String(settings.oauthUserInfoPath).trim()) {
    return String(settings.oauthUserInfoPath).trim();
  }
  if (status && status.sourcePath) {
    const pathModule = getNodeModule("path");
    if (pathModule && typeof pathModule.dirname === "function") {
      return joinPath(pathModule.dirname(status.sourcePath), "codex-user-info.json");
    }
  }
  return defaultOAuthUserInfoPath(null);
}

function resolvePromptExportPath(settings) {
  if (settings && settings.promptExportPath && String(settings.promptExportPath).trim()) {
    return String(settings.promptExportPath).trim();
  }
  return defaultPromptExportPath(null);
}

function parseBase64UrlJson(segment) {
  if (!segment) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch (_) {}

  try {
    const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch (_) {}

  return null;
}

function toBase64Url(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function randomBase64Url(size) {
  const crypto = getNodeModule("crypto");
  if (!crypto || typeof crypto.randomBytes !== "function") {
    throw new Error("Node crypto module is unavailable.");
  }
  return toBase64Url(crypto.randomBytes(size));
}

function createPkcePair() {
  const crypto = getNodeModule("crypto");
  if (!crypto || typeof crypto.createHash !== "function") {
    throw new Error("Node crypto module is unavailable.");
  }
  const verifier = randomBase64Url(32);
  const challenge = toBase64Url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function createState() {
  return randomBase64Url(16);
}

export function decodeOpenAiAccountIdFromAccessToken(accessToken) {
  if (!accessToken || typeof accessToken !== "string") {
    return null;
  }
  const parts = accessToken.split(".");
  if (parts.length < 2) {
    return null;
  }
  const payload = parseBase64UrlJson(parts[1]);
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const authClaims = payload[OPENAI_OAUTH_PROVIDER.jwtClaimPath];
  if (!authClaims || typeof authClaims !== "object") {
    return null;
  }
  const accountId = authClaims[OPENAI_OAUTH_PROVIDER.accountIdClaim];
  return accountId ? String(accountId) : null;
}

function deriveTokenExpiry(raw, accessToken) {
  if (raw && typeof raw.expires === "number") return raw.expires;
  if (raw && raw.tokens && typeof raw.tokens.expires === "number") return raw.tokens.expires;
  if (raw && typeof raw.expires_at === "number") return raw.expires_at;
  if (!accessToken || typeof accessToken !== "string") return null;

  const parts = accessToken.split(".");
  if (parts.length < 2) {
    return null;
  }

  const payload = parseBase64UrlJson(parts[1]);
  if (!payload || typeof payload.exp !== "number") {
    return null;
  }

  return payload.exp * 1000;
}

function detectTokenSourceType(sourcePath) {
  const lower = String(sourcePath || "").toLowerCase().replace(/\\/g, "/");
  if (lower.includes("oauth-cli-kit")) {
    return "oauth_cli_kit";
  }
  if (lower.endsWith("/.codex/auth.json")) {
    return "codex_auth";
  }
  return "unknown";
}

export function normalizeOauthTokenResponse(payload, previousToken = null, nowMs = Date.now()) {
  const access = payload && payload.access_token;
  const refresh = (payload && payload.refresh_token) || (previousToken && previousToken.refresh);
  const expiresIn = payload && Number(payload.expires_in);
  if (!access || !refresh || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error("OAuth token response missing required fields.");
  }

  const accountId = decodeOpenAiAccountIdFromAccessToken(access)
    || (previousToken && previousToken.account_id)
    || null;
  if (!accountId) {
    throw new Error("Unable to resolve account_id from OAuth token.");
  }

  return {
    access,
    refresh,
    expires: Math.trunc(nowMs + expiresIn * 1000),
    account_id: accountId,
  };
}

export function normalizeTokenRecord(raw, sourcePath) {
  const access = raw && (raw.access || raw.access_token || (raw.tokens && (raw.tokens.access_token || raw.tokens.access)));
  const refresh = raw && (raw.refresh || raw.refresh_token || (raw.tokens && (raw.tokens.refresh_token || raw.tokens.refresh)));
  const accountId = raw && (
    raw.account_id
    || raw.accountId
    || (raw.tokens && (raw.tokens.account_id || raw.tokens.accountId))
  ) || decodeOpenAiAccountIdFromAccessToken(access);

  if (!access || !accountId) {
    throw new Error("Unsupported token format");
  }

  return {
    access,
    refresh: refresh || null,
    account_id: accountId,
    expires: deriveTokenExpiry(raw, access),
    source_path: sourcePath || "",
    source_type: detectTokenSourceType(sourcePath),
  };
}

export function getTokenCandidatePathsFromEnv(settings, env) {
  const paths = [];
  if (settings && settings.oauthTokenPath) {
    paths.push(String(settings.oauthTokenPath).trim());
  }

  paths.push(defaultOAuthCliKitTokenPath(env));

  const localAppData = getEnvValue(env, "LOCALAPPDATA");
  if (localAppData) {
    paths.push(joinPath(localAppData, "oauth-cli-kit", "auth", OPENAI_OAUTH_PROVIDER.tokenFilename));
  }

  const home = getEnvValue(env, "USERPROFILE") || getEnvValue(env, "HOME");
  if (home) {
    paths.push(joinPath(home, ".codex", "auth.json"));
  }

  return dedupePaths(paths);
}

export function getTokenCandidatePaths(settings) {
  return getTokenCandidatePathsFromEnv(settings, null);
}

function saveTokenFile(filePath, token) {
  const fs = getNodeModule("fs");
  const pathModule = getNodeModule("path");
  if (!fs || !pathModule) {
    throw new Error("Node fs/path is unavailable in this environment.");
  }

  const fsPath = normalizeForFs(filePath);
  fs.mkdirSync(pathModule.dirname(fsPath), { recursive: true });
  const payload = {
    access: token.access,
    refresh: token.refresh,
    expires: token.expires,
    account_id: token.account_id,
  };
  fs.writeFileSync(fsPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export function readFileText(filePath) {
  const fs = getNodeModule("fs");
  if (!fs || !filePath) {
    return null;
  }

  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (_) {
    return null;
  }
}

function decodeFileUrlToPath(fileUrl) {
  try {
    const url = new URL(fileUrl);
    let pathname = decodeURIComponent(url.pathname || "");
    if (/^\/[A-Za-z]:\//.test(pathname)) {
      pathname = pathname.slice(1);
    }
    return pathname.replace(/\//g, "\\");
  } catch (_) {
    return null;
  }
}

function guessMimeTypeFromPath(filePath) {
  const pathModule = getNodeModule("path");
  const ext = String(pathModule?.extname?.(filePath) || "").toLowerCase();
  const map = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".avif": "image/avif",
  };
  return map[ext] || "application/octet-stream";
}

function filePathToDataUrl(filePath) {
  const fs = getNodeModule("fs");
  if (!fs) {
    throw new Error("Node fs module is unavailable.");
  }

  const normalizedPath = normalizeForFs(filePath);
  if (!fs.existsSync(normalizedPath)) {
    throw new Error(`Image file not found: ${filePath}`);
  }

  const buffer = fs.readFileSync(normalizedPath);
  const mime = guessMimeTypeFromPath(normalizedPath);
  return `data:${mime};base64,${Buffer.from(buffer).toString("base64")}`;
}

export function prepareImageInputForModel(imageSource) {
  const source = String(imageSource || "").trim();
  if (!source) {
    throw new Error("Image source is empty.");
  }

  if (source.startsWith("data:")) {
    return source;
  }
  if (/^https?:\/\//i.test(source)) {
    return source;
  }
  if (source.startsWith("blob:")) {
    throw new Error("Blob image URLs are not supported. Please use a local file or http(s) image.");
  }
  if (/^file:\/\//i.test(source)) {
    const localPath = decodeFileUrlToPath(source);
    if (!localPath) {
      throw new Error("Invalid file URL for image.");
    }
    return filePathToDataUrl(localPath);
  }

  return filePathToDataUrl(source);
}

function locateTokenRecord(settings) {
  const candidatePaths = getTokenCandidatePaths(settings);
  let firstProblem = null;

  for (const candidatePath of candidatePaths) {
    const rawText = readFileText(candidatePath);
    if (!rawText) {
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (_) {
      if (!firstProblem) {
        firstProblem = {
          ok: false,
          state: "invalid",
          message: "OAuth token file format is not supported.",
          sourcePath: candidatePath,
        };
      }
      continue;
    }

    try {
      const token = normalizeTokenRecord(parsed, candidatePath);
      return {
        ok: true,
        token,
        sourcePath: candidatePath,
      };
    } catch (_) {
      if (!firstProblem) {
        firstProblem = {
          ok: false,
          state: "invalid",
          message: "OAuth token file format is not supported.",
          sourcePath: candidatePath,
        };
      }
    }
  }

  return firstProblem || {
    ok: false,
    state: "missing",
    message: "No OAuth token found in the common Windows paths.",
  };
}

export function getOAuthStatus(settings) {
  const located = locateTokenRecord(settings);
  if (!located.ok) {
    return located;
  }

  const token = located.token;
  if (token.expires && Date.now() > token.expires && !token.refresh) {
    return {
      ok: false,
      state: "expired",
      message: "OAuth token expired and no refresh token was found. Please login again.",
      sourcePath: located.sourcePath,
    };
  }

  return {
    ok: true,
    state: "connected",
    message: "Connected",
    token,
    sourcePath: located.sourcePath,
  };
}

function getRefreshOutputPath(settings, sourcePath) {
  const sourceType = detectTokenSourceType(sourcePath);
  if (sourceType === "codex_auth") {
    return resolveTokenOutputPath(settings);
  }
  return sourcePath;
}

async function requestOAuthToken(bodyParams) {
  const response = await fetch(OPENAI_OAUTH_PROVIDER.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(bodyParams).toString(),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`OAuth token API ${response.status}: ${errorText.slice(0, 200)}`);
  }

  return response.json();
}

async function refreshOAuthToken(settings, token, sourcePath) {
  if (!token.refresh) {
    const error = new Error("OAuth refresh token is unavailable.");
    error.uiKey = "api.oauthRefreshUnavailable";
    throw error;
  }
  const payload = await requestOAuthToken({
    grant_type: "refresh_token",
    refresh_token: token.refresh,
    client_id: OPENAI_OAUTH_PROVIDER.clientId,
  });

  const refreshed = normalizeOauthTokenResponse(payload, token);
  const outputPath = getRefreshOutputPath(settings, sourcePath);
  saveTokenFile(outputPath, refreshed);
  return {
    ...refreshed,
    source_path: outputPath,
    source_type: detectTokenSourceType(outputPath),
  };
}

async function ensureFreshToken(settings, token, sourcePath, minTtlSeconds = TOKEN_REFRESH_MIN_TTL_SECONDS) {
  const now = Date.now();
  const expires = token.expires || 0;
  if (expires - now > minTtlSeconds * 1000) {
    return token;
  }
  return refreshOAuthToken(settings, token, sourcePath);
}

export function readToken(settings) {
  const status = getOAuthStatus(settings);
  return status.ok ? status.token : null;
}

export async function getFreshToken(settings, minTtlSeconds = TOKEN_REFRESH_MIN_TTL_SECONDS) {
  const located = locateTokenRecord(settings);
  if (!located.ok || !located.token) {
    const error = new Error(located.message || "OAuth token unavailable.");
    error.uiKey = located.state === "invalid" ? "api.oauthInvalid"
      : located.state === "missing" ? "api.oauthMissing" : "api.oauthTokenUnavailable";
    throw error;
  }
  return ensureFreshToken(settings, located.token, located.sourcePath, minTtlSeconds);
}

function openExternalUrl(url) {
  try {
    const electron = getNodeModule("electron");
    if (electron && electron.shell && typeof electron.shell.openExternal === "function") {
      electron.shell.openExternal(url);
      return true;
    }
  } catch (_) {}

  try {
    if (typeof window !== "undefined" && typeof window.open === "function") {
      window.open(url, "_blank", "noopener");
      return true;
    }
  } catch (_) {}

  try {
    const childProcess = getNodeModule("child_process");
    if (childProcess && typeof childProcess.exec === "function") {
      childProcess.exec(`start "" "${url}"`);
      return true;
    }
  } catch (_) {}

  return false;
}

export function buildOpenAiOauthAuthorizeUrl({ state, codeChallenge, originator }) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: OPENAI_OAUTH_PROVIDER.clientId,
    redirect_uri: OPENAI_OAUTH_PROVIDER.redirectUri,
    scope: OPENAI_OAUTH_PROVIDER.scope,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: originator || OPENAI_OAUTH_PROVIDER.defaultOriginator,
  });
  return `${OPENAI_OAUTH_PROVIDER.authorizeUrl}?${params.toString()}`;
}

function startLocalCallbackServer(expectedState) {
  const http = getNodeModule("http");
  if (!http) {
    throw new Error("Node http module is unavailable.");
  }

  let settled = false;
  let settle = null;
  const codePromise = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });

  const server = http.createServer((req, res) => {
    try {
      const requestUrl = new URL(req.url, OPENAI_OAUTH_PROVIDER.redirectUri);
      if (requestUrl.pathname !== "/auth/callback") {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }

      const code = requestUrl.searchParams.get("code");
      const state = requestUrl.searchParams.get("state");
      const errorCode = requestUrl.searchParams.get("error");
      const errorDescription = requestUrl.searchParams.get("error_description");

      if (state !== expectedState) {
        res.statusCode = 400;
        res.end("State mismatch");
        return;
      }
      if (errorCode) {
        res.statusCode = 400;
        res.end(`OAuth error: ${errorCode}`);
        if (!settled) {
          settled = true;
          const details = errorDescription ? `${errorCode}: ${errorDescription}` : errorCode;
          settle.reject(new Error(`OAuth provider returned an error: ${details}`));
        }
        return;
      }
      if (!code) {
        res.statusCode = 400;
        res.end("Missing code");
        return;
      }

      const body = OAUTH_SUCCESS_HTML;
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(body);

      if (!settled) {
        settled = true;
        settle.resolve(code);
      }
    } catch (error) {
      if (!settled) {
        settled = true;
        settle.reject(error);
      }
      try {
        res.statusCode = 500;
        res.end("Internal error");
      } catch (_) {}
    }
  });

  const listening = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(1455, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    server,
    codePromise,
    listening,
    close() {
      try {
        server.close();
      } catch (_) {}
    },
  };
}

export async function loginOpenAiOauthInteractive(settings = {}, options = {}) {
  const { verifier, challenge } = createPkcePair();
  const state = createState();
  const authorizeUrl = buildOpenAiOauthAuthorizeUrl({
    state,
    codeChallenge: challenge,
    originator: options.originator,
  });

  const callbackServer = startLocalCallbackServer(state);
  await callbackServer.listening;
  try {
    const opened = openExternalUrl(authorizeUrl);
    if (!opened) {
      throw new Error(`Unable to open browser. Please manually open: ${authorizeUrl}`);
    }

    const code = await Promise.race([
      callbackServer.codePromise,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("OAuth callback timeout. Please try login again.")), OAUTH_CALLBACK_TIMEOUT_MS);
      }),
    ]);

    const payload = await requestOAuthToken({
      grant_type: "authorization_code",
      client_id: OPENAI_OAUTH_PROVIDER.clientId,
      code,
      code_verifier: verifier,
      redirect_uri: OPENAI_OAUTH_PROVIDER.redirectUri,
    });
    const token = normalizeOauthTokenResponse(payload, null);
    const tokenPath = resolveTokenOutputPath(settings);
    saveTokenFile(tokenPath, token);
    return {
      tokenPath,
      token,
      authorizeUrl,
    };
  } finally {
    callbackServer.close();
  }
}

export function openOauthLoginPage() {
  return openExternalUrl("https://chatgpt.com/auth/login");
}

async function fetchUserInfoByEndpoint(token, endpoint) {
  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token.access}`,
      "chatgpt-account-id": token.account_id,
      accept: "application/json",
    },
  });

  if (!response.ok) {
    const err = await response.text().catch(() => "");
    throw new Error(`${response.status} ${err.slice(0, 120)}`.trim());
  }

  return response.json();
}

export async function downloadOAuthUserInfo(settings) {
  const token = await getFreshToken(settings);

  const endpoints = [
    "https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27",
    "https://chatgpt.com/backend-api/me",
  ];

  let payload = null;
  let lastError = null;
  for (const endpoint of endpoints) {
    try {
      payload = await fetchUserInfoByEndpoint(token, endpoint);
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!payload) {
    throw new Error(lastError?.message || "Failed to download user info.");
  }

  const fs = getNodeModule("fs");
  const pathModule = getNodeModule("path");
  if (!fs || !pathModule) {
    throw new Error("Node fs/path is unavailable in this environment.");
  }

  const status = getOAuthStatus(settings);
  const outputPath = resolveUserInfoPath(settings, status.ok ? status : null);
  const fsPath = normalizeForFs(outputPath);
  fs.mkdirSync(pathModule.dirname(fsPath), { recursive: true });
  fs.writeFileSync(fsPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  return outputPath;
}

export function buildPromptExportPayload(settings) {
  return {
    prompts_current: settings.prompts || {},
  };
}

export function exportPromptSettingsToFile(settings) {
  const fs = getNodeModule("fs");
  const pathModule = getNodeModule("path");
  if (!fs || !pathModule) {
    throw new Error("Node fs/path is unavailable in this environment.");
  }

  const outputPath = resolvePromptExportPath(settings);
  const fsPath = normalizeForFs(outputPath);
  fs.mkdirSync(pathModule.dirname(fsPath), { recursive: true });
  const payload = buildPromptExportPayload(settings);
  fs.writeFileSync(fsPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return outputPath;
}

export function extractPromptsFromImportedPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid JSON content.");
  }

  const candidate = (
    payload.prompts_current
      ? payload.prompts_current
      : payload
  );
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("No prompts_current object found in JSON.");
  }
  return candidate;
}

export function importPromptSettingsFromFile(settings) {
  const inputPath = resolvePromptExportPath(settings);
  const rawText = readFileText(inputPath);
  if (!rawText) {
    throw new Error(`Cannot read JSON file: ${inputPath}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (_) {
    throw new Error("JSON format is invalid.");
  }

  const prompts = extractPromptsFromImportedPayload(parsed);
  return {
    inputPath,
    prompts,
  };
}
