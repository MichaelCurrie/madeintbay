/* Behaviour for the site listing page.
 *
 * The listings are the single source of truth in public/sites.csv, so the only
 * edit needed to add, remove, or update a site is that one file. This script
 * fetches and parses that CSV at load, renders one card per row, then shuffles.
 * Crawler-facing Schema.org JSON-LD is generated into index.html from the same
 * CSV by scripts/embed_jsonld.mjs at deploy (the checked-in HTML keeps that
 * block empty) so validators that do not execute JavaScript still see it.
 * Rendering happens here (not baked into the HTML) specifically to keep the
 * data and the markup decoupled.
 * Parsing is delegated to PapaParse (vendored at js/papaparse.min.js) rather
 * than hand-rolled, so edge cases like quoted fields, embedded commas/newlines,
 * and escaped quotes are handled correctly.
 */

const FALLBACK_ICON = "img/flag_tbay.webp";

// Each card is marked with the listed site's own favicon so the grid reads as a
// row of recognisable brands, in preference order:
//
//  1. icon - a local copy under img/icons/, downloaded from the listed site by
//     scripts/fetch_icons.mjs at deploy and written into this column there. On
//     the deployed site every row has one, which is what keeps the page free of
//     third-party requests; the checked-in CSV has no such column.
//  2. icon_source - the hand-edited hint in sites.csv naming where a site keeps
//     its icon when that is not /favicon.ico.
//  3. The well-known /favicon.ico, guessed from the listing's own URL.
//
// Only 2 and 3 reach the network from the browser, so they apply when serving
// public/ directly without running the deploy scripts. A page cannot read a
// cross-origin site's <link rel="icon">, so /favicon.ico is the only path worth
// guessing: every listed site missing that file was checked and none serve one
// at another conventional path, so more guesses would only add failing requests.
function siteIconUrl(site) {
	if (site.icon) {
		return site.icon;
	}
	if (site.icon_source) {
		return site.icon_source;
	}
	try {
		return new URL("/favicon.ico", site.url).href;
	} catch {
		return FALLBACK_ICON;
	}
}

// Build the DOM via textContent/setAttribute (never innerHTML) so values from
// the CSV cannot inject markup, and links carry the target/rel hardening that
// the surrounding page expects of outbound links.
function renderSite(site) {
	const li = document.createElement("li");
	li.className = "card";

	const link = document.createElement("a");
	link.className = "card__link";
	link.href = site.url;
	link.target = "_blank";
	link.rel = "noopener";

	const icon = document.createElement("img");
	icon.className = "card__icon";
	icon.src = siteIconUrl(site);
	// Decorative: the site's name sits right beside it in the same link.
	icon.alt = "";
	icon.width = 32;
	icon.height = 32;
	icon.loading = "lazy";
	icon.decoding = "async";
	// Loading these icons is the page's only cross-origin request; withholding
	// the referrer keeps it from telling each listed site who is browsing here.
	icon.referrerPolicy = "no-referrer";
	// Fires for a missing file, a dead domain, and also for the sites that
	// answer every path with their HTML shell, since that will not decode as an
	// image. once means a missing local flag cannot loop.
	icon.addEventListener(
		"error",
		() => {
			icon.src = FALLBACK_ICON;
		},
		{ once: true },
	);
	link.appendChild(icon);

	link.append(site.name || site.url);
	li.appendChild(link);

	const desc = document.createElement("p");
	desc.className = "card__desc";
	desc.textContent = site.description || "";
	li.appendChild(desc);

	const author = document.createElement("p");
	author.className = "card__author";
	const label = document.createElement("span");
	label.className = "card__label";
	label.textContent = "creator";
	author.appendChild(label);
	author.append(" ");
	if (site.creator_url) {
		const creatorLink = document.createElement("a");
		creatorLink.href = site.creator_url;
		creatorLink.target = "_blank";
		creatorLink.rel = "noopener";
		creatorLink.textContent = site.creator;
		author.appendChild(creatorLink);
	} else {
		author.append(site.creator || "");
	}
	li.appendChild(author);

	return li;
}

// Fisher-Yates shuffle. The order is randomised on every load so no single
// listing holds a permanent first position.
function shuffle(items) {
	for (let i = items.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[items[i], items[j]] = [items[j], items[i]];
	}
	return items;
}

function loadSites() {
	const list = document.getElementById("sites");
	Papa.parse("sites.csv", {
		download: true,
		header: true,
		skipEmptyLines: true,
		// Fields are trimmed so a stray space after a comma in the hand-edited
		// CSV never leaks into a URL attribute or visible text.
		transform: (value) => value.trim(),
		complete: (results) => {
			const sites = results.data.filter((site) => site.url);
			shuffle(sites).forEach((site) => list.appendChild(renderSite(site)));
		},
		error: (err) => {
			document.getElementById("no-results").textContent =
				"Sorry, the list of sites could not be loaded.";
			console.error("Failed to load sites.csv:", err);
		},
	});
}

// Live client-side filter. Delegated from document so it keeps working for the
// cards that loadSites() injects after this listener is attached.
function attachSearch() {
	document.addEventListener("input", (e) => {
		if (e.target.id !== "search") return;
		const query = e.target.value.toLowerCase();

		document.querySelectorAll("#sites li").forEach((site) => {
			const matches = site.textContent.toLowerCase().includes(query);
			site.style.display = matches ? "" : "none";
		});

		const count = document.querySelectorAll('#sites li:not([style*="none"])').length;
		document.getElementById("no-results").textContent =
			count === 0 ? "No sites to show. Try adjusting your search?" : "";
	});
}

loadSites();
attachSearch();
