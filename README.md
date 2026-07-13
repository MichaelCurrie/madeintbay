# MadeInTBay.ca

[MadeInTBay.ca](https://www.madeintbay.ca) — A list of websites that were made in Thunder Bay, Ontario, Canada.

(Forked from https://github.com/dohnutt/madeinthesoo)

The FAQ (why this exists, listing criteria, how to get added) lives on the page itself; see [`public/index.html`](public/index.html). 

To add your site, just make a Pull Request editing [`public/sites.csv`](public/sites.csv).
## How it Works (Step-by-Step Flow)

### Architecture

When a user visits `madeintbay.ca`, this is what happens:

| Step | Component | Action | Description |
| :--- | :--- | :--- | :--- |
| **1** | **Client Browser** | **DNS Query** | Initiates a DNS lookup for `madeintbay.ca`. |
| **2** | **Cloudflare DNS** | **DNS Resolution** | Resolves the domain query, returning the authoritative IP addresses for GitHub Pages edge servers. |
| **3** | **Client Browser** | **HTTP GET Request** | Establishes a TLS connection and sends an HTTP GET request for the root path (`/`) to the GitHub Pages IP. |
| **4** | **GitHub Pages** | **Static File Delivery** | Validates the incoming host header against the repository's `CNAME` file, maps the request to the `public/` directory, and serves the static assets (`index.html`, `JS`, `CSS`) verbatim. |
| **5** | **Client Browser** | **Asset Parsing** | Parses the DOM, fetches `public/js/main.js`, and begins client-side execution. |
| **6** | **Client Browser (PapaParse)** | **Local Data Fetch & Parse** | Execution of `main.js` triggers a local fetch for `public/sites.csv`. The vendored `papaparse.min.js` library parses the CSV payload directly in the browser memory. |
| **7** | **Client Browser** | **DOM Manipulation** | Iterates through the parsed JSON objects array generated from the CSV data, dynamically constructing and injecting a card element into the DOM for each row. |

---

### Component Responsibilities

* **Cloudflare:** Handles DNS management and edge routing, pointing the custom apex domain to the GitHub Pages infrastructure.
* **GitHub Pages:** Acts exclusively as a static web server. It performs no server-side preprocessing or runtime build steps; it responds to HTTP requests by serving files directly from disk.
* **Client Browser:** Handles 100% of the runtime computing. Because there is no backend compilation, the client asset pipeline is entirely responsible for data parsing, business logic, and UI rendering.
