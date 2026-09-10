# STUDY PREMIUM COURSE

Render-ready education app/course marketplace with:

- Mobile-first dark/yellow UI
- Home app listing and categories
- App/course detail page
- Free access or paid access
- Razorpay payment checkout
- Server-side Razorpay signature verification
- MongoDB persistence
- Admin login with username + password + separate secret key
- Admin CRUD for apps/courses
- Price, links, banners, screenshots, categories, rating, validity, published/featured/trending controls
- Payment/order dashboard
- Render configuration

## 1. MongoDB

Create a MongoDB Atlas database and copy its connection string.

## 2. Render environment variables

Set all values from `.env.example` in Render:

- `MONGODB_URI`
- `JWT_SECRET`
- `RAZORPAY_KEY_ID`
- `RAZORPAY_KEY_SECRET`
- `PUBLIC_URL`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `ADMIN_SECRET_KEY`

Use real Razorpay keys only in Render Environment Variables.

## 3. First startup

On Render startup the server automatically creates/updates the admin account from `ADMIN_USERNAME`, `ADMIN_PASSWORD` and `ADMIN_SECRET_KEY`, and creates demo apps if the database is empty. No localhost or manual seed step is required.

## 4. Admin

Open:

`https://YOUR-RENDER-DOMAIN/admin.html`

Login with the values you put in Render:

- username
- password
- secret key

Do not expose these values in frontend code.

## 5. Payment flow

For a paid app/course:

Home -> Details -> GET APP / Visit Website -> Razorpay -> server signature verification -> destination URL.

A paid destination URL is not opened before successful verification.

## 6. Important

Replace every demo `example.com` URL with URLs you are authorized to distribute or sell access to.

The project is intentionally not configured with a fake payment-success bypass. A real Razorpay account/key is required for real payments.

## Render start

Build command:
`npm install`

Start command:
`npm start`

Health:
`/api/health`


## Backblaze B2 file storage

The updated project stores uploaded files in Backblaze B2 instead of Render's local filesystem.

Add these Render environment variables:

- `B2_KEY_ID`
- `B2_APPLICATION_KEY`
- `B2_BUCKET_NAME`
- `B2_BUCKET_ID` (recommended for a bucket-restricted application key)

Use a private B2 bucket. The B2 application key stays only on the backend.

Admin uploads:
- App icon/logo
- Banner
- Multiple screenshots
- APK

Uploaded images are served through `/api/media`. Paid APK access is created only after successful Razorpay signature verification. The generated app-download access token is single-use and expires after the configured access period. Website access uses a separate single-use token.

## Render

No `node_modules` should be committed. Render installs dependencies with `npm install` and starts with `npm start`.

The project requires Node 18+ because it uses the built-in `fetch` API.

## Razorpay webhook setup

After deploying on Render, add this environment variable:

`RAZORPAY_WEBHOOK_SECRET`

Use a strong secret that you also enter in the Razorpay Dashboard webhook configuration. Set the webhook URL to:

`https://YOUR-RENDER-SERVICE.onrender.com/api/payments/webhook`

Enable these events:

- `payment.authorized`
- `payment.captured`
- `payment.failed`
- `order.paid`

The server verifies the Checkout signature and then fetches the real Razorpay payment status. Access is granted only when Razorpay reports the payment as `captured`. The webhook also reconciles captured payments if the browser closes or Checkout reports a temporary failure.


## Cashfree payment setup

The project now supports both Cashfree and Razorpay on the paid-item checkout. Add `CASHFREE_APP_ID`, `CASHFREE_SECRET_KEY`, and `CASHFREE_ENV` to Render Environment Variables. Use `sandbox` while testing and `production` for live payments. Cashfree checkout requires the website domain to be whitelisted in the Cashfree merchant dashboard.

Cashfree webhook URL:

```text
https://YOUR-RENDER-DOMAIN/api/payments/cashfree/webhook
```

Enable the payment success, payment failed, and user-dropped webhook events.
