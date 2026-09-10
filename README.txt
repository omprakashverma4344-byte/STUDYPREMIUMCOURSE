STUDY PREMIUM COURSE - Cloudflare Mongoose Fix

Replace:
1. server.cjs -> project root
2. src/worker.mjs -> project src folder
3. wrangler.jsonc -> project root

Do NOT change or re-enter MONGODB_URI. The existing secret on Worker studypremiumcourse is already being read.

Deploy:
npx wrangler deploy --name studypremiumcourse

Then test:
https://studypremiumcourse.omprakashverma4344.workers.dev/api/health
