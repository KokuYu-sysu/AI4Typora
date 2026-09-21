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

export function normalizeWindowsDocumentPath(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const pathModule = getNodeModule("path");
  const windowsPath = raw.replace(/\//g, "\\");
  let normalized = pathModule?.win32?.normalize
    ? pathModule.win32.normalize(windowsPath)
    : windowsPath;
  let root = pathModule?.win32?.parse?.(normalized)?.root || "";
  if (!root && /^[a-z]:\\$/i.test(normalized)) root = normalized;
  if (!root && /^\\\\[^\\]+\\[^\\]+\\$/.test(normalized)) root = normalized;
  while (normalized.length > root.length && normalized.endsWith("\\")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized.toLowerCase();
}

export function hashDocumentPath(normalizedPath) {
  const value = normalizeWindowsDocumentPath(normalizedPath);
  const crypto = getNodeModule("crypto");
  if (!value || !crypto?.createHash) return "";
  return crypto.createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);
}

function filePathFromLocation(location) {
  const href = String(location?.href || "");
  if (!href.toLowerCase().startsWith("file:")) return "";
  try {
    const url = new URL(href);
    const pathname = decodeURIComponent(url.pathname || "");
    const localPath = url.host
      ? `\\\\${url.host}${pathname.replace(/\//g, "\\")}`
      : pathname.replace(/^\/([a-z]:)/i, "$1");
    return /\.md$/i.test(localPath) ? localPath : "";
  } catch (_) {
    return "";
  }
}

export function getCurrentDocumentIdentity(runtime = typeof window !== "undefined" ? window : globalThis) {
  const file = runtime?.File || {};
  const candidate = file.filePath || file.bundle?.filePath || filePathFromLocation(runtime?.location);
  const path = normalizeWindowsDocumentPath(candidate);
  const hash = hashDocumentPath(path);
  if (!path || !hash) {
    return { persistable: false, key: "unsaved", path: "", label: "Unsaved document" };
  }
  const parts = path.split("\\");
  return {
    persistable: true,
    key: `doc_${hash}`,
    path,
    label: parts[parts.length - 1] || "Untitled",
  };
}
