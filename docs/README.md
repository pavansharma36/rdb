# rdb website

A static marketing + documentation site for **rdb**. No build step — plain HTML
+ CSS, palette mirrors the app's default Catppuccin Mocha theme.

```
website/
├─ index.html     landing page (hero, features, plugins, architecture, download, build)
├─ docs.html      full documentation with a sticky table of contents
├─ styles.css     shared styles
└─ assets/        app icons
```

## Preview locally

Open `index.html` directly in a browser, or serve the folder:

```bash
cd docs
python3 -m http.server 8080   # http://localhost:8080
```

## Deploy with GitHub Pages

The download buttons point at `https://github.com/pavansharma36/rdb/releases`,
so the site works as-is once published. Two common options:

- **Project Pages from `/website`:** in repo Settings → Pages, set the source to
  the `master` branch and the `/website` folder. The site serves at
  `https://pavansharma36.github.io/rdb/`.
- **Dedicated workflow:** add a Pages Actions workflow that uploads `website/`
  as the artifact.

If you later move this to a `docs/` folder (the other Pages convention), nothing
else needs changing — all internal links are relative.
