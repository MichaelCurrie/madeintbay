#!/usr/bin/env node
/**
 * Bake Schema.org JSON-LD into public/index.html from public/sites.csv.
 *
 * CSV remains the editable source of truth. Validators and crawlers that only
 * read the static HTML response (no JS execution) need the graph present in the
 * served markup — client-side injection alone is invisible to them.
 *
 * Usage: node scripts/embed_jsonld.mjs
 * Runs in CI before the Pages artifact upload, and locally after editing sites.csv.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CSV_PATH = join(ROOT, "public", "sites.csv");
const HTML_PATH = join(ROOT, "public", "index.html");

const SITE_URL = "https://madeintbay.ca/";
const SITE_NAME = "Made in TBay";
const SITE_DESCRIPTION =
	"A list of websites that were made in beautiful Thunder Bay, Ontario 🇨🇦";

const START_MARKER = "<!-- json-ld:start -->";
const END_MARKER = "<!-- json-ld:end -->";

// Minimal RFC 4180 CSV parse (headers + rows). Handles quoted fields, escaped
// quotes, and CRLF. No dependency — keeps the Pages deploy free of npm install.
function parseCsv(text) {
	const rows = [];
	let row = [];
	let field = "";
	let inQuotes = false;

	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (inQuotes) {
			if (char === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				field += char;
			}
		} else if (char === '"') {
			inQuotes = true;
		} else if (char === ",") {
			row.push(field);
			field = "";
		} else if (char === "\n" || char === "\r") {
			if (char === "\r" && text[i + 1] === "\n") {
				i++;
			}
			row.push(field);
			if (row.some((cell) => cell !== "")) {
				rows.push(row);
			}
			row = [];
			field = "";
		} else {
			field += char;
		}
	}
	if (field !== "" || row.length > 0) {
		row.push(field);
		if (row.some((cell) => cell !== "")) {
			rows.push(row);
		}
	}

	if (rows.length === 0) {
		return [];
	}

	const headers = rows[0].map((h) => h.trim());
	return rows.slice(1).map((cells) => {
		const obj = {};
		headers.forEach((header, index) => {
			obj[header] = (cells[index] ?? "").trim();
		});
		return obj;
	});
}

function buildGraph(sites) {
	const itemListElement = sites.map((site, index) => {
		const item = {
			"@type": "WebSite",
			name: site.name || site.url,
			url: site.url,
		};
		if (site.description) {
			item.description = site.description;
		}
		if (site.creator) {
			const creator = { "@type": "Person", name: site.creator };
			if (site.creator_url) {
				creator.url = site.creator_url;
			}
			item.creator = creator;
		}
		return {
			"@type": "ListItem",
			position: index + 1,
			item,
		};
	});

	return {
		"@context": "https://schema.org",
		"@graph": [
			{
				"@type": "WebSite",
				"@id": `${SITE_URL}#website`,
				name: SITE_NAME,
				url: SITE_URL,
				description: SITE_DESCRIPTION,
				inLanguage: "en-CA",
				about: {
					"@type": "City",
					name: "Thunder Bay",
					containedInPlace: {
						"@type": "AdministrativeArea",
						name: "Ontario",
						containedInPlace: {
							"@type": "Country",
							name: "Canada",
						},
					},
				},
			},
			{
				"@type": "ItemList",
				"@id": `${SITE_URL}#listings`,
				name: "Websites made in Thunder Bay",
				description: SITE_DESCRIPTION,
				numberOfItems: itemListElement.length,
				itemListElement,
			},
		],
	};
}

function jsonLdBlock(graph) {
	// Escape < so a description containing "</script>" cannot terminate the tag
	// when this string is written into HTML source.
	const json = JSON.stringify(graph, null, "\t").replace(/</g, "\\u003c");
	return [
		START_MARKER,
		'\t\t<script type="application/ld+json">',
		json
			.split("\n")
			.map((line) => `\t\t${line}`)
			.join("\n"),
		"\t\t</script>",
		`\t\t${END_MARKER}`,
	].join("\n");
}

function embed(html, block) {
	const start = html.indexOf(START_MARKER);
	const end = html.indexOf(END_MARKER);
	if (start === -1 || end === -1 || end < start) {
		throw new Error(
			`public/index.html must contain ${START_MARKER} … ${END_MARKER} markers`,
		);
	}
	const afterEnd = end + END_MARKER.length;
	return html.slice(0, start) + block + html.slice(afterEnd);
}

const sites = parseCsv(readFileSync(CSV_PATH, "utf8")).filter((site) => site.url);
const html = readFileSync(HTML_PATH, "utf8");
const updated = embed(html, jsonLdBlock(buildGraph(sites)));
writeFileSync(HTML_PATH, updated, "utf8");
console.log(`Embedded JSON-LD for ${sites.length} sites into public/index.html`);
