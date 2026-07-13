# MadeInTBay.ca

[MadeInTBay.ca](https://www.madeintbay.ca) — A list of websites that were made in Thunder Bay, Ontario, Canada.

(Forked from https://github.com/dohnutt/madeinthesoo)

The FAQ (why this exists, listing criteria, how to get added) lives on the page itself; see [`public/index.html`](public/index.html). 

To add your site, just make a Pull Request editing [`public/sites.csv`](public/sites.csv).

## How it's published

The site is plain static HTML/CSS in [`public/`](public/) with no server-side build step. The browser-side code in index.html fetches [`public/sites.csv`](public/sites.csv) at load and renders the cards from it.

- **Web server: GitHub Pages.** On every push to `main`, [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml) uploads `public/` verbatim and deploys it to GitHub Pages (repo Settings → Pages → Source = GitHub Actions).
- **Domain + DNS: Cloudflare.** `madeintbay.ca` is registered with Cloudflare Registrar, and its DNS is hosted at Cloudflare, which points the domain at GitHub Pages. The custom domain is pinned by [`public/CNAME`](public/CNAME).
