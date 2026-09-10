# STUDY PREMIUM COURSE - Cloudflare Workers FREE deployment

This package uses one Cloudflare Worker for the Express API and Cloudflare Static Assets for `public/`.
No Cloudflare Containers, paid Workers plan, R2, KV or D1 are required by this package.
The existing MongoDB Atlas database and Backblaze B2 storage remain in use.

## 1. Requirements
- Node.js 20+ (Node 22 recommended)
- Cloudflare account
- GitHub is optional; VS Code terminal deployment works directly

## 2. Install
```bash
npm install
```

## 3. Login
```bash
npx wrangler login
```

## 4. Add production secrets
Run each command and paste the value only into Wrangler's secure prompt:
```bash
npx wrangler secret put MONGODB_URI
npx wrangler secret put JWT_SECRET
npx wrangler secret put ACCESS_TOKEN_SECRET
npx wrangler secret put ADMIN_USERNAME
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put ADMIN_SECRET_KEY
npx wrangler secret put RAZORPAY_KEY_ID
npx wrangler secret put RAZORPAY_KEY_SECRET
npx wrangler secret put RAZORPAY_WEBHOOK_SECRET
npx wrangler secret put CASHFREE_APP_ID
npx wrangler secret put CASHFREE_SECRET_KEY
npx wrangler secret put B2_KEY_ID
npx wrangler secret put B2_APPLICATION_KEY
npx wrangler secret put B2_BUCKET_NAME
npx wrangler secret put B2_BUCKET_ID
```

Non-secret values can be added under `vars` in wrangler.jsonc if needed, for example CASHFREE_ENV.

## 5. MongoDB Atlas network access
Cloudflare Workers do not have one fixed outbound IP. Your MongoDB Atlas project must allow connections that can originate from Cloudflare's network. If your Atlas network policy only allows your home IP, the Worker will not connect.

## 6. Deploy
```bash
npm run deploy
```
Wrangler prints the final `workers.dev` URL.

## 7. PUBLIC_URL
After the first deploy, add the final URL:
```bash
npx wrangler secret put PUBLIC_URL
```
Then deploy once more:
```bash
npm run deploy
```

## 8. Payment webhooks
Set provider webhooks to your Worker URL:
- Razorpay: `https://YOUR-WORKER.workers.dev/api/payments/webhook`
- Cashfree: `https://YOUR-WORKER.workers.dev/api/payments/cashfree/webhook`

## 9. Test
Open:
- `/api/health`
- `/api/apps`
- `/admin.html`

## Free-plan note
This build deliberately avoids Cloudflare paid products. Cloudflare Workers Free, MongoDB Atlas Free, and Backblaze B2 free allowances each have their own quotas. Payment gateways can also charge normal transaction fees. Therefore the hosting stack can stay within free tiers, but "unlimited at zero cost" is not guaranteed.

## Upload note
The old server accepted very large files through local disk. Workers have request-size/runtime constraints and no persistent local disk, so uploads are held in memory and sent straight to Backblaze B2. This package caps the admin proxy upload at 90 MB. For larger APK/video uploads, use a direct-to-B2 upload flow rather than proxying the file through the Worker.
