# STUDY PREMIUM COURSE — Cloudflare Workers edition

Converted from the Node/Express deployment to Cloudflare Workers while preserving the existing frontend, MongoDB models, payment routes, admin routes and Backblaze B2 integration as much as possible.

Main deployment files:
- `src/worker.mjs` — Worker entry point
- `server.cjs` — existing Express backend adapted for Workers
- `wrangler.jsonc` — Worker + Static Assets configuration
- `CLOUDFLARE-DEPLOY.md` — exact deployment steps

Secrets are intentionally NOT included.
