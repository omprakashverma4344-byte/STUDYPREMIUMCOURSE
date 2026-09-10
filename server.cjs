// ============================================================
// STUDY PREMIUM COURSE  - PRODUCTION BACKEND
// File: server.cjs
// ============================================================

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const mongooseModule = require("mongoose");
const mongoose = mongooseModule?.default || mongooseModule;
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const multer = require("multer");
let nodemailer = null;
try { nodemailer = require("nodemailer"); } catch {}

const app = express();
const PORT = process.env.PORT || 10000;

const JWT_SECRET = process.env.JWT_SECRET;
const ACCESS_TOKEN_SECRET =
  process.env.ACCESS_TOKEN_SECRET || JWT_SECRET;

if (!JWT_SECRET) {
  console.error("ERROR: JWT_SECRET is missing.");
  process.exit(1);
}

// ============================================================
// DIRECTORIES
// ============================================================

// Cloudflare Workers has no __dirname/local persistent filesystem.
// Static files are served by Workers Static Assets (wrangler.jsonc).


// ============================================================
// APP CONFIG
// ============================================================

app.set("trust proxy", 1);

app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

app.use(compression());

app.use(
  cors({
    origin: true,
    credentials: true
  })
);

// ============================================================
// RAZORPAY WEBHOOK
// MUST be registered before express.json()
// ============================================================

app.post(
  "/api/payments/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
      const signature = req.headers["x-razorpay-signature"];

      if (!secret) {
        console.error("RAZORPAY_WEBHOOK_SECRET is missing.");
        return res.status(500).json({ error: "Webhook secret is not configured." });
      }
      if (!signature) {
        return res.status(400).json({ error: "Missing webhook signature." });
      }

      const expected = crypto.createHmac("sha256", secret).update(req.body).digest("hex");
      const a = Buffer.from(expected, "utf8");
      const b = Buffer.from(String(signature), "utf8");
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(400).json({ error: "Invalid webhook signature." });
      }

      const event = JSON.parse(req.body.toString("utf8"));
      const payment = event?.payload?.payment?.entity;
      const orderEntity = event?.payload?.order?.entity;
      const razorpayOrderId = payment?.order_id || orderEntity?.id || "";
      const razorpayPaymentId = payment?.id || "";

      if (event.event === "payment.captured" || event.event === "order.paid") {
        if (razorpayOrderId) {
          const order = await Order.findOne({ razorpayOrderId });
          if (order) {
            if (razorpayPaymentId) order.razorpayPaymentId = razorpayPaymentId;
            order.status = "pending_admin";
            await order.save();
            /* Access is created only after explicit admin approval. */
            /* BatchOwnership intentionally NOT created here. */
            /* approval route below creates it and starts the expiry clock. */
            await Promise.resolve();
            /* removed automatic ownership creation */
            /* await BatchOwnership.findOneAndUpdate(
              { orderId: order._id },
              { $set: {
                appId: order.appId,
                ownerEmail: normalizeEmail(order.customerEmail),
                orderId: order._id,
                active: true,
                durationMonths: Number(order.durationMonths || 0),
                expiresAt: makeOwnershipExpiry(null, order)
              } },
              { upsert: true, new: true, setDefaultsOnInsert: true }
            ); */
          }

          const donation = await DonationPayment.findOne({ razorpayOrderId });
          if (donation) {
            if (razorpayPaymentId) donation.razorpayPaymentId = razorpayPaymentId;
            donation.status = "paid";
            await donation.save();
          }
        }
      }

      if (event.event === "payment.authorized" && razorpayOrderId) {
        const order = await Order.findOne({ razorpayOrderId });
        if (order && order.status !== "paid") {
          if (razorpayPaymentId) order.razorpayPaymentId = razorpayPaymentId;
          order.status = "created";
          await order.save();
        }
      }

      if (event.event === "payment.failed" && razorpayOrderId) {
        const order = await Order.findOne({ razorpayOrderId });
        if (order && order.status !== "paid") {
          if (razorpayPaymentId) order.razorpayPaymentId = razorpayPaymentId;
          order.status = "failed";
          await order.save();
        }
        const donation = await DonationPayment.findOne({ razorpayOrderId });
        if (donation && donation.status !== "paid") {
          if (razorpayPaymentId) donation.razorpayPaymentId = razorpayPaymentId;
          donation.status = "failed";
          await donation.save();
        }
      }

      return res.json({ received: true });
    } catch (error) {
      console.error("RAZORPAY WEBHOOK ERROR:", error);
      return res.status(500).json({ error: "Webhook processing failed." });
    }
  }
);


// ============================================================
// CASHFREE WEBHOOK
// MUST be registered before express.json() because Cashfree signs
// the exact raw request body.
// ============================================================

app.post(
  "/api/payments/cashfree/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const secret = process.env.CASHFREE_SECRET_KEY;
      const signature = String(req.headers["x-webhook-signature"] || "");
      const timestamp = String(req.headers["x-webhook-timestamp"] || "");

      if (!secret) {
        console.error("CASHFREE_SECRET_KEY is missing.");
        return res.status(500).json({ error: "Cashfree is not configured." });
      }

      if (!signature || !timestamp) {
        return res.status(400).json({ error: "Missing Cashfree webhook headers." });
      }

      const rawBody = req.body.toString("utf8");
      const expected = crypto
        .createHmac("sha256", secret)
        .update(timestamp + rawBody)
        .digest("base64");

      const a = Buffer.from(expected, "utf8");
      const b = Buffer.from(signature, "utf8");
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(400).json({ error: "Invalid Cashfree webhook signature." });
      }

      const event = JSON.parse(rawBody);
      const type = String(event?.type || "");
      const cashfreeOrderId = String(event?.data?.order?.order_id || "");
      const cashfreePaymentId = String(event?.data?.payment?.cf_payment_id || "");
      const paymentStatus = String(event?.data?.payment?.payment_status || "").toUpperCase();

      if (!cashfreeOrderId) {
        return res.json({ received: true });
      }

      // Donation payments use the same verified Cashfree webhook.
      // Check DonationPayment before the course Order so both flows can coexist.
      const donation = await DonationPayment.findOne({ cashfreeOrderId });
      if (donation) {
        if (type === "PAYMENT_SUCCESS_WEBHOOK" && paymentStatus === "SUCCESS") {
          donation.cashfreePaymentId = cashfreePaymentId;
          donation.paymentGateway = "cashfree";
          donation.status = "paid";
          await donation.save();
        } else if (
          (type === "PAYMENT_FAILED_WEBHOOK" || type === "PAYMENT_USER_DROPPED_WEBHOOK") &&
          donation.status !== "paid"
        ) {
          donation.cashfreePaymentId = cashfreePaymentId;
          donation.paymentGateway = "cashfree";
          donation.status = "failed";
          await donation.save();
        }
        return res.json({ received: true });
      }

      const order = await Order.findOne({ cashfreeOrderId });
      if (!order) {
        return res.json({ received: true });
      }

      if (type === "PAYMENT_SUCCESS_WEBHOOK" && paymentStatus === "SUCCESS") {
        order.cashfreePaymentId = cashfreePaymentId;
        order.status = "pending_admin";
        await order.save();
        // Access is intentionally NOT created until admin approval.
      }

      if (
        (type === "PAYMENT_FAILED_WEBHOOK" || type === "PAYMENT_USER_DROPPED_WEBHOOK") &&
        order.status !== "paid"
      ) {
        order.cashfreePaymentId = cashfreePaymentId;
        order.status = "failed";
        await order.save();
      }

      return res.json({ received: true });
    } catch (error) {
      console.error("CASHFREE WEBHOOK ERROR:", error);
      return res.status(500).json({ error: "Cashfree webhook processing failed." });
    }
  }
);

app.use(
  express.json({
    limit: "2mb"
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "2mb"
  })
);

// ============================================================
// RATE LIMIT
// ============================================================

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false
});

app.use("/api", apiLimiter);

// ============================================================
// FILE UPLOAD
// ============================================================

const allowedImageTypes = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif"
];

const storage = multer.memoryStorage();

const upload = multer({
  storage,

  limits: {
    fileSize: 8 * 1024 * 1024
  },

  fileFilter: function (req, file, cb) {
    if (!allowedImageTypes.includes(file.mimetype)) {
      return cb(
        new Error(
          "Only JPG, PNG, WEBP and GIF images are allowed."
        )
      );
    }

    cb(null, true);
  }
});

// ============================================================
// BACKBLAZE B2 STORAGE
// ============================================================
//
// IMPORTANT:
//
// B2_KEY_ID = Application Key ID
// B2_APPLICATION_KEY = actual Application Key
// B2_BUCKET_NAME = exact bucket name
// B2_BUCKET_ID = optional but recommended
//
// Never expose these values to frontend.
// ============================================================

let b2AuthCache = null;
let b2BucketCache = null;

function envValue(name) {
  const value = String(process.env[name] || "").trim();

  if (
    value.length >= 2 &&
    (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
  ) {
    return value.slice(1, -1).trim();
  }

  return value;
}

function b2KeyId() {
  return (
    envValue("B2_KEY_ID") ||
    envValue("B2_APPLICATION_KEY_ID")
  );
}

function b2ApplicationKey() {
  return (
    envValue("B2_APPLICATION_KEY") ||
    envValue("B2_KEY")
  );
}

function b2BucketName() {
  return envValue("B2_BUCKET_NAME");
}

function b2BucketId() {
  return envValue("B2_BUCKET_ID");
}

function b2Configured() {
  return Boolean(
    b2KeyId() &&
    b2ApplicationKey() &&
    b2BucketName()
  );
}

function resetB2Cache() {
  b2AuthCache = null;
  b2BucketCache = null;
}

function b2ConfigStatus() {
  return {
    configured: b2Configured(),
    keyIdPresent: Boolean(b2KeyId()),
    applicationKeyPresent: Boolean(b2ApplicationKey()),
    bucketNamePresent: Boolean(b2BucketName()),
    bucketIdPresent: Boolean(b2BucketId()),
    bucketName: b2BucketName() || null
  };
}

// ============================================================
// B2 AUTHORIZE
// ============================================================

async function b2Authorize(force = false) {
  if (!b2Configured()) {
    const missing = [];

    if (!b2KeyId()) {
      missing.push("B2_KEY_ID");
    }

    if (!b2ApplicationKey()) {
      missing.push("B2_APPLICATION_KEY");
    }

    if (!b2BucketName()) {
      missing.push("B2_BUCKET_NAME");
    }

    throw new Error(
      `Backblaze B2 is not configured. Missing: ${missing.join(", ")}`
    );
  }

  if (
    !force &&
    b2AuthCache &&
    b2AuthCache.expiresAt > Date.now() + 60000
  ) {
    return b2AuthCache;
  }

  const keyId = b2KeyId();
  const applicationKey = b2ApplicationKey();

  const basic = Buffer
    .from(`${keyId}:${applicationKey}`, "utf8")
    .toString("base64");

  let response;

  try {
    response = await fetch(
      "https://api.backblazeb2.com/b2api/v2/b2_authorize_account",
      {
        method: "GET",
        headers: {
          Authorization: `Basic ${basic}`
        }
      }
    );
  } catch (error) {
    throw new Error(
      `Could not connect to Backblaze B2: ${error.message}`
    );
  }

  const data =
    await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error("B2 AUTH FAILED:", {
      httpStatus: response.status,
      code: data.code || "",
      message: data.message || ""
    });

    let reason =
      data.message ||
      data.code ||
      `HTTP ${response.status}`;

    if (
      data.code === "bad_auth_token" ||
      data.code === "unauthorized"
    ) {
      reason =
        "Invalid Backblaze Application Key ID or Application Key. " +
        "Use the Application Key ID and the actual Application Key, not the key name.";
    }

    throw new Error(
      `Backblaze authorization failed: ${reason}`
    );
  }

  if (
    !data.authorizationToken ||
    !data.apiUrl ||
    !data.downloadUrl ||
    !data.accountId
  ) {
    throw new Error(
      "Backblaze authorization returned an incomplete response."
    );
  }

  b2AuthCache = {
    ...data,

    expiresAt:
      Date.now() +
      23 * 60 * 60 * 1000
  };

  return b2AuthCache;
}

// ============================================================
// B2 BUCKET
// ============================================================

async function b2GetBucket(force = false) {
  if (
    !force &&
    b2BucketCache &&
    b2BucketCache.bucketId &&
    b2BucketCache.bucketName
  ) {
    return b2BucketCache;
  }

  const configuredBucketId =
    b2BucketId();

  // If bucket ID is supplied, don't call list buckets.
  // This also works better with restricted application keys.
  if (configuredBucketId) {
    b2BucketCache = {
      bucketId: configuredBucketId,
      bucketName: b2BucketName()
    };

    return b2BucketCache;
  }

  const auth =
    await b2Authorize(force);

  let response;

  try {
    response = await fetch(
      `${auth.apiUrl}/b2api/v2/b2_list_buckets`,
      {
        method: "POST",

        headers: {
          Authorization:
            auth.authorizationToken,

          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({
          accountId:
            auth.accountId,

          bucketName:
            b2BucketName()
        })
      }
    );
  } catch (error) {
    throw new Error(
      `Could not connect to Backblaze bucket API: ${error.message}`
    );
  }

  const data =
    await response.json().catch(() => ({}));

  if (!response.ok) {
    if (
      response.status === 401 &&
      !force
    ) {
      resetB2Cache();
      return b2GetBucket(true);
    }

    throw new Error(
      data.message ||
      data.code ||
      "Could not find Backblaze bucket."
    );
  }

  const bucket =
    (data.buckets || [])[0];

  if (!bucket) {
    throw new Error(
      `Backblaze bucket "${b2BucketName()}" was not found.`
    );
  }

  b2BucketCache = {
    bucketId:
      bucket.bucketId,

    bucketName:
      bucket.bucketName
  };

  return b2BucketCache;
}

// ============================================================
// B2 SAFE FILE NAME
// ============================================================

function b2SafeName(name) {
  return String(name || "file")
    .replace(
      /[^a-zA-Z0-9._/-]/g,
      "-"
    )
    .replace(/\\+/g, "/")
    .replace(/^\/+/, "")
    .substring(0, 240);
}

// ============================================================
// B2 GET UPLOAD URL
// ============================================================

async function b2GetUploadUrl(
  auth,
  bucket
) {
  let response;

  try {
    response = await fetch(
      `${auth.apiUrl}/b2api/v2/b2_get_upload_url`,
      {
        method: "POST",

        headers: {
          Authorization:
            auth.authorizationToken,

          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({
          bucketId:
            bucket.bucketId
        })
      }
    );
  } catch (error) {
    throw new Error(
      `Could not connect to Backblaze upload API: ${error.message}`
    );
  }

  const data =
    await response.json().catch(() => ({}));

  if (!response.ok) {
    const error =
      new Error(
        data.message ||
        data.code ||
        "Could not get B2 upload URL."
      );

    error.status =
      response.status;

    error.b2Code =
      data.code || "";

    throw error;
  }

  if (
    !data.uploadUrl ||
    !data.authorizationToken
  ) {
    throw new Error(
      "Backblaze returned an incomplete upload URL response."
    );
  }

  return data;
}

// ============================================================
// B2 UPLOAD FILE
// ============================================================

async function b2UploadFile(
  fileBuffer,
  fileName,
  contentType
) {
  if (!b2Configured()) {
    throw new Error("Backblaze B2 is not configured on the server.");
  }

  const body = Buffer.isBuffer(fileBuffer)
    ? fileBuffer
    : Buffer.from(fileBuffer || []);

  const sha1Hex = crypto
    .createHash("sha1")
    .update(body)
    .digest("hex");

  let auth = await b2Authorize(false);
  let bucket = await b2GetBucket(false);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const uploadData = await b2GetUploadUrl(auth, bucket);
      const safeName = b2SafeName(fileName);
      const putResponse = await fetch(uploadData.uploadUrl, {
        method: "POST",
        headers: {
          Authorization: uploadData.authorizationToken,
          "X-Bz-File-Name": encodeURIComponent(safeName),
          "Content-Type": contentType || "application/octet-stream",
          "Content-Length": String(body.byteLength),
          "X-Bz-Content-Sha1": sha1Hex
        },
        body
      });

      const putData = await putResponse.json().catch(() => ({}));
      if (!putResponse.ok) {
        const error = new Error(
          putData.message || putData.code || "Backblaze upload failed."
        );
        error.status = putResponse.status;
        error.b2Code = putData.code || "";
        throw error;
      }

      return {
        fileId: putData.fileId,
        fileName: putData.fileName,
        contentType: contentType || "application/octet-stream",
        size: body.byteLength
      };
    } catch (error) {
      const retryable =
        error.status === 401 || error.b2Code === "expired_auth_token";
      if (!retryable || attempt === 1) throw error;
      resetB2Cache();
      auth = await b2Authorize(true);
      bucket = await b2GetBucket(true);
    }
  }

  throw new Error("Backblaze upload failed.");
}

// ============================================================
// B2 DOWNLOAD
// ============================================================

async function b2DownloadStream(
  fileName,
  res
) {
  let auth =
    await b2Authorize(false);

  const safeName =
    b2SafeName(fileName);

  if (!safeName) {
    throw new Error(
      "Invalid Backblaze file name."
    );
  }

  const encodedPath =
    safeName
      .split("/")
      .map(part =>
        encodeURIComponent(part)
      )
      .join("/");

  function makeUrl(authData) {
    return (
      `${authData.downloadUrl}/file/` +
      `${encodeURIComponent(
        b2BucketName()
      )}/` +
      encodedPath
    );
  }

  let response =
    await fetch(
      makeUrl(auth),
      {
        headers: {
          Authorization:
            auth.authorizationToken
        }
      }
    );

  if (response.status === 401) {
    resetB2Cache();

    auth =
      await b2Authorize(true);

    response =
      await fetch(
        makeUrl(auth),
        {
          headers: {
            Authorization:
              auth.authorizationToken
          }
        }
      );
  }

  if (
    !response.ok ||
    !response.body
  ) {
    const text =
      await response
        .text()
        .catch(() => "");

    throw new Error(
      `Backblaze file could not be downloaded (${response.status}). ${text}`
    );
  }

  const type =
    response.headers.get(
      "content-type"
    );

  const length =
    response.headers.get(
      "content-length"
    );

  if (type) {
    res.setHeader(
      "Content-Type",
      type
    );
  }

  if (length) {
    res.setHeader(
      "Content-Length",
      length
    );
  }

  res.setHeader(
    "Cache-Control",
    "private, no-store"
  );

  const {
    Readable
  } = require("stream");

  Readable
    .fromWeb(response.body)
    .pipe(res);
}

// ============================================================
// MONGOOSE SCHEMAS
// ============================================================

const appSchema =
  new mongoose.Schema(
    {
      name: {
        type: String,
        required: true,
        trim: true,
        maxlength: 150
      },

      developer: {
        type: String,
        default: "STUDY PREMIUM COURSE ",
        trim: true
      },

      category: {
        type: String,
        default: "Education",
        trim: true
      },

      description: {
        type: String,
        default: ""
      },

      logo: {
        type: String,
        default: ""
      },

      logoKey: {
        type: String,
        default: ""
      },

      screenshots: {
        type: [String],
        default: []
      },

      screenshotKeys: {
        type: [String],
        default: []
      },

      banner: {
        type: String,
        default: ""
      },

      bannerKey: {
        type: String,
        default: ""
      },

      price: {
        type: Number,
        default: 0,
        min: 0
      },

      purchasePlans: { type: [{ planId: String, label: String, days: Number, price: Number, active: { type: Boolean, default: true } }], default: [] },

      websiteUrl: {
        type: String,
        default: ""
      },

      downloadUrl: {
        type: String,
        default: ""
      },

      appFileKey: {
        type: String,
        default: ""
      },

      appFileName: {
        type: String,
        default: ""
      },

      appFileMime: {
        type: String,
        default: ""
      },

      appFileSize: {
        type: Number,
        default: 0
      },

      accessType: {
        type: String,
        enum: [
          "free",
          "paid"
        ],
        default: "free"
      },

      validity: {
        type: String,
        default: "Lifetime"
      },

      rating: {
        type: Number,
        default: 4.8,
        min: 0,
        max: 5
      },

      downloads: {
        type: Number,
        default: 0
      },

      featured: {
        type: Boolean,
        default: false
      },

      trending: {
        type: Boolean,
        default: false
      },

      published: {
        type: Boolean,
        default: true
      },

      upcoming: {
        type: Boolean,
        default: false
      }
    },
    {
      timestamps: true
    }
  );

const orderSchema =
  new mongoose.Schema(
    {
      paymentGateway: {
        type: String,
        enum: ["razorpay", "cashfree", "upi_qr"],
        default: "razorpay"
      },

      cashfreeOrderId: {
        type: String,
        unique: true,
        sparse: true
      },

      cashfreeCfOrderId: {
        type: String,
        default: ""
      },

      cashfreePaymentId: {
        type: String,
        default: ""
      },

      upiOrderId: {
        type: String,
        unique: true,
        sparse: true
      },

      upiReference: {
        type: String,
        default: ""
      },

      upiSubmittedAt: {
        type: Date,
        default: null
      },

      upiVerifiedAt: {
        type: Date,
        default: null
      },

      razorpayOrderId: {
        type: String,
        unique: true,
        sparse: true
      },

      razorpayPaymentId: {
        type: String,
        default: ""
      },

      appId: {
        type:
          mongoose.Schema.Types.ObjectId,
        ref: "App",
        required: true
      },

      appName: {
        type: String,
        default: ""
      },

      amount: {
        type: Number,
        required: true
      },

      currency: {
        type: String,
        default: "INR"
      },

      status: {
        type: String,
        enum: [
          "created",
          "pending_verification",
          "paid",
          "failed"
        ],
        default: "created"
      },

      durationMonths: {
        type: Number,
        default: 0,
        min: 0,
        max: 120
      },

      durationDays: { type: Number, default: 0, min: 0, max: 36500 },
      planId: { type: String, default: "" },
      planLabel: { type: String, default: "" },

      customerName: {
        type: String,
        default: ""
      },

      customerEmail: {
        type: String,
        default: ""
      },

      customerPhone: {
        type: String,
        default: ""
      }
    },
    {
      timestamps: true
    }
  );

const accessSchema =
  new mongoose.Schema(
    {
      tokenHash: {
        type: String,
        required: true,
        unique: true
      },

      orderId: {
        type:
          mongoose.Schema.Types.ObjectId,
        ref: "Order",
        required: true
      },

      appId: {
        type:
          mongoose.Schema.Types.ObjectId,
        ref: "App",
        required: true
      },

      type: {
        type: String,
        enum: [
          "app",
          "website"
        ],
        required: true
      },

      expiresAt: {
        type: Date,
        required: true
      },

      usedAt: {
        type: Date,
        default: null
      }
    },
    {
      timestamps: true
    }
  );

const adminSchema =
  new mongoose.Schema(
    {
      username: {
        type: String,
        unique: true,
        required: true
      },

      passwordHash: {
        type: String,
        required: true
      },

      secretHash: {
        type: String,
        required: true
      }
    },
    {
      timestamps: true
    }
  );

const settingsSchema =
  new mongoose.Schema(
    {
      key: {
        type: String,
        unique: true,
        default: "main"
      },

      title: {
        type: String,
        default: "STUDY PREMIUM COURSE "
      },

      tagline: {
        type: String,
        default:
          "LEARN • PREPARE • SUCCEED"
      },
      maintenanceMode: { type: Boolean, default: false },
      maintenanceMessage: { type: String, default: "We are updating the course platform. Please try again shortly." },
      maintenanceAllowUsers: { type: Boolean, default: false },
      notificationEmail: { type: Boolean, default: false }
    },
    {
      timestamps: true
    }
  );


// ============================================================
// USER + BATCH OWNERSHIP + DONATION
// ============================================================


// ============================================================
// LIVE VISITOR ANALYTICS
// Unique visitors are stored in MongoDB; "live" means heartbeat
// seen within the last 45 seconds. No payment/user credentials stored.
// ============================================================
const visitorSchema = new mongoose.Schema({
  visitorId: { type: String, required: true, unique: true, index: true },
  firstSeen: { type: Date, default: Date.now, index: true },
  lastSeen: { type: Date, default: Date.now, index: true },
  page: { type: String, default: "/" },
  userAgent: { type: String, default: "" },
  ipHash: { type: String, default: "" }
}, { timestamps: true });

const Visitor = mongoose.model("Visitor", visitorSchema);

function visitorIpHash(req) {
  const raw = String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
  return raw ? crypto.createHash("sha256").update(raw).digest("hex").slice(0, 24) : "";
}

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  active: { type: Boolean, default: true }
}, { timestamps: true });

const batchOwnershipSchema = new mongoose.Schema({
  appId: { type: mongoose.Schema.Types.ObjectId, ref: "App", required: true },
  ownerEmail: { type: String, required: true, lowercase: true, trim: true, index: true },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true },
  active: { type: Boolean, default: true },
  durationMonths: { type: Number, default: 0 },
  durationDays: { type: Number, default: 0, min: 0, max: 36500 },
  expiresAt: { type: Date, default: null, index: true },
  donatedAt: { type: Date, default: null }
}, { timestamps: true });

const donationSchema = new mongoose.Schema({
  ownershipId: { type: mongoose.Schema.Types.ObjectId, ref: "BatchOwnership", required: true },
  appId: { type: mongoose.Schema.Types.ObjectId, ref: "App", required: true },
  donorEmail: { type: String, required: true, lowercase: true, trim: true },
  recipientEmail: { type: String, required: true, lowercase: true, trim: true },
  otpHash: { type: String, required: true },
  otpExpiresAt: { type: Date, required: true },
  status: { type: String, enum: ["pending_otp", "pending_admin", "approved", "rejected", "completed", "cancelled"], default: "pending_otp" },
  verifiedAt: { type: Date, default: null },
  approvedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  rejectionReason: { type: String, default: "" }
}, { timestamps: true });

const User = mongoose.model("User", userSchema);
const BatchOwnership = mongoose.model("BatchOwnership", batchOwnershipSchema);
const Donation = mongoose.model("Donation", donationSchema);
const donationPaymentSchema = new mongoose.Schema({
  donorName: { type: String, required: true, trim: true, maxlength: 100 },
  donorEmail: { type: String, required: true, lowercase: true, trim: true },
  amount: { type: Number, required: true, min: 1 },
  currency: { type: String, default: "INR" },
  razorpayOrderId: { type: String, unique: true, sparse: true },
  razorpayPaymentId: { type: String, default: "" },
  cashfreeOrderId: { type: String, unique: true, sparse: true },
  cashfreePaymentId: { type: String, default: "" },
  paymentGateway: { type: String, enum: ["razorpay", "cashfree"], default: "razorpay" },
  status: { type: String, enum: ["created", "paid", "failed"], default: "created" }
}, { timestamps: true });

const DonationPayment = mongoose.model("DonationPayment", donationPaymentSchema);


const AppModel =
  mongoose.model(
    "App",
    appSchema
  );

const Order =
  mongoose.model(
    "Order",
    orderSchema
  );

const Access =
  mongoose.model(
    "Access",
    accessSchema
  );

const Admin =
  mongoose.model(
    "Admin",
    adminSchema
  );

const Settings =
  mongoose.model(
    "Settings",
    settingsSchema
  );

// ============================================================
// ADVANCED ANALYTICS / COURSE PROGRESS / NOTIFICATIONS
// ============================================================
const couponSchema = new mongoose.Schema({
  code:{type:String,required:true,unique:true,uppercase:true,trim:true}, type:{type:String,enum:["percent","fixed"],default:"percent"}, value:{type:Number,min:0,required:true}, maxUses:{type:Number,default:0}, usedCount:{type:Number,default:0}, minAmount:{type:Number,default:0}, startAt:{type:Date,default:null}, endAt:{type:Date,default:null}, active:{type:Boolean,default:true}
},{timestamps:true});
const Coupon = mongoose.model("Coupon", couponSchema);

const courseLessonSchema = new mongoose.Schema({
  appId: { type: mongoose.Schema.Types.ObjectId, ref: "App", required: true, index: true },
  title: { type: String, required: true, trim: true, maxlength: 180 },
  description: { type: String, default: "", maxlength: 2000 },
  videoUrl: { type: String, default: "" },
  materialUrl: { type: String, default: "" },
  order: { type: Number, default: 0 },
  active: { type: Boolean, default: true }
}, { timestamps: true });
const CourseLesson = mongoose.model("CourseLesson", courseLessonSchema);

const progressSchema = new mongoose.Schema({
  userEmail: { type: String, required: true, lowercase: true, index: true },
  appId: { type: mongoose.Schema.Types.ObjectId, ref: "App", required: true, index: true },
  lessonId: { type: mongoose.Schema.Types.ObjectId, ref: "CourseLesson", required: true },
  completed: { type: Boolean, default: false },
  lastWatchedAt: { type: Date, default: Date.now }
}, { timestamps: true });
progressSchema.index({ userEmail: 1, appId: 1, lessonId: 1 }, { unique: true });
const Progress = mongoose.model("Progress", progressSchema);

const notificationSchema = new mongoose.Schema({
  audienceType: { type: String, enum: ["all", "batch", "student"], required: true },
  audienceId: { type: String, default: "" },
  title: { type: String, required: true, maxlength: 160 },
  message: { type: String, required: true, maxlength: 3000 },
  type: { type: String, default: "general" },
  eventKey: { type: String, default: "", index: true },
  createdBy: { type: String, default: "admin" }
}, { timestamps: true });
const Notification = mongoose.model("Notification", notificationSchema);

const notificationReadSchema = new mongoose.Schema({
  notificationId: { type: mongoose.Schema.Types.ObjectId, ref: "Notification", required: true },
  userEmail: { type: String, required: true, lowercase: true, index: true },
  readAt: { type: Date, default: Date.now }
}, { timestamps: true });
notificationReadSchema.index({ notificationId: 1, userEmail: 1 }, { unique: true });
const NotificationRead = mongoose.model("NotificationRead", notificationReadSchema);

const auditLogSchema = new mongoose.Schema({
  admin: { type: String, default: "admin" },
  action: { type: String, required: true },
  entityType: { type: String, default: "system" },
  entityId: { type: String, default: "" },
  meta: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });
const AuditLog = mongoose.model("AuditLog", auditLogSchema);

async function writeAudit(req, action, entityType="system", entityId="", meta={}) {
  try { await AuditLog.create({ admin: req.admin?.username || "admin", action, entityType, entityId: String(entityId || ""), meta }); } catch (e) { console.error("AUDIT LOG ERROR", e.message); }
}

async function sendNotification(audienceType, audienceId, title, message, type="general", eventKey="") {
  try { return await Notification.create({ audienceType, audienceId: String(audienceId || ""), title, message, type, eventKey }); } catch (e) { console.error("NOTIFICATION ERROR", e.message); return null; }
}


// Maintenance mode: public pages are blocked, admin remains available.
app.use(async (req, res, next) => {
  if (req.path.startsWith("/api/admin") || req.path === "/admin.html" || req.path.startsWith("/api/auth") || req.path.startsWith("/api/analytics")) return next();
  if (req.path === "/styles.css" || req.path === "/admin.js" || req.path === "/favicon.ico") return next();
  try {
    const st = await Settings.findOne({ key: "main" }).lean();
    if (st?.maintenanceMode && !st?.maintenanceAllowUsers) {
      if (req.path.startsWith("/api/")) return res.status(503).json({ error: st.maintenanceMessage || "Maintenance mode is enabled." });
      return res.status(503).send(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Maintenance</title><style>body{margin:0;background:#09090b;color:#fff;font-family:system-ui;display:grid;place-items:center;min-height:100vh;padding:24px;text-align:center}.box{max-width:620px;padding:36px;border:1px solid #2a2a2e;border-radius:24px;background:#121215}h1{font-size:34px}p{color:#aaa;line-height:1.7}</style></head><body><div class="box"><h1>🛠️ Under Maintenance</h1><p>${String(st.maintenanceMessage || "We are updating the course platform. Please try again shortly.").replace(/[<>]/g,"")}</p></div></body></html>`);
    }
  } catch {}
  next();
});

// ============================================================
// RAZORPAY
// ============================================================

let razorpay = null;

function getRazorpay() {
  if (
    !process.env.RAZORPAY_KEY_ID ||
    !process.env.RAZORPAY_KEY_SECRET
  ) {
    return null;
  }

  if (!razorpay) {
    razorpay =
      new Razorpay({
        key_id:
          process.env.RAZORPAY_KEY_ID,

        key_secret:
          process.env.RAZORPAY_KEY_SECRET
      });
  }

  return razorpay;
}


// ============================================================
// CASHFREE
// ============================================================

function getCashfreeConfig() {
  const appId = String(process.env.CASHFREE_APP_ID || "").trim();
  const secretKey = String(process.env.CASHFREE_SECRET_KEY || "").trim();
  const environment = String(process.env.CASHFREE_ENV || "production").toLowerCase() === "sandbox"
    ? "sandbox"
    : "production";

  if (!appId || !secretKey) return null;

  return {
    appId,
    secretKey,
    environment,
    apiVersion: "2025-01-01",
    baseUrl: environment === "sandbox"
      ? "https://sandbox.cashfree.com/pg"
      : "https://api.cashfree.com/pg"
  };
}

async function cashfreeRequest(pathname, options = {}) {
  const cf = getCashfreeConfig();
  if (!cf) {
    const error = new Error("Cashfree is not configured on the server.");
    error.statusCode = 503;
    throw error;
  }

  const response = await fetch(`${cf.baseUrl}${pathname}`, {
    method: options.method || "GET",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-api-version": cf.apiVersion,
      "x-client-id": cf.appId,
      "x-client-secret": cf.secretKey,
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }

  if (!response.ok) {
    const message =
      data?.message ||
      data?.type ||
      data?.code ||
      `Cashfree request failed (${response.status})`;
    const error = new Error(String(message));
    error.statusCode = response.status;
    error.details = data;
    throw error;
  }

  return data;
}

// ============================================================
// HELPERS
// ============================================================

function signAdmin(admin) {
  return jwt.sign(
    {
      sub:
        admin._id.toString(),

      username:
        admin.username,

      role: "admin"
    },

    JWT_SECRET,

    {
      expiresIn: "12h"
    }
  );
}


function signUser(user) {
  return jwt.sign(
    { sub: user._id.toString(), email: user.email, role: "user" },
    JWT_SECRET,
    { expiresIn: "30d" }
  );
}

async function requireUser(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Login required" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== "user") throw new Error("Forbidden");
    const user = await User.findById(decoded.sub).lean();
    if (!user) throw new Error("User not found");
    if (user.active === false) throw new Error("Account disabled");
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired login" });
  }
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "").slice(-10);
}

function resolvePurchasePlan(item, body={}) {
  // Lifetime-only purchase system. Any old duration/plan fields are ignored.
  return {planId:"lifetime",planLabel:"Lifetime",days:0,price:Number(item.price||0)};
}

function makeOwnershipExpiry(app, order) {
  const days = Number(order?.durationDays || 0);
  if (days > 0) { const d = new Date(); d.setDate(d.getDate() + days); return d; }
  const months = Number(order?.durationMonths || 0);
  if (months > 0) { const d = new Date(); d.setMonth(d.getMonth() + months); return d; }
  return null;
}

async function sendDonationOtp(recipientEmail, otp, donorName, batchName) {
  const host = String(process.env.SMTP_HOST || "").trim();
  const port = Number(process.env.SMTP_PORT || 587);
  const user = String(process.env.SMTP_USER || "").trim();
  const pass = String(process.env.SMTP_PASS || "").trim();
  const from = String(process.env.SMTP_FROM || user || "").trim();

  if (host && user && pass && nodemailer) {
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass }
    });
    await transporter.sendMail({
      from,
      to: recipientEmail,
      subject: `Batch donation verification - ${batchName}`,
      text: `${donorName || "A user"} wants to donate ${batchName} to you. Your OTP is ${otp}. It expires in 10 minutes.`
    });
    return { sent: true, developmentOtp: null };
  }

  if (String(process.env.DONATION_DEV_OTP || (process.env.NODE_ENV === "production" ? "false" : "true")).toLowerCase() === "true") {
    console.log(`[DONATION DEV OTP] ${recipientEmail}: ${otp}`);
    return { sent: false, developmentOtp: otp };
  }

  throw new Error("Donation email service is not configured. Set SMTP_* or enable DONATION_DEV_OTP for local testing.");
}

function createAccessToken() {
  return crypto.randomBytes(48).toString("hex");
}

function hashAccessToken(token) {
  return crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");
}

function validHttpUrl(value) {
  if (!value) return true;

  try {
    const u =
      new URL(value);

    return (
      u.protocol === "http:" ||
      u.protocol === "https:"
    );
  } catch {
    return false;
  }
}

function normalizeAppBody(body) {
  const price =
    Number(body.price || 0);

  return {
    name:
      String(body.name || "")
        .trim(),

    developer:
      String(
        body.developer ||
        "STUDY PREMIUM COURSE "
      ).trim(),

    category:
      String(
        body.category ||
        "Education"
      ).trim(),

    description:
      String(
        body.description || ""
      ),

    logo:
      String(
        body.logo || ""
      ),

    logoKey:
      String(
        body.logoKey || ""
      ),

    screenshots:
      Array.isArray(
        body.screenshots
      )
        ? body.screenshots.filter(
          Boolean
        )
        : [],

    screenshotKeys:
      Array.isArray(
        body.screenshotKeys
      )
        ? body.screenshotKeys.filter(
          Boolean
        )
        : [],

    banner:
      String(
        body.banner || ""
      ),

    bannerKey:
      String(
        body.bannerKey || ""
      ),

    price,


    websiteUrl:
      String(
        body.websiteUrl || ""
      ).trim(),

    downloadUrl:
      String(
        body.downloadUrl || ""
      ).trim(),

    appFileKey:
      String(
        body.appFileKey || ""
      ).trim(),

    appFileName:
      String(
        body.appFileName || ""
      ).trim(),

    appFileMime:
      String(
        body.appFileMime || ""
      ).trim(),

    appFileSize:
      Number(
        body.appFileSize || 0
      ),

    accessType:
      price > 0
        ? "paid"
        : "free",

    validity:
      String(
        body.validity ||
        "Lifetime"
      ),

    rating:
      Number(
        body.rating || 4.8
      ),

    featured:
      Boolean(body.featured),

    trending:
      Boolean(body.trending),

    published:
      body.published !== false
  };
}

// ============================================================
// ADMIN AUTH
// ============================================================

function requireAdmin(
  req,
  res,
  next
) {
  const header =
    req.headers.authorization ||
    "";

  const token =
    header.startsWith("Bearer ")
      ? header.slice(7)
      : "";

  if (!token) {
    return res.status(401).json({
      error:
        "Admin authentication required"
    });
  }

  try {
    const decoded =
      jwt.verify(
        token,
        JWT_SECRET
      );

    if (
      decoded.role !==
      "admin"
    ) {
      throw new Error(
        "Forbidden"
      );
    }

    req.admin =
      decoded;

    next();
  } catch {
    return res.status(401).json({
      error:
        "Invalid or expired admin token"
    });
  }
}

// ============================================================
// ACCESS AUTH
// ============================================================

async function requireAccess(
  req,
  res,
  next
) {
  const token =
    req.headers[
    "x-access-token"
    ] ||
    req.query.token ||
    "";

  if (!token) {
    return res.status(401).json({
      error:
        "Access token required"
    });
  }

  try {
    const tokenHash =
      hashAccessToken(token);

    const access =
      await Access.findOne({
        tokenHash,

        expiresAt: {
          $gt: new Date()
        },

        usedAt: null
      });

    if (!access) {
      return res.status(403).json({
        error:
          "Access token expired or invalid"
      });
    }

    req.access =
      access;

    next();
  } catch {
    return res.status(403).json({
      error:
        "Access denied"
    });
  }
}


// ============================================================
// USER AUTH
// ============================================================

app.post("/api/auth/register", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || "");
    if (!name || !email || password.length < 6) {
      return res.status(400).json({ error: "Name, valid email and password (6+ characters) are required." });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Invalid email address." });
    }
    const existing = await User.findOne({ email });
    if (existing) return res.status(409).json({ error: "Account already exists. Please login." });
    const user = await User.create({ name, email, passwordHash: await bcrypt.hash(password, 12) });
    res.status(201).json({ success: true, token: signUser(user), user: { id: user._id, name: user.name, email: user.email } });
  } catch (error) {
    console.error("REGISTER ERROR:", error);
    res.status(500).json({ error: "Could not create account." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || "");
    const user = await User.findOne({ email });
    if (user && user.active === false) {
      return res.status(403).json({ error: "Your student account has been removed by admin." });
    }
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: "Invalid email or password." });
    }
    res.json({ success: true, token: signUser(user), user: { id: user._id, name: user.name, email: user.email } });
  } catch (error) {
    console.error("LOGIN ERROR:", error);
    res.status(500).json({ error: "Login failed." });
  }
});

app.get("/api/auth/me", requireUser, (req, res) => {
  res.json({ user: { id: req.user._id, name: req.user.name, email: req.user.email } });
});

// ============================================================
// STUDENT ADVANCED FEATURES
// ============================================================
app.get("/api/my-orders", requireUser, async (req,res)=>{try{res.json(await Order.find({customerEmail:req.user.email}).sort({createdAt:-1}).limit(200).lean())}catch(e){res.status(500).json({error:"Unable to load purchase history"})}});
app.get("/api/my-notifications", requireUser, async (req,res)=>{try{const [n,reads]=await Promise.all([Notification.find({$or:[{audienceType:"all"},{audienceType:"student",audienceId:req.user.email},{audienceType:"batch",audienceId:{$in:(await BatchOwnership.find({ownerEmail:req.user.email}).distinct("appId")).map(String)}}]}).sort({createdAt:-1}).limit(100).lean(),NotificationRead.find({userEmail:req.user.email}).lean()]);const set=new Set(reads.map(x=>String(x.notificationId)));res.json(n.map(x=>({...x,read:set.has(String(x._id))})));}catch(e){res.status(500).json({error:"Unable to load notifications"})}});
app.post("/api/my-notifications/:id/read", requireUser, async(req,res)=>{try{await NotificationRead.updateOne({notificationId:req.params.id,userEmail:req.user.email},{$set:{readAt:new Date()}},{upsert:true});res.json({success:true})}catch(e){res.status(500).json({error:"Unable to update notification"})}});
app.put("/api/profile", requireUser, async(req,res)=>{try{const name=String(req.body.name||req.user.name).trim().slice(0,80);await User.updateOne({_id:req.user._id},{$set:{name}});res.json({success:true,name});}catch(e){res.status(500).json({error:"Unable to update profile"})}});
app.get("/api/course/:appId", requireUser, async(req,res)=>{try{const own=await BatchOwnership.findOne({appId:req.params.appId,ownerEmail:req.user.email,active:true,$or:[{expiresAt:null},{expiresAt:{$gt:new Date()}}]});if(!own)return res.status(403).json({error:"Active batch access required"});const [batch,lessons,done]=await Promise.all([AppModel.findById(req.params.appId).lean(),CourseLesson.find({appId:req.params.appId,active:true}).sort({order:1}).lean(),Progress.find({appId:req.params.appId,userEmail:req.user.email}).lean()]);if(!batch)return res.status(404).json({error:"Batch not found"});const doneSet=new Set(done.filter(x=>x.completed).map(x=>String(x.lessonId)));res.json({batch,lessons:lessons.map(l=>({...l,completed:doneSet.has(String(l._id))})),progress:lessons.length?Math.round(doneSet.size/lessons.length*100):0});}catch(e){res.status(500).json({error:"Unable to load course"})}});
app.post("/api/course/:appId/progress", requireUser, async(req,res)=>{try{const own=await BatchOwnership.findOne({appId:req.params.appId,ownerEmail:req.user.email,active:true,$or:[{expiresAt:null},{expiresAt:{$gt:new Date()}}]});if(!own)return res.status(403).json({error:"Active batch access required"});const lesson=await CourseLesson.findOne({_id:req.body.lessonId,appId:req.params.appId,active:true});if(!lesson)return res.status(404).json({error:"Lesson not found"});const completed=Boolean(req.body.completed);await Progress.findOneAndUpdate({userEmail:req.user.email,appId:req.params.appId,lessonId:lesson._id},{$set:{completed,lastWatchedAt:new Date()}},{upsert:true,new:true});const total=await CourseLesson.countDocuments({appId:req.params.appId,active:true});const done=await Progress.countDocuments({userEmail:req.user.email,appId:req.params.appId,completed:true});res.json({success:true,progress:total?Math.round(done/total*100):0});}catch(e){res.status(500).json({error:"Unable to save progress"})}});

app.get("/api/my-batches/all", requireUser, async (req,res)=>{try{const rows=await BatchOwnership.find({ownerEmail:req.user.email}).populate("appId").sort({createdAt:-1}).lean();const now=new Date();res.json(rows.map(o=>({ownershipId:o._id,status:(o.active&&(!o.expiresAt||new Date(o.expiresAt)>now))?"active":"expired",expiresAt:o.expiresAt,purchasedAt:o.createdAt,batch:o.appId})));}catch(e){res.status(500).json({error:"Unable to load batches"})}});

// ============================================================
// MY BATCHES
// ============================================================

app.get("/api/my-batches", requireUser, async (req, res) => {
  try {
    const ownerships = await BatchOwnership.find({ ownerEmail: req.user.email, active: true })
      .populate("appId")
      .sort({ createdAt: -1 })
      .lean();

    const now = new Date();
    const valid = [];
    for (const o of ownerships) {
      if (o.expiresAt && new Date(o.expiresAt) <= now) {
        await BatchOwnership.updateOne({ _id: o._id }, { $set: { active: false } });
        continue;
      }
      valid.push({
        ownershipId: o._id,
        purchasedAt: o.createdAt,
        donatedAt: o.donatedAt,
        expiresAt: o.expiresAt,
        durationMonths: o.durationMonths || 0,
        batch: o.appId
      });
    }
    res.json(valid);
  } catch (error) {
    console.error("MY BATCHES ERROR:", error);
    res.status(500).json({ error: "Unable to load your batches." });
  }
});

app.post("/api/my-batches/access", requireUser, async (req, res) => {
  try {
    const ownership = await BatchOwnership.findOne({
      _id: req.body.ownershipId,
      ownerEmail: req.user.email,
      active: true
    }).populate("appId").populate("orderId");

    if (!ownership) return res.status(404).json({ error: "Batch access not found. Please purchase/restore access again." });
    if (ownership.expiresAt && new Date(ownership.expiresAt) <= new Date()) {
      ownership.active = false;
      await ownership.save();
      return res.status(403).json({ error: "This batch access has expired. Please purchase again." });
    }
    if (!ownership.orderId || ownership.orderId.status !== "paid") {
      return res.status(403).json({ error: "Payment is not approved yet." });
    }

    const item = ownership.appId;
    if (!item) return res.status(404).json({ error: "Batch not found." });

    const type = item.websiteUrl ? "website" : "app";
    const token = createAccessToken();
    const expiresAt = ownership.expiresAt || new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000);
    await Access.create({ tokenHash: hashAccessToken(token), orderId: ownership.orderId._id, appId: item._id, type, expiresAt });

    const url = type === "website"
      ? `/api/access/website?token=${encodeURIComponent(token)}`
      : `/api/access/download?token=${encodeURIComponent(token)}`;

    return res.json({ success: true, url, expiresAt, type });
  } catch (error) {
    console.error("MY BATCH ACCESS ERROR:", error);
    return res.status(500).json({ error: "Could not open batch." });
  }
});


// ============================================================
// DONATE BATCH
// ============================================================

app.post("/api/donate/create", requireUser, async (req, res) => {
  try {
    const ownershipId = String(req.body.ownershipId || "").trim();
    const recipientEmail = normalizeEmail(req.body.recipientEmail);
    if (!ownershipId || !recipientEmail) return res.status(400).json({ error: "Batch and recipient email are required." });
    if (recipientEmail === req.user.email) return res.status(400).json({ error: "You cannot donate a batch to yourself." });
    const recipient = await User.findOne({ email: recipientEmail }).lean();
    if (!recipient) return res.status(404).json({ error: "Recipient must create a PREP MASTER account first." });
    const ownership = await BatchOwnership.findOne({ _id: ownershipId, ownerEmail: req.user.email, active: true }).populate("appId");
    if (!ownership) return res.status(403).json({ error: "You do not own this batch." });
    const pending = await Donation.findOne({ ownershipId: ownership._id, status: { $in: ["pending_otp", "pending_admin", "approved"] } });
    if (pending) return res.status(409).json({ error: "A donation request is already pending for this batch." });
    const otp = crypto.randomInt(100000, 1000000).toString();
    const otpHash = hashAccessToken(otp);
    const donation = await Donation.create({ ownershipId, appId: ownership.appId._id, donorEmail: req.user.email, recipientEmail, otpHash, otpExpiresAt: new Date(Date.now() + 10 * 60 * 1000) });
    let mail;
    try {
      mail = await sendDonationOtp(recipientEmail, otp, req.user.name, ownership.appId.name);
    } catch (mailError) {
      await Donation.findByIdAndDelete(donation._id);
      return res.status(503).json({ error: mailError.message });
    }
    res.json({ success: true, donationId: donation._id, message: "OTP sent to recipient email.", developmentOtp: mail.developmentOtp || undefined });
  } catch (error) {
    console.error("DONATE CREATE ERROR:", error);
    res.status(500).json({ error: "Could not create donation request." });
  }
});

app.post("/api/donate/verify", requireUser, async (req, res) => {
  try {
    const donation = await Donation.findById(req.body.donationId);
    if (!donation) return res.status(404).json({ error: "Donation request not found." });
    if (donation.donorEmail !== req.user.email) return res.status(403).json({ error: "Not your donation request." });
    if (donation.status !== "pending_otp") return res.status(400).json({ error: "This donation request is no longer waiting for OTP." });
    if (donation.otpExpiresAt < new Date()) { donation.status = "cancelled"; await donation.save(); return res.status(400).json({ error: "OTP has expired." }); }
    if (hashAccessToken(String(req.body.otp || "").trim()) !== donation.otpHash) return res.status(400).json({ error: "Invalid OTP." });
    donation.status = "pending_admin";
    donation.verifiedAt = new Date();
    await donation.save();
    res.json({ success: true, message: "OTP verified. Waiting for provider/admin approval." });
  } catch (error) {
    console.error("DONATE VERIFY ERROR:", error);
    res.status(500).json({ error: "Could not verify donation." });
  }
});

app.get("/api/donations/mine", requireUser, async (req, res) => {
  try {
    const rows = await Donation.find({ $or: [{ donorEmail: req.user.email }, { recipientEmail: req.user.email }] }).populate("appId", "name logo category validity").sort({ createdAt: -1 }).limit(100).lean();
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: "Unable to load donations." });
  }
});

// ============================================================
// ADMIN DONATIONS
// ============================================================

app.get("/api/admin/donations", requireAdmin, async (req, res) => {
  try {
    const rows = await Donation.find({ status: { $in: ["pending_admin", "approved"] } }).populate("appId", "name logo category").sort({ createdAt: -1 }).lean();
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: "Unable to load donation requests." });
  }
});

app.post("/api/admin/donations/:id/approve", requireAdmin, async (req, res) => {
  try {
    const donation = await Donation.findOne({ _id: req.params.id, status: "pending_admin" });
    if (!donation) return res.status(404).json({ error: "Pending donation not found." });
    const ownership = await BatchOwnership.findOne({ _id: donation.ownershipId, ownerEmail: donation.donorEmail, active: true });
    if (!ownership) return res.status(409).json({ error: "Batch is no longer owned by donor." });
    ownership.ownerEmail = donation.recipientEmail;
    ownership.donatedAt = new Date();
    await ownership.save();
    donation.status = "completed";
    donation.approvedAt = new Date();
    donation.completedAt = new Date();
    await donation.save();
    res.json({ success: true, message: "Batch donated successfully." });
  } catch (error) {
    console.error("DONATION APPROVE ERROR:", error);
    res.status(500).json({ error: "Could not approve donation." });
  }
});

app.post("/api/admin/donations/:id/reject", requireAdmin, async (req, res) => {
  try {
    const donation = await Donation.findOneAndUpdate({ _id: req.params.id, status: "pending_admin" }, { status: "rejected", rejectionReason: String(req.body.reason || "Rejected by provider/admin").slice(0, 500) }, { new: true });
    if (!donation) return res.status(404).json({ error: "Pending donation not found." });
    res.json({ success: true, message: "Donation rejected." });
  } catch (error) {
    res.status(500).json({ error: "Could not reject donation." });
  }
});

// ============================================================
// PUBLIC DONATION PAYMENTS + LEADERBOARD
// ============================================================

app.post("/api/donations/payment/order", async (req, res) => {
  try {
    const donorName = String(req.body.donorName || "").trim();
    const donorEmail = normalizeEmail(req.body.donorEmail);
    const amount = Math.round(Number(req.body.amount || 0));

    if (!donorName || donorName.length < 2) {
      return res.status(400).json({ error: "Please enter your name." });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(donorEmail)) {
      return res.status(400).json({ error: "Please enter a valid email." });
    }
    if (!Number.isFinite(amount) || amount < 1) {
      return res.status(400).json({ error: "Minimum donation is ₹1." });
    }

    const rp = getRazorpay();
    if (!rp) {
      return res.status(503).json({ error: "Razorpay is not configured on the server." });
    }

    const razorpayOrder = await rp.orders.create({
      amount: amount * 100,
      currency: "INR",
      receipt: `donate_${Date.now()}`
    });

    await DonationPayment.create({
      donorName,
      donorEmail,
      amount,
      currency: "INR",
      razorpayOrderId: razorpayOrder.id,
      status: "created"
    });

    res.json({
      success: true,
      orderId: razorpayOrder.id,
      amount: amount * 100,
      currency: "INR",
      keyId: process.env.RAZORPAY_KEY_ID,
      donorName,
      donorEmail
    });
  } catch (error) {
    console.error("DONATION PAYMENT ORDER ERROR:", error);
    res.status(500).json({ error: "Could not create donation payment." });
  }
});

app.post("/api/donations/payment/verify", async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: "Incomplete payment verification data." });
    }
    if (!process.env.RAZORPAY_KEY_SECRET) {
      return res.status(503).json({ error: "Payment verification is not configured." });
    }

    const expected = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expected.length !== String(razorpay_signature).length ||
        !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(razorpay_signature)))) {
      return res.status(400).json({ error: "Payment signature verification failed." });
    }

    const donation = await DonationPayment.findOne({ razorpayOrderId: razorpay_order_id });
    if (!donation) return res.status(404).json({ error: "Donation payment not found." });
    if (donation.status === "paid") return res.json({ success: true, message: "Donation already recorded." });

    donation.razorpayPaymentId = razorpay_payment_id;
    donation.status = "paid";
    await donation.save();

    res.json({ success: true, message: "Donation received successfully." });
  } catch (error) {
    console.error("DONATION PAYMENT VERIFY ERROR:", error);
    res.status(500).json({ error: "Could not verify donation payment." });
  }
});

// ============================================================
// CASHFREE DONATION PAYMENT
// Uses the same Cashfree webhook as course payments.
// ============================================================

app.post("/api/donations/payment/cashfree/order", async (req, res) => {
  try {
    const donorName = String(req.body.donorName || "").trim();
    const donorEmail = normalizeEmail(req.body.donorEmail);
    const amount = Math.round(Number(req.body.amount || 0));

    if (!donorName || donorName.length < 2) {
      return res.status(400).json({ error: "Please enter your name." });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(donorEmail)) {
      return res.status(400).json({ error: "Please enter a valid email." });
    }
    if (!Number.isFinite(amount) || amount < 1) {
      return res.status(400).json({ error: "Minimum donation is ₹1." });
    }

    const cf = getCashfreeConfig();
    if (!cf) {
      return res.status(503).json({ error: "Cashfree is not configured on the server." });
    }

    const cashfreeOrderId = `donate_cf_${Date.now()}_${crypto.randomBytes(5).toString("hex")}`;
    const publicUrl = String(process.env.PUBLIC_URL || "").replace(/\/$/, "");

    const orderBody = {
      order_id: cashfreeOrderId,
      order_amount: amount,
      order_currency: "INR",
      customer_details: {
        customer_id: `donor_${crypto.createHash("sha256").update(donorEmail).digest("hex").slice(0, 20)}`,
        customer_name: donorName.slice(0, 100),
        customer_email: donorEmail,
        customer_phone: "9999999999"
      },
      order_note: "STUDY PREMIUM COURSE Donation",
      order_tags: {
        donation: "true",
        donor_email: donorEmail
      }
    };

    if (publicUrl) {
      orderBody.order_meta = {
        return_url: `${publicUrl}/?donation=cashfree&order_id={order_id}`,
        notify_url: `${publicUrl}/api/payments/cashfree/webhook`
      };
    }

    const cashfreeOrder = await cashfreeRequest("/orders", {
      method: "POST",
      headers: { "x-idempotency-key": cashfreeOrderId },
      body: orderBody
    });

    await DonationPayment.create({
      donorName,
      donorEmail,
      amount,
      currency: "INR",
      cashfreeOrderId,
      cashfreePaymentId: "",
      paymentGateway: "cashfree",
      status: "created"
    });

    return res.json({
      success: true,
      gateway: "cashfree",
      orderId: cashfreeOrderId,
      paymentSessionId: cashfreeOrder.payment_session_id,
      mode: cf.environment,
      amount,
      currency: "INR"
    });
  } catch (error) {
    console.error("CREATE CASHFREE DONATION ERROR:", error?.details || error);
    return res.status(error.statusCode || 500).json({
      error: error.message || "Could not create Cashfree donation payment."
    });
  }
});

app.post("/api/donations/payment/cashfree/verify", async (req, res) => {
  try {
    const cashfreeOrderId = String(req.body.orderId || "").trim();
    if (!cashfreeOrderId) {
      return res.status(400).json({ error: "Cashfree donation order ID is required." });
    }

    const donation = await DonationPayment.findOne({ cashfreeOrderId });
    if (!donation) {
      return res.status(404).json({ error: "Donation payment not found." });
    }
    if (donation.status === "paid") {
      return res.json({ success: true, status: "paid", message: "Donation already recorded." });
    }

    const cashfreeOrder = await cashfreeRequest(`/orders/${encodeURIComponent(cashfreeOrderId)}`);
    const orderStatus = String(cashfreeOrder.order_status || "").toUpperCase();

    if (orderStatus === "PAID") {
      try {
        const payments = await cashfreeRequest(`/orders/${encodeURIComponent(cashfreeOrderId)}/payments`);
        const successfulPayment = Array.isArray(payments)
          ? payments.find(p => String(p.payment_status || "").toUpperCase() === "SUCCESS")
          : null;
        if (successfulPayment?.cf_payment_id) {
          donation.cashfreePaymentId = String(successfulPayment.cf_payment_id);
        }
      } catch (paymentLookupError) {
        console.warn("CASHFREE DONATION PAYMENT LOOKUP WARNING:", paymentLookupError?.message || paymentLookupError);
      }

      donation.paymentGateway = "cashfree";
      donation.status = "paid";
      await donation.save();

      return res.json({ success: true, status: "paid", message: "Donation received successfully." });
    }

    if (["EXPIRED", "TERMINATED", "CANCELLED"].includes(orderStatus)) {
      donation.status = "failed";
      await donation.save();
      return res.json({ success: true, status: "failed", message: "Donation payment was not completed." });
    }

    return res.json({ success: true, status: "pending", message: "Payment is still being processed." });
  } catch (error) {
    console.error("VERIFY CASHFREE DONATION ERROR:", error?.details || error);
    return res.status(error.statusCode || 500).json({
      error: error.message || "Could not verify Cashfree donation payment."
    });
  }
});

app.get("/api/donations/leaderboard", async (req, res) => {
  try {
    const rows = await DonationPayment.aggregate([
      { $match: { status: "paid" } },
      { $group: { _id: "$donorEmail", donorName: { $last: "$donorName" }, total: { $sum: "$amount" } } },
      { $sort: { total: -1, donorName: 1 } },
      { $limit: 20 }
    ]);
    res.json(rows.map((x, i) => ({ rank: i + 1, name: x.donorName, amount: x.total })));
  } catch (error) {
    console.error("DONATION LEADERBOARD ERROR:", error);
    res.status(500).json({ error: "Unable to load donation leaderboard." });
  }
});

// ============================================================
// HEALTH
// ============================================================

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      ok: true,
      service:
        "STUDY PREMIUM COURSE",
      time:
        new Date().toISOString()
    });
  }
);

// ============================================================
// CONFIG
// ============================================================

app.get(
  "/api/config",
  (req, res) => {
    res.json({
      razorpayKeyId:
        process.env
          .RAZORPAY_KEY_ID ||
        "",

      publicUrl:
        process.env.PUBLIC_URL ||
        ""
    });
  }
);

// ============================================================
// PUBLIC SETTINGS
// ============================================================

app.get(
  "/api/settings",
  async (req, res) => {
    try {
      const settings =
        await Settings.findOne({
          key: "main"
        }).lean();

      res.json(
        settings || {
          title:
            "STUDY PREMIUM COURSE",

          tagline:
            "LEARN • PREPARE • SUCCEED"
          ,maintenanceMode:false,maintenanceMessage:"We are updating the course platform. Please try again shortly.",maintenanceAllowUsers:false
        }
      );
    } catch {
      res.status(500).json({
        error:
          "Unable to load website settings."
      });
    }
  }
);

// ============================================================
// PUBLIC APPS
// ============================================================

app.get(
  "/api/apps",
  async (req, res) => {
    try {
      const filter = {
        published: true
      };

      if (
        req.query.category &&
        req.query.category !== "All"
      ) {
        filter.category =
          req.query.category;
      }

      if (req.query.search) {
        filter.name = {
          $regex:
            req.query.search.trim(),

          $options: "i"
        };
      }

      if (req.query.upcoming === "true") {
        filter.upcoming = true;
      }

      const apps =
        await AppModel.find(filter)
          .sort({
            featured: -1,
            trending: -1,
            createdAt: -1
          })
          .lean();

      res.json(apps);
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "Unable to load apps"
      });
    }
  }
);

// ============================================================
// SINGLE APP
// ============================================================

app.get(
  "/api/apps/:id",
  async (req, res) => {
    try {
      const item =
        await AppModel.findOne({
          _id:
            req.params.id,

          published:
            true
        }).lean();

      if (!item) {
        return res.status(404).json({
          error:
            "App not found"
        });
      }

      res.json(item);
    } catch {
      res.status(400).json({
        error:
          "Invalid app id"
      });
    }
  }
);

// ============================================================
// PAYMENT ORDER
// ============================================================

app.post(
  "/api/payments/order",
  async (req, res) => {
    try {
      const {
        appId, planId = "", durationDays = 0,
        customerName = "", customerEmail = "", customerPhone = ""
      } = req.body;

      if (!appId) {
        return res.status(400).json({
          error:
            "App ID is required"
        });
      }

      if (
        !customerName.trim()
      ) {
        return res.status(400).json({
          error:
            "Customer name is required"
        });
      }

      if (
        !customerEmail.trim()
      ) {
        return res.status(400).json({
          error:
            "Customer email is required"
        });
      }

      const item =
        await AppModel.findOne({
          _id: appId,
          published: true
        });

      if (!item) {
        return res.status(404).json({
          error:
            "App not found"
        });
      }

      if (
        item.accessType !==
        "paid" ||
        item.price <= 0
      ) {
        return res.status(400).json({
          error:
            "This item is free"
        });
      }

      const plan = resolvePurchasePlan(item, {planId, durationDays});
      const amountInr = Number(plan.price);

      const rp =
        getRazorpay();

      if (!rp) {
        return res.status(503).json({
          error:
            "Razorpay is not configured on the server."
        });
      }

      const amount =
        Math.round(
          amountInr * 100
        );

      const razorpayOrder =
        await rp.orders.create({
          amount,

          currency:
            "INR",

          receipt:
            `pm_${Date.now()}`
        });

      await Order.create({
        paymentGateway:
          "razorpay",

        razorpayOrderId:
          razorpayOrder.id,

        appId:
          item._id,

        appName:
          item.name,

        amount:
          amountInr,
        durationDays: plan.days,
        planId: plan.planId,
        planLabel: plan.planLabel,

        currency:
          "INR",

        status:
          "created",

        customerName:
          customerName.trim(),

        customerEmail:
          customerEmail.trim(),

        customerPhone:
          customerPhone.trim()
      });

      res.json({
        success:
          true,

        orderId:
          razorpayOrder.id,

        amount,

        currency:
          "INR",

        keyId:
          process.env
            .RAZORPAY_KEY_ID,

        app: {
          id:
            item._id,

          name:
            item.name,

          validity:
            item.validity
        }
      });
    } catch (error) {
      console.error(
        "CREATE ORDER ERROR:",
        error
      );

      res.status(500).json({
        error:
          "Could not create payment order"
      });
    }
  }
);


// ============================================================
// CASHFREE PAYMENT ORDER
// ============================================================

app.post(
  "/api/payments/cashfree/order",
  async (req, res) => {
    try {
      const {
        appId,
        planId = "",
        durationDays = 0,
        customerName = "",
        customerEmail = "",
        customerPhone = ""
      } = req.body;

      if (!appId) return res.status(400).json({ error: "App ID is required" });
      if (!String(customerName).trim()) return res.status(400).json({ error: "Customer name is required" });
      if (!String(customerEmail).trim()) return res.status(400).json({ error: "Customer email is required" });
      if (!String(customerPhone).trim()) return res.status(400).json({ error: "Customer phone is required for Cashfree" });

      const cf = getCashfreeConfig();
      if (!cf) {
        return res.status(503).json({ error: "Cashfree is not configured on the server." });
      }

      const item = await AppModel.findOne({ _id: appId, published: true });
      if (!item) return res.status(404).json({ error: "App not found" });
      if (item.accessType !== "paid" || item.price <= 0) {
        return res.status(400).json({ error: "This item is free" });
      }

      const plan = resolvePurchasePlan(item, {planId, durationDays});
      const amountInr = Number(plan.price);

      const localOrderId = `spc_${Date.now()}_${crypto.randomBytes(5).toString("hex")}`;
      const publicUrl = String(process.env.PUBLIC_URL || "").replace(/\/$/, "");

      const orderBody = {
        order_id: localOrderId,
        order_amount: Number(amountInr.toFixed(2)),
        order_currency: "INR",
        customer_details: {
          customer_id: `cust_${crypto.createHash("sha256").update(String(customerEmail).toLowerCase()).digest("hex").slice(0, 20)}`,
          customer_name: String(customerName).trim().slice(0, 100),
          customer_email: String(customerEmail).trim().toLowerCase(),
          customer_phone: String(customerPhone).replace(/\D/g, "").slice(-10)
        },
        order_note: String(item.name || "STUDY PREMIUM COURSE").slice(0, 180),
        order_tags: {
          app_id: String(item._id)
        }
      };

      if (publicUrl) {
        orderBody.order_meta = {
          return_url: `${publicUrl}/app.html?id=${encodeURIComponent(String(item._id))}&cashfree_order_id={order_id}`,
          notify_url: `${publicUrl}/api/payments/cashfree/webhook`
        };
      }

      const cashfreeOrder = await cashfreeRequest("/orders", {
        method: "POST",
        headers: { "x-idempotency-key": localOrderId },
        body: orderBody
      });

      const dbOrder = await Order.create({
        paymentGateway: "cashfree",
        cashfreeOrderId: localOrderId,
        cashfreeCfOrderId: String(cashfreeOrder.cf_order_id || ""),
        appId: item._id,
        appName: item.name,
        amount: amountInr,
        durationDays: plan.days, planId: plan.planId, planLabel: plan.planLabel,
        currency: "INR",
        status: "created",
        customerName: String(customerName).trim(),
        customerEmail: String(customerEmail).trim().toLowerCase(),
        customerPhone: String(customerPhone).trim()
      });

      return res.json({
        success: true,
        gateway: "cashfree",
        orderId: localOrderId,
        dbOrderId: dbOrder._id,
        paymentSessionId: cashfreeOrder.payment_session_id,
        mode: cf.environment,
        amount: item.price,
        currency: "INR"
      });
    } catch (error) {
      console.error("CREATE CASHFREE ORDER ERROR:", error?.details || error);
      return res.status(error.statusCode || 500).json({
        error: error.message || "Could not create Cashfree payment order"
      });
    }
  }
);

// ============================================================
// CASHFREE PAYMENT VERIFY / STATUS
// ============================================================

app.post(
  "/api/payments/cashfree/verify",
  async (req, res) => {
    try {
      const cashfreeOrderId = String(req.body.orderId || "").trim();
      if (!cashfreeOrderId) {
        return res.status(400).json({ error: "Cashfree order ID is required." });
      }

      const order = await Order.findOne({ cashfreeOrderId });
      if (!order) return res.status(404).json({ error: "Order not found." });

      const cashfreeOrder = await cashfreeRequest(`/orders/${encodeURIComponent(cashfreeOrderId)}`);
      const status = String(cashfreeOrder.order_status || "").toUpperCase();

      // Never trust the browser callback alone. Access is granted only
      // after Cashfree's server reports the order as PAID.
      if (status === "PAID") {
        order.status = "pending_admin";
        order.cashfreeCfOrderId = String(cashfreeOrder.cf_order_id || order.cashfreeCfOrderId || "");
        await order.save();

        return res.json({
          success: true,
          status: "pending_admin",
          pendingApproval: true,
          message: "Payment confirmed. Waiting for admin approval before access is activated.",
          orderId: order._id,
          cashfreeOrderId
        });
      }

      if (["EXPIRED", "TERMINATED"].includes(status) && order.status !== "paid") {
        order.status = "failed";
        await order.save();
      }

      return res.status(202).json({
        success: false,
        pending: status === "ACTIVE",
        status: status || "ACTIVE",
        error: status === "ACTIVE"
          ? "Payment is not confirmed yet. Please complete the payment or wait for confirmation."
          : `Cashfree payment status: ${status || "UNKNOWN"}`
      });
    } catch (error) {
      console.error("VERIFY CASHFREE PAYMENT ERROR:", error?.details || error);
      return res.status(error.statusCode || 500).json({
        error: error.message || "Cashfree payment verification failed"
      });
    }
  }
);

// ============================================================
// UPI QR PAYMENT - MANUAL VERIFICATION
// Static UPI QR payments cannot be automatically verified by Cashfree.
// The server NEVER grants access from a screenshot/UTR alone.
// An admin must verify the transaction in the UPI/bank account first.
// ============================================================

app.post("/api/payments/upi-qr/order", async (req, res) => {
  try {
    const { appId, planId = "", durationDays = 0, customerName = "", customerEmail = "", customerPhone = "" } = req.body;

    if (!appId) return res.status(400).json({ error: "App ID is required" });
    if (!String(customerName).trim()) return res.status(400).json({ error: "Customer name is required" });
    if (!String(customerEmail).trim()) return res.status(400).json({ error: "Customer email is required" });
    if (!String(customerPhone).trim()) return res.status(400).json({ error: "Mobile number is required" });

    const item = await AppModel.findOne({ _id: appId, published: true });
    if (!item) return res.status(404).json({ error: "App not found" });
    if (item.accessType !== "paid" || Number(item.price) <= 0) {
      return res.status(400).json({ error: "This item is free" });
    }

    const plan = resolvePurchasePlan(item, {planId, durationDays});
    const amountInr = Number(plan.price);
    const upiOrderId = `upi_${Date.now()}_${crypto.randomBytes(5).toString("hex")}`;
    const order = await Order.create({
      paymentGateway: "upi_qr",
      upiOrderId,
      appId: item._id,
      appName: item.name,
      amount: amountInr,
      durationDays: plan.days, planId: plan.planId, planLabel: plan.planLabel,
      currency: "INR",
      status: "created",
      customerName: String(customerName).trim().slice(0, 100),
      customerEmail: String(customerEmail).trim().toLowerCase(),
      customerPhone: String(customerPhone).trim().slice(0, 15)
    });

    return res.json({
      success: true,
      orderId: upiOrderId,
      dbOrderId: order._id,
      amount: amountInr,
      currency: "INR",
      plan: {planId: plan.planId, label: plan.planLabel, days: plan.days},
      qrUrl: "/qr-payment.jpeg",
      message: "Scan the QR and pay the exact amount. Access will be unlocked only after admin verifies the transaction."
    });
  } catch (error) {
    console.error("CREATE UPI QR ORDER ERROR:", error);
    return res.status(500).json({ error: "Could not create QR payment order" });
  }
});

app.post("/api/payments/upi-qr/submit", async (req, res) => {
  try {
    const upiOrderId = String(req.body.orderId || "").trim();
    const reference = String(req.body.reference || "").trim();

    if (!upiOrderId) return res.status(400).json({ error: "QR order ID is required" });
    if (!/^[A-Za-z0-9._-]{6,64}$/.test(reference)) {
      return res.status(400).json({ error: "Enter a valid UPI transaction/reference ID" });
    }

    const order = await Order.findOne({ upiOrderId });
    if (!order) return res.status(404).json({ error: "QR order not found" });
    if (order.paymentGateway !== "upi_qr") return res.status(400).json({ error: "Invalid payment method" });
    if (order.status === "paid") return res.json({ success: true, status: "paid" });
    if (order.status === "failed") return res.status(400).json({ error: "This payment request is closed" });

    order.upiReference = reference;
    order.upiSubmittedAt = new Date();
    order.status = "pending_verification";
    await order.save();

    return res.json({
      success: true,
      status: "pending_verification",
      message: "Payment proof submitted. Access will unlock only after the admin verifies the actual transaction."
    });
  } catch (error) {
    console.error("SUBMIT UPI QR PAYMENT ERROR:", error);
    return res.status(500).json({ error: "Could not submit payment reference" });
  }
});

// ============================================================
// PAYMENT VERIFY
// ============================================================

app.post(
  "/api/payments/verify",
  async (req, res) => {
    try {
      const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

      if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        return res.status(400).json({ error: "Incomplete payment verification data" });
      }

      const secret = process.env.RAZORPAY_KEY_SECRET;
      if (!secret) {
        return res.status(503).json({ error: "Payment verification is not configured." });
      }

      const expected = crypto.createHmac("sha256", secret)
        .update(`${razorpay_order_id}|${razorpay_payment_id}`)
        .digest("hex");
      const a = Buffer.from(expected, "utf8");
      const b = Buffer.from(String(razorpay_signature), "utf8");

      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(400).json({ error: "Payment signature verification failed" });
      }

      const order = await Order.findOne({ razorpayOrderId: razorpay_order_id });
      if (!order) return res.status(404).json({ error: "Order not found" });

      const rp = getRazorpay();
      if (!rp) return res.status(503).json({ error: "Razorpay is not configured on the server." });

      const payment = await rp.payments.fetch(razorpay_payment_id);

      if (payment.order_id !== razorpay_order_id) {
        return res.status(400).json({ error: "Payment does not belong to this order." });
      }

      if (payment.status !== "captured") {
        if (payment.status === "failed" && order.status !== "paid") {
          order.razorpayPaymentId = razorpay_payment_id;
          order.status = "failed";
          await order.save();
        }
        return res.status(202).json({
          success: false,
          pending: payment.status !== "failed",
          status: payment.status,
          error: payment.status === "failed"
            ? "Razorpay reports this payment as failed. If money was debited, wait for reconciliation before trying again."
            : "Payment is not captured yet. Please wait for confirmation."
        });
      }

      order.razorpayPaymentId = razorpay_payment_id;
      order.status = "pending_admin";
      await order.save();

      const item = await AppModel.findById(order.appId).lean();
      if (!item) return res.status(404).json({ error: "Purchased item no longer exists" });

      return res.json({
        success: true,
        status: "pending_admin",
        pendingApproval: true,
        message: "Payment verified. Waiting for admin approval before access is activated.",
        orderId: order._id,
        paymentId: razorpay_payment_id,
        app: {
          id: item._id,
          name: item.name,
          websiteUrl: item.websiteUrl,
          downloadUrl: item.downloadUrl,
          appFileKey: item.appFileKey || "",
          validity: item.validity
        }
      });
    } catch (error) {
      console.error("VERIFY PAYMENT ERROR:", error);
      return res.status(500).json({ error: "Payment verification failed" });
    }
  }
);

// ============================================================
// CHECK PAYMENT STATUS
// ============================================================

app.post(
  "/api/payments/check-status",
  async (req, res) => {
    try {
      const orderId = String(req.body.orderId || "").trim();
      const paymentId = String(req.body.paymentId || "").trim();

      if (!orderId || !paymentId) {
        return res.status(400).json({ error: "Order ID and payment ID are required." });
      }

      const rp = getRazorpay();
      if (!rp) return res.status(503).json({ error: "Razorpay is not configured on the server." });

      const order = await Order.findOne({ razorpayOrderId: orderId });
      if (!order) return res.status(404).json({ error: "Order not found." });

      const payment = await rp.payments.fetch(paymentId);
      if (payment.order_id !== orderId) {
        return res.status(400).json({ error: "Payment does not belong to this order." });
      }

      if (payment.status === "captured") {
        order.razorpayPaymentId = paymentId;
        order.status = "paid";
        await order.save();

        await BatchOwnership.findOneAndUpdate(
          { orderId: order._id },
          { $set: {
                appId: order.appId,
                ownerEmail: normalizeEmail(order.customerEmail),
                orderId: order._id,
                active: true,
                durationMonths: Number(order.durationMonths || 0),
                expiresAt: makeOwnershipExpiry(null, order)
              } },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        return res.json({ success: true, status: "paid", orderId: order._id, paymentId });
      }

      if (payment.status === "failed") {
        if (order.status !== "paid") {
          order.razorpayPaymentId = paymentId;
          order.status = "failed";
          await order.save();
        }
        return res.json({ success: false, status: "failed" });
      }

      return res.json({ success: false, pending: true, status: payment.status });
    } catch (error) {
      console.error("CHECK PAYMENT STATUS ERROR:", error);
      return res.status(500).json({ error: "Could not check payment status." });
    }
  }
);

// ============================================================
// AUTO EXPIRE BATCH ACCESS
async function expireBatchOwnerships() {
  const now = new Date();
  await BatchOwnership.updateMany(
    { active: true, expiresAt: { $ne: null, $lte: now } },
    { $set: { active: false } }
  );
}

// Cloudflare Workers does not allow setInterval() in global scope.
// Expiration is checked opportunistically from ensureDatabaseReady() instead.


// ALREADY PURCHASED / RESTORE ACCESS
// Works after Razorpay, Cashfree or admin-approved UPI QR payment.
// The customer must provide the same email + mobile used for payment.
// ============================================================

app.post("/api/purchases/already-owned", async (req, res) => {
  try {
    const appId = String(req.body.appId || "").trim();
    const email = normalizeEmail(req.body.email);
    const phone = normalizePhone(req.body.phone);

    if (!appId || !mongoose.isValidObjectId(appId)) return res.status(400).json({ error: "Invalid batch." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Enter the same email used for payment." });
    if (phone.length < 10) return res.status(400).json({ error: "Enter the same mobile number used for payment." });

    const ownerships = await BatchOwnership.find({ appId, ownerEmail: email, active: true }).populate("orderId").populate("appId").sort({ createdAt: -1 });
    const ownership = ownerships.find(o => {
      if (!o.orderId || o.orderId.status !== "paid") return false;
      if (o.expiresAt && new Date(o.expiresAt) <= new Date()) return false;
      return normalizePhone(o.orderId.customerPhone) === phone;
    });

    if (!ownership) {
      return res.status(403).json({ error: "No approved purchase found for this email and mobile number." });
    }

    if (ownership.expiresAt && new Date(ownership.expiresAt) <= new Date()) {
      ownership.active = false;
      await ownership.save();
      return res.status(403).json({ error: "This batch access has expired. Please purchase again." });
    }

    const item = ownership.appId;
    const type = item.websiteUrl ? "website" : "app";
    const token = createAccessToken();
    const expiresAt = ownership.expiresAt || new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000);

    await Access.create({
      tokenHash: hashAccessToken(token),
      orderId: ownership.orderId._id,
      appId: item._id,
      type,
      expiresAt
    });

    return res.json({
      success: true,
      type,
      expiresAt,
      url: type === "website"
        ? `/api/access/website?token=${encodeURIComponent(token)}`
        : `/api/access/download?token=${encodeURIComponent(token)}`
    });
  } catch (error) {
    console.error("ALREADY PURCHASED ERROR:", error);
    return res.status(500).json({ error: "Could not restore purchased access." });
  }
});

// ============================================================
// CREATE ACCESS TOKEN
// ============================================================

app.post(
  "/api/access/create",
  async (req, res) => {
    try {
      const {
        orderId,
        type
      } = req.body;

      if (
        !orderId ||
        ![
          "app",
          "website"
        ].includes(type)
      ) {
        return res.status(400).json({
          error:
            "Invalid access request"
        });
      }

      const order = await Order.findOne({ _id: orderId, status: "paid" });
      if (!order) {
        return res.status(403).json({ error: "Admin approval required before access is activated." });
      }
      const ownership = await BatchOwnership.findOne({
        orderId: order._id,
        ownerEmail: normalizeEmail(order.customerEmail),
        active: true
      });
      if (!ownership || (ownership.expiresAt && new Date(ownership.expiresAt) <= new Date())) {
        if (ownership && ownership.expiresAt && new Date(ownership.expiresAt) <= new Date()) {
          ownership.active = false; await ownership.save();
        }
        return res.status(403).json({ error: "Batch access is not active or has expired." });
      }

      const token =
        createAccessToken();

      const tokenHash =
        hashAccessToken(
          token
        );

      const item =
        await AppModel.findById(
          order.appId
        ).lean();

      if (!item) {
        return res.status(404).json({
          error:
            "App not found"
        });
      }

      const expiresAt = makeOwnershipExpiry(item, order) ||
        new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000);

      // Course batches usually open their website. If the requested app
      // access has no uploaded app file, safely fall back to the website
      // instead of sending the student to a dead download endpoint.
      const effectiveType =
        type === "app" && !item.appFileKey && item.websiteUrl
          ? "website"
          : type;

      await Access.create({
        tokenHash,
        orderId: order._id,
        appId: item._id,
        type: effectiveType,
        expiresAt
      });

      const destination =
        effectiveType === "website"
          ? item.websiteUrl
          : (
            item.appFileKey
              ? `/api/access/download?token=${encodeURIComponent(token)}`
              : item.downloadUrl
          );

      if (!destination) {
        return res.status(400).json({
          error:
            "Destination URL or uploaded app file is not configured by admin"
        });
      }

      const url =
        type === "website"
          ? `/api/access/website?token=${encodeURIComponent(token)}`
          : `/api/access/download?token=${encodeURIComponent(token)}`;

      res.json({
        success:
          true,

        token,

        expiresAt,

        type,

        destination,

        url
      });
    } catch (error) {
      console.error(
        "ACCESS TOKEN ERROR:",
        error
      );

      res.status(500).json({
        error:
          "Could not create access token"
      });
    }
  }
);

// ============================================================
// PRIVATE B2 MEDIA
// ============================================================

app.get(
  "/api/media",
  async (req, res) => {
    try {
      const key =
        String(
          req.query.key || ""
        );

      if (
        !key ||
        key.includes("..") ||
        key.startsWith("/")
      ) {
        return res.status(400).json({
          error:
            "Invalid media key"
        });
      }

      await b2DownloadStream(
        key,
        res
      );
    } catch (error) {
      console.error(
        "MEDIA ERROR:",
        error.message
      );

      if (!res.headersSent) {
        res.status(404).json({
          error:
            "Media not found"
        });
      }
    }
  }
);

// ============================================================
// FREE DOWNLOAD
// ============================================================

app.get(
  "/api/free-download/:id",
  async (req, res) => {
    try {
      const item =
        await AppModel.findOne({
          _id:
            req.params.id,

          published:
            true
        }).lean();

      if (!item) {
        return res.status(404).json({
          error:
            "App not found."
        });
      }

      if (
        item.accessType ===
        "paid" &&
        Number(item.price) > 0
      ) {
        return res.status(402).json({
          error:
            "Payment required."
        });
      }

      if (item.appFileKey) {
        await AppModel.updateOne(
          {
            _id:
              item._id
          },
          {
            $inc: {
              downloads: 1
            }
          }
        );

        const filename =
          String(
            item.appFileName ||
            "app.apk"
          ).replace(
            /[^a-zA-Z0-9._-]/g,
            "_"
          );

        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${filename}"`
        );

        return await b2DownloadStream(
          item.appFileKey,
          res
        );
      }

      if (
        item.downloadUrl
      ) {
        return res.redirect(
          item.downloadUrl
        );
      }

      return res.status(404).json({
        error:
          "App file has not been uploaded."
      });
    } catch (error) {
      console.error(
        "FREE DOWNLOAD ERROR:",
        error
      );

      if (!res.headersSent) {
        res.status(500).json({
          error:
            "Could not download app."
        });
      }
    }
  }
);

// ============================================================
// PAID APP DOWNLOAD
// ============================================================

app.get(
  "/api/access/download",
  async (req, res) => {
    try {
      const token =
        String(
          req.query.token || ""
        );

      if (!token) {
        return res.status(401).json({
          error:
            "Access token required"
        });
      }

      const access =
        await Access.findOneAndUpdate(
          {
            tokenHash:
              hashAccessToken(
                token
              ),

            type:
              "app",

            expiresAt: {
              $gt:
                new Date()
            },

            usedAt:
              null
          },

          {
            $set: {
              usedAt:
                new Date()
            }
          },

          {
            new:
              true
          }
        );

      if (!access) {
        return res.status(403).json({
          error:
            "Download token expired, invalid or already used."
        });
      }

      const item =
        await AppModel.findById(
          access.appId
        ).lean();

      if (!item) {
        return res.status(404).json({
          error:
            "App not found"
        });
      }

      await AppModel.updateOne(
        {
          _id:
            item._id
        },
        {
          $inc: {
            downloads:
              1
          }
        }
      );

      if (
        item.appFileKey
      ) {
        const filename =
          String(
            item.appFileName ||
            "app.apk"
          ).replace(
            /[^a-zA-Z0-9._-]/g,
            "_"
          );

        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${filename}"`
        );

        return await b2DownloadStream(
          item.appFileKey,
          res
        );
      }

      if (item.downloadUrl) {
        return res.redirect(item.downloadUrl);
      }

      // A course may not have an APK/app file. In that case the secure
      // access token should still open the configured course website.
      if (item.websiteUrl && validHttpUrl(item.websiteUrl)) {
        return res.redirect(item.websiteUrl);
      }

      return res.status(404).json({
        error: "App file or course website has not been configured by admin."
      });
    } catch (error) {
      console.error(
        "DOWNLOAD ERROR:",
        error
      );

      if (!res.headersSent) {
        res.status(500).json({
          error:
            "Could not download app."
        });
      }
    }
  }
);

// ============================================================
// WEBSITE ACCESS
// ============================================================

app.get(
  "/api/access/website",
  async (req, res) => {
    try {
      const token =
        String(
          req.query.token || ""
        );

      if (!token) {
        return res.status(401).send(
          "Access token required."
        );
      }

      const access =
        await Access.findOneAndUpdate(
          {
            tokenHash:
              hashAccessToken(
                token
              ),

            type:
              "website",

            expiresAt: {
              $gt:
                new Date()
            },

            usedAt:
              null
          },

          {
            $set: {
              usedAt:
                new Date()
            }
          },

          {
            new:
              true
          }
        );

      if (!access) {
        return res.status(403).send(
          "Access token expired, invalid or already used."
        );
      }

      const item =
        await AppModel.findById(
          access.appId
        ).lean();

      if (
        !item ||
        !item.websiteUrl
      ) {
        return res.status(404).send(
          "Website link is not configured."
        );
      }

      if (
        !validHttpUrl(
          item.websiteUrl
        )
      ) {
        return res.status(400).send(
          "Invalid website URL."
        );
      }

      return res.redirect(
        item.websiteUrl
      );
    } catch (error) {
      console.error(
        "WEBSITE ACCESS ERROR:",
        error
      );

      return res.status(500).send(
        "Could not open website."
      );
    }
  }
);

// ============================================================
// ACCESS CHECK
// ============================================================

app.get(
  "/api/access/check",
  requireAccess,
  async (req, res) => {
    try {
      const item =
        await AppModel.findById(
          req.access.appId
        ).lean();

      if (!item) {
        return res.status(404).json({
          error:
            "App not found"
        });
      }

      const destination =
        req.access.type ===
          "website"
          ? item.websiteUrl
          : (
            item.appFileKey
              ? "/api/access/download"
              : item.downloadUrl
          );

      if (!destination) {
        return res.status(404).json({
          error:
            "Destination URL not configured"
        });
      }

      res.json({
        success:
          true,

        type:
          req.access.type,

        destination,

        expiresAt:
          req.access.expiresAt
      });
    } catch {
      res.status(500).json({
        error:
          "Could not verify access"
      });
    }
  }
);

// ============================================================
// ADMIN LOGIN
// ============================================================

app.post(
  "/api/admin/login",
  async (req, res) => {
    try {
      const {
        username,
        password,
        secretKey
      } = req.body;

      const admin =
        await Admin.findOne({
          username
        });

      if (!admin) {
        return res.status(401).json({
          error:
            "Invalid admin credentials"
        });
      }

      const passOk =
        await bcrypt.compare(
          password || "",
          admin.passwordHash
        );

      const secretOk =
        await bcrypt.compare(
          secretKey || "",
          admin.secretHash
        );

      if (
        !passOk ||
        !secretOk
      ) {
        return res.status(401).json({
          error:
            "Invalid admin credentials"
        });
      }

      res.json({
        token:
          signAdmin(admin),

        username:
          admin.username
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "Login failed"
      });
    }
  }
);

// ============================================================
// ADMIN B2 STATUS
// ============================================================

app.get(
  "/api/admin/b2-status",
  requireAdmin,
  async (req, res) => {
    try {
      const config =
        b2ConfigStatus();

      if (!config.configured) {
        return res.status(503).json({
          ok:
            false,

          ...config,

          error:
            "B2 environment variables are incomplete."
        });
      }

      const auth =
        await b2Authorize(
          true
        );

      const bucket =
        await b2GetBucket(
          true
        );

      return res.json({
        ok:
          true,

        configured:
          true,

        keyIdPresent:
          true,

        applicationKeyPresent:
          true,

        bucketName:
          bucket.bucketName,

        bucketId:
          bucket.bucketId,

        apiUrl:
          auth.apiUrl,

        downloadUrl:
          auth.downloadUrl,

        message:
          "Backblaze B2 authorization and bucket configuration are working."
      });
    } catch (error) {
      console.error(
        "B2 STATUS ERROR:",
        error
      );

      return res.status(502).json({
        ok:
          false,

        ...b2ConfigStatus(),

        error:
          error.message ||
          "Backblaze B2 connection failed."
      });
    }
  }
);

// ============================================================
// ADMIN APPS
// ============================================================

app.get(
  "/api/admin/apps",
  requireAdmin,
  async (req, res) => {
    try {
      const apps =
        await AppModel.find()
          .sort({
            createdAt:
              -1
          })
          .lean();

      res.json(apps);
    } catch {
      res.status(500).json({
        error:
          "Unable to load admin apps"
      });
    }
  }
);

// ============================================================
// CREATE APP
// ============================================================

app.post(
  "/api/admin/apps",
  requireAdmin,
  async (req, res) => {
    try {
      const body =
        normalizeAppBody(
          req.body
        );

      if (!body.name) {
        return res.status(400).json({
          error:
            "App name is required"
        });
      }

      if (
        !validHttpUrl(
          body.websiteUrl
        ) ||
        !validHttpUrl(
          body.downloadUrl
        )
      ) {
        return res.status(400).json({
          error:
            "Website/download URL must be http(s)"
        });
      }

      const item =
        await AppModel.create(
          body
        );

      res.status(201).json(
        item
      );
    } catch (error) {
      console.error(error);

      res.status(400).json({
        error:
          error.message ||
          "Could not create app"
      });
    }
  }
);

// ============================================================
// UPDATE APP
// ============================================================

app.put(
  "/api/admin/apps/:id",
  requireAdmin,
  async (req, res) => {
    try {
      const body =
        normalizeAppBody(
          req.body
        );

      if (
        !validHttpUrl(
          body.websiteUrl
        ) ||
        !validHttpUrl(
          body.downloadUrl
        )
      ) {
        return res.status(400).json({
          error:
            "Website/download URL must be http(s)"
        });
      }

      const item =
        await AppModel.findByIdAndUpdate(
          req.params.id,
          body,
          {
            new:
              true,

            runValidators:
              true
          }
        );

      if (!item) {
        return res.status(404).json({
          error:
            "App not found"
        });
      }

      res.json(item);
    } catch (error) {
      res.status(400).json({
        error:
          error.message ||
          "Could not update app"
      });
    }
  }
);

// ============================================================
// DELETE APP
// ============================================================

app.delete(
  "/api/admin/apps/:id",
  requireAdmin,
  async (req, res) => {
    try {
      await AppModel.findByIdAndDelete(
        req.params.id
      );

      await Access.deleteMany({
        appId:
          req.params.id
      });

      res.json({
        success:
          true
      });
    } catch {
      res.status(400).json({
        error:
          "Could not delete app"
      });
    }
  }
);

// ============================================================
// B2 UPLOAD
// ============================================================

const uploadAll =
  multer({
    storage,

    limits: {
      fileSize:
        90 * 1024 * 1024
    },

    fileFilter:
      function (
        req,
        file,
        cb
      ) {
        const kind =
          String(
            req.body.kind ||
            ""
          );

        const imageOk =
          allowedImageTypes.includes(
            file.mimetype
          );

        const apkOk =
          file.mimetype ===
          "application/vnd.android.package-archive" ||
          /\.apk$/i.test(
            file.originalname
          );

        if (
          [
            "logo",
            "banner",
            "screenshot"
          ].includes(kind) &&
          !imageOk
        ) {
          return cb(
            new Error(
              "Only JPG, PNG, WEBP and GIF images are allowed."
            )
          );
        }

        if (
          kind === "apk" &&
          !apkOk
        ) {
          return cb(
            new Error(
              "Only APK files are allowed."
            )
          );
        }

        if (
          ![
            "logo",
            "banner",
            "screenshot",
            "apk"
          ].includes(kind)
        ) {
          return cb(
            new Error(
              "Invalid upload type."
            )
          );
        }

        cb(
          null,
          true
        );
      }
  });

app.post(
  "/api/admin/upload",
  requireAdmin,
  uploadAll.single("file"),
  async (req, res) => {
    try {
      if (!b2Configured()) {
        return res.status(503).json({
          error:
            "Backblaze B2 is not configured on the server."
        });
      }

      if (!req.file) {
        return res.status(400).json({
          error:
            "File is required."
        });
      }

      const kind =
        String(
          req.body.kind ||
          "file"
        );

      const folder =
        kind === "apk"
          ? "apps"
          : `images/${kind}`;

      const fileName =
        `${folder}/${Date.now()}-${crypto.randomBytes(6).toString("hex")}-${b2SafeName(req.file.originalname)}`;

      const uploaded =
        await b2UploadFile(
          req.file.buffer,
          fileName,
          req.file.mimetype
        );

      res.json({
        success:
          true,

        kind,

        key:
          uploaded.fileName,

        url:
          `/api/media?key=${encodeURIComponent(
            uploaded.fileName
          )}`,

        fileName:
          req.file.originalname,

        mime:
          uploaded.contentType,

        size:
          uploaded.size
      });
    } catch (error) {
      console.error(
        "B2 UPLOAD ERROR:",
        error
      );

      res.status(400).json({
        error:
          error.message ||
          "Backblaze upload failed."
      });
    }
  }
);

// ============================================================
// ADMIN ORDERS
// ============================================================

app.get(
  "/api/admin/orders",
  requireAdmin,
  async (req, res) => {
    try {
      const orders =
        await Order.find()
          .sort({
            createdAt:
              -1
          })
          .limit(500)
          .lean();

      res.json(
        orders
      );
    } catch {
      res.status(500).json({
        error:
          "Unable to load orders"
      });
    }
  }
);

// ============================================================
// ADMIN PAYMENT APPROVAL (Razorpay / Cashfree / UPI QR)
app.post("/api/admin/orders/:id/approve", requireAdmin, async (req,res)=>{
  try {
    const order=await Order.findById(req.params.id);
    if(!order) return res.status(404).json({error:"Order not found"});
    if(!["pending_admin","pending_verification"].includes(order.status)) return res.status(400).json({error:"Order is not waiting for approval"});
    order.status="paid";
    if(order.paymentGateway==="upi_qr") order.upiVerifiedAt=new Date();
    await order.save();
    const days=Number(order.durationDays||0);
    const expiresAt=days>0 ? new Date(Date.now()+days*86400000) : null;
    const own=await BatchOwnership.findOneAndUpdate(
      {appId:order.appId,ownerEmail:normalizeEmail(order.customerEmail)},
      {$set:{orderId:order._id,appId:order.appId,ownerEmail:normalizeEmail(order.customerEmail),active:true,durationDays:days,durationMonths:Number(order.durationMonths||0),expiresAt}},
      {upsert:true,new:true,setDefaultsOnInsert:true}
    );
    await writeAudit(req,"approve_payment","order",order._id,{studentEmail:order.customerEmail,appId:order.appId,durationDays:days,expiresAt});
    res.json({success:true,status:"paid",ownership:own});
  }catch(e){res.status(500).json({error:e.message||"Could not approve payment"});}
});

// ADMIN UPI QR PAYMENT VERIFICATION
// ============================================================

app.post("/api/admin/orders/:id/upi-qr/approve", requireAdmin, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.paymentGateway !== "upi_qr") return res.status(400).json({ error: "This is not a QR payment" });
    if (!order.upiReference) return res.status(400).json({ error: "No UPI transaction reference submitted" });
    if (order.status === "paid") return res.json({ success: true, status: "paid" });

    // Admin should approve only after confirming the same amount/reference in the bank/UPI app.
    order.status = "paid";
    order.upiVerifiedAt = new Date();
    await order.save();

    await BatchOwnership.findOneAndUpdate(
      { orderId: order._id },
      {
        $set: {
          appId: order.appId,
          ownerEmail: normalizeEmail(order.customerEmail),
          orderId: order._id,
          active: true,
          durationMonths: Number(order.durationMonths || 0),
          expiresAt: makeOwnershipExpiry(null, order)
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return res.json({ success: true, status: "paid", orderId: order._id });
  } catch (error) {
    console.error("APPROVE UPI QR PAYMENT ERROR:", error);
    return res.status(500).json({ error: "Could not approve QR payment" });
  }
});

app.post("/api/admin/orders/:id/upi-qr/reject", requireAdmin, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.paymentGateway !== "upi_qr") return res.status(400).json({ error: "This is not a QR payment" });
    if (order.status === "paid") return res.status(400).json({ error: "Paid orders cannot be rejected" });

    order.status = "failed";
    await order.save();
    return res.json({ success: true, status: "failed" });
  } catch (error) {
    console.error("REJECT UPI QR PAYMENT ERROR:", error);
    return res.status(500).json({ error: "Could not reject QR payment" });
  }
});


// ============================================================
// PUBLIC LIVE VISITOR HEARTBEAT
// ============================================================
app.post("/api/analytics/heartbeat", async (req, res) => {
  try {
    const visitorId = String(req.body?.visitorId || "").trim().slice(0, 100);
    const page = String(req.body?.page || "/").trim().slice(0, 200) || "/";
    if (!visitorId) return res.status(400).json({ error: "visitorId is required" });

    const now = new Date();
    await Visitor.findOneAndUpdate(
      { visitorId },
      {
        $set: {
          lastSeen: now,
          page,
          userAgent: String(req.headers["user-agent"] || "").slice(0, 300),
          ipHash: visitorIpHash(req)
        },
        $setOnInsert: { firstSeen: now }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const liveSince = new Date(Date.now() - 45 * 1000);
    const [liveUsers, totalVisitors, todayVisitors] = await Promise.all([
      Visitor.countDocuments({ lastSeen: { $gte: liveSince } }),
      Visitor.countDocuments(),
      Visitor.countDocuments({
        firstSeen: {
          $gte: new Date(new Date().setHours(0, 0, 0, 0))
        }
      })
    ]);

    res.json({ liveUsers, totalVisitors, todayVisitors });
  } catch (error) {
    console.error("ANALYTICS HEARTBEAT ERROR:", error);
    res.status(500).json({ error: "Analytics unavailable" });
  }
});

app.get("/api/analytics/live", async (req, res) => {
  try {
    const liveSince = new Date(Date.now() - 45 * 1000);
    const [liveUsers, totalVisitors, todayVisitors] = await Promise.all([
      Visitor.countDocuments({ lastSeen: { $gte: liveSince } }),
      Visitor.countDocuments(),
      Visitor.countDocuments({ firstSeen: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) } })
    ]);
    res.json({ liveUsers, totalVisitors, todayVisitors });
  } catch {
    res.status(500).json({ error: "Analytics unavailable" });
  }
});

app.get("/api/admin/analytics", requireAdmin, async (req, res) => {
  try {
    const liveSince = new Date(Date.now() - 45 * 1000);
    const todayStart = new Date(new Date().setHours(0, 0, 0, 0));
    const [liveUsers, totalVisitors, todayVisitors, liveList] = await Promise.all([
      Visitor.countDocuments({ lastSeen: { $gte: liveSince } }),
      Visitor.countDocuments(),
      Visitor.countDocuments({ firstSeen: { $gte: todayStart } }),
      Visitor.find({ lastSeen: { $gte: liveSince } })
        .select("visitorId firstSeen lastSeen page")
        .sort({ lastSeen: -1 })
        .limit(100)
        .lean()
    ]);
    res.json({ liveUsers, totalVisitors, todayVisitors, liveList });
  } catch (error) {
    console.error("ADMIN ANALYTICS ERROR:", error);
    res.status(500).json({ error: "Unable to load analytics" });
  }
});

// ============================================================
// ADMIN STATS
// ============================================================

app.get(
  "/api/admin/stats",
  requireAdmin,
  async (req, res) => {
    try {
      const [
        apps,
        orders,
        paid
      ] =
        await Promise.all([
          AppModel.countDocuments(),

          Order.countDocuments(),

          Order.find({
            status:
              "paid"
          }).lean()
        ]);

      const revenue =
        paid.reduce(
          (
            sum,
            order
          ) =>
            sum +
            Number(
              order.amount ||
              0
            ),

          0
        );

      const downloads =
        await AppModel.aggregate([
          {
            $group: {
              _id:
                null,

              total: {
                $sum:
                  "$downloads"
              }
            }
          }
        ]);

      res.json({
        apps,

        orders,

        paidOrders:
          paid.length,

        revenue,

        downloads:
          downloads[0]
            ?.total ||
          0
      });
    } catch {
      res.status(500).json({
        error:
          "Unable to load statistics"
      });
    }
  }
);

// ============================================================
// ADVANCED ADMIN MANAGEMENT
// ============================================================
app.get("/api/admin/lessons", requireAdmin, async(req,res)=>{try{res.json(await CourseLesson.find().populate("appId","name").sort({appId:1,order:1}).lean())}catch(e){res.status(500).json({error:"Unable to load lessons"})}});
app.post("/api/admin/lessons", requireAdmin, async(req,res)=>{try{const x=await CourseLesson.create({appId:req.body.appId,title:String(req.body.title||"").trim(),description:String(req.body.description||""),videoUrl:String(req.body.videoUrl||""),materialUrl:String(req.body.materialUrl||""),order:Number(req.body.order||0),active:req.body.active!==false});await writeAudit(req,"create_lesson","lesson",x._id,{title:x.title});res.json(x)}catch(e){res.status(400).json({error:e.message})}});
app.put("/api/admin/lessons/:id", requireAdmin, async(req,res)=>{try{const x=await CourseLesson.findByIdAndUpdate(req.params.id,{$set:{title:req.body.title,description:req.body.description,videoUrl:req.body.videoUrl,materialUrl:req.body.materialUrl,order:Number(req.body.order||0),active:req.body.active!==false}},{new:true,runValidators:true});await writeAudit(req,"update_lesson","lesson",req.params.id);res.json(x)}catch(e){res.status(400).json({error:e.message})}});
app.delete("/api/admin/lessons/:id", requireAdmin, async(req,res)=>{try{await CourseLesson.findByIdAndDelete(req.params.id);await Progress.deleteMany({lessonId:req.params.id});await writeAudit(req,"delete_lesson","lesson",req.params.id);res.json({success:true})}catch(e){res.status(500).json({error:"Unable to delete lesson"})}});
app.get("/api/admin/coupons", requireAdmin, async(req,res)=>{try{res.json(await Coupon.find().sort({createdAt:-1}).lean())}catch(e){res.status(500).json({error:"Unable to load coupons"})}});
app.post("/api/admin/coupons", requireAdmin, async(req,res)=>{try{const x=await Coupon.create({code:String(req.body.code||"").trim().toUpperCase(),type:req.body.type||"percent",value:Number(req.body.value||0),maxUses:Number(req.body.maxUses||0),minAmount:Number(req.body.minAmount||0),endAt:req.body.endAt||null});await writeAudit(req,"create_coupon","coupon",x._id,{code:x.code});res.json(x)}catch(e){res.status(400).json({error:e.code===11000?"Coupon already exists":e.message})}});
app.delete("/api/admin/coupons/:id", requireAdmin, async(req,res)=>{try{await Coupon.findByIdAndDelete(req.params.id);await writeAudit(req,"delete_coupon","coupon",req.params.id);res.json({success:true})}catch(e){res.status(500).json({error:"Unable to delete coupon"})}});
app.post("/api/admin/notifications", requireAdmin, async(req,res)=>{try{const n=await sendNotification(req.body.audienceType||"all",req.body.audienceId||"",String(req.body.title||"Notification").slice(0,160),String(req.body.message||"").slice(0,3000),req.body.type||"general");await writeAudit(req,"send_notification","notification",n?._id,{audience:req.body.audienceType});res.json(n)}catch(e){res.status(500).json({error:"Unable to send notification"})}});
app.post("/api/admin/access/grant", requireAdmin, async(req,res)=>{try{const email=normalizeEmail(req.body.email);const appId=String(req.body.appId||"");const days=0;if(!email||!appId)return res.status(400).json({error:"Student email and batch are required"});const user=await User.findOne({email});if(!user)return res.status(404).json({error:"Student not found"});const appItem=await AppModel.findById(appId).lean();if(!appItem)return res.status(404).json({error:"Batch not found"});const manualOrder=await Order.create({paymentGateway:"razorpay",razorpayOrderId:`manual_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,appId:appItem._id,appName:appItem.name,amount:0,currency:"INR",status:"paid",durationDays:days,planId:"manual",planLabel:days>0?`${days} Days`:`Lifetime`,customerName:user.name,customerEmail:user.email,customerPhone:""});const expiresAt=days>0?new Date(Date.now()+days*86400000):null;const own=await BatchOwnership.findOneAndUpdate({appId:appItem._id,ownerEmail:email},{$set:{orderId:manualOrder._id,active:true,durationDays:days,expiresAt,donatedAt:null}},{upsert:true,new:true,setDefaultsOnInsert:true});await writeAudit(req,"grant_access","batch_ownership",own._id,{email,appId,durationDays:days});res.json({success:true,ownership:own})}catch(e){res.status(400).json({error:e.message||"Unable to grant access"})}});
app.put("/api/admin/access/:id", requireAdmin, async(req,res)=>{try{const own=await BatchOwnership.findById(req.params.id);if(!own)return res.status(404).json({error:"Access record not found"});const days=0;own.active=true;own.durationDays=days;own.expiresAt=days>0?new Date(Date.now()+days*86400000):null;await own.save();await writeAudit(req,"edit_access","batch_ownership",own._id,{durationDays:days});res.json({success:true,ownership:own})}catch(e){res.status(400).json({error:e.message||"Unable to edit access"})}});
app.post("/api/admin/access/:id/remove", requireAdmin, async(req,res)=>{try{const own=await BatchOwnership.findByIdAndUpdate(req.params.id,{$set:{active:false}},{new:true});if(!own)return res.status(404).json({error:"Access record not found"});await writeAudit(req,"remove_access","batch_ownership",own._id);res.json({success:true,ownership:own})}catch(e){res.status(500).json({error:"Unable to remove access"})}});
app.post("/api/admin/access/:id/restore", requireAdmin, async(req,res)=>{try{const own=await BatchOwnership.findById(req.params.id);if(!own)return res.status(404).json({error:"Access record not found"});const days=0;own.active=true;own.durationDays=days;own.expiresAt=days>0?new Date(Date.now()+days*86400000):null;await own.save();await writeAudit(req,"restore_access","batch_ownership",own._id,{durationDays:days});res.json({success:true,ownership:own})}catch(e){res.status(400).json({error:e.message||"Unable to restore access"})}});
app.get("/api/admin/students", requireAdmin, async(req,res)=>{try{const q=String(req.query.q||"").trim();const users=await User.find(q?{$or:[{name:{$regex:q,$options:"i"}},{email:{$regex:q,$options:"i"}}]}:{}).select("name email active createdAt updatedAt").sort({createdAt:-1}).limit(500).lean();const emails=users.map(u=>u.email);const owners=await BatchOwnership.find({ownerEmail:{$in:emails}}).populate("appId","name").lean();res.json(users.map(u=>({...u,batches:owners.filter(o=>o.ownerEmail===u.email).map(o=>({id:o._id,name:o.appId?.name,active:o.active,expiresAt:o.expiresAt,durationDays:o.durationDays||0}))})));}catch(e){res.status(500).json({error:"Unable to load students"})}});
app.put("/api/admin/students/:id", requireAdmin, async(req,res)=>{try{const u=await User.findById(req.params.id);if(!u)return res.status(404).json({error:"Student not found"});if(req.body.name!==undefined)u.name=String(req.body.name).trim().slice(0,80);if(req.body.email!==undefined){const email=normalizeEmail(req.body.email);if(!email)return res.status(400).json({error:"Valid email required"});const exists=await User.findOne({email,_id:{$ne:u._id}});if(exists)return res.status(409).json({error:"Email already in use"});const oldEmail=u.email;u.email=email;await BatchOwnership.updateMany({ownerEmail:oldEmail},{$set:{ownerEmail:email}});await Order.updateMany({customerEmail:oldEmail},{$set:{customerEmail:email}});}if(req.body.active!==undefined)u.active=!!req.body.active;await u.save();await writeAudit(req,"edit_student","student",u._id,{name:u.name,email:u.email,active:u.active});res.json({success:true,student:{id:u._id,name:u.name,email:u.email,active:u.active}})}catch(e){res.status(400).json({error:e.message||"Unable to edit student"})}});
app.delete("/api/admin/students/:id", requireAdmin, async(req,res)=>{try{const u=await User.findById(req.params.id);if(!u)return res.status(404).json({error:"Student not found"});await BatchOwnership.updateMany({ownerEmail:u.email},{$set:{active:false}});u.active=false;await u.save();await writeAudit(req,"remove_student","student",u._id,{email:u.email});res.json({success:true})}catch(e){res.status(500).json({error:"Unable to remove student"})}});

// ============================================================
// ADVANCED ADMIN ANALYTICS / REPORTS
// ============================================================
app.get("/api/admin/advanced-analytics", requireAdmin, async (req, res) => {
  try {
    const now = new Date();
    const dayStart = new Date(now); dayStart.setHours(0,0,0,0);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const liveSince = new Date(Date.now() - 45 * 1000);
    const [users, activeUsers, totalOrders, paidOrders, todayPaid, monthPaid, liveVisitors, popular, gateways, registrations] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ updatedAt: { $gte: new Date(Date.now()-15*60*1000) } }),
      Order.countDocuments(),
      Order.countDocuments({status:"paid"}),
      Order.find({status:"paid", createdAt:{$gte:dayStart}}).lean(),
      Order.find({status:"paid", createdAt:{$gte:monthStart}}).lean(),
      Visitor.countDocuments({lastSeen:{$gte:liveSince}}),
      Order.aggregate([{ $match:{status:"paid"} },{ $group:{_id:"$appName", sales:{$sum:1}, revenue:{$sum:"$amount"}}},{ $sort:{sales:-1}},{ $limit:10}]),
      Order.aggregate([{ $match:{status:"paid"} },{ $group:{_id:"$paymentGateway", sales:{$sum:1}, revenue:{$sum:"$amount"}}},{ $sort:{revenue:-1}}]),
      User.countDocuments({createdAt:{$gte:dayStart}})
    ]);
    const sum = a => a.reduce((n,x)=>n+Number(x.amount||0),0);
    res.json({ totalStudents:users, activeUsers, totalOrders, paidOrders, liveUsers:liveVisitors, newRegistrations:registrations, todaySales:todayPaid.length, todayRevenue:sum(todayPaid), monthlyRevenue:sum(monthPaid), totalRevenue:sum(await Order.find({status:"paid"}).select("amount").lean()), popularBatches:popular, gatewayStats:gateways });
  } catch (e) { res.status(500).json({error:"Unable to load advanced analytics"}); }
});

app.get("/api/admin/gateway-report", requireAdmin, async (req,res)=>{
  try {
    const rows=await Order.aggregate([{ $group:{ _id:{gateway:"$paymentGateway",status:"$status"}, count:{$sum:1}, amount:{$sum:"$amount"}}},{ $sort:{"_id.gateway":1}}]);
    const refunds=await Order.aggregate([{ $match:{refundStatus:{$in:["requested","refunded"]}}},{ $group:{_id:"$refundStatus",count:{$sum:1},amount:{$sum:"$refundAmount"}}}]);
    res.json({rows, refunds});
  } catch(e){res.status(500).json({error:"Unable to load gateway report"});}
});

app.get("/api/admin/audit-logs", requireAdmin, async (req,res)=>{ try { res.json(await AuditLog.find().sort({createdAt:-1}).limit(500).lean()); } catch(e){res.status(500).json({error:"Unable to load activity logs"});} });

app.get("/api/admin/backup", requireAdmin, async (req,res)=>{
  try {
    const [apps,orders,users,owners,coupons,lessons,notifications]=await Promise.all([AppModel.find().lean(),Order.find().lean(),User.find().select("-passwordHash").lean(),BatchOwnership.find().lean(),Coupon.find().lean(),CourseLesson.find().lean(),Notification.find().lean()]);
    res.setHeader("Content-Disposition",`attachment; filename=study-premium-backup-${new Date().toISOString().slice(0,10)}.json`); res.json({exportedAt:new Date(),apps,orders,users,owners,coupons,lessons,notifications});
  } catch(e){res.status(500).json({error:"Backup failed"});}
});

// ============================================================
// ADMIN CUSTOMERS
// ============================================================

app.get(
  "/api/admin/customers",
  requireAdmin,
  async (req, res) => {
    try {
      const customers =
        await Order.find()
          .select(
            "appName amount status customerName customerEmail customerPhone paymentGateway razorpayPaymentId razorpayOrderId cashfreePaymentId cashfreeOrderId createdAt"
          )
          .sort({
            createdAt:
              -1
          })
          .limit(500)
          .lean();

      res.json(
        customers
      );
    } catch {
      res.status(500).json({
        error:
          "Unable to load customers"
      });
    }
  }
);

// ============================================================
// ADMIN WEBSITE SETTINGS
// ============================================================

app.get(
  "/api/admin/settings",
  requireAdmin,
  async (req, res) => {
    try {
      const settings =
        await Settings.findOne({
          key:
            "main"
        }).lean();

      res.json(
        settings || {
          key:
            "main",

          title:
            "STUDY PREMIUM COURSE ",

          tagline:
            "LEARN • PREPARE • SUCCEED"
        }
      );
    } catch {
      res.status(500).json({
        error:
          "Unable to load website settings."
      });
    }
  }
);

app.put(
  "/api/admin/settings",
  requireAdmin,
  async (req, res) => {
    try {
      const title =
        String(
          req.body.title ||
          "STUDY PREMIUM COURSE "
        )
          .trim()
          .slice(
            0,
            100
          );

      const tagline =
        String(
          req.body.tagline ||
          "LEARN • PREPARE • SUCCEED"
        )
          .trim()
          .slice(
            0,
            180
          );

      const maintenanceMode = req.body.maintenanceMode === undefined ? undefined : Boolean(req.body.maintenanceMode);
      const maintenanceAllowUsers = req.body.maintenanceAllowUsers === undefined ? undefined : Boolean(req.body.maintenanceAllowUsers);
      const maintenanceMessage = req.body.maintenanceMessage === undefined ? undefined : String(req.body.maintenanceMessage || "").trim().slice(0,300);

      const settings =
        await Settings.findOneAndUpdate(
          {
            key:
              "main"
          },

          {
            key:
              "main",

            title,

            tagline, ...(maintenanceMode === undefined ? {} : {maintenanceMode}), ...(maintenanceAllowUsers === undefined ? {} : {maintenanceAllowUsers}), ...(maintenanceMessage === undefined ? {} : {maintenanceMessage})
          },

          {
            upsert:
              true,

            new:
              true,

            runValidators:
              true
          }
        ).lean();

      res.json(
        settings
      );
    } catch (error) {
      res.status(400).json({
        error:
          error.message ||
          "Could not save website settings."
      });
    }
  }
);

// ============================================================
// UPLOAD ERROR HANDLER
// ============================================================

app.use(
  (
    err,
    req,
    res,
    next
  ) => {
    if (
      err instanceof
      multer.MulterError
    ) {
      return res.status(400).json({
        error:
          `Upload error: ${err.message}`
      });
    }

    if (err) {
      console.error(
        err
      );

      return res.status(400).json({
        error:
          err.message ||
          "Request failed"
      });
    }

    next();
  }
);

// ============================================================
// STATIC ASSETS
// Served by Cloudflare Workers Static Assets (wrangler.jsonc).
// ============================================================

// ============================================================
// INITIALIZATION
// ============================================================

async function ensureSettings() {
  await Settings.findOneAndUpdate(
    {
      key:
        "main"
    },

    {
      $setOnInsert: {
        key:
          "main",

        title:
          "STUDY PREMIUM COURSE",

        tagline:
          "LEARN • PREPARE • SUCCEED"
      }
    },

    {
      upsert:
        true
    }
  );
}

async function ensureAdmin() {
  const username =
    process.env.ADMIN_USERNAME;

  const password =
    process.env.ADMIN_PASSWORD;

  const secretKey =
    process.env.ADMIN_SECRET_KEY;

  if (
    !username ||
    !password ||
    !secretKey
  ) {
    console.warn(
      "WARNING: Admin environment variables are missing."
    );

    return;
  }

  const passwordHash =
    await bcrypt.hash(
      password,
      12
    );

  const secretHash =
    await bcrypt.hash(
      secretKey,
      12
    );

  await Admin.findOneAndUpdate(
    {
      username
    },

    {
      username,

      passwordHash,

      secretHash
    },

    {
      upsert:
        true,

      new:
        true
    }
  );

  console.log(
    `Admin account ready: ${username}`
  );
}

// ============================================================
// DEMO DATA
// ============================================================

async function ensureDemoApps() {
  if (
    await AppModel.countDocuments() >
    0
  ) {
    return;
  }

  await AppModel.insertMany([
    {
      name:
        "Study IQ",

      developer:
        "LALIT",

      category:
        "Education",

      description:
        "Competitive exam preparation, classes and study material.",

      logo:
        "https://placehold.co/256x256/111827/facc15?text=STUDY+IQ",

      screenshots: [
        "https://placehold.co/600x1000/0b0b0d/facc15?text=Course+Screen",

        "https://placehold.co/600x1000/0b0b0d/facc15?text=Course+Details",

        "https://placehold.co/600x1000/0b0b0d/facc15?text=Video+Player"
      ],

      banner:
        "https://placehold.co/1400x500/07111a/facc15?text=STUDY+IQ",

      price:
        0,

      websiteUrl:
        "https://example.com",

      downloadUrl:
        "https://example.com",

      accessType:
        "free",

      validity:
        "Lifetime",

      rating:
        4.8,

      downloads:
        23000,

      featured:
        true,

      trending:
        true,

      published:
        true
    },

    {
      name:
        "UP PCS Prelims 2026 - Pratigya Crash Course",

      developer:
        "Rojgar With Ankit",

      category:
        "UPSC/UPPCS",

      description:
        "Demo paid course listing for STUDY PREMIUM COURSE.",

      logo:
        "https://placehold.co/256x256/111827/facc15?text=UPPCS",

      screenshots: [
        "https://placehold.co/600x1000/0b0b0d/facc15?text=Batch+Screen"
      ],

      banner:
        "https://placehold.co/1400x700/08121d/facc15?text=UPPCS+2026",

      price:
        799,

      websiteUrl:
        "https://example.com",

      downloadUrl:
        "https://example.com",

      accessType:
        "paid",

      validity:
        "Lifetime",

      rating:
        4.9,

      downloads:
        0,

      featured:
        true,

      trending:
        true,

      published:
        true
    }
  ]);

  console.log(
    "Demo apps created."
  );
}

async function ensurePurchasePlans(){
  // Legacy purchasePlans are intentionally ignored. All paid purchases are Lifetime at the batch price.
  return;
}

// ============================================================
// CLOUDFLARE WORKERS STARTUP
// ============================================================
// Workers cannot rely on a persistent local filesystem/process lifecycle.
// The HTTP server is registered immediately; MongoDB initializes lazily on
// the first API request and the connection promise is reused by the isolate.

let databaseReadyPromise = null;
let lastOwnershipExpiryCheck = 0;

async function ensureDatabaseReady() {
  if (mongoose.connection.readyState === 1) {
    // Replace the old process-level interval with a lightweight,
    // request-triggered check that is safe in Cloudflare Workers.
    if (Date.now() - lastOwnershipExpiryCheck >= 60 * 1000) {
      lastOwnershipExpiryCheck = Date.now();
      try {
        await expireBatchOwnerships();
      } catch (error) {
        console.error("AUTO EXPIRE BATCH OWNERSHIPS ERROR:", error);
      }
    }
    return;
  }
  if (databaseReadyPromise) return databaseReadyPromise;

  databaseReadyPromise = (async () => {
    if (!process.env.MONGODB_URI) {
      throw new Error("MONGODB_URI is missing");
    }

    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000
    });

    await ensureAdmin();
    await ensureSettings();
    await ensureDemoApps();
    await ensurePurchasePlans();
    lastOwnershipExpiryCheck = Date.now();
    try {
      await expireBatchOwnerships();
    } catch (error) {
      console.error("AUTO EXPIRE BATCH OWNERSHIPS ERROR:", error);
    }
  })().catch((error) => {
    databaseReadyPromise = null;
    throw error;
  });

  return databaseReadyPromise;
}

// Inserted late in the middleware chain would miss routes, therefore this
// readiness gate is exposed and called by the Worker wrapper before handing
// API requests to Express.
app.listen(PORT);

module.exports = {
  app,
  PORT,
  ensureDatabaseReady
};
