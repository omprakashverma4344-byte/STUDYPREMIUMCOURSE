
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

const TOKEN_KEY="spc_user_token";let currentUser=null,currentDonationId=null;function token(){return localStorage.getItem(TOKEN_KEY)||""}function esc(v=""){return String(v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[c]))}function toast(msg){const e=document.getElementById("toast");if(!e){alert(msg);return}e.textContent=msg;e.classList.add("show");clearTimeout(window._t);window._t=setTimeout(()=>e.classList.remove("show"),3000)}function headers(){return {"Content-Type":"application/json","Authorization":"Bearer "+token()}}async function api(url,options={}){const r=await fetch(url,{...options,headers:{...headers(),...(options.headers||{})}});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||"Request failed");return d}
async function registerUser(){try{const d=await api("/api/auth/register",{method:"POST",body:JSON.stringify({name:document.getElementById("regName").value.trim(),email:document.getElementById("regEmail").value.trim(),password:document.getElementById("regPassword").value})});localStorage.setItem(TOKEN_KEY,d.token);currentUser=d.user;showDashboard();toast("Account created.")}catch(e){toast(e.message)}}async function login(){try{const d=await api("/api/auth/login",{method:"POST",body:JSON.stringify({email:document.getElementById("loginEmail").value.trim(),password:document.getElementById("loginPassword").value})});localStorage.setItem(TOKEN_KEY,d.token);currentUser=d.user;showDashboard();toast("Login successful.")}catch(e){toast(e.message)}}function logout(){localStorage.removeItem(TOKEN_KEY);location.reload()}async function boot(){if(!token())return;try{const d=await api("/api/auth/me");currentUser=d.user;showDashboard()}catch{localStorage.removeItem(TOKEN_KEY)}}function showDashboard(){document.getElementById("authView").classList.add("hidden-force");document.getElementById("dashboardView").classList.remove("hidden-force");document.getElementById("welcome").textContent=`Hi, ${currentUser.name}`;document.getElementById("accountEmail").textContent=currentUser.email;loadBatches();loadDonations()}
async function loadBatches(){try{const batches=await api("/api/my-batches"),list=document.getElementById("batchList"),select=document.getElementById("donateBatch");if(!batches.length){list.innerHTML='<p class="small-muted">No batches yet. Buy a paid batch using this account email.</p>';select.innerHTML='<option value="">No batches available</option>';return}list.innerHTML=batches.map(x=>{const b=x.batch||{};return `<div class="account-card batch-card"><img src="${esc(b.logo||"")}" alt=""><div class="grow"><b>${esc(b.name||"Batch")}</b><div class="small-muted">${esc(b.category||"Education")} • ${esc(b.validity||"Lifetime")}</div></div><div class="batch-actions"><button class="primary" onclick="openBatch('${x.ownershipId}')">Open</button><button class="secondary" onclick="selectDonate('${x.ownershipId}')">🎁 Donate</button></div></div>`}).join("");select.innerHTML=batches.map(x=>`<option value="${x.ownershipId}">${esc(x.batch?.name||"Batch")}</option>`).join("")}catch(e){toast(e.message)}}function selectDonate(id){document.getElementById("donateBatch").value=id;document.getElementById("recipientEmail").focus();window.scrollTo({top:document.body.scrollHeight,behavior:"smooth"})}async function openBatch(id){try{const d=await api("/api/my-batches/access",{method:"POST",body:JSON.stringify({ownershipId:id,type:"website"})});location.href=d.url}catch(e){toast(e.message)}}async function createDonation(){try{const ownershipId=document.getElementById("donateBatch").value,recipientEmail=document.getElementById("recipientEmail").value.trim();const d=await api("/api/donate/create",{method:"POST",body:JSON.stringify({ownershipId,recipientEmail})});currentDonationId=d.donationId;document.getElementById("otpCard").classList.remove("hidden-force");if(d.developmentOtp){toast(`DEV OTP: ${d.developmentOtp}`);document.getElementById("donationOtp").value=d.developmentOtp}else toast("OTP sent to recipient email.")}catch(e){toast(e.message)}}async function verifyDonation(){try{const otp=document.getElementById("donationOtp").value.trim();await api("/api/donate/verify",{method:"POST",body:JSON.stringify({donationId:currentDonationId,otp})});toast("OTP verified. Waiting for provider/admin approval.");document.getElementById("otpCard").classList.add("hidden-force");loadDonations()}catch(e){toast(e.message)}}async function loadDonations(){try{const rows=await api("/api/donations/mine"),el=document.getElementById("donationHistory");if(!rows.length){el.innerHTML='<p class="small-muted">No donation requests yet.</p>';return}el.innerHTML=rows.map(x=>`<div class="account-card"><b>${esc(x.appId?.name||"Batch")}</b><div class="small-muted">${esc(x.donorEmail)} → ${esc(x.recipientEmail)}</div><span class="status-pill">${esc(x.status)}</span></div>`).join("")}catch(e){toast(e.message)}}document.addEventListener("DOMContentLoaded",boot);

async function loadAdvancedAccount(){try{const [rows,orders,notes]=await Promise.all([api('/api/my-batches/all'),api('/api/my-orders'),api('/api/my-notifications')]);const list=document.getElementById('advancedAccount');if(!list)return;const active=rows.filter(x=>x.status==='active'),expired=rows.filter(x=>x.status==='expired');list.innerHTML=`<div class="account-grid"><div class="account-card"><h2>🟢 Active Batches</h2>${active.map(x=>`<div class="report-row"><div><b>${esc(x.batch?.name||'Batch')}</b><div class="small-muted">Expiry: ${x.expiresAt?new Date(x.expiresAt).toLocaleDateString():'Lifetime'}</div></div><button class="primary" style="width:auto;padding:10px 14px" onclick="location.href='/course.html?id=${x.batch?._id}'">Continue</button></div>`).join('')||'<p class="small-muted">No active batch.</p>'}</div><div class="account-card"><h2>⏰ Expired Batches</h2>${expired.map(x=>`<div class="report-row"><b>${esc(x.batch?.name||'Batch')}</b><span>Expired</span></div>`).join('')||'<p class="small-muted">No expired batch.</p>'}</div></div><div class="account-card"><h2>🧾 Purchase History</h2>${orders.map(o=>`<div class="report-row"><div><b>${esc(o.appName||'Batch')}</b><div class="small-muted">${new Date(o.createdAt).toLocaleString()}</div></div><span>${esc(o.status)} • ${money(o.amount)}</span></div>`).join('')||'<p class="small-muted">No orders.</p>'}</div><div class="account-card"><h2>🔔 Notifications</h2>${notes.map(n=>`<div class="report-row"><div><b>${esc(n.title)}</b><div class="small-muted">${esc(n.message)}</div></div><button onclick="api('/api/my-notifications/${n._id}/read',{method:'POST'}).then(loadAdvancedAccount)">${n.read?'Read':'Mark read'}</button></div>`).join('')||'<p class="small-muted">No notifications.</p>'}</div>`}catch(e){console.error(e)}}
const _showDashboard=showDashboard;showDashboard=function(){_showDashboard();setTimeout(loadAdvancedAccount,300)};
