import { execFile, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const HTTP_URL_PATTERN = /\bhttps?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/i;
const HTTP_URL_GLOBAL_PATTERN = /\bhttps?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/gi;
const SINGLE_HTTP_URL_PATTERN = /^\s*https?:\/\/[^\s<>"']+\s*$/i;
const TRAILING_URL_PUNCTUATION_PATTERN = /[.,!?;:)\]}]+$/;
const URL_BALLOON_BUNDLE_ID = "com.apple.messages.URLBalloonProvider";
const DEFAULT_STATE_DIR =
  process.env.BRIDGE_STATE_DIR ||
  path.join(os.homedir(), ".bluebubbles-codex-bridge", "state");
const DEFAULT_RICH_LINK_ASSET_DIR = path.join(DEFAULT_STATE_DIR, "rich-link-previews");
const RICH_LINK_PAYLOAD_SCRIPT_PATH = fileURLToPath(
  new URL("../scripts/rich-link-payload.py", import.meta.url),
);
const LINK_PRESENTATION_SOURCE_SCRIPT_PATH = fileURLToPath(
  new URL("../scripts/linkpresentation-metadata.swift", import.meta.url),
);
const LINK_PRESENTATION_HELPER_PATH =
  process.env.LINK_PRESENTATION_HELPER_PATH ||
  path.join(DEFAULT_STATE_DIR, "build", "linkpresentation-metadata");
const HTML_FETCH_TIMEOUT_MS = 8_000;
const ASSET_FETCH_TIMEOUT_MS = 8_000;
const LINK_PRESENTATION_TIMEOUT_MS = 14_000;
const MAX_HTML_BYTES = 1_500_000;
const MAX_ASSET_BYTES = 2_000_000;
const PREVIEW_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const DEFAULT_LINK_PREVIEW_MODE = "generated";
const LINK_PREVIEW_MODES = new Set(["generated", "native", "auto", "off"]);

const RICH_LINK_PAYLOAD_SCRIPT = String.raw`
import base64
import plistlib
import sys
from plistlib import UID

url = sys.argv[1]
title = sys.argv[2] if len(sys.argv) > 2 else url
objects = [
    "$null",
    {"richLinkIsPlaceholder": False, "richLinkMetadata": UID(2), "$class": UID(10)},
    {"originalURL": UID(3), "URL": UID(6), "title": UID(8), "usesActivityPub": False, "$class": UID(9), "version": 1},
    {"NS.base": UID(0), "$class": UID(5), "NS.relative": UID(4)},
    url,
    {"$classname": "NSURL", "$classes": ["NSURL", "NSObject"]},
    {"NS.base": UID(0), "$class": UID(5), "NS.relative": UID(7)},
    url,
    title,
    {"$classname": "LPLinkMetadata", "$classes": ["LPLinkMetadata", "NSObject"]},
    {"$classname": "RichLink"},
]
payload = {
    "$version": 100000,
    "$archiver": "NSKeyedArchiver",
    "$top": {"root": UID(1)},
    "$objects": objects,
}
sys.stdout.write(base64.b64encode(plistlib.dumps(payload, fmt=plistlib.FMT_BINARY, sort_keys=False)).decode("ascii"))
`;

export function hasHttpUrl(value) {
  return typeof value === "string" && HTTP_URL_PATTERN.test(value);
}

export function isSingleHttpUrl(value) {
  return typeof value === "string" && SINGLE_HTTP_URL_PATTERN.test(value);
}

export function isAppleMapsDirectionsUrl(value) {
  return Boolean(parseAppleMapsDirectionsUrl(value));
}

function parseAppleMapsDirectionsUrl(value) {
  if (!isSingleHttpUrl(value)) return null;
  try {
    const url = new URL(String(value).trim());
    if (url.hostname.toLowerCase() !== "maps.apple.com") return null;
    const source = url.searchParams.get("saddr") || "";
    const destination = url.searchParams.get("daddr") || "";
    if (!source || !destination) return null;
    return {
      source: parseAppleMapsAddressValue(source),
      destination: parseAppleMapsAddressValue(destination),
      destinationName: cleanAppleMapsLabel(url.searchParams.get("q")),
      transportType: appleMapsTransportType(url.searchParams.get("dirflg")),
    };
  } catch {
    return null;
  }
}

function parseAppleMapsAddressValue(value) {
  const raw = String(value || "").trim();
  const coordinate = raw.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  return {
    raw,
    latitude: coordinate ? Number(coordinate[1]) : null,
    longitude: coordinate ? Number(coordinate[2]) : null,
    label: coordinate ? "" : raw.replace(/\+/g, " "),
  };
}

function appleMapsTransportType(dirflg) {
  const flag = String(dirflg || "").trim().toLowerCase();
  if (flag === "w") return 2;
  return 1;
}

export function shouldRequestDdScan({ chatGuid, text }) {
  return Boolean(
    chatGuid &&
      isSingleHttpUrl(text) &&
      getLinkPreviewMode() === "native",
  );
}

export function chooseTextSendRoute({
  chatGuid,
  text,
  richText = false,
  selectedMessageGuid = null,
}) {
  const mode = getLinkPreviewMode();
  const urlOnly = Boolean(chatGuid && isSingleHttpUrl(text));
  const generatedLinkPreview =
    urlOnly &&
    !richText &&
    !selectedMessageGuid &&
    (mode === "generated" || mode === "auto");
  const ddScan = urlOnly && mode === "native";
  return {
    ddScan,
    generatedLinkPreview,
    previewMode: mode,
    method:
      richText || selectedMessageGuid || ddScan || generatedLinkPreview
        ? "private-api"
        : "apple-script",
  };
}

export function getLinkPreviewMode() {
  const raw = String(process.env.BLUEBUBBLES_LINK_PREVIEW_MODE || DEFAULT_LINK_PREVIEW_MODE)
    .trim()
    .toLowerCase();
  return LINK_PREVIEW_MODES.has(raw) ? raw : DEFAULT_LINK_PREVIEW_MODE;
}

export function prepareLinkPreviewText(text) {
  if (!isSingleHttpUrl(text)) return text;
  return text.trim();
}

export function buildUrlOnlyRichLinkPayload(text) {
  if (!isSingleHttpUrl(text)) return null;
  const url = text.trim();
  const title = fallbackRichLinkTitle(url);
  const result = spawnSync("python3", ["-c", RICH_LINK_PAYLOAD_SCRIPT, url, title], {
    encoding: "utf8",
    timeout: 2000,
    maxBuffer: 8192,
  });
  if (result.status !== 0 || result.error) return null;
  const payloadData = String(result.stdout || "").trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payloadData)) return null;
  return {
    balloonBundleId: URL_BALLOON_BUNDLE_ID,
    payloadData,
  };
}

export async function buildGeneratedRichLinkPayload(text, options = {}) {
  if (!isSingleHttpUrl(text)) return null;
  const url = text.trim();
  const appleMapsDirections = parseAppleMapsDirectionsUrl(url);
  const outputDir = options.outputDir || DEFAULT_RICH_LINK_ASSET_DIR;
  const iconOnly = options.assetMode === "icon-only";
  const linkPresentationPromise = options.skipLinkPresentation || appleMapsDirections
    ? Promise.resolve(null)
    : fetchLinkPresentationMetadata(url, { outputDir }).catch(() => null);
  const [htmlMetadata, linkPresentationMetadata] = await Promise.all([
    fetchRichLinkMetadata(url).catch(() => null),
    linkPresentationPromise,
  ]);
  const metadata = mergeRichLinkMetadata({ url, htmlMetadata, linkPresentationMetadata });
  if (appleMapsDirections) {
    const appleMapsMetadata = buildAppleMapsDirectionsRichLinkMetadata({
      url,
      parsedDirections: appleMapsDirections,
      metadata,
    });
    const payloadData = buildRichLinkPayloadArchive(appleMapsMetadata);
    if (payloadData) {
      return {
        balloonBundleId: URL_BALLOON_BUNDLE_ID,
        payloadData,
        attachmentFilePath: null,
        attachmentName: null,
        url: appleMapsMetadata.url,
        resolvedUrl: appleMapsMetadata.resolvedUrl,
        title: appleMapsMetadata.title,
        nativeLikelyUseful: false,
        source: "generated",
        previewKind: "apple_maps_directions",
      };
    }
  }
  if (!metadata) return buildUrlOnlyRichLinkPayload(url);

  const linkPresentationAsset = pickLinkPresentationAsset(linkPresentationMetadata, metadata, {
    iconOnly,
  });
  const asset =
    linkPresentationAsset ||
    (await downloadPreviewAsset(metadata, {
      outputDir,
      iconOnly,
    }).catch(() => null));
  const payloadData = buildRichLinkPayloadArchive({
    ...metadata,
    attachmentRole: asset?.kind || null,
    attachmentSourceUrl: asset?.sourceUrl || "",
    iconUrl: asset?.kind === "icon" ? asset.sourceUrl : metadata.iconUrl,
    imageUrl: asset?.kind === "image" ? asset.sourceUrl : metadata.imageUrl,
    mimeType: asset?.mimeType || metadata.iconMimeType || "image/png",
  });
  if (!payloadData) return buildUrlOnlyRichLinkPayload(url);
  return {
    balloonBundleId: URL_BALLOON_BUNDLE_ID,
    payloadData,
    attachmentFilePath: asset?.filePath || null,
    attachmentName: asset?.fileName || null,
    url: metadata.url,
    resolvedUrl: metadata.resolvedUrl,
    title: metadata.title,
    nativeLikelyUseful: metadata.nativeLikelyUseful,
    source: "generated",
    attachmentRole: asset?.kind || null,
  };
}

export async function buildPreflightRichLinkPayload(text, options = {}) {
  const decision = await buildPreflightRichLinkDecision(text, options);
  return decision.route === "generated" ? decision.payload : null;
}

export async function buildNativeRichLinkPreflightDecision(text, options = {}) {
  if (!isSingleHttpUrl(text)) {
    return { route: "generated", reason: "not_single_url", payload: null };
  }
  const url = text.trim();
  if (isAppleMapsDirectionsUrl(url)) {
    return { route: "generated", reason: "apple_maps_directions_payload", payload: null };
  }
  const mode = options.mode || getLinkPreviewMode();
  if (mode === "generated") {
    return { route: "generated", reason: "generated_default", payload: null };
  }
  if (mode === "off") {
    return { route: "none", reason: "link_preview_disabled", payload: null };
  }
  const outputDir = options.outputDir || DEFAULT_RICH_LINK_ASSET_DIR;
  const linkPresentationMetadata = await fetchLinkPresentationMetadata(url, {
    outputDir,
    timeoutMs: options.timeoutMs,
  });
  return chooseNativeRichLinkPreflightRoute(linkPresentationMetadata);
}

export function chooseNativeRichLinkPreflightRoute(linkPresentationMetadata) {
  if (isLinkPresentationPreviewLikelyUseful(linkPresentationMetadata)) {
    return {
      route: "native",
      reason: "native_likely_useful",
      payload: null,
    };
  }
  return {
    route: "generated",
    reason: linkPresentationMetadata?.ok ? "native_preview_not_useful" : "native_preflight_unavailable",
    payload: null,
  };
}

export async function buildPreflightRichLinkDecision(text, options = {}) {
  const payload = await buildGeneratedRichLinkPayload(text, {
    ...options,
    assetMode: options.assetMode || "icon-only",
  });
  return choosePreflightRichLinkRoute(payload, text);
}

export function choosePreflightRichLinkRoute(payload, text) {
  if (payload?.previewKind === "apple_maps_directions" && payload.payloadData) {
    return {
      route: "generated",
      reason: "apple_maps_directions_payload",
      payload,
    };
  }
  if (isGeneratedRichLinkPayloadWorthSending(payload, text)) {
    return {
      route: "generated",
      reason: payload.attachmentRole === "image"
        ? "generated_image_fallback"
        : "generated_favicon_fallback",
      payload,
    };
  }
  return {
    route: "none",
    reason: payload?.nativeLikelyUseful ? "generated_skipped_native_likely_useful" : "generated_fallback_unavailable",
    payload: null,
  };
}

export function isGeneratedRichLinkPayloadWorthSending(payload, text) {
  if (!payload?.payloadData || payload.source !== "generated") return false;
  if (payload.previewKind === "apple_maps_directions") return true;
  if (!payload.attachmentFilePath) return false;
  if (!isSingleHttpUrl(text)) return false;
  const title = String(payload.title || "").replace(/\s+/g, " ").trim();
  if (!title) return false;
  return true;
}

function mergeRichLinkMetadata({ url, htmlMetadata, linkPresentationMetadata }) {
  if (!htmlMetadata && !linkPresentationMetadata?.ok) return null;
  const parsedUrl = new URL(url);
  const fallbackTitle = fallbackRichLinkTitle(url);
  const rawTitle = linkPresentationMetadata?.title || htmlMetadata?.title || fallbackTitle;
  const title = shouldPreferFallbackTitle(parsedUrl, rawTitle) ? fallbackTitle : rawTitle || fallbackTitle;
  const resolvedUrl =
    linkPresentationMetadata?.resolvedUrl ||
    linkPresentationMetadata?.originalUrl ||
    htmlMetadata?.resolvedUrl ||
    url;
  const iconUrl =
    htmlMetadata?.iconUrl ||
    htmlMetadata?.appleTouchIconUrl ||
    (linkPresentationMetadata?.icon ? resolvedUrl : "") ||
    new URL("/favicon.ico", parsedUrl.origin).href;
  return {
    url,
    resolvedUrl,
    title,
    summary: htmlMetadata?.summary || "",
    siteName: htmlMetadata?.siteName || prettyHostLabel(parsedUrl.hostname),
    iconUrl,
    imageUrl: htmlMetadata?.imageUrl || (linkPresentationMetadata?.image ? resolvedUrl : ""),
    nativeLikelyUseful: isLinkPresentationPreviewLikelyUseful(linkPresentationMetadata),
  };
}

function buildAppleMapsDirectionsRichLinkMetadata({ url, parsedDirections, metadata }) {
  const destinationName =
    cleanAppleMapsLabel(parsedDirections.destinationName) ||
    cleanAppleMapsLabel(parsedDirections.destination.label) ||
    cleanAppleMapsLabel(metadata?.summary) ||
    cleanAppleMapsDestinationFromTitle(metadata?.title) ||
    cleanAppleMapsLabel(parsedDirections.destination.raw) ||
    "Destination";
  const sourceName =
    cleanAppleMapsLabel(parsedDirections.source.label) ||
    cleanAppleMapsLabel(metadata?.sourceName) ||
    "Start";
  const title = /^directions to\s+/i.test(metadata?.title || "")
    ? cleanAppleMapsLabel(metadata.title)
    : `Directions to ${destinationName}`;
  return {
    url,
    resolvedUrl: url,
    title,
    summary: destinationName,
    siteName: "Maps",
    appleMapsDirections: {
      transportType: parsedDirections.transportType,
      sourceAddress: sourceName === "Start" ? parsedDirections.source.raw : sourceName,
      sourceLocationName: sourceName,
      destinationAddress: destinationName,
      destinationLocationName: destinationName,
      distance: 0,
      sourceAddressComponents: buildAppleMapsAddressComponents(sourceName),
      destinationAddressComponents: buildAppleMapsAddressComponents(destinationName),
    },
  };
}

function cleanAppleMapsDestinationFromTitle(value) {
  const label = cleanAppleMapsLabel(value);
  if (!/^directions to\s+/i.test(label)) return "";
  return label.replace(/^directions to\s+/i, "").trim();
}

function cleanAppleMapsLabel(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function buildAppleMapsAddressComponents(label) {
  const value = cleanAppleMapsLabel(label);
  if (!value || value === "Start") return {};
  return {
    street: value,
  };
}

function isLinkPresentationPreviewLikelyUseful(linkPresentationMetadata) {
  if (!linkPresentationMetadata?.ok) return false;
  const title = String(linkPresentationMetadata.title || "").replace(/\s+/g, " ").trim();
  if (!title) return false;
  return Boolean(linkPresentationMetadata.icon || linkPresentationMetadata.image);
}

function pickLinkPresentationAsset(linkPresentationMetadata, metadata, { iconOnly = false } = {}) {
  const candidates = iconOnly
    ? [{ kind: "icon", asset: linkPresentationMetadata?.icon, sourceUrl: metadata.iconUrl }]
    : [
        { kind: "image", asset: linkPresentationMetadata?.image, sourceUrl: metadata.imageUrl },
        { kind: "icon", asset: linkPresentationMetadata?.icon, sourceUrl: metadata.iconUrl },
      ];
  for (const candidate of candidates) {
    const asset = candidate.asset;
    if (!asset?.filePath || !fs.existsSync(asset.filePath)) continue;
    return {
      kind: candidate.kind,
      filePath: asset.filePath,
      fileName: asset.fileName || path.basename(asset.filePath),
      mimeType: asset.mimeType || "image/png",
      sourceUrl: candidate.sourceUrl || metadata.resolvedUrl || metadata.url,
    };
  }
  return null;
}

async function fetchRichLinkMetadata(value) {
  const url = new URL(value);
  const response = await fetchWithTimeout(url.href, {
    timeoutMs: HTML_FETCH_TIMEOUT_MS,
    headers: {
      "user-agent": PREVIEW_USER_AGENT,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
    },
  });
  const contentType = response.headers.get("content-type") || "";
  const buffer = Buffer.from(await response.arrayBuffer());
  const html = response.ok && /^text\/html|application\/xhtml\+xml/i.test(contentType)
    ? buffer.subarray(0, MAX_HTML_BYTES).toString("utf8")
    : "";
  const metadata = extractHtmlMetadata(html, url.href);
  const fallbackTitle = fallbackRichLinkTitle(url.href);
  const title = shouldPreferFallbackTitle(url, metadata.title) ? fallbackTitle : metadata.title || fallbackTitle;
  const iconUrl =
    metadata.iconUrl || metadata.appleTouchIconUrl || new URL("/favicon.ico", url.origin).href;
  return {
    url: url.href,
    resolvedUrl: response.url || url.href,
    title,
    summary: metadata.summary || "",
    siteName: metadata.siteName || prettyHostLabel(url.hostname),
    iconUrl,
    imageUrl: metadata.imageUrl || "",
  };
}

async function fetchLinkPresentationMetadata(
  value,
  { outputDir, timeoutMs = LINK_PRESENTATION_TIMEOUT_MS } = {},
) {
  if (!buildLinkPresentationHelper()) return null;
  const effectiveTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : LINK_PRESENTATION_TIMEOUT_MS;
  const id = crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
  const assetDir = path.join(outputDir, `lp-${id}`);
  fs.mkdirSync(assetDir, { recursive: true });
  try {
    const { stdout } = await execFileAsync(
      LINK_PRESENTATION_HELPER_PATH,
      [value, assetDir, String(Math.ceil(effectiveTimeoutMs / 1000))],
      {
        encoding: "utf8",
        timeout: effectiveTimeoutMs + 1_000,
        maxBuffer: 256 * 1024,
      },
    );
    const parsed = JSON.parse(String(stdout || "").trim());
    return parsed?.ok ? parsed : null;
  } catch {
    return null;
  }
}

function buildLinkPresentationHelper() {
  if (!fs.existsSync(LINK_PRESENTATION_SOURCE_SCRIPT_PATH)) return false;
  try {
    const sourceStat = fs.statSync(LINK_PRESENTATION_SOURCE_SCRIPT_PATH);
    const helperStat = fs.existsSync(LINK_PRESENTATION_HELPER_PATH)
      ? fs.statSync(LINK_PRESENTATION_HELPER_PATH)
      : null;
    if (helperStat && helperStat.mtimeMs >= sourceStat.mtimeMs) return true;
  } catch {
    return false;
  }
  fs.mkdirSync(path.dirname(LINK_PRESENTATION_HELPER_PATH), { recursive: true });
  const result = spawnSync(
    "xcrun",
    ["swiftc", LINK_PRESENTATION_SOURCE_SCRIPT_PATH, "-o", LINK_PRESENTATION_HELPER_PATH],
    {
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 512 * 1024,
    },
  );
  return result.status === 0 && !result.error && fs.existsSync(LINK_PRESENTATION_HELPER_PATH);
}

function shouldPreferFallbackTitle(url, title) {
  const rawTitle = String(title || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!rawTitle) return false;
  const hostLabel = prettyHostLabel(url.hostname).toLowerCase();
  if (!hostLabel || !rawTitle.includes(hostLabel)) return false;
  const pathTokens = significantPathTitleTokens(url.pathname);
  if (pathTokens.length === 0) return false;
  return pathTokens.every((token) => !rawTitle.includes(token));
}

function significantPathTitleTokens(pathname) {
  const stopTokens = new Set([
    "com",
    "en",
    "html",
    "htm",
    "index",
    "page",
    "pages",
    "pd",
    "product",
    "products",
    "store",
    "topic",
    "topics",
  ]);
  return String(pathname || "")
    .split("/")
    .flatMap((part) =>
      decodeURIComponent(part || "")
        .replace(/\.[A-Za-z0-9]+$/, "")
        .split(/[^A-Za-z0-9]+/),
    )
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 3 && !stopTokens.has(token));
}

async function downloadPreviewAsset(metadata, { outputDir, iconOnly = false }) {
  const candidates = [
    !iconOnly && metadata.imageUrl ? { kind: "image", sourceUrl: metadata.imageUrl } : null,
    metadata.iconUrl ? { kind: "icon", sourceUrl: metadata.iconUrl } : null,
    { kind: "icon", sourceUrl: new URL("/favicon.ico", metadata.url).href },
  ].filter(Boolean);
  for (const { kind, sourceUrl } of uniqueAssetCandidates(candidates)) {
    const response = await fetchWithTimeout(sourceUrl, {
      timeoutMs: ASSET_FETCH_TIMEOUT_MS,
      headers: {
        "user-agent": PREVIEW_USER_AGENT,
        accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      },
    }).catch(() => null);
    if (!response?.ok) continue;
    const contentType = (response.headers.get("content-type") || "").split(";")[0].trim();
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer).subarray(0, MAX_ASSET_BYTES);
    const mimeType = detectImageMimeType(buffer, contentType, sourceUrl);
    if (!mimeType) continue;
    const id = crypto.createHash("sha256").update(`${metadata.url}\0${sourceUrl}\0${buffer}`).digest("hex").slice(0, 16);
    const fileName = `${id}.pluginPayloadAttachment`;
    await mkdir(outputDir, { recursive: true });
    const filePath = path.join(outputDir, fileName);
    await writeFile(filePath, buffer);
    return { kind, filePath, fileName, mimeType, sourceUrl };
  }
  return null;
}

function uniqueAssetCandidates(candidates) {
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    const key = candidate?.sourceUrl;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

function buildRichLinkPayloadArchive(metadata) {
  const result = spawnSync("python3", [RICH_LINK_PAYLOAD_SCRIPT_PATH], {
    input: JSON.stringify(metadata),
    encoding: "utf8",
    timeout: 2000,
    maxBuffer: 64 * 1024,
  });
  if (result.status !== 0 || result.error) return null;
  const payloadData = String(result.stdout || "").trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payloadData)) return null;
  return payloadData;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 8000);
  timeout.unref?.();
  try {
    return await fetch(url, {
      redirect: "follow",
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function extractHtmlMetadata(html, baseUrl) {
  if (!html) return {};
  return {
    title: firstMeta(html, ["og:title", "twitter:title"]) || extractTitle(html),
    summary: firstMeta(html, ["og:description", "twitter:description", "description"]),
    siteName: firstMeta(html, ["og:site_name", "application-name"]),
    imageUrl: absoluteUrl(firstMeta(html, ["og:image", "twitter:image", "twitter:image:src"]), baseUrl),
    iconUrl: absoluteUrl(extractIconLink(html, ["icon", "shortcut icon"]), baseUrl),
    appleTouchIconUrl: absoluteUrl(extractIconLink(html, ["apple-touch-icon", "apple-touch-icon-precomposed"]), baseUrl),
  };
}

function firstMeta(html, names) {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = parseHtmlAttributes(tag[0]);
    const key = String(attrs.property || attrs.name || "").toLowerCase();
    const value = decodeHtml(attrs.content || "");
    if (wanted.has(key) && value) return value;
  }
  return "";
}

function extractIconLink(html, relNames) {
  const wanted = relNames.map((name) => name.toLowerCase());
  for (const tag of html.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = parseHtmlAttributes(tag[0]);
    const rel = String(attrs.rel || "").toLowerCase();
    const href = decodeHtml(attrs.href || "");
    if (href && wanted.some((name) => rel.split(/\s+/).join(" ").includes(name))) return href;
  }
  return "";
}

function parseHtmlAttributes(tag) {
  const attrs = {};
  for (const match of tag.matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
    attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attrs;
}

function extractTitle(html) {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return decodeHtml(match?.[1] || "").replace(/\s+/g, " ").trim();
}

function absoluteUrl(value, baseUrl) {
  if (!value) return "";
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return "";
  }
}

function detectImageMimeType(buffer, contentType, sourceUrl) {
  if (/^image\//i.test(contentType)) return contentType.toLowerCase();
  if (buffer.subarray(0, 4).equals(Buffer.from([0x00, 0x00, 0x01, 0x00]))) return "image/x-icon";
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (/\.ico(?:$|[?#])/i.test(sourceUrl)) return "image/x-icon";
  if (/\.png(?:$|[?#])/i.test(sourceUrl)) return "image/png";
  if (/\.jpe?g(?:$|[?#])/i.test(sourceUrl)) return "image/jpeg";
  if (/\.gif(?:$|[?#])/i.test(sourceUrl)) return "image/gif";
  return null;
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function splitTextForLinkPreviewMessages(value) {
  if (typeof value !== "string" || !HTTP_URL_PATTERN.test(value)) {
    const text = trimMessagePart(value);
    return text ? [{ text, urlOnly: false }] : [];
  }
  const parts = [];
  let cursor = 0;
  for (const match of value.matchAll(HTTP_URL_GLOBAL_PATTERN)) {
    const start = match.index ?? 0;
    const rawUrl = match[0];
    const { url } = stripTrailingUrlPunctuation(rawUrl);
    const end = start + url.length;
    if (
      !url ||
      !isValidPreviewUrl(url) ||
      !hasUrlBoundaryAfter(value, end) ||
      isAssignmentValueUrl(value, start)
    ) {
      continue;
    }
    appendTextPart(parts, value.slice(cursor, start));
    appendUrlPart(parts, url);
    cursor = start + rawUrl.length;
  }
  appendTextPart(parts, value.slice(cursor));
  return parts.length ? parts : [{ text: trimMessagePart(value), urlOnly: isSingleHttpUrl(value) }];
}

function appendTextPart(parts, value) {
  const text = trimMessagePart(value);
  if (!text) return;
  const previous = parts.at(-1);
  if (previous && !previous.urlOnly) {
    previous.text = `${previous.text}\n${text}`;
    return;
  }
  parts.push({ text, urlOnly: false });
}

function appendUrlPart(parts, value) {
  const text = String(value || "").trim();
  if (!text) return;
  parts.push({ text, urlOnly: true });
}

function stripTrailingUrlPunctuation(value) {
  const url = String(value || "").replace(TRAILING_URL_PUNCTUATION_PATTERN, "");
  return { url };
}

function isAssignmentValueUrl(value, start) {
  const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const prefix = value.slice(lineStart, start);
  return /[A-Za-z_][A-Za-z0-9_]*\s*=\s*$/.test(prefix);
}

function isValidPreviewUrl(value) {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && /[A-Za-z0-9]/.test(url.hostname);
  } catch {
    return false;
  }
}

function hasUrlBoundaryAfter(value, index) {
  if (index >= value.length) return true;
  return /[\s.,!?;:)\]}]/.test(value[index]);
}

function trimMessagePart(value) {
  return String(value || "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function fallbackRichLinkTitle(value) {
  try {
    const url = new URL(value);
    const hostLabel = prettyHostLabel(url.hostname);
    const slugTitle = [...url.pathname.split("/")]
      .reverse()
      .map((part) => decodeURIComponent(part || "").replace(/\.[A-Za-z0-9]+$/, ""))
      .find((part) => /[a-z]/i.test(part) && !(/^[A-Z0-9-]+$/.test(part) && part.includes("-")));
    if (slugTitle) return `${titleCaseSlug(slugTitle)} - ${hostLabel}`;
    return hostLabel || value;
  } catch {
    return value;
  }
}

function prettyHostLabel(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^www\./, "");
  const root = host.split(".")[0];
  return root ? titleCaseSlug(root) : hostname;
}

function titleCaseSlug(value) {
  return String(value || "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
