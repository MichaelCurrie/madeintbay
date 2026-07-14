/* Behaviour for the site listing page.
 *
 * The listings are the single source of truth in public/sites.csv, so the only
 * edit needed to add, remove, or update a site is that one file. This script
 * fetches and parses that CSV at load, renders one card per row, then shuffles.
 * The same rows also drive a Schema.org JSON-LD graph injected into <head> for
 * search engines and AI crawlers — a presentation layer over the CSV, not a
 * second data store. Rendering happens here (not baked into the HTML)
 * specifically to keep the data and the markup decoupled. Parsing is delegated
 * to PapaParse (vendored at js/papaparse.min.js) rather than hand-rolled, so
 * edge cases like quoted fields, embedded commas/newlines, and escaped quotes
 * are handled correctly.
 */

const SITE_URL = "https://madeintbay.ca/";
const SITE_NAME = "Made in TBay";
const SITE_DESCRIPTION =
	"A list of websites that were made in beautiful Thunder Bay, Ontario 🇨🇦";

// Schema.org graph for crawlers. ItemList order matches the CSV (stable), not
// the shuffled card order shown to visitors. textContent assignment keeps the
// payload out of HTML parsing, so a </script> substring in a description cannot
// break out of the script element.
function injectJsonLd(sites) {
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

	const graph = {
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

	const existing = document.getElementById("sites-jsonld");
	if (existing) {
		existing.remove();
	}

	const script = document.createElement("script");
	script.id = "sites-jsonld";
	script.type = "application/ld+json";
	script.textContent = JSON.stringify(graph);
	document.head.appendChild(script);
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
	link.textContent = site.name || site.url;
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
			// JSON-LD first, from CSV order; cards get a separate shuffled copy.
			injectJsonLd(sites);
			shuffle([...sites]).forEach((site) => list.appendChild(renderSite(site)));
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
