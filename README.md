# MadeInTBay.ca

[MadeInTBay.ca](https://www.madeintbay.ca) — A list of websites that were made in Thunder Bay, Ontario, Canada.

(Forked from https://github.com/dohnutt/madeinthesoo)

The FAQ (why this exists, listing criteria, how to get added) lives on the page itself; see [`public/index.html`](public/index.html).

To add your site, just make a Pull Request editing [`public/sites.csv`](public/sites.csv). After editing the CSV, run `node scripts/embed_jsonld.mjs` so the Schema.org JSON-LD in `index.html` stays in sync (CI also runs this before every Pages deploy).

### Step-by-Step Flow

When a user visits `madeintbay.ca`, this is what happens:

| Step | Component | Action | Description |
| :--- | :--- | :--- | :--- |
| **1** | **Client Browser** | **DNS Query** | Initiates a DNS lookup for `madeintbay.ca`. |
| **2** | **Cloudflare DNS** | **DNS Resolution** | Resolves the domain query, returning the authoritative IP addresses for GitHub Pages edge servers. |
| **3** | **Client Browser** | **HTTP GET Request** | Establishes a TLS connection and sends an HTTP GET request for the root path (`/`) to the GitHub Pages IP. |
| **4** | **GitHub Pages** | **HTTP GET Response** | Validates the incoming host header against the repository's `CNAME` file, maps the request to the `public/` directory, and serves the static assets (`index.html` with baked-in JSON-LD, `JS`, `CSS`) verbatim. |
| **5** | **Client Browser** | **Asset Parsing** | Parses the DOM (including the static `application/ld+json` block in `<head>`), fetches `public/js/main.js`, and begins client-side execution. |
| **6** | **Client Browser** | **Local Data Fetch & Parse** | Execution of `main.js` triggers a local fetch for `public/sites.csv`. The vendored `papaparse.min.js` library parses the CSV payload directly in the browser memory. |
| **7** | **Client Browser** | **DOM Manipulation** | Iterates through the parsed rows, dynamically constructing and injecting a card element into the DOM for each listing (shuffled for display). |

---

### Component Responsibilities

* **Cloudflare:** Handles DNS management and edge routing, pointing the custom apex domain to the GitHub Pages infrastructure.
* **GitHub Pages:** Acts as a static web server. Deploy CI runs `scripts/embed_jsonld.mjs` so `index.html` contains Schema.org JSON-LD derived from `sites.csv` before the artifact is uploaded.
* **Client Browser:** Renders the interactive listing (parse CSV, shuffle cards, search). Crawler-facing structured data is already in the HTML; the browser does not regenerate it.
* **robots.txt:** Explicitly allows every user-agent (including common AI crawlers); there are no `Disallow` rules.
