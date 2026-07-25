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
 * Icons are found the way a browser finds them: read the page, take the
 * <link rel="icon"> and web-app-manifest entries it declares, and only fall
 * back to guessing /favicon.ico. A browser script could never do this — it
 * cannot read a cross-origin page's markup — but this runs server-side, which
 * is what lets it reach the icons that live at unguessable paths (WordPress
 * puts them under /wp-content/uploads/, Vercel apps under /assets/).
 *
 * sites.csv stays the editable source of truth, and the two icon columns are
 * kept separate so this script never consumes its own output: icon_source is
 * hand-edited and pins one absolute URL when the automatic pick is wrong, while
 * icon is generated here and holds the local path to the downloaded copy. Rows
 * with no usable icon get the Thunder Bay flag, so the browser never falls back
 * over the network. Like the JSON-LD, the generated column exists only in CI
 * and is not committed.
 *
 * Usage: node scripts/fetch_icons.mjs
 * Set ICON_REFRESH=1 to ignore the cache TTL and re-fetch everything.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseCsv, stringifyCsv } from "./csv.mjs";
import { imageExtension, visibleFraction } from "./image_probe.mjs";

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
const HTML_MAX_BYTES = 2 * 1024 * 1024;
const CONCURRENCY = 8;

// Cards draw the icon at about 21 CSS pixels, so roughly 42 device pixels on a
// 2x screen. Sources a little larger than that downscale cleanly; much larger
// is just bytes, and 16x16 is visibly soft.
const TARGET_PX = 96;
const MAX_CANDIDATES = 6;

// An icon that lands below this fraction of legible pixels is treated as
// unusable. Measured against the real listings, genuine icons score 10% and up
// while a white-on-transparent logo scores 0.00%, so anything in between is
// comfortably outside the range either produces.
const MIN_VISIBLE_FRACTION = 0.015;

// Some hosts serve nothing useful to an unrecognised client. Identifying the
// fetcher honestly and pointing at the site keeps it debuggable from their
// access logs.
const USER_AGENT = "Mozilla/5.0 (compatible; MadeInTBayIconBot/1.0; +https://madeintbay.ca/)";

async function fetchResource(url, accept, maxBytes) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			redirect: "follow",
			signal: controller.signal,
			headers: { "User-Agent": USER_AGENT, Accept: accept },
		});
		if (!res.ok) {
			return { error: `HTTP ${res.status}` };
		}
		const buf = Buffer.from(await res.arrayBuffer());
		if (buf.length === 0) {
			return { error: "empty body" };
		}
		if (buf.length > maxBytes) {
			return { error: `too large (${buf.length} bytes)` };
		}
		// Relative hrefs must resolve against wherever we actually landed, which
		// is not the requested URL when a host redirects to www or to https.
		return { buf, finalUrl: res.url || url };
	} catch (err) {
		return { error: err.name === "AbortError" ? "timed out" : err.message };
	} finally {
		clearTimeout(timer);
	}
}

function attrOf(tag, name) {
	const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i"));
	return match ? (match[2] ?? match[3] ?? match[4]).trim() : "";
}

/** Largest edge named by a sizes attribute; Infinity for the scalable "any". */
function largestSize(sizes) {
	if (/\bany\b/i.test(sizes)) {
		return Infinity;
	}
	let best = 0;
	for (const match of sizes.matchAll(/(\d+)\s*[x×]\s*(\d+)/gi)) {
		best = Math.max(best, Number(match[1]), Number(match[2]));
	}
	return best;
}

function scoreCandidate(candidate) {
	const px = largestSize(candidate.sizes);
	const scalable =
		px === Infinity || candidate.type === "image/svg+xml" || /\.svg(\?|#|$)/i.test(candidate.url);
	if (scalable) {
		return 100;
	}

	let score;
	if (!px) {
		// Unlabelled, so it could be any resolution; a declared icon is still a
		// more deliberate choice than a path we guessed.
		score = 55;
	} else if (px >= 48 && px <= 256) {
		score = 90 - Math.abs(px - TARGET_PX) / 32;
	} else if (px > 256) {
		score = 70;
	} else if (px >= 32) {
		score = 60;
	} else {
		score = 35;
	}
	if (/apple-touch-icon/.test(candidate.rel)) {
		// Built for a home screen, so almost always square and fully opaque.
		score += 4;
	}
	return score;
}

function parseIconLinks(html, base) {
	const found = [];
	for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
		const tag = match[0];
		const rel = attrOf(tag, "rel").toLowerCase();
		if (!/\bicon\b/.test(rel) || rel.includes("mask-icon")) {
			// mask-icon is Safari's pinned-tab silhouette: one flat colour, and
			// meaningless outside that context.
			continue;
		}
		const href = attrOf(tag, "href");
		if (!href) {
			continue;
		}
		try {
			found.push({
				url: new URL(href, base).href,
				sizes: attrOf(tag, "sizes"),
				type: attrOf(tag, "type").toLowerCase(),
				rel,
			});
		} catch {
			// Unparseable href; nothing to fetch.
		}
	}
	return found;
}

async function manifestIcons(html, base) {
	const tag = [...html.matchAll(/<link\b[^>]*>/gi)]
		.map((match) => match[0])
		.find((candidate) => /\bmanifest\b/i.test(attrOf(candidate, "rel")));
	if (!tag) {
		return [];
	}
	let manifestUrl;
	try {
		manifestUrl = new URL(attrOf(tag, "href"), base).href;
	} catch {
		return [];
	}
	const res = await fetchResource(
		manifestUrl,
		"application/manifest+json,application/json",
		MAX_BYTES,
	);
	if (res.error) {
		return [];
	}
	let icons;
	try {
		icons = JSON.parse(res.buf.toString("utf8")).icons;
	} catch {
		return [];
	}
	if (!Array.isArray(icons)) {
		return [];
	}
	return icons.flatMap((icon) => {
		// Maskable icons are drawn with heavy bleed for the launcher to crop, so
		// used as-is they look like a tiny logo adrift in padding.
		if (!icon?.src || /maskable/i.test(icon.purpose ?? "")) {
			return [];
		}
		try {
			return [
				{
					url: new URL(icon.src, res.finalUrl).href,
					sizes: icon.sizes ?? "",
					type: (icon.type ?? "").toLowerCase(),
					rel: "manifest",
				},
			];
		} catch {
			return [];
		}
	});
}

/** Ordered best-first list of icon URLs to try for a site. */
async function discoverCandidates(pageUrl) {
	const candidates = [];
	const page = await fetchResource(pageUrl, "text/html,application/xhtml+xml", HTML_MAX_BYTES);
	if (!page.error) {
		const html = page.buf.toString("utf8");
		candidates.push(...parseIconLinks(html, page.finalUrl));
		candidates.push(...(await manifestIcons(html, page.finalUrl)));
	}

	const ranked = candidates
		.map((candidate) => ({ ...candidate, score: scoreCandidate(candidate) }))
		.sort((a, b) => b.score - a.score);

	// The well-known location, tried last: plenty of sites declare nothing and
	// still have one, but a declared icon is the more deliberate choice.
	try {
		ranked.push({ url: new URL("/favicon.ico", pageUrl).href, score: 0 });
	} catch {
		// Caller handles an empty list.
	}

	const seen = new Set();
	return ranked
		.filter((candidate) => !seen.has(candidate.url) && seen.add(candidate.url))
		.slice(0, MAX_CANDIDATES);
}

/** Download one candidate and reject anything unusable, with the reason why. */
async function tryCandidate(url) {
	const res = await fetchResource(url, "image/*,*/*;q=0.8", MAX_BYTES);
	if (res.error) {
		return { error: res.error };
	}
	const ext = imageExtension(res.buf);
	if (!ext) {
		return { error: "not a usable image" };
	}
	const visible = visibleFraction(res.buf);
	if (visible !== null && visible < MIN_VISIBLE_FRACTION) {
		return { error: `invisible on a light background (${(visible * 100).toFixed(2)}% legible)` };
	}
	return { buf: res.buf, ext };
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
	// Only an absolute http(s) URL is a usable pin. Anything else means "work it
	// out", so re-running against an already-rewritten CSV stays idempotent.
	const hint = /^https?:\/\//i.test(site.icon_source ?? "") ? site.icon_source : "";
	const entry = cache[site.url];
	const cachedPath = entry ? join(CACHE_DIR, entry.file) : null;

	if (
		entry &&
		entry.hint === hint &&
		!REFRESH &&
		now - Date.parse(entry.fetchedAt) < ttlMs &&
		existsSync(cachedPath)
	) {
		// Fresh: reuse without touching the network at all, discovery included.
		return {
			site,
			src: entry.source,
			status: "cached",
			buf: readFileSync(cachedPath),
			ext: entry.ext,
			hint,
			fetchedAt: entry.fetchedAt,
		};
	}

	const candidates = hint ? [{ url: hint }] : await discoverCandidates(site.url);
	const rejected = [];
	for (const candidate of candidates) {
		const result = await tryCandidate(candidate.url);
		if (!result.error) {
			return {
				site,
				src: candidate.url,
				status: "fetched",
				buf: result.buf,
				ext: result.ext,
				hint,
				fetchedAt: new Date(now).toISOString(),
			};
		}
		rejected.push(`${candidate.url} (${result.error})`);
	}

	// A host that is briefly down should not drop an icon the cache already
	// holds, so a stale copy beats falling back to the flag. Its original
	// timestamp is kept so the next deploy tries the network again.
	if (entry && existsSync(cachedPath)) {
		return {
			site,
			src: entry.source,
			status: "stale",
			buf: readFileSync(cachedPath),
			ext: entry.ext,
			hint,
			fetchedAt: entry.fetchedAt,
		};
	}
	// Failures are deliberately not cached, so a site that gains a usable icon
	// is picked up on the next push rather than after a negative entry expires.
	return { site, hint, status: "flag", rejected };
});

const nextCache = {};
let vendored = 0;

for (const { site, src, status, buf, ext, hint, fetchedAt, rejected } of outcomes) {
	if (!buf) {
		site.icon = FALLBACK_ICON;
		console.log(`  flag    ${site.url}`);
		for (const reason of rejected ?? []) {
			console.log(`            tried ${reason}`);
		}
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
	nextCache[site.url] = { source: src, hint, file: cacheFile, ext, fetchedAt };
	console.log(`  ${status.padEnd(7)} ${site.url} -> ${file}`);
	if (status === "fetched" && src) {
		console.log(`            from ${src}`);
	}
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
