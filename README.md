# madeintbay.ca

[madeintbay.ca](https://www.madeintbay.ca) — A list of websites that were made in Thunder Bay, Ontario, Canada.

(Forked from https://github.com/dohnutt/madeinthesoo)

The site's content and FAQ (why this exists, listing criteria, and how to get added) live on the page itself; see [`public/index.html`](public/index.html). To add your site, just make a Pull Request.

## How it's published

The site is plain static HTML/CSS with no build step. Everything served lives in [`public/`](public/).

- **Web server: GitHub Pages.** On every push to `main`, [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml) uploads `public/` verbatim and deploys it to GitHub Pages (repo Settings → Pages → Source = GitHub Actions).
- **Domain + DNS: Cloudflare.** `madeintbay.ca` is registered with Cloudflare Registrar, and its DNS is hosted at Cloudflare, which points the domain at GitHub Pages. The custom domain is pinned by [`public/CNAME`](public/CNAME).
