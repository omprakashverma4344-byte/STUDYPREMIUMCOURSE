
/* =========================================================
   LIVE USER + VISITOR COUNTER
   Runs on every page that loads app.js.
========================================================= */
(function startLiveAnalytics() {
  const KEY = "spc_visitor_id";
  let visitorId = localStorage.getItem(KEY);
  if (!visitorId) {
    visitorId = (crypto.randomUUID ? crypto.randomUUID() : "v-" + Date.now() + "-" + Math.random().toString(36).slice(2));
    localStorage.setItem(KEY, visitorId);
  }

  async function heartbeat() {
    try {
      const r = await fetch("/api/analytics/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visitorId, page: location.pathname })
      });
      const data = await r.json();
      if (r.ok) renderLiveCounter(data);
    } catch {}
  }

  function renderLiveCounter(data) {
    let el = document.getElementById("liveVisitorCounter");
    if (!el) {
      el = document.createElement("div");
      el.id = "liveVisitorCounter";
      el.className = "live-visitor-counter";
      document.body.appendChild(el);
    }
    el.innerHTML = `<span class="live-dot"></span><b>${Number(data.liveUsers || 0)}</b> Live <span class="live-sep">•</span> <b>${Number(data.totalVisitors || 0).toLocaleString("en-IN")}</b> Visitors`;
    el.title = `Today: ${Number(data.todayVisitors || 0).toLocaleString("en-IN")} visitors`;
  }

  heartbeat();
  setInterval(heartbeat, 15000);
  window.addEventListener("beforeunload", () => {
    // The server expires a visitor automatically after 45 seconds.
  });
})();

let selectedCategory = "All";
let currentApp = null;
let accessType = null;

function esc(value = "") {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]));
}

function money(value) {
  const amount = Number(value || 0);
  return amount > 0
    ? `₹${amount.toLocaleString("en-IN")}`
    : "Free";
}

function toast(message) {
  const old = document.getElementById("toast");

  if (!old) {
    alert(message);
    return;
  }

  old.textContent = message;
  old.classList.add("show");

  clearTimeout(window.toastTimer);

  window.toastTimer = setTimeout(() => {
    old.classList.remove("show");
  }, 2800);
}


/* =========================================================
   HOME — LOAD APPS
========================================================= */

async function loadApps() {

  const list = document.getElementById("appList");

  if (!list) return;

  const search =
    document.getElementById("search")?.value?.trim() || "";

  const params = new URLSearchParams();

  if (search) {
    params.set("search", search);
  }

  if (selectedCategory !== "All") {
    params.set("category", selectedCategory);
  }

  list.innerHTML =
    `<div class="loading">Loading...</div>`;

  try {

    const response =
      await fetch(`/api/apps?${params.toString()}`);

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.error || "Unable to load apps"
      );
    }

    const apps = Array.isArray(data)
      ? data
      : [];

    const count =
      document.getElementById("count");

    if (count) {
      count.textContent =
        `${apps.length} apps`;
    }

    renderCategories(apps);

    if (!apps.length) {

      list.innerHTML =
        `<div class="loading">
          No apps or courses found.
        </div>`;

      return;
    }

    list.innerHTML = apps.map(app => {

      const price =
        Number(app.price || 0);

      const buttonText =
        price > 0
          ? money(price)
          : "GET";

      return `
        <article class="app-row">

          <button class="favorite-btn" title="Favorite" onclick="event.stopPropagation();toggleFavorite('${esc(app._id)}', this)">${isFavorite(app._id) ? "★" : "☆"}</button>

          <img
            class="app-logo"
            src="${esc(app.logo || "")}"
            alt="${esc(app.name)}"
            loading="lazy"
            onerror="this.style.opacity='.25'"
          >

          <div class="app-info">

            <h3>
              ${esc(app.name)}
            </h3>

            <p>
              ${esc(app.developer || "STUDY PREMIUM COURSE")}
              •
              ${esc(app.category || "Education")}
            </p>

            <p>
              <span class="rating">
                ★ ${Number(app.rating || 0).toFixed(1)}
              </span>

              &nbsp;

              ${Number(app.downloads || 0).toLocaleString("en-IN")}+
            </p>

          </div>

          <div>

            <button
              class="get-btn"
              onclick="openApp('${esc(app._id)}')"
            >
              ${buttonText}
            </button>

            <div class="free">
              ${price > 0 ? "Paid" : "Free"}
            </div>

          </div>

        </article>
      `;

    }).join("");

  } catch (error) {

    console.error(error);

    list.innerHTML =
      `<div class="loading">
        Could not load apps.
      </div>`;
  }
}


/* =========================================================
   OPEN APP DETAILS
========================================================= */

function openApp(id) {

  if (!id) {
    toast("Invalid app.");
    return;
  }

  location.href =
    `/app.html?id=${encodeURIComponent(id)}`;
}


/* =========================================================
   CATEGORY FILTER
========================================================= */

function renderCategories(apps) {

  const container =
    document.getElementById("categories");

  if (!container) return;

  /*
    Category list current result se banayi ja rahi hai.
    All hamesha first rahega.
  */

  const categories = [
    "All",
    ...new Set(
      apps
        .map(app => app.category)
        .filter(Boolean)
    )
  ];

  container.innerHTML =
    categories.map(category => {

      const active =
        category === selectedCategory
          ? "active"
          : "";

      return `
        <button
          class="chip ${active}"
          onclick="selectCategory(${JSON.stringify(category)})"
        >
          ${esc(category)}
        </button>
      `;

    }).join("");
}


function selectCategory(category) {

  selectedCategory = category;

  loadApps();
}


/* =========================================================
   APP DETAIL
========================================================= */

async function loadDetail() {

  const root =
    document.getElementById("detail");

  if (!root) return;

  const id =
    new URLSearchParams(
      window.location.search
    ).get("id");

  if (!id) {

    root.innerHTML =
      `<div class="loading">
        Invalid app.
      </div>`;

    return;
  }

  root.innerHTML =
    `<div class="loading">
      Loading app...
    </div>`;

  try {

    const response =
      await fetch(
        `/api/apps/${encodeURIComponent(id)}`
      );

    const data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        data.error || "App not found"
      );
    }

    currentApp = data;

    renderDetail(data);

  } catch (error) {

    console.error(error);

    root.innerHTML =
      `<div class="loading">
        ${esc(error.message)}
      </div>`;
  }
}


/* =========================================================
   RENDER DETAIL PAGE
========================================================= */

function renderDetail(app) {

  const root =
    document.getElementById("detail");

  if (!root) return;

  const price =
    Number(app.price || 0);

  const rating =
    Number(app.rating || 0);

  const downloads =
    Number(app.downloads || 0);

  const screenshots =
    Array.isArray(app.screenshots)
      ? app.screenshots
      : [];

  const banner =
    app.banner
      ? `
        <img
          class="banner"
          src="${esc(app.banner)}"
          alt="${esc(app.name)}"
          loading="lazy"
        >
      `
      : "";

  const screenshotsHtml =
    screenshots.length
      ? screenshots.map(image => `
          <img
            src="${esc(image)}"
            alt="Screenshot"
            loading="lazy"
          >
        `).join("")
      : `
          <p style="color:#666">
            No screenshots added yet.
          </p>
        `;

  root.innerHTML = `

    ${banner}

    <section class="detail-top">

      <img
        class="detail-logo"
        src="${esc(app.logo || "")}"
        alt="${esc(app.name)}"
        onerror="this.style.opacity='.25'"
      >

      <div>

        <h1>
          ${esc(app.name)}
        </h1>

        <div class="meta">
          ${esc(app.developer || "STUDY PREMIUM COURSE")}
        </div>

        <div class="badges">

          <span class="badge">
            ${esc(app.category || "Education")}
          </span>

          <span class="badge">
            ${esc(app.validity || "Lifetime")}
          </span>

          <span class="badge rating">
            ★ ${rating.toFixed(1)}
          </span>

          ${price > 0
      ? `<span class="badge">Paid</span>`
      : `<span class="badge">Free</span>`
    }

        </div>

      </div>

    </section>


    <div class="action-stack">

      <button
        class="primary"
        onclick="handleAccess('app')"
      >
        ${price > 0
      ? `GET APP — ${money(price)}`
      : "GET APP — Free"
    }
      </button>


      <button
        class="secondary"
        onclick="handleAccess('website')"
      >
        🌐 Visit Website
      </button>

      ${price > 0 ? `
      <button
        class="secondary"
        onclick="openAlreadyPurchased()"
      >
        🔐 Already Purchased? Open Batch
      </button>` : ""}

    </div>


    <section class="detail-stats">

      <div class="stat">

        <small>RATING</small>

        <b>
          ${rating.toFixed(1)}
        </b>

        <small>
          ★★★★★
        </small>

      </div>


      <div class="stat">

        <small>VALIDITY</small>

        <b>
          ${esc(app.validity || "Lifetime")}
        </b>

        <small>
          Access
        </small>

      </div>


      <div class="stat">

        <small>PRICE</small>

        <b>
          ${money(price)}
        </b>

        <small>
          ${price > 0 ? "Paid" : "Free"}
        </small>

      </div>


      <div class="stat">

        <small>DOWNLOADS</small>

        <b>
          ${downloads.toLocaleString("en-IN")}+
        </b>

        <small>
          Installs
        </small>

      </div>

    </section>


    <h2>
      📸 Screenshots
    </h2>

    <div class="screens">
      ${screenshotsHtml}
    </div>


    <div class="about">

      <h2>
        About This App
      </h2>

      <p>
        ${esc(
      app.description ||
      "No description added yet."
    )}
      </p>

    </div>
  `;
}


/* =========================================================
   ALREADY PURCHASED / RESTORE ACCESS
========================================================= */

function openAlreadyPurchased() {
  if (!currentApp) {
    toast("Batch information is unavailable.");
    return;
  }
  const modal = document.getElementById("alreadyPurchasedModal");
  if (!modal) {
    toast("Restore access form is unavailable.");
    return;
  }
  const email = document.getElementById("restoreEmail");
  const phone = document.getElementById("restorePhone");
  if (email && !email.value) email.value = localStorage.getItem("spc_restore_email") || "";
  if (phone && !phone.value) phone.value = localStorage.getItem("spc_restore_phone") || "";
  modal.classList.remove("hidden");
}

function closeAlreadyPurchased() {
  document.getElementById("alreadyPurchasedModal")?.classList.add("hidden");
}

async function restorePurchasedAccess() {
  if (!currentApp) return;
  const email = document.getElementById("restoreEmail")?.value.trim() || "";
  const phone = document.getElementById("restorePhone")?.value.trim() || "";
  if (!email || !phone) {
    toast("Enter the same email and mobile number used during payment.");
    return;
  }
  const button = document.getElementById("restoreAccessButton");
  if (button) { button.disabled = true; button.textContent = "Checking purchase..."; }
  try {
    const r = await fetch("/api/purchases/already-owned", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: currentApp._id, email, phone })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.success) throw new Error(data.error || "Approved purchase not found.");
    localStorage.setItem("spc_restore_email", email);
    localStorage.setItem("spc_restore_phone", phone);
    closeAlreadyPurchased();
    toast("✅ Purchase verified. Opening your batch...");
    setTimeout(() => { window.location.href = data.url; }, 500);
  } catch (e) {
    toast(e.message || "Could not open purchased batch.");
  } finally {
    if (button) { button.disabled = false; button.textContent = "🔓 Open My Batch"; }
  }
}

/* =========================================================
   ACCESS CONTROL
========================================================= */

function handleAccess(type) {

  if (!currentApp) {
    toast("App information is not available.");
    return;
  }

  accessType = type;

  const price =
    Number(currentApp.price || 0);

  /*
    FREE
    ↓
    Direct destination
  */

  if (
    currentApp.accessType !== "paid" ||
    price <= 0
  ) {

    openDestination(type);

    return;
  }

  /*
    PAID
    ↓
    Payment modal
  */

  const payText =
    document.getElementById("payText");

  if (payText) {

    payText.textContent =
      `Pay ${money(price)} for ${currentApp.name} (${currentApp.validity || "Lifetime"}).`;
  }

  const modal =
    document.getElementById("payModal");

  if (modal) {
    modal.classList.remove("hidden");
  }
}


/* =========================================================
   CLOSE PAYMENT
========================================================= */

function getSelectedPurchasePlan(){
  return {planId:"lifetime",durationDays:0,label:"Lifetime",price:Number(currentApp?.price||0)};
}


function closePay() {

  const modal =
    document.getElementById("payModal");

  if (modal) {
    modal.classList.add("hidden");
  }

  accessType = null;
}


/* =========================================================
   PAYMENT
========================================================= */

async function startPayment() {

  if (!currentApp) {
    toast("App information is missing.");
    return;
  }

  const name =
    document
      .getElementById("buyerName")
      ?.value
      ?.trim();

  const email =
    document
      .getElementById("buyerEmail")
      ?.value
      ?.trim();

  const phone =
    document
      .getElementById("buyerPhone")
      ?.value
      ?.trim();

  if (!name) {

    toast("Please enter your name.");

    return;
  }

  if (!email) {

    toast("Please enter your email.");

    return;
  }

  /*
    Basic email validation
  */

  const emailPattern =
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!emailPattern.test(email)) {

    toast("Please enter a valid email.");

    return;
  }


  const selectedGateway =
    document.getElementById("paymentGateway")?.value || "cashfree";

  if (selectedGateway === "cashfree") {
    await startCashfreePayment({ name, email, phone });
    return;
  }

  if (selectedGateway === "upi_qr") {
    await startUpiQrPayment({ name, email, phone });
    return;
  }

  const payButton =
    document.getElementById("payButton");

  if (payButton) {

    payButton.disabled = true;
    payButton.textContent =
      "Creating payment...";
  }


  try {

    /*
      STEP 1
      Create Razorpay order on SERVER
    */

    const response =
      await fetch(
        "/api/payments/order",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body: JSON.stringify({

            appId: currentApp._id,
            ...getSelectedPurchasePlan(),

            customerName: name,

            customerEmail: email,

            customerPhone: phone

          })
        }
      );


    const order =
      await response.json();


    if (!response.ok) {

      throw new Error(
        order.error ||
        "Payment order could not be created."
      );
    }


    /*
      Razorpay library check
    */

    if (
      typeof Razorpay === "undefined"
    ) {

      throw new Error(
        "Razorpay checkout could not load."
      );
    }


    /*
      STEP 2
      Open Razorpay Checkout
    */

    const options = {

      key: order.keyId,

      amount: order.amount,

      currency: order.currency || "INR",

      name: "STUDY PREMIUM COURSE",

      description:
        currentApp.name,

      order_id:
        order.orderId,

      prefill: {

        name: name,

        email: email,

        contact: phone

      },

      notes: {

        appId:
          String(currentApp._id),

        accessType:
          String(accessType || "")

      },

      theme: {
        color: "#ffc400"
      },


      /*
        IMPORTANT:
        Razorpay successful payment
        is NOT trusted directly.

        Server verification happens below.
      */

      handler: async function (payment) {

        await verifyPayment(payment);

      }

    };


    const razorpayCheckout =
      new Razorpay(options);


    razorpayCheckout.on(
      "payment.failed",
      async function (response) {

        console.error(
          "Razorpay payment.failed:",
          response
        );

        const paymentId =
          response?.error?.metadata?.payment_id;

        const orderId =
          response?.error?.metadata?.order_id ||
          order.orderId;

        // A debit can sometimes be reconciled after Checkout reports a
        // failure. Ask the server for the real Razorpay status before
        // telling the customer to pay again.
        if (paymentId && orderId) {
          toast("Payment status is being checked...");

          try {
            for (let attempt = 0; attempt < 5; attempt++) {
              const check = await fetch(
                "/api/payments/check-status",
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ orderId, paymentId })
                }
              );

              const result = await check.json();

              if (result.success && result.status === "paid") {
                toast("Payment confirmed. Creating secure access...");
                const accessResponse = await fetch("/api/access/create", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    orderId: result.orderId,
                    type: accessType
                  })
                });

                const accessResult = await accessResponse.json();

                if (!accessResponse.ok || !accessResult.success) {
                  throw new Error(accessResult.error || "Could not create secure access.");
                }

                closePay();
                toast("Payment verified. Opening access...");
                setTimeout(() => {
                  window.location.href = accessResult.url;
                }, 700);
                return;
              }

              if (result.status === "failed") {
                break;
              }

              await new Promise(resolve => setTimeout(resolve, 2500));
            }
          } catch (error) {
            console.error("Payment status polling error:", error);
          }
        }

        toast(
          "Payment could not be confirmed yet. If money was debited, please wait for the transaction status to update before trying again."
        );

        resetPayButton();
      }
    );


    razorpayCheckout.open();


  } catch (error) {

    console.error(error);

    toast(
      error.message ||
      "Payment setup failed."
    );

    resetPayButton();
  }
}



/* =========================================================
   UPI QR PAYMENT
========================================================= */

let activeQrOrderId = "";

async function startUpiQrPayment({ name, email, phone }) {
  const payButton = document.getElementById("payButton");
  if (!phone) {
    toast("Please enter your mobile number.");
    return;
  }

  if (payButton) {
    payButton.disabled = true;
    payButton.textContent = "Preparing QR...";
  }

  try {
    const response = await fetch("/api/payments/upi-qr/order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appId: currentApp._id,
        ...getSelectedPurchasePlan(),
        customerName: name,
        customerEmail: email,
        customerPhone: phone
      })
    });

    const order = await response.json();
    if (!response.ok || !order.success) {
      throw new Error(order.error || "Could not start QR payment.");
    }

    activeQrOrderId = order.orderId;
    const qrImage = document.getElementById("upiQrImage");
    if (qrImage) qrImage.src = order.qrUrl || "/qr-payment.jpeg";

    const text = document.getElementById("qrPayText");
    if (text) {
      text.textContent = `Pay exactly ₹${Number(order.amount || 0).toLocaleString("en-IN")} via the QR, then enter your UPI transaction/reference ID.`;
    }

    const ref = document.getElementById("upiReference");
    if (ref) ref.value = "";

    document.getElementById("payModal")?.classList.add("hidden");
    document.getElementById("qrPayModal")?.classList.remove("hidden");
    resetPayButton();
  } catch (error) {
    console.error("UPI QR payment error:", error);
    toast(error.message || "QR payment setup failed.");
    resetPayButton();
  }
}

function closeQrPayment() {
  document.getElementById("qrPayModal")?.classList.add("hidden");
  activeQrOrderId = "";
}

async function submitUpiQrPayment() {
  const button = document.getElementById("upiSubmitButton");
  const reference = document.getElementById("upiReference")?.value?.trim() || "";

  if (!activeQrOrderId) {
    toast("QR payment session is missing. Please start again.");
    return;
  }

  if (!/^[A-Za-z0-9._-]{6,64}$/.test(reference)) {
    toast("Please enter a valid UPI transaction/reference ID.");
    return;
  }

  if (button) {
    button.disabled = true;
    button.textContent = "Submitting...";
  }

  try {
    const response = await fetch("/api/payments/upi-qr/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId: activeQrOrderId, reference })
    });
    const result = await response.json();
    if (!response.ok || !result.success) {
      throw new Error(result.error || "Could not submit payment reference.");
    }

    document.getElementById("qrPayText").textContent =
      "Reference submitted. Access will unlock automatically only after the admin verifies the real transaction in the UPI/bank account.";
    if (button) button.textContent = "Verification Pending";
    toast("Payment reference submitted. Please wait for verification.");
  } catch (error) {
    console.error("UPI QR submit error:", error);
    toast(error.message || "Could not submit payment reference.");
    if (button) {
      button.disabled = false;
      button.textContent = "I Have Paid — Submit Reference";
    }
  }
}

/* =========================================================
   CASHFREE PAYMENT
========================================================= */

async function startCashfreePayment({ name, email, phone }) {
  const payButton = document.getElementById("payButton");

  if (!phone) {
    toast("Please enter your mobile number for Cashfree payment.");
    return;
  }

  if (payButton) {
    payButton.disabled = true;
    payButton.textContent = "Creating Cashfree payment...";
  }

  try {
    if (typeof Cashfree === "undefined") {
      throw new Error("Cashfree checkout could not load.");
    }

    const response = await fetch("/api/payments/cashfree/order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appId: currentApp._id,
        ...getSelectedPurchasePlan(),
        customerName: name,
        customerEmail: email,
        customerPhone: phone
      })
    });

    const order = await response.json();
    if (!response.ok || !order.success || !order.paymentSessionId) {
      throw new Error(order.error || "Cashfree order could not be created.");
    }

    const cashfree = Cashfree({
      mode: order.mode === "sandbox" ? "sandbox" : "production"
    });

    toast("Opening Cashfree secure checkout...");

    const result = await cashfree.checkout({
      paymentSessionId: order.paymentSessionId,
      redirectTarget: "_modal"
    });

    if (result?.error) {
      throw new Error(result.error.message || "Cashfree checkout failed.");
    }

    toast("Checking Cashfree payment status...");

    // Payment status can take a few seconds to reconcile. Poll Cashfree
    // through our backend and trust only the server-side PAID status.
    for (let attempt = 0; attempt < 8; attempt++) {
      const verifyResponse = await fetch("/api/payments/cashfree/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: order.orderId })
      });

      const verified = await verifyResponse.json();

      if (verifyResponse.ok && verified.success && verified.pendingApproval) {
        closePay();
        toast("Payment verified. Waiting for admin approval. Access will unlock after approval.");
        resetPayButton();
        return;
      }

      if (["EXPIRED", "TERMINATED"].includes(String(verified.status || "").toUpperCase())) {
        throw new Error("Cashfree payment was not completed.");
      }

      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    throw new Error("Payment is still pending. Please wait and check again before paying another time.");
  } catch (error) {
    console.error("Cashfree payment error:", error);
    toast(error.message || "Cashfree payment failed.");
    resetPayButton();
  }
}

/* =========================================================
   PAYMENT VERIFICATION
========================================================= */

async function verifyPayment(payment) {
  try {
    toast("Verifying payment...");

    const response = await fetch("/api/payments/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        razorpay_order_id: payment.razorpay_order_id,
        razorpay_payment_id: payment.razorpay_payment_id,
        razorpay_signature: payment.razorpay_signature
      })
    });

    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.error || "Payment verification failed.");
    }

    // A fresh one-time token is created only after server-side
    // Razorpay signature verification succeeds.
    closePay();
    toast("Payment verified. Waiting for admin approval. Access will unlock after approval.");
    resetPayButton();

  } catch (error) {
    console.error("Payment verification error:", error);
    toast(error.message || "Payment verification failed.");
    resetPayButton();
  }
}


/* =========================================================
   RESET PAYMENT BUTTON
========================================================= */

function resetPayButton() {

  const button =
    document.getElementById("payButton");

  if (!button) return;

  button.disabled = false;

  button.textContent =
    "Pay & Continue";
}


/* =========================================================
   OPEN DESTINATION
========================================================= */

function openDestination(type, item = currentApp) {
  if (!item) {
    toast("App information unavailable.");
    return;
  }

  // Paid access is handled by /api/access/create after payment verification.
  // Free B2-hosted APKs use a separate public download endpoint.
  if (type === "app" && item.appFileKey) {
    window.location.href =
      `/api/free-download/${encodeURIComponent(item._id)}`;
    return;
  }

  const url =
    type === "website"
      ? item.websiteUrl || ""
      : item.downloadUrl || "";

  if (!url) {
    toast(
      type === "website"
        ? "Website link is not available."
        : "Download link is not available."
    );
    return;
  }

  try {
    const parsed = new URL(url);

    if (
      parsed.protocol !== "http:" &&
      parsed.protocol !== "https:"
    ) {
      throw new Error("Invalid destination.");
    }

    window.location.href = parsed.href;
  } catch (error) {
    console.error(error);
    toast("Invalid destination URL.");
  }
}


/* =========================================================
   SHARE
========================================================= */

async function shareCurrentApp() {

  if (!currentApp) {

    toast(
      "App information unavailable."
    );

    return;
  }

  const url =
    window.location.href;

  try {

    if (
      navigator.share
    ) {

      await navigator.share({

        title:
          currentApp.name,

        text:
          `Check ${currentApp.name} on STUDY PREMIUM COURSE.`,

        url:
          url

      });

    } else {

      await navigator.clipboard.writeText(
        url
      );

      toast(
        "App link copied."
      );
    }

  } catch (error) {

    console.log(
      "Share cancelled."
    );
  }
}


/* =========================================================
   UPCOMING / FAVORITES / DONATE
========================================================= */

function favoriteIds() {
  try { return JSON.parse(localStorage.getItem("spc_favorites") || "[]"); }
  catch { return []; }
}

function isFavorite(id) {
  return favoriteIds().includes(String(id));
}

function toggleFavorite(id, button) {
  const ids = favoriteIds();
  const key = String(id);
  const i = ids.indexOf(key);
  if (i >= 0) ids.splice(i, 1); else ids.push(key);
  localStorage.setItem("spc_favorites", JSON.stringify(ids));
  if (button) button.textContent = i >= 0 ? "☆" : "★";
  toast(i >= 0 ? "Removed from favorites." : "Added to favorites.");
}

async function showSection(section) {
  const home = document.getElementById("homeView");
  const special = document.getElementById("specialView");
  const list = document.getElementById("specialList");
  const title = document.getElementById("specialTitle");
  const count = document.getElementById("specialCount");
  const donate = document.getElementById("donatePanel");
  if (!special || !home) return;

  if (section === "apps") {
    home.classList.remove("hidden-force");
    special.classList.add("hidden-force");
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }

  home.classList.add("hidden-force");
  special.classList.remove("hidden-force");
  donate?.classList.add("hidden-force");

  if (section === "donate") {
    title.textContent = "Donate";
    count.textContent = "Support the project";
    list.innerHTML = "";
    donate?.classList.remove("hidden-force");
    loadDonationLeaderboard();
    return;
  }

  const apps = await fetch("/api/apps").then(r => r.json()).catch(() => []);
  let rows = [];
  if (section === "upcoming") {
    title.textContent = "Upcoming";
    rows = Array.isArray(apps) ? apps.filter(x => x.upcoming) : [];
  } else {
    title.textContent = "Favorites";
    rows = Array.isArray(apps) ? apps.filter(x => isFavorite(x._id)) : [];
  }
  count.textContent = `${rows.length} item${rows.length === 1 ? "" : "s"}`;
  if (!rows.length) {
    list.innerHTML = `<div class="loading">${section === "upcoming" ? "No upcoming batches yet." : "No favorites yet. Tap ☆ on a batch to save it."}</div>`;
    return;
  }
  list.innerHTML = rows.map(renderAppRow).join("");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderAppRow(app) {
  const price = Number(app.price || 0);
  return `
    <article class="app-row">
      <button class="favorite-btn" title="Favorite" onclick="event.stopPropagation();toggleFavorite('${esc(app._id)}', this)">${isFavorite(app._id) ? "★" : "☆"}</button>
      <img class="app-logo" src="${esc(app.logo || "")}" alt="${esc(app.name)}" onerror="this.style.display='none'">
      <div class="app-info">
        <h3>${esc(app.name)}</h3>
        <p>${esc(app.developer || "STUDY PREMIUM COURSE")} • ${esc(app.category || "Education")}</p>
        <p><span class="rating">★ ${Number(app.rating || 0).toFixed(1)}</span> &nbsp; ${Number(app.downloads || 0).toLocaleString("en-IN")}+</p>
      </div>
      <div><button class="get-btn" onclick="openApp('${esc(app._id)}')">${price > 0 ? money(price) : "GET"}</button><div class="free">${price > 0 ? "Paid" : "Free"}</div></div>
    </article>`;
}

async function loadDonationLeaderboard() {
  const el = document.getElementById("donationLeaderboard");
  if (!el) return;
  try {
    const r = await fetch("/api/donations/leaderboard");
    const rows = await r.json();
    if (!r.ok) throw new Error(rows.error || "Unable to load leaderboard");
    if (!rows.length) { el.innerHTML = `<div class="loading">No donations yet. Be the first supporter!</div>`; return; }
    el.innerHTML = rows.map(x => `
      <div class="leader-row ${x.rank <= 3 ? "leader-top" : ""}">
        <div class="leader-rank">${x.rank <= 3 ? ["🥇","🥈","🥉"][x.rank-1] : "#" + x.rank}</div>
        <div class="leader-name">${esc(x.name)}</div>
        <strong>₹${Number(x.amount || 0).toLocaleString("en-IN")}</strong>
      </div>`).join("");
  } catch (e) { el.innerHTML = `<div class="loading">${esc(e.message)}</div>`; }
}

async function startDonationPayment() {
  const donorName = document.getElementById("donorName")?.value.trim();
  const donorEmail = document.getElementById("donorEmail")?.value.trim();
  const amount = Number(document.getElementById("donorAmount")?.value || 0);
  if (!donorName || !donorEmail || amount < 1) { toast("Enter your name, email and donation amount."); return; }
  if (typeof Razorpay === "undefined") { toast("Payment gateway could not load."); return; }
  try {
    const r = await fetch("/api/donations/payment/order", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ donorName, donorEmail, amount }) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Could not start payment.");
    const options = {
      key: data.keyId,
      amount: data.amount,
      currency: data.currency,
      name: "STUDY PREMIUM COURSE",
      description: "Support / Donation",
      order_id: data.orderId,
      prefill: { name: donorName, email: donorEmail },
      theme: { color: "#111111" },
      handler: async function (response) {
        try {
          const vr = await fetch("/api/donations/payment/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(response) });
          const vd = await vr.json();
          if (!vr.ok) throw new Error(vd.error || "Payment verification failed.");
          toast("❤️ Donation received. Thank you!");
          document.getElementById("donorAmount").value = "";
          await loadDonationLeaderboard();
        } catch (e) { toast(e.message); }
      },
      modal: { ondismiss: function () { toast("Donation payment cancelled."); } }
    };
    new Razorpay(options).open();
  } catch (e) { toast(e.message); }
}

async function startCashfreeDonationPayment() {
  const donorName = document.getElementById("donorName")?.value.trim();
  const donorEmail = document.getElementById("donorEmail")?.value.trim();
  const amount = Number(document.getElementById("donorAmount")?.value || 0);

  if (!donorName || !donorEmail || amount < 1) {
    toast("Enter your name, email and donation amount.");
    return;
  }

  if (typeof Cashfree === "undefined") {
    toast("Cashfree checkout could not load.");
    return;
  }

  try {
    const response = await fetch("/api/donations/payment/cashfree/order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ donorName, donorEmail, amount })
    });

    const order = await response.json();
    if (!response.ok || !order.success || !order.paymentSessionId) {
      throw new Error(order.error || "Cashfree donation order could not be created.");
    }

    const cashfree = Cashfree({
      mode: order.mode === "sandbox" ? "sandbox" : "production"
    });

    toast("Opening Cashfree secure checkout...");

    const result = await cashfree.checkout({
      paymentSessionId: order.paymentSessionId,
      redirectTarget: "_modal"
    });

    if (result?.error) {
      throw new Error(result.error.message || "Cashfree checkout failed.");
    }

    toast("Checking Cashfree donation payment...");

    for (let attempt = 0; attempt < 8; attempt++) {
      const verifyResponse = await fetch("/api/donations/payment/cashfree/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: order.orderId })
      });

      const verified = await verifyResponse.json();

      if (verifyResponse.ok && verified.success && verified.status === "paid") {
        toast("❤️ Donation received. Thank you!");
        document.getElementById("donorAmount").value = "";
        await loadDonationLeaderboard();
        return;
      }

      if (verifyResponse.ok && verified.status === "failed") {
        throw new Error(verified.message || "Donation payment was not completed.");
      }

      await new Promise(resolve => setTimeout(resolve, 1500));
    }

    toast("Payment submitted. It may take a little time to appear on the leaderboard.");
    await loadDonationLeaderboard();
  } catch (e) {
    console.error("Cashfree donation error:", e);
    toast(e.message || "Cashfree donation payment failed.");
  }
}

/* =========================================================
   STARTUP
========================================================= */

document.addEventListener(
  "DOMContentLoaded",
  function () {

    /*
      Home page
    */

    if (
      document.getElementById("appList")
    ) {

      loadApps();
    }


    /*
      App details page
    */

    if (
      document.getElementById("detail")
    ) {

      loadDetail();
    }

  }
);