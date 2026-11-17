// SO Approvals: the whole front end. Hash routes:
//   #/                inbox          #/form/new   #/form/<id>
//   #/me              signature, password
//   #/admin/users     #/admin/rules
import {
  APPROVER_ROLES, CREATOR_ROLES, DEFAULT_FOC, FINAL_ROLES, ROLES, SECTIONS, STATUS,
  checkForm, holds, money, npt, parsePicks, pickChain, stepOf, totals,
} from "./shared.js";
import { buildPdf } from "./pdf.js";

// While the site is being tested: a button that fills a form with
// sample data. Set to false to remove it.
const SAMPLE_BUTTON = true;
const sampleData = () => ({
  dealer: "Individual Customer", customer_name: "Test Customer", customer_address: "Dang",
  contact: "9800000000", pan: "123456789", bfis_bank: "Global IME Bank LTD",
  bfis_branch: "Lamahi Branch", do_amount: "4,000,000", do_date: new Date().toISOString().slice(0, 10),
  brand: "GAC", model: "AION V- Elite", mfg_year: "2024", color: "Silver With Black",
  // A different VIN each time, so test forms do not look like repeats.
  vins: `TEST${Date.now().toString(36).toUpperCase()}`,
  mrp: "6,499,000", regular_margin: "1,399,000", units: "1",
  billing_notes: "Deal Amount: 5100000" + String.fromCharCode(10) + "Credit Note: 600000 (Exchange Top Up)",
  booking_amount: "100,000", booking_date: new Date().toISOString().slice(0, 10),
  place: "Kathmandu", new_so: "Yes",
});

const app = document.getElementById("app");
const nav = document.getElementById("nav");
let me = null;
// Each page load gets a number; a slow load that finishes after a newer
// one has started must not draw over it.
let view = 0;
const ticket = () => { const n = view; return () => n !== view; };
// The page with unsaved edits says so here; leaving it asks first.
let unsaved = null;
let shownHash = location.hash || "#/";

// ------------------------------------------------------------ helpers

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));

async function call(path, options = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: options.body && !(options.body instanceof Blob)
      ? { "Content-Type": "application/json", ...(options.headers || {}) }
      : options.headers,
  });
  const data = res.headers.get("Content-Type")?.includes("json") ? await res.json() : null;
  // A session that ran out while someone was logged in: back to the
  // login page. (Only then -- the start-up check gets 401 too, and
  // redrawing on that would loop.)
  if (res.status === 401 && path !== "/api/login" && me) {
    me = false;
    render();
    throw new Error("Please log in");
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Error ${res.status}`);
    err.data = data;
    throw err;
  }
  return data;
}

const post = (path, body) => call(path, { method: "POST", body: JSON.stringify(body || {}) });
const put = (path, body) => call(path, { method: "PUT", body: JSON.stringify(body || {}) });

// Small line icons (stroke follows the text colour).
const ICONS = {
  inbox: "M4 13h4l2 3h4l2-3h4M5 5h14l1 8v6H4v-6z",
  plus: "M12 5v14M5 12h14",
  users: "M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6M21 19v-1a4 4 0 0 0-3-3.9M15.5 4.1a3 3 0 0 1 0 5.8",
  rules: "M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4",
  user: "M20 21v-1a5 5 0 0 0-5-5H9a5 5 0 0 0-5 5v1M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8",
  logout: "M15 4h4v16h-4M10 16l-4-4 4-4M6 12h10",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14M20 20l-4-4",
  file: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6",
  download: "M12 4v11M7 10l5 5 5-5M5 20h14",
  check: "M5 12l5 5L20 7",
  back: "M15 18l-6-6 6-6",
  send: "M4 12l16-8-6 16-3-7z",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  clip: "M20 11l-8.5 8.5a5 5 0 0 1-7-7L13 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L14 7",
  sign: "M3 17c3-1 5-6 7-6s0 6 3 6 3-3 5-3 2 2 3 2M3 21h18",
};
const icon = (name) => `<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`;

let toastTimer;
/** A short message at the bottom; kind "ok" (green) or "bad" (red). */
function toast(text, kind = "") {
  const t = document.getElementById("toast");
  t.className = `toast ${kind}`;
  t.textContent = text;
  void t.offsetWidth;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), kind === "bad" ? 5000 : 2800);
}

/** A confirmation dialog on the page. Resolves true for OK. */
function ask({ title, text = "", ok = "OK", danger = false }) {
  const back = document.getElementById("modal");
  document.getElementById("modal-title").textContent = title;
  document.getElementById("modal-text").textContent = text;
  const okButton = document.getElementById("modal-ok");
  const cancel = document.getElementById("modal-cancel");
  okButton.textContent = ok;
  okButton.className = danger ? "danger" : "primary";
  back.classList.add("show");
  okButton.focus();
  return new Promise((resolve) => {
    const done = (answer) => {
      back.classList.remove("show");
      okButton.onclick = cancel.onclick = back.onclick = document.onkeydown = null;
      resolve(answer);
    };
    okButton.onclick = () => done(true);
    cancel.onclick = () => done(false);
    back.onclick = (e) => { if (e.target === back) done(false); };
    document.onkeydown = (e) => { if (e.key === "Escape") done(false); };
  });
}

const initials = (name) => String(name || "?").split(/\s+/).filter(Boolean).slice(0, 2)
  .map((w) => w[0].toUpperCase()).join("");

const isApprover = () => me && me.roles.some((r) => APPROVER_ROLES.includes(r) || r === "sap_user");
// Where a form is now, in words.
const statusText = (f) => (f.status === "pending" ? `With ${f.waiting_name || roleLabel(f.waiting_for)}`
  : f.status === "with_sap" ? `With SAP user ${f.sap_name || ""}`.trim() : STATUS[f.status]);
const canCreate = () => me && (me.is_admin || CREATOR_ROLES.some((r) => me.roles.includes(r)));
// Times are stored in UTC and shown in Nepal time.
const date = (s) => (s ? npt(s) : "");
const roleLabel = (r) => ROLES[r] || r;

function setNav() {
  if (!me) { nav.innerHTML = ""; return; }
  const here = location.hash || "#/";
  const on = (href) => (href === "#/" ? here === "#/" || here === "#" || here.startsWith("#/list") || here.startsWith("#/form/") && here !== "#/form/new"
    : here.startsWith(href));
  const link = (href, name, text) => `<a href="${href}" class="${on(href) ? "on" : ""}">${icon(name)}${text}</a>`;
  const roles = me.roles.map(roleLabel).join(", ") || (me.is_admin ? "Admin" : "");
  nav.innerHTML = [
    link("#/", "inbox", "Forms"),
    canCreate() ? link("#/form/new", "plus", "New form") : "",
    me.is_admin ? link("#/admin/users", "users", "Users") : "",
    me.is_admin ? link("#/admin/rules", "rules", "Rules") : "",
    `<span class="spacer"></span>`,
    `<a href="#/me" class="user ${on("#/me") ? "on" : ""}" title="My account"><span class="avatar">${esc(initials(me.name))}</span>
      <span class="who">${esc(me.name)}<small>${esc(roles)}</small></span></a>`,
    `<button id="logout" type="button" class="ghost" title="Log out">${icon("logout")}<span class="hide-sm">Log out</span></button>`,
  ].join("");
  document.getElementById("logout").onclick = async () => {
    await post("/api/logout").catch(() => {});
    me = null;
    location.hash = "#/";
    render();
  };
}

// -------------------------------------------------------------- router

async function render() {
  view += 1;
  unsaved = null;
  window.onbeforeunload = null;
  shownHash = location.hash || "#/";
  if (me === null) {
    try {
      me = (await call("/api/me")).user;
    } catch {
      me = false;
    }
  }
  setNav();
  if (!me) return viewLogin();
  if (me.must_change) return viewPassword(true);
  const hash = location.hash || "#/";
  let m;
  try {
    if ((m = /^#\/list\/(todo|mine|all)$/.exec(hash))) return await viewList(m[1]);
    if (hash === "#/" || hash === "#") return await viewList(isApprover() ? "todo" : "mine");
    if (hash === "#/form/new") return await viewForm(null);
    if ((m = /^#\/form\/(\d+)$/.exec(hash))) return await viewForm(Number(m[1]));
    if (hash === "#/me") return await viewMe();
    if (hash === "#/admin/users" && me.is_admin) return await viewUsers();
    if (hash === "#/admin/rules" && me.is_admin) return await viewRules();
    app.innerHTML = `<div class="empty-state">${icon("file")}<b>Page not found</b><a href="#/">Back to forms</a></div>`;
  } catch (e) {
    app.innerHTML = `<div class="note bad">${esc(e.message)}</div><p><a href="#/">${icon("back")} Back to forms</a></p>`;
  }
}
window.addEventListener("hashchange", async () => {
  if (unsaved && unsaved()) {
    const wanted = location.hash;
    history.replaceState(null, "", shownHash);      // stay for now; no second hashchange
    const leave = await ask({ title: "Leave without saving?", text: "You have changes that are not saved.", ok: "Leave", danger: true });
    if (!leave) return;
    unsaved = null;
    history.replaceState(null, "", wanted);
  }
  window.scrollTo(0, 0);              // a new page starts at its top
  render();
});

// --------------------------------------------------------------- login

function viewLogin() {
  app.innerHTML = `<div class="login-wrap">
    <form class="card login" id="f">
      <div class="mark">SO</div>
      <h1>Welcome back</h1>
      <p class="muted" style="margin:0 0 18px">Sign in to SO Approvals, CG Motors.</p>
      <div id="msg"></div>
      <label>Username<input name="username" autocomplete="username" required autofocus></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
      <button class="primary block" style="margin-top:18px">Sign in</button>
    </form></div>`;
  const f = document.getElementById("f");
  f.onsubmit = async (e) => {
    e.preventDefault();
    const button = f.querySelector("button");
    button.disabled = true;
    try {
      me = (await post("/api/login", { username: f.username.value, password: f.password.value })).user;
      render();
    } catch (err) {
      document.getElementById("msg").innerHTML = `<div class="note bad">${esc(err.message)}</div>`;
      button.disabled = false;
    }
  };
}

function viewPassword(forced) {
  app.innerHTML = `<div class="login-wrap">
    <form class="card login" id="f">
      <div class="mark">SO</div>
      <h1>${forced ? "Choose your password" : "Change password"}</h1>
      <p class="muted" style="margin:0 0 18px">${forced ? "You signed in with a temporary password. Choose your own to continue." : "At least 10 characters, with letters and numbers."}</p>
      <div id="msg"></div>
      <label>Current password<input name="old" type="password" autocomplete="current-password" required></label>
      <label>New password<input name="new1" type="password" autocomplete="new-password" required minlength="10"></label>
      <label>New password again<input name="new2" type="password" autocomplete="new-password" required minlength="10"></label>
      <button class="primary block" style="margin-top:18px">Save password</button>
    </form></div>`;
  const f = document.getElementById("f");
  f.onsubmit = async (e) => {
    e.preventDefault();
    const msg = document.getElementById("msg");
    if (f.new1.value !== f.new2.value) {
      msg.innerHTML = `<div class="note bad">The two new passwords differ.</div>`;
      return;
    }
    try {
      await post("/api/me/password", { old_password: f.old.value, new_password: f.new1.value });
      me = null;
      toast("Password saved", "ok");
      location.hash = "#/me";
      render();
    } catch (err) {
      msg.innerHTML = `<div class="note bad">${esc(err.message)}</div>`;
    }
  };
}

// --------------------------------------------------------------- lists

let listFilter = "";          // a stat card picked on the Forms page
const STAGES = {
  drafts: { label: "Drafts", match: (f) => ["draft", "returned"].includes(f.status) },
  approval: { label: "With approvers", match: (f) => f.status === "pending" },
  sap: { label: "With SAP user", match: (f) => ["approved", "with_sap"].includes(f.status) },
  done: { label: "SO created", match: (f) => f.status === "done" },
};

async function viewList(box) {
  const stale = ticket();
  const [{ forms }, all, todo] = await Promise.all([
    call(`/api/forms?box=${box}`),
    box === "all" ? null : call("/api/forms?box=all"),
    isApprover() && box !== "todo" ? call("/api/forms?box=todo") : null,
  ]);
  if (stale()) return;
  const everything = all ? all.forms : forms;
  const waiting = box === "todo" ? forms.length : todo ? todo.forms.length : 0;
  const tabs = [
    isApprover() ? ["todo", "Waiting for me"] : null,
    ["mine", "My forms"],
    ["all", "All I can see"],
  ].filter(Boolean);
  const sigWarn = isApprover() && !me.has_signature
    ? `<div class="note warn">${icon("sign")} Draw your signature in <a href="#/me">My account</a> before approving.</div>` : "";
  app.innerHTML = `
    <div class="page-head">
      <div><h1>Forms</h1><div class="sub">Sales Order for Billing approvals</div></div>
      ${canCreate() ? `<a class="btn primary" href="#/form/new">${icon("plus")}New form</a>` : ""}
    </div>
    ${sigWarn}
    <div class="stats">
      ${isApprover() ? `<button type="button" class="stat ${waiting ? "attention" : ""} ${box === "todo" ? "on" : ""}" data-go="todo">
        <div class="label">Waiting for me</div><div class="value">${waiting}</div></button>` : ""}
      ${Object.entries(STAGES).map(([k, st]) => `<button type="button" class="stat ${listFilter === k ? "on" : ""}" data-stage="${k}">
        <div class="label">${st.label}</div><div class="value">${everything.filter(st.match).length}</div></button>`).join("")}
    </div>
    <div class="card flush">
      <div class="toolbar">
        <div class="tabs">${tabs.map(([k, l]) => `<a href="#/list/${k}" class="${k === box ? "on" : ""}">${l}</a>`).join("")}</div>
        <div class="search">${icon("search")}<input id="q" type="search" placeholder="Search form, customer, dealer, brand, SO…" aria-label="Search"></div>
        ${listFilter ? `<button type="button" class="ghost" id="clearFilter">${esc(STAGES[listFilter].label)} ✕</button>` : ""}
      </div>
      <div id="rows"></div>
    </div>`;
  const rows = document.getElementById("rows");
  const draw = () => {
    const q = document.getElementById("q").value.trim().toLowerCase();
    const shown = forms.filter((f) => (!listFilter || STAGES[listFilter].match(f))
      && (!q || [f.number, f.customer, f.dealer, f.brand, f.model, f.so_number, f.owner_name]
        .some((v) => String(v || "").toLowerCase().includes(q))));
    rows.innerHTML = shown.length ? `<table>
      <thead><tr><th>Form</th><th>Customer</th><th class="hide-sm">Vehicle</th><th class="num hide-xs">Invoice</th><th>Status</th><th class="hide-sm">Updated</th></tr></thead>
      <tbody>${shown.map((f) => `
        <tr class="link" data-id="${f.id}" tabindex="0">
          <td><b>${esc(f.number)}</b><span class="sub">${esc(f.owner_name)}</span></td>
          <td>${esc(f.customer) || "<span class='muted'>—</span>"}<span class="sub">${esc(f.dealer)}</span></td>
          <td class="hide-sm">${esc(f.brand)} <span class="sub">${esc(f.model)}</span></td>
          <td class="num hide-xs">${money(f.invoice)}</td>
          <td><span class="pill ${f.status}">${esc(statusText(f))}</span>
            ${f.so_number ? `<span class="sub">SO ${esc(f.so_number)}</span>` : ""}</td>
          <td class="hide-sm muted">${esc(date(f.updated_at))}</td>
        </tr>`).join("")}</tbody></table>`
      : `<div class="empty-state">${icon("inbox")}<b>${q || listFilter ? "No forms match" : box === "todo" ? "Nothing is waiting for you" : "No forms yet"}</b>
          ${q || listFilter ? "Try another search or filter." : box === "todo" ? "Forms that need your approval or action show up here." : canCreate() ? `<a href="#/form/new">Start a new form</a>` : ""}</div>`;
    rows.querySelectorAll("tr.link").forEach((tr) => {
      const go = () => { location.hash = `#/form/${tr.dataset.id}`; };
      tr.onclick = go;
      tr.onkeydown = (e) => { if (e.key === "Enter") go(); };
    });
  };
  draw();
  document.getElementById("q").oninput = draw;
  app.querySelectorAll("[data-stage]").forEach((b) => {
    b.onclick = () => {
      listFilter = listFilter === b.dataset.stage ? "" : b.dataset.stage;
      if (box === "todo") location.hash = "#/list/all";
      else viewList(box);
    };
  });
  const goTodo = app.querySelector("[data-go=todo]");
  if (goTodo) goTodo.onclick = () => { listFilter = ""; location.hash = "#/list/todo"; };
  const clear = document.getElementById("clearFilter");
  if (clear) clear.onclick = () => { listFilter = ""; viewList(box); };
}

// ---------------------------------------------------------------- form

/**
 * A list of approvers grouped by role, in the order of the paper form.
 * A role nobody holds yet still shows, greyed out, so it is clear who
 * is missing rather than silently absent.
 */
function approverSelect(id, approvers, exclude, placeholder) {
  const groups = APPROVER_ROLES.map((role) => {
    const people = approvers.filter((u) => u.roles.includes(role) && !exclude.includes(u.id));
    const options = people.length
      ? people.map((u) => `<option value="${u.id}:${role}">${esc(u.name)} (${esc(roleLabel(role))})</option>`).join("")
      : `<option disabled>nobody yet (admin: add on the Users page)</option>`;
    return `<optgroup label="${esc(roleLabel(role))}">${options}</optgroup>`;
  }).join("");
  return `<select id="${id}" style="max-width:460px"><option value="">${esc(placeholder)}</option>${groups}</select>`;
}

function fieldInput(key, label, kind, required, value, editable) {
  const lab = `${esc(label)}${required ? ' <span class="req">*</span>' : ""}`;
  const ro = editable ? "" : "readonly";
  if (!editable && kind !== "list") {
    // Amounts as money; a count (units) as it is.
    const shown = kind === "number" && key !== "units" && String(value ?? "").trim() !== "" ? money(value) : value;
    const blank = shown === undefined || shown === null || String(shown).trim() === "";
    return `<div class="ro ${kind === "textarea" ? "wide" : ""}"><span class="k">${esc(label)}</span>
      <span class="v ${blank ? "empty" : ""}">${blank ? "—" : esc(shown)}</span></div>`;
  }
  if (kind === "textarea") {
    return `<label class="wide">${lab}<textarea data-k="${key}" ${ro}>${esc(value)}</textarea></label>`;
  }
  if (kind === "list") {
    const chosen = Array.isArray(value) ? value : (value === undefined ? DEFAULT_FOC.slice() : []);
    const all = [...new Set([...DEFAULT_FOC, ...chosen])];
    if (!editable) {
      return `<div class="wide"><label>${lab}</label><ul>${chosen.map((c) => `<li>${esc(c)}</li>`).join("") || "<li class='muted'>None</li>"}</ul></div>`;
    }
    return `<div class="wide"><label>${lab}</label><div class="foc" data-list="${key}">
      ${all.map((c) => `<label><input type="checkbox" value="${esc(c)}" ${chosen.includes(c) ? "checked" : ""}> ${esc(c)}</label>`).join("")}
      </div><div class="row" style="margin-top:6px"><input id="foc-new" placeholder="Add another FOC item" style="max-width:320px"><button type="button" id="foc-add">Add</button></div></div>`;
  }
  // A read-only empty date box would still show "mm/dd/yyyy".
  const type = kind === "date" && (editable || value) ? "date" : "text";
  const mode = kind === "number" ? 'inputmode="decimal"' : "";
  return `<label>${lab}<input type="${type}" ${mode} data-k="${key}" value="${esc(value)}" ${ro}></label>`;
}

function readForm(root, data) {
  const out = { ...data };
  root.querySelectorAll("[data-k]").forEach((el) => { out[el.dataset.k] = el.value; });
  root.querySelectorAll("[data-list]").forEach((box) => {
    out[box.dataset.list] = [...box.querySelectorAll("input:checked")].map((i) => i.value);
  });
  return out;
}

async function viewForm(id) {
  if (id === null && !canCreate()) throw new Error("Only sales people and sales supervisors make forms");
  const stale = ticket();
  const [{ rules, default_chain: fallback, rules_active: rulesOn }, { approvers }, detail] = await Promise.all([
    call("/api/rules"),
    call("/api/approvers"),
    id === null ? Promise.resolve(null) : call(`/api/forms/${id}`),
  ]);
  if (stale()) return;
  const form = detail ? detail.form : { status: "draft", data: { units: "1", dealer: "", foc: DEFAULT_FOC.slice() }, owner_name: me.name };
  const can = detail ? detail.can : { edit: true, decide: false, so: false };
  let data = { ...form.data };
  if (data.foc === undefined) data.foc = DEFAULT_FOC.slice();

  const lastReturn = detail && [...detail.events].reverse().find((e) => e.action === "returned");
  const banner = form.status === "returned" && lastReturn
    ? `<div class="note bad"><b>Returned by ${esc(lastReturn.user_name)} (${esc(roleLabel(lastReturn.role))}):</b> ${esc(lastReturn.remark)}</div>` : "";

  // Where the form is: Prepared, Approvals, SAP user, SO created, Attached.
  const stage = { draft: 0, returned: 0, pending: 1, approved: 2, with_sap: 2,
    done: form.attach_status === "attached" ? 5 : 4 }[form.status] ?? 0;
  const tracker = ["Prepared", "Approvals", "SAP user", "SO created", "Attached in SAP"]
    .map((label, i) => `<li class="${i < stage ? "done" : i === stage ? "now" : ""}">${label}</li>`).join("");
  const t0 = totals(data);
  app.innerHTML = `
    <div class="page-head">
      <div>
        <div class="row" style="gap:12px"><h1>${detail ? esc(form.number) : "New approval form"}</h1>
          <span class="pill ${form.status}">${esc(statusText(form))}</span></div>
        <div class="sub">Sales Order for Billing · prepared by ${esc(form.owner_name)} · ${esc(date(form.created_at) || npt(new Date().toISOString()))}</div>
      </div>
      <div class="row">
        <a class="btn ghost" href="#/">${icon("back")}Forms</a>
        ${SAMPLE_BUTTON && can.edit ? `<button type="button" id="sample">Fill sample data</button>` : ""}
        ${detail && detail.can.remove ? `<button type="button" class="danger" id="delete">${icon("trash")}Delete draft</button>` : ""}
      </div>
    </div>
    <ol class="tracker" aria-label="Progress">${tracker}</ol>
    ${banner}
    <div class="form-layout">
      <div class="main-col">
        <div id="fields">
          ${SECTIONS.map(([title, fields], i) => `
            <section class="card"><h2 class="section-title"><span class="num">${i + 1}</span>${esc(title)}</h2><div class="grid">
              ${fields.map(([k, l, kind, req]) => fieldInput(k, l, kind, req, data[k], can.edit)).join("")}
            </div>
            ${title === "Billing Amount Details" ? `<div class="totals" id="totals"></div>` : ""}
            </section>`).join("")}
        </div>
        <section class="card"><div class="card-head"><h2>${icon("clip")} Supporting documents</h2>
          ${can.edit && detail ? `<label class="btn">${icon("plus")}Add PDF / photo<input type="file" id="upload" accept="application/pdf,image/png,image/jpeg" multiple hidden></label>` : ""}</div>
          <ul class="files" id="files"></ul>
          ${can.edit ? (detail ? `<span class="muted small">PDF, PNG or JPG, up to 10 MB each.</span>` : `<p class="muted" style="margin:0">Save the draft first, then add documents.</p>`) : ""}
        </section>
        <section class="card"><h2>${icon("sign")} Approvals</h2><div id="chain"></div></section>
        ${detail ? `<section class="card"><h2>History</h2><ul class="timeline">${detail.events.map((e) => `
          <li><span class="when">${esc(date(e.at))}</span><b>${esc(e.user_name)}</b> ${esc(describe(e))}${e.remark ? `<span class="muted"> — ${esc(e.remark)}</span>` : ""}</li>`).join("")}</ul></section>` : ""}
      </div>
      <aside class="side">
        <div class="card summary">
          <h3>Summary</h3>
          <div class="muted small">Invoice value</div>
          <div class="big" id="sumInvoice">${money(t0.invoice)}</div>
          <dl style="margin-top:12px">
            <dt>Customer</dt><dd id="sumCustomer">${esc(data.customer_name) || "—"}</dd>
            <dt>Vehicle</dt><dd id="sumVehicle">${esc([data.brand, data.model].filter(Boolean).join(" ")) || "—"}</dd>
            <dt>Discount</dt><dd id="sumDiscount">${money(t0.discount)} (${t0.discount_pct.toFixed(1)}%)</dd>
            ${form.sap_name ? `<dt>SAP user</dt><dd>${esc(form.sap_name)}</dd>` : ""}
            ${form.so_number ? `<dt>SAP order</dt><dd>${esc(form.so_number)}</dd>` : ""}
          </dl>
        </div>
        <div id="actions"></div>
        ${detail ? `<div class="card"><h3>Document</h3><div class="row">
          <button type="button" id="viewPdf">${icon("eye")}View PDF</button>
          <button type="button" id="pdf">${icon("download")}Download PDF</button></div></div>` : ""}
      </aside>
    </div>
    ${can.decide ? `<div class="mobile-bar"><button type="button" class="primary" id="mbDecide">${icon("sign")}Review and decide</button></div>`
      : can.edit ? `<div class="mobile-bar"><button type="button" id="mbSave">Save draft</button><button type="button" class="primary" id="mbSend">${icon("send")}Send</button></div>` : ""}`;
  const mobile = (id, target) => {
    const b = document.getElementById(id);
    if (b) b.onclick = () => document.getElementById(target)?.click();
  };
  mobile("mbSave", "save");
  mobile("mbSend", "send");
  const mbDecide = document.getElementById("mbDecide");
  if (mbDecide) mbDecide.onclick = () => document.getElementById("actions").scrollIntoView({ behavior: "smooth" });

  const fieldsEl = document.getElementById("fields");
  const showTotals = () => {
    const t = totals(data);
    document.getElementById("sumInvoice").textContent = money(t.invoice);
    document.getElementById("sumDiscount").textContent = `${money(t.discount)} (${t.discount_pct.toFixed(1)}%)`;
    document.getElementById("sumCustomer").textContent = data.customer_name || "—";
    document.getElementById("sumVehicle").textContent = [data.brand, data.model].filter(Boolean).join(" ") || "—";
    document.getElementById("totals").innerHTML = `
      <div>Total discount<b>${money(t.discount)}</b><span class="muted">${t.discount_pct.toFixed(1)}% of MRP</span></div>
      <div>Billing price (per unit)<b>${money(t.billing)}</b></div>
      <div>Invoice value<b>${money(t.invoice)}</b></div>`;
  };
  const showChain = () => {
    const el = document.getElementById("chain");
    if (detail && detail.steps.length) {
      el.innerHTML = `<p class="muted" style="margin-top:0">Rule: ${esc(form.rule)}</p><div class="steps">${detail.steps.map((s) => `
        <div class="step ${s.done ? "done" : ""} ${s.current ? "current" : ""}">
          <div class="role">${esc(s.label)}${s.person ? ` · ${esc(s.person)}` : ""}</div>
          ${s.done ? `<img alt="Signature of ${esc(s.done.name)}" src="${esc(s.done.signature || "")}"><b>${esc(s.done.name)}</b><div class="muted" style="font-size:12px">${esc(date(s.done.at))}</div>${s.done.remark ? `<div style="font-size:13px">${esc(s.done.remark)}</div>` : ""}`
          : `<div class="muted" style="font-size:13px;margin-top:6px">${s.current ? "Waiting for" : "Then"}: ${esc(s.holders.join(", ") || "nobody holds this role")}</div>`}
        </div>`).join("")}
        ${form.status === "pending" && stepOf(form.chain[form.chain.length - 1]).user_id && form.step === form.chain.length - 1
          ? `<div class="step" style="border-style:dashed"><div class="role">Next</div><div class="muted" style="font-size:13px;margin-top:6px">${esc(stepOf(form.chain[form.step]).name)} chooses who it goes to next, or gives the final approval.</div></div>` : ""}
        </div>`;
    } else if (!rulesOn) {
      // Rules switched off: the sales person chooses the first approver;
      // each approver then chooses the next.
      const ownerId = detail ? detail.form.owner_id : me.id;
      const [first] = parsePicks(data.approvers);
      const who = first && approvers.find((u) => u.id === first.user_id);
      el.innerHTML = `<p class="muted" style="margin-top:0">Choose who approves this form first. Each approver then chooses who it goes to next, until the CFO, Dep. CEO or CEO gives the final approval.</p>
        ${first ? `<p>First approver: <b>${esc(who ? who.name : "(no longer active)")}</b> <span class="muted">${esc(roleLabel(first.role))}</span></p>`
          : `<div class="note warn">No first approver chosen yet.</div>`}
        ${can.edit ? approverSelect("pick-first", approvers, [ownerId], first ? "Change the first approver" : "+ choose the first approver") : ""}`;
      const select = el.querySelector("#pick-first");
      if (select) {
        select.onchange = () => {
          if (!select.value) return;
          data.approvers = [select.value];
          markDirty();
          showChain();
        };
      }
    } else {
      const { rule, chain } = pickChain(rules, data, fallback);
      // Who would approve each step. Nobody approves their own form.
      const ownerId = detail ? detail.form.owner_id : me.id;
      const steps = chain.map((role) => ({
        role,
        names: approvers.filter((u) => u.id !== ownerId && holds(u, role, data.brand)).map((u) => u.name),
      }));
      const missing = steps.filter((s) => !s.names.length);
      el.innerHTML = `<p class="muted" style="margin-top:0">When sent, this form goes along this chain (rule: ${esc(rule)}${data.brand ? `, brand ${esc(String(data.brand).toUpperCase())}` : ""}):</p>
        <div class="steps">${steps.map((s, i) => `
          <div class="step ${s.names.length ? "" : "current"}" style="min-height:0">
            <div class="role">${i + 1}. ${esc(roleLabel(s.role))}</div>
            <div style="font-size:13px;margin-top:4px">${s.names.length ? esc(s.names.join(", ")) : "<b>Nobody can approve this step</b>"}</div>
          </div>`).join("")}</div>
        ${missing.length ? `<div class="note warn" style="margin-top:10px">This form cannot be sent until the admin gives someone ${missing.map((s) => `<b>${esc(roleLabel(s.role))}</b>`).join(", ")}${data.brand ? ` for brand ${esc(String(data.brand).toUpperCase())}` : ""}. You cannot approve your own form.</div>` : ""}`;
    }
  };
  let markDirty = () => {};
  const showFiles = () => {
    const list = document.getElementById("files");
    const files = detail ? detail.files : [];
    list.innerHTML = files.length ? files.map((f) => `
      <li>${icon("file")}<a href="/api/files/${f.id}" target="_blank" rel="noopener">${esc(f.name)}</a>
        <span class="size">${(f.size / 1024).toFixed(0)} KB</span>
        ${can.edit ? `<button type="button" class="ghost danger" data-del="${f.id}" title="Remove">${icon("trash")}</button>` : ""}</li>`).join("")
      : `<li class="muted">No documents attached.</li>`;
    list.querySelectorAll("[data-del]").forEach((b) => {
      b.onclick = async () => {
        if (!(await ask({ title: "Remove this document?", ok: "Remove", danger: true }))) return;
        await call(`/api/files/${b.dataset.del}`, { method: "DELETE" });
        render();
      };
    });
  };
  showTotals();
  showChain();
  showFiles();

  if (can.edit) {
    let dirty = false;
    let formId = detail ? detail.form.id : null;
    unsaved = () => dirty;
    markDirty = () => { dirty = true; };
    fieldsEl.addEventListener("input", () => {
      data = readForm(fieldsEl, data);
      dirty = true;
      showTotals();
      showChain();
    });
    fieldsEl.addEventListener("change", () => {
      data = readForm(fieldsEl, data);
      dirty = true;
      showTotals();
      showChain();
    });
    const add = document.getElementById("foc-add");
    if (add) {
      add.onclick = () => {
        const input = document.getElementById("foc-new");
        const value = input.value.trim();
        if (!value) return;
        const box = fieldsEl.querySelector("[data-list=foc]");
        const label = document.createElement("label");
        label.innerHTML = `<input type="checkbox" checked value="${esc(value)}"> ${esc(value)}`;
        box.appendChild(label);
        input.value = "";
        data = readForm(fieldsEl, data);
        dirty = true;
      };
    }
    const actions = document.getElementById("actions");
    actions.innerHTML = `<div class="card"><h3>Next step</h3>
      <p class="muted small" style="margin-top:0">Save as often as you like. Once sent, the form cannot be changed unless an approver returns it.</p>
      <div id="problems"></div>
      <div class="row"><button type="button" id="save" style="flex:1">Save draft</button>
      <button type="button" class="primary" id="send" style="flex:1">${icon("send")}Send for approval</button></div></div>`;
    // Saving a new form gives it a number. The address is updated
    // without reloading the page, so a send in progress (and its error
    // message) is not wiped out by a redraw.
    const save = async () => {
      data = readForm(fieldsEl, data);
      if (!formId) {
        const created = await post("/api/forms", { data });
        formId = created.id;
        dirty = false;
        history.replaceState(null, "", `#/form/${formId}`);
        shownHash = location.hash;
        return formId;
      }
      await put(`/api/forms/${formId}`, { data });
      dirty = false;
      return formId;
    };
    const showProblems = (html) => {
      const el = document.getElementById("problems");
      el.innerHTML = html;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    };
    document.getElementById("save").onclick = async () => {
      try {
        const isNew = !formId;
        await save();
        toast("Draft saved", "ok");
        if (isNew) render();          // now documents can be added
      } catch (e) { toast(e.message, "bad"); }
    };
    const sendButton = document.getElementById("send");
    sendButton.onclick = async () => {
      data = readForm(fieldsEl, data);
      const problems = checkForm(data);
      if (problems.length) {
        showProblems(`<div class="note bad"><b>Not ready to send:</b><ul>${problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul></div>`);
        return;
      }
      let route;
      if (rulesOn) {
        route = pickChain(rules, data, fallback).chain.map(roleLabel).join(" → ");
      } else {
        const [first] = parsePicks(data.approvers);
        if (!first) {
          showProblems(`<div class="note bad"><b>Not ready to send:</b> choose who approves this form first (Approvals, above).</div>`);
          return;
        }
        route = (approvers.find((u) => u.id === first.user_id) || {}).name || "?";
      }
      if (!(await ask({ title: "Send for approval?", text: `It goes to: ${route}\n\nYou cannot change it while it is with the approvers.`, ok: "Send" }))) return;
      sendButton.disabled = true;
      try {
        const sentId = await save();
        await post(`/api/forms/${sentId}/submit`);
        toast("Sent for approval", "ok");
        render();
      } catch (e) {
        const list = e.data && e.data.problems;
        showProblems(`<div class="note bad"><b>Not sent.</b> The form is saved as a draft.${list ? `<ul>${list.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ` ${esc(e.message)}`}</div>`);
        toast("Not sent: see the message on the form", "bad");
        sendButton.disabled = false;
      }
    };
    window.onbeforeunload = () => (dirty ? true : undefined);
    const upload = document.getElementById("upload");
    if (upload) {
      upload.onchange = async () => {
        if (dirty) await save().catch(() => {});
        for (const file of upload.files) {
          try {
            await call(`/api/forms/${formId}/files`, {
              method: "POST", body: file,
              headers: { "Content-Type": file.type, "X-File-Name": encodeURIComponent(file.name) },
            });
            toast(`Added ${file.name}`, "ok");
          } catch (e) { toast(`${file.name}: ${e.message}`, "bad"); }
        }
        render();
      };
    }
  }

  const sampleButton = document.getElementById("sample");
  if (sampleButton) {
    sampleButton.onclick = () => {
      for (const [k, v] of Object.entries(sampleData())) {
        const el = fieldsEl.querySelector(`[data-k=${k}]`);
        if (el) el.value = v;
      }
      fieldsEl.dispatchEvent(new Event("input"));
      toast("Sample data filled in. Change anything, then save or send.");
    };
  }

  const deleteButton = document.getElementById("delete");
  if (deleteButton) {
    deleteButton.onclick = async () => {
      if (!(await ask({ title: `Delete draft ${form.number}?`, text: "This cannot be undone.", ok: "Delete", danger: true }))) return;
      try {
        await call(`/api/forms/${form.id}`, { method: "DELETE" });
        unsaved = null;
        toast("Draft deleted", "ok");
        location.hash = "#/list/mine";
      } catch (e) { toast(e.message, "bad"); }
    };
  }

  const actions = document.getElementById("actions");
  const sapUsers = approvers.filter((u) => u.roles.includes("sap_user"));
  const sapSelect = (id, first) => `<select id="${id}" style="max-width:320px"><option value="">${esc(first)}</option>
    ${sapUsers.map((u) => `<option value="${u.id}" ${u.name === form.sap_name ? "selected" : ""}>${esc(u.name)}</option>`).join("")}</select>`;
  if (can.decide) {
    // A form routed person by person, at the end of its route so far: this
    // approver sends it on, or (CFO, Dep. CEO, CEO) approves it as final.
    const routing = stepOf(form.chain[form.step]).user_id && form.step === form.chain.length - 1;
    const mayFinish = FINAL_ROLES.includes(form.waiting_for);
    const approvedIds = form.chain.map((x) => stepOf(x).user_id);
    actions.innerHTML = `<div class="card" style="border-color:var(--brand)"><h2>${icon("sign")} Your decision</h2>
      <p class="muted small" style="margin-top:-6px">As ${esc(roleLabel(form.waiting_for))}. Read the form, then approve or return it.</p>
      ${me.has_signature ? "" : `<div class="note warn">Draw your signature in <a href="#/me">My account</a> first.</div>`}
      <label>Remark<textarea id="remark" placeholder="Optional when approving; say what to change when returning"></textarea></label>
      ${routing ? `<div style="margin-top:12px">
        <label class="choice"><input type="radio" name="route" value="next" checked> Approve and send on to</label>
        <div style="margin:6px 0 12px 26px">${approverSelect("next", approvers, [form.owner_id, ...approvedIds], "choose who approves next")}</div>
        ${mayFinish
          ? `<label class="choice"><input type="radio" name="route" value="final"> Final approval (no one after me)</label>`
          : `<p class="muted" style="font-size:13px;margin:0">Only the CFO, Dep. CEO or CEO can give the final approval.</p>`}
      </div>` : ""}
      ${can.assign && sapUsers.length ? `<div style="margin-top:12px"><label>SAP user who will create the SO${form.sap_name ? "" : " (you can also choose later)"}</label>
        <div style="margin-top:4px">${sapSelect("decideSap", "not chosen yet")}</div></div>` : ""}
      <div class="row" style="margin-top:14px">
        <button type="button" class="danger" id="return" style="flex:1">Return</button>
        <button type="button" class="primary" id="approve" style="flex:2" ${me.has_signature ? "" : "disabled"}>${icon("check")}Approve and sign</button>
      </div></div>`;
    const go = async (action) => {
      const remark = document.getElementById("remark").value;
      if (action === "return" && !remark.trim()) { toast("Say what needs changing in the remark", "bad"); document.getElementById("remark").focus(); return; }
      const payload = { action, remark };
      const sapChoice = document.getElementById("decideSap");
      if (action === "approve" && sapChoice && sapChoice.value) payload.sap_user_id = Number(sapChoice.value);
      let question = action === "approve" ? "Approve this form with your signature?" : "Return this form to the sales person?";
      let okLabel = action === "approve" ? "Approve" : "Return";
      if (action === "approve" && routing) {
        const finalChoice = (document.querySelector("input[name=route]:checked") || {}).value === "final";
        if (finalChoice) {
          payload.final = true;
          question = "Give the FINAL approval with your signature? The form is then fully approved.";
        } else {
          const next = document.getElementById("next");
          if (!next.value) { toast("Choose who approves next", "bad"); next.focus(); return; }
          payload.next = next.value;
          question = `Approve with your signature and send it on to ${next.options[next.selectedIndex].text}?`;
          okLabel = "Approve and send";
        }
      }
      if (!(await ask({ title: question, ok: okLabel, danger: action === "return" }))) return;
      try {
        await post(`/api/forms/${form.id}/decide`, payload);
        toast(action === "approve" ? "Approved" : "Returned", "ok");
        render();
      } catch (e) { toast(e.message, "bad"); }
    };
    document.getElementById("approve").onclick = () => go("approve");
    document.getElementById("return").onclick = () => go("return");
  }
  if ((can.assign && !can.decide) || can.so) {
    const pending = form.status === "pending";
    actions.insertAdjacentHTML("beforeend", (can.assign && !can.decide ? `<div class="card"><h2>SAP user</h2>
      <p class="muted" style="margin-top:0">${pending
        ? (form.sap_name ? `<b>${esc(form.sap_name)}</b> will create the SO once the form is fully approved. You can change this.`
          : "Choose who will create the sales order in SAP. The form goes to them as soon as it is fully approved.")
        : form.status === "with_sap"
          ? `Now with <b>${esc(form.sap_name)}</b>. If they are busy, send it to someone else.`
          : "Fully approved. Choose who creates the sales order in SAP."}</p>
      ${sapUsers.length ? `<div class="row">${sapSelect("sapUser", "choose an SAP user")}
        <button type="button" class="primary" id="assign">${pending ? "Save SAP user" : form.sap_name ? "Change SAP user" : "Send to SAP user"}</button></div>`
        : `<div class="note warn">No SAP users yet. An admin adds them on the Users page with the role <b>SAP user</b>.</div>`}
      </div>` : "")
      + (can.so ? `<div class="card" style="border-color:var(--brand)"><h2>SAP sales order</h2>
      <p class="muted" style="margin-top:0">${form.status === "with_sap"
        ? "Create the sales order in SAP, download the PDF (top of the page) and attach it to the order (VA02 → Services for Object → Create attachment), then enter the SO number here."
        : "Correct the SO number if it was entered wrongly."}</p>
      <input id="so" inputmode="numeric" placeholder="SO number, e.g. 8000096581" value="${esc(form.so_number || "")}">
      <button type="button" class="primary block" id="saveSo" style="margin-top:10px">Save SO number</button></div>` : ""));
    const assign = document.getElementById("assign");
    if (assign) {
      assign.onclick = async () => {
        const choice = document.getElementById("sapUser");
        if (!choice.value) { toast("Choose an SAP user", "bad"); return; }
        try {
          await post(`/api/forms/${form.id}/assign`, { user_id: Number(choice.value) });
          toast(form.status === "pending" ? `SAP user set: ${choice.options[choice.selectedIndex].text}`
            : `Sent to ${choice.options[choice.selectedIndex].text}`, "ok");
          render();
        } catch (e) { toast(e.message, "bad"); }
      };
    }
  }
  if (form.status === "done") {
    const pdf = detail.final_pdf;
    const state = !pdf ? (can.so
      ? `<div class="note warn">The PDF for SAP has not been uploaded yet. <button type="button" id="uploadSap">Make and upload the PDF</button></div>`
      : `<div class="note warn">Waiting for the SAP user to upload the PDF for SAP.</div>`)
      : form.attach_status === "attached"
        ? `<div class="note ok">Attached to SO ${esc(form.so_number)} in SAP on ${esc(date(form.attached_at))} (Nepal time).</div>`
        : form.attach_status === "failed"
          ? `<div class="note bad"><b>Not attached in SAP:</b> ${esc(form.attach_message)}
              ${can.retry_attach ? `<div style="margin-top:8px"><button type="button" id="retryAttach">Try again</button></div>` : ""}</div>`
          : `<div class="note warn">Waiting to be attached to SO ${esc(form.so_number)} in SAP. The tray app on the SAP PC does this within a few minutes.</div>`;
    actions.insertAdjacentHTML("afterbegin", `<div class="card"><h2>${icon("clip")} Attachment in SAP</h2>${state}</div>`);
    const up = document.getElementById("uploadSap");
    if (up) {
      up.onclick = async () => {
        up.disabled = true;
        try { await sendPdfForSap(form.id); toast("PDF uploaded", "ok"); } catch (e) { toast(e.message, "bad"); }
        render();
      };
    }
    const retry = document.getElementById("retryAttach");
    if (retry) {
      retry.onclick = async () => {
        try { await post(`/api/forms/${form.id}/attach-retry`); toast("Will try again", "ok"); } catch (e) { toast(e.message, "bad"); }
        render();
      };
    }
  }

  const saveSo = document.getElementById("saveSo");
  if (saveSo) {
    saveSo.onclick = async () => {
      try {
        await post(`/api/forms/${form.id}/so`, { so_number: document.getElementById("so").value });
      } catch (e) { toast(e.message, "bad"); return; }
      try {
        await sendPdfForSap(form.id);
        toast("SO number saved. The PDF will be attached to the order in SAP.", "ok");
      } catch (e) {
        toast(`SO number saved, but the PDF for SAP was not uploaded: ${e.message}`, "bad");
      }
      render();
    };
  }

  const pdfButton = document.getElementById("pdf");
  if (pdfButton) {
    pdfButton.onclick = async () => {
      pdfButton.disabled = true;
      pdfButton.textContent = "Making PDF…";
      try {
        const { fresh, bytes } = await makePdf(form.id);
        const blob = new Blob([bytes], { type: "application/pdf" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${fresh.form.number}${fresh.form.so_number ? `_SO${fresh.form.so_number}` : ""}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      } catch (e) {
        toast(e.message, "bad");
      }
      pdfButton.disabled = false;
      pdfButton.innerHTML = `${icon("download")}Download PDF`;
    };
  }

  // View: the same PDF in a new tab. The tab is opened at the click
  // (later, after the PDF is built, a popup blocker would stop it) and
  // shows a note until the PDF is ready.
  const viewButton = document.getElementById("viewPdf");
  if (viewButton) {
    viewButton.onclick = async () => {
      const tab = window.open("", "_blank");
      if (tab) {
        tab.document.title = `${form.number} (PDF)`;
        tab.document.body.style.font = "16px system-ui, sans-serif";
        tab.document.body.textContent = "Making the PDF…";
      }
      viewButton.disabled = true;
      viewButton.textContent = "Making PDF…";
      try {
        const { bytes } = await makePdf(form.id);
        const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
        if (tab && !tab.closed) tab.location.href = url;
        else window.location.assign(url);          // popups blocked: open it here
        setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
      } catch (e) {
        if (tab && !tab.closed) tab.close();
        toast(e.message, "bad");
      }
      viewButton.disabled = false;
      viewButton.innerHTML = `${icon("eye")}View PDF`;
    };
  }
}

/** The full PDF for a form: the form, signatures, history, attachments. */
async function makePdf(formId) {
  const fresh = await call(`/api/forms/${formId}`);
  const bytes = await buildPdf(fresh, async (f) => {
    const res = await fetch(`/api/files/${f.id}`, { credentials: "same-origin" });
    if (!res.ok) throw new Error(`Could not load ${f.name}`);
    return new Uint8Array(await res.arrayBuffer());
  });
  return { fresh, bytes };
}

/** Make the PDF and hand it to the site, for the tray app to attach in SAP. */
async function sendPdfForSap(formId) {
  toast("Making the PDF for SAP…");
  const { bytes } = await makePdf(formId);
  await call(`/api/forms/${formId}/final-pdf`, {
    method: "POST", body: new Blob([bytes], { type: "application/pdf" }),
    headers: { "Content-Type": "application/pdf" },
  });
}

function describe(e) {
  return {
    created: "made the form",
    submitted: "sent it for approval",
    approved: `approved as ${roleLabel(e.role)}`,
    returned: `returned it as ${roleLabel(e.role)}`,
    sent_on: "sent it on",
    assigned: "sent it to the SAP user",
    final_pdf: "made the PDF for SAP",
    attach_ok: "attached the PDF to the order",
    attach_failed: "could not attach the PDF",
    attach_retry: "asked to attach it again",
    so_entered: "entered the SAP sales order",
    attached: "added a document",
    removed: "removed a document",
  }[e.action] || e.action;
}

// ------------------------------------------------------------ account

async function viewMe() {
  const stale = ticket();
  const { image } = await call("/api/me/signature");
  if (stale()) return;
  app.innerHTML = `
    <div class="page-head"><div><h1>My account</h1><div class="sub">Your signature and password</div></div></div>
    <section class="card"><div class="row" style="gap:14px">
      <span class="avatar" style="width:46px;height:46px;font-size:16px">${esc(initials(me.name))}</span>
      <div><b style="font-size:16px">${esc(me.name)}</b> <span class="muted">@${esc(me.username)}</span>
      <div class="muted small">${me.roles.map(roleLabel).map(esc).join(", ") || "No roles"}${me.brands.length ? ` · brands: ${me.brands.map(esc).join(", ")}` : ""}${me.is_admin ? " · admin" : ""}</div></div>
    </div></section>
    <section class="card">
      <h2>Signature</h2>
      <p class="muted" style="margin-top:0">Draw with a finger, pen or mouse. It is stamped on every form you approve, with your name, role, date and time.</p>
      ${image ? `<p>Current:</p><img class="sigshow" alt="Your signature" src="${esc(image)}">` : ""}
      <canvas class="sigpad" id="pad" aria-label="Signature pad"></canvas>
      <div class="row" style="margin-top:8px">
        <button type="button" id="clear">Clear</button>
        <button type="button" class="primary" id="saveSig">Save signature</button>
      </div>
    </section>
    <section class="card"><h2>Password</h2><button type="button" id="pw">Change password</button></section>`;

  const pad = document.getElementById("pad");
  const ratio = window.devicePixelRatio || 1;
  pad.width = pad.clientWidth * ratio;
  pad.height = pad.clientHeight * ratio;
  const ctx = pad.getContext("2d");
  ctx.scale(ratio, ratio);
  ctx.lineWidth = 2.4;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#0b2a6b";
  let drawing = false;
  let drawn = false;
  const at = (e) => {
    const r = pad.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  pad.onpointerdown = (e) => {
    drawing = true;
    drawn = true;
    pad.setPointerCapture(e.pointerId);
    ctx.beginPath();
    ctx.moveTo(...at(e));
  };
  pad.onpointermove = (e) => {
    if (!drawing) return;
    ctx.lineTo(...at(e));
    ctx.stroke();
  };
  pad.onpointerup = () => { drawing = false; };
  document.getElementById("clear").onclick = () => {
    ctx.clearRect(0, 0, pad.width, pad.height);
    drawn = false;
  };
  document.getElementById("saveSig").onclick = async () => {
    if (!drawn) { toast("Draw your signature first", "bad"); return; }
    try {
      await put("/api/me/signature", { image: trimmed(pad) });
      me.has_signature = true;
      toast("Signature saved", "ok");
      render();
    } catch (e) { toast(e.message, "bad"); }
  };
  document.getElementById("pw").onclick = () => viewPassword(false);
}

/** The drawing cropped to its ink, as a PNG data URL. */
function trimmed(canvas) {
  const ctx = canvas.getContext("2d");
  const { width, height } = canvas;
  const pixels = ctx.getImageData(0, 0, width, height).data;
  let top = height, left = width, right = 0, bottom = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[(y * width + x) * 4 + 3] > 0) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  if (right <= left || bottom <= top) return canvas.toDataURL("image/png");
  const pad = 6;
  const out = document.createElement("canvas");
  out.width = right - left + pad * 2;
  out.height = bottom - top + pad * 2;
  out.getContext("2d").drawImage(canvas, left, top, right - left, bottom - top,
    pad, pad, right - left, bottom - top);
  return out.toDataURL("image/png");
}

// -------------------------------------------------------------- admin

function roleChips(selected, name) {
  return `<div class="chips">${Object.entries(ROLES).map(([k, l]) => `
    <label><input type="checkbox" name="${name}" value="${k}" ${selected.includes(k) ? "checked" : ""}> ${esc(l)}</label>`).join("")}</div>`;
}

const splitBrands = (text) => text.split(",").map((s) => s.trim()).filter(Boolean);

async function viewUsers() {
  const stale = ticket();
  const { users } = await call("/api/admin/users");
  if (stale()) return;
  app.innerHTML = `
    <div class="page-head"><div><h1>Users</h1><div class="sub">Who can sign in, and what each person does</div></div></div>
    <section class="card flush"><table>
      <thead><tr><th>Name</th><th>Roles</th><th class="hide-sm">Brands</th><th></th></tr></thead>
      <tbody>${users.map((u) => `<tr>
        <td><div class="row" style="gap:10px;flex-wrap:nowrap"><span class="avatar">${esc(initials(u.name))}</span><div><b>${esc(u.name)}</b><span class="sub">@${esc(u.username)}${u.is_admin ? " · admin" : ""}${u.active ? "" : " · switched off"}${u.has_signature ? "" : " · no signature"}</span></div></div></td>
        <td>${u.roles.map(roleLabel).map(esc).join(", ")}</td>
        <td class="hide-sm">${esc(u.brands.join(", ") || "all")}</td>
        <td><button type="button" data-edit="${u.id}">Edit</button></td></tr>`).join("")}</tbody></table></section>
    <section class="card" id="editor"></section>`;
  const editor = document.getElementById("editor");
  const open = (u) => {
    editor.innerHTML = `<h2>${u ? `Edit ${esc(u.name)}` : "Add a person"}</h2><form id="uf">
      <div id="umsg"></div>
      <div class="grid">
        <label>Username<input name="username" value="${esc(u ? u.username : "")}" ${u ? "readonly" : "required"}></label>
        <label>Full name<input name="name" value="${esc(u ? u.name : "")}" required></label>
        <label>${u ? "New temporary password (blank = keep)" : "Temporary password"}<input name="password" type="text" autocomplete="off" ${u ? "" : "required"}></label>
        <label>Brands (comma separated; blank or ALL = every brand)<input name="brands" value="${esc(u ? u.brands.join(", ") : "")}"></label>
      </div>
      <p style="margin:12px 0 4px">Roles</p>${roleChips(u ? u.roles : [], "role")}
      <div class="chips" style="margin-top:10px">
        <label><input type="checkbox" name="is_admin" ${u && u.is_admin ? "checked" : ""}> Admin</label>
        ${u ? `<label><input type="checkbox" name="active" ${u.active ? "checked" : ""}> Can log in</label>` : ""}
      </div>
      <p class="muted" style="font-size:13px">A temporary password must be changed at first login. Give it to the person directly, not by group chat.</p>
      <div class="row end"><button type="button" id="cancel">Cancel</button><button class="primary">${u ? "Save" : "Add person"}</button></div>
    </form>`;
    const f = document.getElementById("uf");
    document.getElementById("cancel").onclick = () => open(null);
    f.onsubmit = async (e) => {
      e.preventDefault();
      const payload = {
        name: f.name.value,
        roles: [...f.querySelectorAll("input[name=role]:checked")].map((i) => i.value),
        brands: splitBrands(f.brands.value),
        is_admin: f.is_admin.checked,
      };
      if (f.password.value) payload.password = f.password.value;
      try {
        if (u) {
          payload.active = f.active.checked;
          await put(`/api/admin/users/${u.id}`, payload);
        } else {
          payload.username = f.username.value;
          await post("/api/admin/users", payload);
        }
        toast("Saved", "ok");
        viewUsers();
      } catch (err) {
        document.getElementById("umsg").innerHTML = `<div class="note bad">${esc(err.message)}</div>`;
      }
    };
  };
  open(null);
  app.querySelectorAll("[data-edit]").forEach((b) => {
    b.onclick = () => {
      open(users.find((u) => u.id === Number(b.dataset.edit)));
      editor.scrollIntoView({ behavior: "smooth" });
    };
  });
}

async function viewRules() {
  const stale = ticket();
  const [settings, { approvers }] = await Promise.all([call("/api/rules"), call("/api/approvers")]);
  if (stale()) return;
  let rules = settings.rules.map((r) => ({ ...r, chain: r.chain.slice() }));
  let fallback = settings.default_chain.slice();
  let active = settings.rules_active !== false;
  // Who could act on a step: for a rule limited to brands, someone who
  // holds the role for each of those brands.
  const who = (role, brands) => {
    const list = (brands || []).filter(Boolean);
    const names = approvers.filter((u) => (list.length
      ? list.every((b) => holds(u, role, b)) : holds(u, role, "") || u.roles.includes(role))).map((u) => u.name);
    return names;
  };
  const chainEditor = (chain, key) => `
    <div class="chain-edit" data-chain="${key}">Chain:
      ${chain.map((c, j) => {
        const names = who(c, key === "default" ? [] : rules[key].brands);
        return `<span class="pill" style="${names.length ? "" : "background:var(--bad-bg);color:var(--bad)"}" title="${esc(names.join(", ") || "nobody holds this role")}">${j + 1}. ${esc(roleLabel(c))} · ${esc(names.length ? names.join(", ") : "nobody")}<button type="button" data-rm="${j}" aria-label="Remove ${esc(roleLabel(c))}">✕</button></span>`;
      }).join("")}
      <select data-add aria-label="Add a step"><option value="">+ add step</option>${APPROVER_ROLES.filter((x) => !chain.includes(x)).map((x) => `<option value="${x}">${esc(roleLabel(x))}</option>`).join("")}</select>
    </div>`;
  const draw = () => {
    app.innerHTML = `
      <div class="page-head"><div><h1>Approval rules</h1><div class="sub">Who approves which form</div></div></div>
      <div class="card switch">
        <input type="checkbox" id="active" ${active ? "checked" : ""}>
        <label for="active" style="color:var(--ink);font-size:15px;font-weight:400"><b>Use approval rules</b><br>
          <span class="muted">${active
            ? "On: the rules below pick who approves each form."
            : "Off: the sales person chooses who approves each form, in order. The rules below are kept but not used."}</span></label>
      </div>
      <div style="${active ? "" : "opacity:.55"}">
      <p class="muted">When a form is sent, the first rule whose conditions <b>all</b> hold picks the chain. A blank condition always holds. A form keeps the chain it was sent with, even if the rules change later. A step shown in red has nobody to approve it, so forms needing it cannot be sent.</p>
      <div id="rmsg"></div>
      <div id="rules">${rules.map((r, i) => `
        <div class="rule" data-i="${i}">
          <div class="grid">
            <label>Name<input data-f="name" value="${esc(r.name)}"></label>
            <label>Brands (comma; blank or ALL = any brand)<input data-f="brands" value="${esc((r.brands || []).join(", "))}"></label>
            <label>Discount at least (% of MRP)<input data-f="min_discount_pct" inputmode="decimal" value="${esc(r.min_discount_pct ?? "")}"></label>
            <label>Invoice value at least<input data-f="min_invoice" inputmode="decimal" value="${esc(r.min_invoice ?? "")}"></label>
          </div>
          ${chainEditor(r.chain, i)}
          <div class="row end" style="margin-top:8px">
            <button type="button" data-up ${i === 0 ? "disabled" : ""}>Move up</button>
            <button type="button" class="danger" data-del>Delete rule</button>
          </div>
        </div>`).join("")}</div>
      <div class="rule" style="border-style:dashed">
        <b>If no rule fits</b> <span class="muted">(every form that matches none of the rules above)</span>
        ${chainEditor(fallback, "default")}
      </div>
      </div>
      <div class="row" style="justify-content:space-between">
        <button type="button" id="addRule">+ Add rule</button>
        <button type="button" class="primary" id="saveRules">Save rules</button>
      </div>`;
    // Only the numbered rules; the "If no rule fits" box is wired below.
    app.querySelectorAll(".rule[data-i]").forEach((el) => {
      const i = Number(el.dataset.i);
      el.querySelectorAll("[data-f]").forEach((input) => {
        input.oninput = () => {
          const f = input.dataset.f;
          rules[i][f] = f === "brands" ? splitBrands(input.value) : input.value;
        };
      });
      el.querySelectorAll("[data-rm]").forEach((b) => {
        b.onclick = () => { rules[i].chain.splice(Number(b.dataset.rm), 1); draw(); };
      });
      el.querySelector("[data-add]").onchange = (e) => {
        if (e.target.value) { rules[i].chain.push(e.target.value); draw(); }
      };
      el.querySelector("[data-f=brands]").onchange = () => draw();   // refresh who can act
      el.querySelector("[data-up]").onclick = () => {
        [rules[i - 1], rules[i]] = [rules[i], rules[i - 1]];
        draw();
      };
      el.querySelector("[data-del]").onclick = () => {
        ask({ title: `Delete rule "${rules[i].name}"?`, ok: "Delete", danger: true })
          .then((yes) => { if (yes) { rules.splice(i, 1); draw(); } });
      };
    });
    document.getElementById("active").onchange = (e) => { active = e.target.checked; draw(); };
    const fb = app.querySelector("[data-chain=default]");
    fb.querySelectorAll("[data-rm]").forEach((b) => {
      b.onclick = () => { fallback.splice(Number(b.dataset.rm), 1); draw(); };
    });
    fb.querySelector("[data-add]").onchange = (e) => {
      if (e.target.value) { fallback.push(e.target.value); draw(); }
    };
    document.getElementById("addRule").onclick = () => {
      rules.push({ name: `Rule ${rules.length + 1}`, brands: [], min_discount_pct: "", min_invoice: "", chain: fallback.slice() });
      draw();
    };
    document.getElementById("saveRules").onclick = async () => {
      try {
        const saved = await put("/api/admin/rules", { rules, default_chain: fallback, rules_active: active });
        rules = saved.rules;
        fallback = saved.default_chain;
        active = saved.rules_active;
        toast("Rules saved", "ok");
        draw();
      } catch (e) {
        document.getElementById("rmsg").innerHTML = `<div class="note bad">${esc(e.message)}</div>`;
      }
    };
  };
  draw();
}

render();
