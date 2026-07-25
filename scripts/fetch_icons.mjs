#!/usr/bin/env node
/**
 * Vendor each listed site's favicon into public/img/icons/ at deploy time.
 *
 * The page used to fetch these icons from the listed sites at render time,
 * which made every visitor's browser announce itself to seventeen third-party
 * domains. Downloading them here instead keeps the deployed page's promise that
 * it makes no third-party request and works offline, the same reason the fonts
 * are self-hosted and PapaParse is vendored.
 *
 * sites.csv stays the editable source of truth, and the two icon columns are
 * kept separate so this script never consumes its own output: icon_source is
 * hand-edited and holds the absolute URL for sites that keep their icon
 * somewhere other than /favicon.ico, while icon is generated here and holds the
 * local path to the downloaded copy. Rows whose icon could not be fetched get
 * the Thunder Bay flag, so the browser never falls back over the network. Like
 * the JSON-LD, the generated column exists only in CI and is not committed.
 *
 * Usage: node scripts/fetch_icons.mjs
 * Set ICON_REFRESH=1 to ignore the cache TTL and re-fetch everything.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseCsv, stringifyCsv } from "./csv.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CSV_PATH = join(ROOT, "public", "sites.csv");
const OUT_DIR = join(ROOT, "public", "img", "icons");
const CACHE_DIR = join(ROOT, ".cache", "icons");
const CACHE_INDEX = join(CACHE_DIR, "index.json");

// Path the browser uses, relative to public/index.html.
const OUT_PREFIX = "img/icons";
const FALLBACK_ICON = "img/flag_tbay.webp";

// A deploy re-fetches anything older than this. Deploys are driven by pushes,
// so without a TTL an icon downloaded once would be pinned until sites.csv
// happened to change again.
const TTL_DAYS = 7;
const REFRESH = process.env.ICON_REFRESH === "1";

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 512 * 1024;
const CONCURRENCY = 8;

// Some hosts serve nothing useful to an unrecognised client. Identifying the
// fetcher honestly and pointing at the site keeps it debuggable from their
// access logs.
const USER_AGENT = "Mozilla/5.0 (compatible; MadeInTBayIconBot/1.0; +https://madeintbay.ca/)";

/**
 * Identify the image by magic bytes rather than trusting Content-Type, because
 * the failure this has to catch is a server answering 200 with an HTML error
 * page or an empty body. Returns the extension, or null if it is not an image.
 */
function imageExtension(buf) {
	if (buf.length < 16) {
		return null;
	}
	if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
		return "png";
	}
	if (buf.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
		return "jpg";
	}
	if (buf.subarray(0, 4).toString("ascii") === "GIF8") {
		return "gif";
	}
	if (
		buf.subarray(0, 4).toString("ascii") === "RIFF" &&
		buf.subarray(8, 12).toString("ascii") === "WEBP"
	) {
		return "webp";
	}
	if (buf.subarray(0, 2).toString("ascii") === "BM") {
		return "bmp";
	}
	// ICO and CUR share a header; byte 2 is the resource type.
	if (
		buf[0] === 0x00 &&
		buf[1] === 0x00 &&
		(buf[2] === 0x01 || buf[2] === 0x02) &&
		buf[3] === 0x00
	) {
		return "ico";
	}

	const head = buf.subarray(0, 1024).toString("utf8").trimStart();
	if (head.startsWith("<?xml") || head.startsWith("<svg") || head.startsWith("<!DOCTYPE svg")) {
		const svg = buf.toString("utf8");
		if (!/<svg[\s>]/i.test(svg)) {
			return null;
		}
		// These files end up served from madeintbay.ca, and an SVG opened
		// directly (not via <img>) runs its own script in this origin. Rather
		// than rewrite someone else's markup, refuse anything with an active
		// content vector and let the row fall back to the flag.
		if (/<script[\s>]|\son\w+\s*=|javascript:|<foreignObject[\s>]/i.test(svg)) {
			return null;
		}
		return "svg";
	}

	return null;
}

/** The URL to try for a site: the icon_source hint if given, else /favicon.ico. */
function sourceUrl(site) {
	// Guarded so a relative path in the hint column can never be handed to
	// fetch() as if it were a remote address.
	if (/^https?:\/\//i.test(site.icon_source ?? "")) {
		return site.icon_source;
	}
	try {
		return new URL("/favicon.ico", site.url).href;
	} catch {
		return null;
	}
}

function slugFor(site) {
	let host;
	try {
		host = new URL(site.url).hostname.replace(/^www\./, "");
	} catch {
		host = site.name || "site";
	}
	return host.replace(/[^a-z0-9.-]/gi, "-").toLowerCase();
}

async function download(url) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			redirect: "follow",
			signal: controller.signal,
			headers: { "User-Agent": USER_AGENT, Accept: "image/*,*/*;q=0.8" },
		});
		if (!res.ok) {
			return { error: `HTTP ${res.status}` };
		}
		const buf = Buffer.from(await res.arrayBuffer());
		if (buf.length === 0) {
			return { error: "empty body" };
		}
		if (buf.length > MAX_BYTES) {
			return { error: `too large (${buf.length} bytes)` };
		}
		const ext = imageExtension(buf);
		if (!ext) {
			return { error: "not a usable image" };
		}
		return { buf, ext };
	} catch (err) {
		return { error: err.name === "AbortError" ? "timed out" : err.message };
	} finally {
		clearTimeout(timer);
	}
}

/** Run tasks with a small pool so one slow host does not serialise the rest. */
async function pooled(items, limit, worker) {
	const results = new Array(items.length);
	let next = 0;
	const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await worker(items[index], index);
		}
	});
	await Promise.all(runners);
	return results;
}

function loadCacheIndex() {
	if (!existsSync(CACHE_INDEX)) {
		return {};
	}
	try {
		return JSON.parse(readFileSync(CACHE_INDEX, "utf8"));
	} catch {
		return {};
	}
}

const { headers, rows } = parseCsv(readFileSync(CSV_PATH, "utf8"));
const sites = rows.filter((site) => site.url);
if (!headers.includes("icon")) {
	headers.push("icon");
}

mkdirSync(CACHE_DIR, { recursive: true });
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

const cache = loadCacheIndex();
const now = Date.now();
const ttlMs = TTL_DAYS * 24 * 60 * 60 * 1000;

const outcomes = await pooled(sites, CONCURRENCY, async (site) => {
	const src = sourceUrl(site);
	if (!src) {
		return { site, src, status: "no source" };
	}

	const entry = cache[site.url];
	const cachedPath = entry ? join(CACHE_DIR, entry.file) : null;
	const cachedFresh =
		entry &&
		entry.source === src &&
		!REFRESH &&
		now - Date.parse(entry.fetchedAt) < ttlMs &&
		existsSync(cachedPath);

	if (cachedFresh) {
		return {
			site,
			src,
			status: "cached",
			buf: readFileSync(cachedPath),
			ext: entry.ext,
			fetchedAt: entry.fetchedAt,
		};
	}

	const result = await download(src);
	if (result.error) {
		// A host that is briefly down should not drop an icon the cache already
		// holds, so a stale copy beats falling back to the flag. Its original
		// timestamp is kept so the next deploy tries the network again.
		if (entry && existsSync(cachedPath)) {
			return {
				site,
				src,
				status: `stale (${result.error})`,
				buf: readFileSync(cachedPath),
				ext: entry.ext,
				fetchedAt: entry.fetchedAt,
			};
		}
		// Failures are deliberately not cached, so the handful of sites with no
		// icon are retried on every deploy and one that adds a favicon is picked
		// up on the next push rather than after a negative entry expires.
		return { site, src, status: `skipped (${result.error})` };
	}
	return {
		site,
		src,
		status: "fetched",
		buf: result.buf,
		ext: result.ext,
		fetchedAt: new Date(now).toISOString(),
	};
});

const nextCache = {};
let vendored = 0;

for (const { site, src, status, buf, ext, fetchedAt } of outcomes) {
	if (!buf) {
		site.icon = FALLBACK_ICON;
		console.log(`  flag    ${site.url} — ${status}`);
		continue;
	}

	const slug = slugFor(site);
	const digest = createHash("sha256").update(buf).digest("hex").slice(0, 8);
	// The digest in the name makes each version its own immutable URL, so a
	// changed icon is picked up immediately instead of being masked by a
	// cached response under a reused filename.
	const file = `${slug}.${digest}.${ext}`;
	writeFileSync(join(OUT_DIR, file), buf);
	site.icon = `${OUT_PREFIX}/${file}`;
	vendored++;

	const cacheFile = `${slug}.${ext}`;
	writeFileSync(join(CACHE_DIR, cacheFile), buf);
	nextCache[site.url] = { source: src, file: cacheFile, ext, fetchedAt };
	console.log(`  ${status.padEnd(7)} ${site.url} -> ${file}`);
}

// Drop cache files for sites no longer listed so the cache cannot grow forever.
const keep = new Set(Object.values(nextCache).map((entry) => entry.file));
for (const file of readdirSync(CACHE_DIR)) {
	if (file !== "index.json" && !keep.has(file)) {
		rmSync(join(CACHE_DIR, file), { force: true });
	}
}
writeFileSync(CACHE_INDEX, `${JSON.stringify(nextCache, null, "\t")}\n`, "utf8");
writeFileSync(CSV_PATH, stringifyCsv(headers, rows), "utf8");

console.log(`Vendored ${vendored}/${sites.length} icons into public/${OUT_PREFIX}/`);
