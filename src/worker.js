// SO approvals: the API behind the site. Static pages come from ./public;
// every /api/* request runs here. Data is in D1 (binding DB).

import {
  APPROVER_ROLES, CREATOR_ROLES, DEFAULT_CHAIN, FINAL_ROLES, ROLES, canAct, checkForm, holds, normBrands, parsePicks,
  pickChain, stepOf, totals,
} from "../public/shared.js";

const SESSION_HOURS = 12;
const PBKDF2_ITERATIONS = 100000;          // the most Workers allow
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const MAX_FILE = 10 * 1024 * 1024;
const MAX_FILES = 15;
const CHUNK = 1024 * 1024;
const MAX_SIGNATURE = 300 * 1024;
const MAX_FINAL_PDF = 60 * 1024 * 1024;     // the form plus every attachment
const FILE_TYPES = {
  "application/pdf": [0x25, 0x50, 0x44, 0x46],          // %PDF
  "image/png": [0x89, 0x50, 0x4e, 0x47],
  "image/jpeg": [0xff, 0xd8, 0xff],
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const fail = (status, message) => { throw new HttpError(status, message); };

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

async function body(request, limit = 512 * 1024) {
  const text = await request.text();
  if (text.length > limit) fail(413, "Request too large");
  try {
    return JSON.parse(text || "{}");
  } catch {
    fail(400, "Request is not JSON");
  }
}

const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const parse = (text, fallback) => {
  try { return JSON.parse(text); } catch { return fallback; }
};

// ------------------------------------------------------------ passwords

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (s) => new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16)));

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITERATIONS}$${hex(salt)}$${await pbkdf2(password, salt, PBKDF2_ITERATIONS)}`;
}

async function checkPassword(password, stored) {
  const [scheme, iterations, salt, hash] = String(stored || "").split("$");
  if (scheme !== "pbkdf2" || !hash) return false;
  const got = await pbkdf2(password, unhex(salt), Number(iterations));
  let diff = got.length ^ hash.length;
  for (let i = 0; i < Math.min(got.length, hash.length); i++) {
    diff |= got.charCodeAt(i) ^ hash.charCodeAt(i);
  }
  return diff === 0;
}

function passwordProblem(password, username) {
  const p = String(password || "");
  if (p.length < 10) return "Password must be at least 10 characters";
  if (username && p.toLowerCase().includes(String(username).toLowerCase())) {
    return "Password must not contain the username";
  }
  if (!/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) return "Password needs letters and numbers";
  return "";
}

async function sha256(text) {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

// ------------------------------------------------------------- sessions

function cookieToken(request) {
  const match = /(?:^|;\s*)sid=([A-Za-z0-9_-]{20,})/.exec(request.headers.get("Cookie") || "");
  return match ? match[1] : "";
}

function cookie(token, maxAge) {
  return `sid=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    roles: parse(row.roles, []),
    brands: parse(row.brands, []),
    is_admin: !!row.is_admin,
    active: !!row.active,
    must_change: !!row.must_change,
    has_signature: !!row.signature,
  };
}

async function currentUser(env, request) {
  const token = cookieToken(request);
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`,
  ).bind(await sha256(token), now()).first();
  return row ? { ...publicUser(row), signature: row.signature } : null;
}

async function login(env, request) {
  const { username, password } = await body(request, 4096);
  if (!username || !password) fail(400, "Give a username and password");
  const row = await env.DB.prepare("SELECT * FROM users WHERE username = ?")
    .bind(String(username).trim()).first();
  if (row && row.locked_until && row.locked_until > now()) {
    fail(429, `Too many wrong passwords. Try again after ${row.locked_until.slice(11, 16)} UTC.`);
  }
  // Hash even for an unknown user, so the reply time does not tell
  // whether the username exists.
  const ok = await checkPassword(password, row ? row.password
    : "pbkdf2$100000$00000000000000000000000000000000$00");
  if (!row || !ok || !row.active) {
    if (row) {
      const failed = row.failed_logins + 1;
      const lock = failed >= MAX_FAILED
        ? new Date(Date.now() + LOCK_MINUTES * 60000).toISOString().replace("T", " ").slice(0, 19)
        : null;
      await env.DB.prepare("UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?")
        .bind(lock ? 0 : failed, lock, row.id).run();
    }
    fail(401, "Wrong username or password");
  }
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const expires = new Date(Date.now() + SESSION_HOURS * 3600000).toISOString()
    .replace("T", " ").slice(0, 19);
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?").bind(row.id),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now()),
    env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .bind(await sha256(token), row.id, expires),
  ]);
  return json({ user: publicUser(row) }, 200, { "Set-Cookie": cookie(token, SESSION_HOURS * 3600) });
}

async function logout(env, request) {
  const token = cookieToken(request);
  if (token) {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  }
  return json({ ok: true }, 200, { "Set-Cookie": cookie("x".repeat(20), 0) });
}

async function changePassword(env, request, user) {
  const { old_password, new_password } = await body(request, 4096);
  const row = await env.DB.prepare("SELECT password FROM users WHERE id = ?").bind(user.id).first();
  if (!(await checkPassword(old_password || "", row.password))) fail(400, "The current password is wrong");
  const problem = passwordProblem(new_password, user.username);
  if (problem) fail(400, problem);
  if (new_password === old_password) fail(400, "Choose a new password, not the same one");
  const token = cookieToken(request);
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET password = ?, must_change = 0 WHERE id = ?")
      .bind(await hashPassword(new_password), user.id),
    // Sign out everywhere else.
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?")
      .bind(user.id, await sha256(token)),
  ]);
  return json({ ok: true });
}

async function saveSignature(env, request, user) {
  const { image } = await body(request, MAX_SIGNATURE + 1024);
  if (typeof image !== "string" || !image.startsWith("data:image/png;base64,")) {
    fail(400, "The signature must be a PNG drawing");
  }
  if (image.length > MAX_SIGNATURE) fail(413, "The signature image is too large");
  await env.DB.prepare("UPDATE users SET signature = ? WHERE id = ?").bind(image, user.id).run();
  return json({ ok: true });
}

// ---------------------------------------------------------------- users

const allUsers = async (env) => (await env.DB.prepare("SELECT * FROM users ORDER BY name").all()).results;

function cleanRoles(roles) {
  if (!Array.isArray(roles)) fail(400, "roles must be a list");
  const bad = roles.filter((r) => !ROLES[r]);
  if (bad.length) fail(400, `Unknown role: ${bad.join(", ")}`);
  return [...new Set(roles)];
}

function cleanBrands(brands) {
  if (!Array.isArray(brands)) fail(400, "brands must be a list");
  return normBrands(brands);
}

async function adminCreateUser(env, request) {
  const b = await body(request, 8192);
  const username = String(b.username || "").trim();
  if (!/^[A-Za-z0-9._-]{3,30}$/.test(username)) fail(400, "Username: 3-30 letters, digits, . _ -");
  if (!String(b.name || "").trim()) fail(400, "Give the person's name");
  const problem = passwordProblem(b.password, username);
  if (problem) fail(400, `Temporary password: ${problem}`);
  try {
    await env.DB.prepare(
      `INSERT INTO users (username, name, roles, brands, is_admin, password, must_change)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
    ).bind(username, String(b.name).trim(), JSON.stringify(cleanRoles(b.roles || [])),
      JSON.stringify(cleanBrands(b.brands || [])), b.is_admin ? 1 : 0,
      await hashPassword(b.password)).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) fail(409, `Username ${username} is taken`);
    throw e;
  }
  return json({ ok: true });
}

async function adminUpdateUser(env, request, admin, id) {
  const b = await body(request, 8192);
  const row = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
  if (!row) fail(404, "No such user");
  if (id === admin.id && (b.is_admin === false || b.active === false)) {
    fail(400, "You cannot remove your own admin rights or switch yourself off");
  }
  const sets = [];
  const args = [];
  if (b.name !== undefined) { sets.push("name = ?"); args.push(String(b.name).trim() || row.name); }
  if (b.roles !== undefined) { sets.push("roles = ?"); args.push(JSON.stringify(cleanRoles(b.roles))); }
  if (b.brands !== undefined) { sets.push("brands = ?"); args.push(JSON.stringify(cleanBrands(b.brands))); }
  if (b.is_admin !== undefined) { sets.push("is_admin = ?"); args.push(b.is_admin ? 1 : 0); }
  if (b.active !== undefined) { sets.push("active = ?"); args.push(b.active ? 1 : 0); }
  const statements = [];
  if (b.password) {
    const problem = passwordProblem(b.password, row.username);
    if (problem) fail(400, `Temporary password: ${problem}`);
    sets.push("password = ?", "must_change = 1", "failed_logins = 0", "locked_until = NULL");
    args.push(await hashPassword(b.password));
  }
  if (!sets.length) fail(400, "Nothing to change");
  statements.push(env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).bind(...args, id));
  if (b.password || b.active === false) {
    statements.push(env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id));
  }
  await env.DB.batch(statements);
  return json({ ok: true });
}

// ---------------------------------------------------------------- rules

async function getSettings(env) {
  const rows = (await env.DB.prepare(
    "SELECT key, value FROM settings WHERE key IN ('rules', 'default_chain', 'rules_active')",
  ).all()).results;
  const get = (k, d) => parse((rows.find((r) => r.key === k) || {}).value, d);
  const fallback = get("default_chain", DEFAULT_CHAIN);
  return {
    rules: get("rules", []),
    default_chain: Array.isArray(fallback) && fallback.length ? fallback : DEFAULT_CHAIN,
    // Off: the sales person picks the approvers on each form.
    rules_active: get("rules_active", true) !== false,
  };
}

function cleanChain(chain, where) {
  if (!Array.isArray(chain) || !chain.length) fail(400, `${where}: the chain is empty`);
  const bad = chain.filter((c) => !APPROVER_ROLES.includes(c));
  if (bad.length) fail(400, `${where}: unknown step ${bad.join(", ")}`);
  if (new Set(chain).size !== chain.length) fail(400, `${where}: a step is listed twice`);
  return chain.slice();
}

async function saveRules(env, request) {
  const { rules, default_chain, rules_active } = await body(request, 64 * 1024);
  if (!Array.isArray(rules) || rules.length > 30) fail(400, "rules must be a list of up to 30");
  const fallback = cleanChain(default_chain || DEFAULT_CHAIN, "If no rule fits");
  const clean = rules.map((r, i) => {
    const chain = cleanChain(r.chain, `Rule ${i + 1}`);
    const number = (v, what) => {
      if (v === null || v === undefined || v === "") return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) fail(400, `Rule ${i + 1}: ${what} must be a number`);
      return n;
    };
    return {
      name: String(r.name || `Rule ${i + 1}`).trim().slice(0, 60),
      brands: cleanBrands(r.brands || []),
      min_discount_pct: number(r.min_discount_pct, "minimum discount %"),
      min_invoice: number(r.min_invoice, "minimum invoice value"),
      chain,
    };
  });
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('rules', ?)")
      .bind(JSON.stringify(clean)),
    env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('default_chain', ?)")
      .bind(JSON.stringify(fallback)),
    env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('rules_active', ?)")
      .bind(JSON.stringify(rules_active !== false)),
  ]);
  return json({ rules: clean, default_chain: fallback, rules_active: rules_active !== false });
}

// ---------------------------------------------------------------- forms

const AFTER_APPROVAL = ["approved", "with_sap", "done"];

function canView(user, form) {
  if (user.is_admin || form.owner_id === user.id) return true;
  if (form.sap_user_id === user.id) return true;
  // Sales Account routes every approved form to an SAP user.
  if (user.roles.includes("sales_account") && AFTER_APPROVAL.includes(form.status)) return true;
  const chain = parse(form.chain, []);
  const data = parse(form.data, {});
  // A person picked for a step sees the form even if their role has a
  // brand limit: the sales person chose them.
  return chain.map(stepOf).some((s) => (s.user_id ? s.user_id === user.id : holds(user, s.role, data.brand)));
}

function canDecide(user, form) {
  if (form.status !== "pending" || form.owner_id === user.id) return false;
  const chain = parse(form.chain, []);
  const data = parse(form.data, {});
  return canAct(user, chain[form.step], data.brand);
}

/**
 * Sales Account (or an admin) chooses the SAP user who will create the
 * SO: already while the form is with the approvers (it then goes straight
 * to that SAP user at the final approval), or after; and can change it
 * until the SO number is in.
 */
function canAssign(user, form) {
  return ["pending", "approved", "with_sap"].includes(form.status)
    && (user.is_admin || user.roles.includes("sales_account"));
}

async function sapUser(env, id) {
  const sap = await env.DB.prepare("SELECT * FROM users WHERE id = ? AND active = 1").bind(Number(id)).first();
  if (!sap || !parse(sap.roles, []).includes("sap_user")) fail(400, "Choose an SAP user");
  return sap;
}

const assignedRemark = (form, sap) => (form.sap_name && form.sap_user_id !== sap.id
  ? `to ${sap.name} (was ${form.sap_name})` : `to ${sap.name}`);

/** The SAP user it was sent to (or an admin) enters the SO number. */
function canEnterSo(user, form) {
  return ["with_sap", "done"].includes(form.status)
    && (user.is_admin || (form.sap_user_id === user.id && user.roles.includes("sap_user")));
}

function waitsFor(user, form) {
  if (canDecide(user, form)) return true;
  if (form.status === "approved") return canAssign(user, form);
  if (form.status === "with_sap") return form.sap_user_id === user.id;
  return false;
}

async function loadForm(env, user, id) {
  const form = await env.DB.prepare(
    `SELECT f.*, u.name AS owner_name, s.name AS sap_name FROM forms f
     JOIN users u ON u.id = f.owner_id LEFT JOIN users s ON s.id = f.sap_user_id WHERE f.id = ?`,
  ).bind(id).first();
  if (!form || !canView(user, form)) fail(404, "No such form");
  return form;
}

function summary(form) {
  const data = parse(form.data, {});
  const t = totals(data);
  const chain = parse(form.chain, []);
  return {
    id: form.id,
    number: form.number,
    status: form.status,
    owner_id: form.owner_id,
    owner_name: form.owner_name,
    customer: data.customer_name || "",
    dealer: data.dealer || "",
    brand: data.brand || "",
    model: data.model || "",
    invoice: t.invoice,
    waiting_for: form.status === "pending" ? stepOf(chain[form.step]).role : null,
    waiting_name: form.status === "pending" ? stepOf(chain[form.step]).name || null
      : form.status === "with_sap" ? form.sap_name : null,
    sap_name: form.sap_name || null,
    attach_status: form.attach_status || null,
    attach_message: form.attach_message || null,
    attached_at: form.attached_at || null,
    so_number: form.so_number,
    updated_at: form.updated_at,
  };
}

async function listForms(env, user, box) {
  const rows = (await env.DB.prepare(
    `SELECT f.*, u.name AS owner_name, s.name AS sap_name FROM forms f
     JOIN users u ON u.id = f.owner_id LEFT JOIN users s ON s.id = f.sap_user_id
     ORDER BY f.updated_at DESC LIMIT 500`,
  ).all()).results;
  let pick = rows.filter((f) => canView(user, f));
  if (box === "todo") pick = pick.filter((f) => waitsFor(user, f));
  if (box === "mine") pick = pick.filter((f) => f.owner_id === user.id);
  return json({ forms: pick.map(summary) });
}

async function nextNumber(env) {
  const year = new Date().getUTCFullYear();
  // A counter per year, so a deleted draft's number is never given out
  // again. It starts from the highest number already used.
  const row = await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES (?, (
       SELECT COALESCE(MAX(CAST(substr(number, 10) AS INTEGER)), 0) + 1 FROM forms WHERE number LIKE ?))
     ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1
     RETURNING value`,
  ).bind(`counter:${year}`, `SOA-${year}-%`).first();
  return `SOA-${year}-${String(Number(row.value)).padStart(4, "0")}`;
}

function cleanData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) fail(400, "data must be an object");
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (!/^[a-z_]{1,40}$/.test(k)) continue;
    if (Array.isArray(v)) out[k] = v.map((x) => String(x).slice(0, 200)).slice(0, 40);
    else if (v !== null && v !== undefined) out[k] = String(v).slice(0, 4000);
  }
  return out;
}

async function event(env, form, user, action, extra = {}) {
  return env.DB.prepare(
    `INSERT INTO events (form_id, user_id, user_name, action, role, step, remark, signature)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(form, user.id, user.name, action, extra.role || null,
    extra.step ?? null, extra.remark || null, extra.signature || null);
}

async function createForm(env, request, user) {
  if (!user.is_admin && !CREATOR_ROLES.some((r) => user.roles.includes(r))) {
    fail(403, "Only sales people and sales supervisors make forms");
  }
  const { data } = await body(request);
  for (let attempt = 0; attempt < 3; attempt++) {
    const number = await nextNumber(env);
    try {
      const res = await env.DB.prepare(
        "INSERT INTO forms (number, owner_id, data) VALUES (?, ?, ?)",
      ).bind(number, user.id, JSON.stringify(cleanData(data || {}))).run();
      const id = res.meta.last_row_id;
      await (await event(env, id, user, "created")).run();
      return json({ id, number });
    } catch (e) {
      if (!/UNIQUE/i.test(String(e))) throw e;
    }
  }
  fail(409, "Could not number the form, try again");
}

async function updateForm(env, request, user, id) {
  const form = await loadForm(env, user, id);
  if (form.owner_id !== user.id) fail(403, "Only the person who made the form can change it");
  if (!["draft", "returned"].includes(form.status)) fail(409, "The form is with the approvers; it cannot be changed now");
  const { data } = await body(request);
  await env.DB.prepare("UPDATE forms SET data = ?, updated_at = ? WHERE id = ?")
    .bind(JSON.stringify(cleanData(data || {})), now(), id).run();
  return json({ ok: true });
}

async function submitForm(env, user, id) {
  const form = await loadForm(env, user, id);
  if (form.owner_id !== user.id) fail(403, "Only the person who made the form can send it");
  if (!["draft", "returned"].includes(form.status)) fail(409, "The form has already been sent");
  const data = parse(form.data, {});
  const problems = checkForm(data);
  if (problems.length) return json({ problems }, 400);
  const settings = await getSettings(env);
  const users = (await allUsers(env)).filter((u) => u.active).map(publicUser);
  let rule;
  let chain;
  if (settings.rules_active) {
    ({ rule, chain } = pickChain(settings.rules, data, settings.default_chain));
    const missing = chain.filter((role) => !users.some((u) => u.id !== user.id
      && holds(u, role, data.brand)));
    if (missing.length) {
      return json({
        problems: missing.map((r) => `Nobody holds the role ${ROLES[r]} for brand ${data.brand}. Ask the admin to set one up.`),
      }, 400);
    }
  } else {
    // Rules switched off: the sales person picks the first approver; each
    // approver then picks the next, until a CFO, Dep. CEO or CEO gives
    // the final approval.
    const [first] = parsePicks(data.approvers);
    if (!first) return json({ problems: ["Choose who approves this form first (Approvals, below)"] }, 400);
    const problem = pickProblem(users, first, user, []);
    if (problem) return json({ problems: [problem] }, 400);
    chain = [{ role: first.role, user_id: first.user_id, name: users.find((u) => u.id === first.user_id).name }];
    rule = "Each approver chooses the next";
  }
  const res = await env.DB.prepare(
    `UPDATE forms SET status = 'pending', rule = ?, chain = ?, step = 0, updated_at = ?
     WHERE id = ? AND status IN ('draft', 'returned')`,
  ).bind(rule, JSON.stringify(chain), now(), id).run();
  if (!res.meta.changes) fail(409, "The form changed meanwhile; reload it");
  await (await event(env, id, user, "submitted", {
    remark: `Chain: ${rule}`, signature: user.signature,
  })).run();
  return json({ ok: true, rule, chain });
}

/** Why this person cannot be the next approver, or "" if they can. */
function pickProblem(users, pick, owner, approvedIds) {
  const u = users.find((x) => x.id === pick.user_id);
  if (!u) return "The chosen approver can no longer log in; choose someone else";
  if (u.id === owner.id) return "The person who made the form cannot approve it";
  if (!u.roles.includes(pick.role)) return `${u.name} is not ${ROLES[pick.role]}`;
  if (approvedIds.includes(u.id)) return `${u.name} has already approved this form`;
  return "";
}

async function decide(env, request, user, id) {
  const { action, remark, next, final, sap_user_id } = await body(request, 8192);
  const form = await loadForm(env, user, id);
  if (!canDecide(user, form)) fail(403, "This form is not waiting for you");
  const chain = parse(form.chain, []);
  const role = stepOf(chain[form.step]).role;
  const note = String(remark || "").trim().slice(0, 1000);
  if (action === "approve") {
    if (!user.signature) fail(400, "Draw your signature first (My account)");
    // Sales Account may name the SAP user while approving.
    let sap = null;
    if (sap_user_id) {
      if (!canAssign(user, form)) fail(403, "Only Sales Account chooses the SAP user");
      sap = await sapUser(env, sap_user_id);
    }
    const sapId = sap ? sap.id : form.sap_user_id;
    let last = form.step + 1 >= chain.length;
    let newChain = chain;
    // A form routed person by person: at the end of the chain so far, the
    // approver either sends it on to someone or gives the final approval.
    if (stepOf(chain[form.step]).user_id && last) {
      if (final) {
        if (!FINAL_ROLES.includes(role)) {
          fail(400, `Only the CFO, Dep. CEO or CEO can give the final approval. Choose who it goes to next.`);
        }
      } else {
        const [pick] = parsePicks([next]);
        if (!pick) fail(400, "Choose who the form goes to next, or give the final approval");
        const users = (await allUsers(env)).filter((u) => u.active).map(publicUser);
        const owner = { id: form.owner_id };
        const approved = chain.slice(0, form.step + 1).map((s) => stepOf(s).user_id);
        const problem = pickProblem(users, pick, owner, approved);
        if (problem) fail(400, problem);
        newChain = [...chain, { role: pick.role, user_id: pick.user_id, name: users.find((u) => u.id === pick.user_id).name }];
        last = false;
      }
    }
    // Fully approved: straight to the SAP user if one is already chosen.
    const status = !last ? "pending" : sapId ? "with_sap" : "approved";
    const res = await env.DB.prepare(
      `UPDATE forms SET step = ?, status = ?, chain = ?, sap_user_id = ?, updated_at = ?
       WHERE id = ? AND status = 'pending' AND step = ?`,
    ).bind(last ? form.step : form.step + 1, status,
      JSON.stringify(newChain), sapId || null, now(), id, form.step).run();
    if (!res.meta.changes) fail(409, "Someone else acted on this form just now; reload it");
    await (await event(env, id, user, "approved", {
      role, step: form.step, remark: note, signature: user.signature,
    })).run();
    if (sap && sap.id !== form.sap_user_id) {
      await (await event(env, id, user, "assigned", { remark: assignedRemark(form, sap) })).run();
    }
    if (newChain !== chain) {
      const to = newChain[newChain.length - 1];
      await (await event(env, id, user, "sent_on", {
        role, step: form.step, remark: `to ${to.name} (${ROLES[to.role]})`,
      })).run();
    }
    return json({ ok: true, status });
  }
  if (action === "return") {
    if (!note) fail(400, "Say what needs changing");
    const res = await env.DB.prepare(
      `UPDATE forms SET status = 'returned', step = 0, updated_at = ?
       WHERE id = ? AND status = 'pending' AND step = ?`,
    ).bind(now(), id, form.step).run();
    if (!res.meta.changes) fail(409, "Someone else acted on this form just now; reload it");
    await (await event(env, id, user, "returned", { role, step: form.step, remark: note })).run();
    return json({ ok: true, status: "returned" });
  }
  fail(400, "action must be approve or return");
}

async function setSoNumber(env, request, user, id) {
  const { so_number } = await body(request, 1024);
  const form = await loadForm(env, user, id);
  if (!canEnterSo(user, form)) {
    fail(form.status === "approved" ? 409 : 403, form.status === "approved"
      ? "Sales Account must first send the form to an SAP user"
      : "Only the SAP user the form was sent to can enter the SO number");
  }
  const so = String(so_number || "").trim();
  if (!/^\d{6,10}$/.test(so)) fail(400, "The SO number is 6 to 10 digits");
  await env.DB.prepare(
    `UPDATE forms SET so_number = ?, status = 'done', updated_at = ?,
       attach_status = NULL, attach_message = NULL, attached_at = NULL WHERE id = ?`,
  ).bind(so, now(), id).run();
  await (await event(env, id, user, "so_entered", {
    remark: form.so_number ? `SO ${so} (was ${form.so_number})` : `SO ${so}`,
  })).run();
  return json({ ok: true });
}

async function assignSap(env, request, user, id) {
  const { user_id } = await body(request, 1024);
  const form = await loadForm(env, user, id);
  if (!canAssign(user, form)) {
    fail(403, form.status === "done" ? "The SO is already created" : "Only Sales Account sends approved forms to an SAP user");
  }
  const sap = await sapUser(env, user_id);
  // While still with the approvers the form stays with them; it goes to
  // the SAP user at the final approval.
  const res = await env.DB.prepare(
    `UPDATE forms SET sap_user_id = ?, updated_at = ?,
       status = CASE WHEN status = 'pending' THEN 'pending' ELSE 'with_sap' END
     WHERE id = ? AND status IN ('pending', 'approved', 'with_sap')`,
  ).bind(sap.id, now(), id).run();
  if (!res.meta.changes) fail(409, "The form changed meanwhile; reload it");
  await (await event(env, id, user, "assigned", { remark: assignedRemark(form, sap) })).run();
  return json({ ok: true });
}

async function formDetail(env, user, id) {
  const form = await loadForm(env, user, id);
  const events = (await env.DB.prepare("SELECT * FROM events WHERE form_id = ? ORDER BY id")
    .bind(id).all()).results;
  const files = (await env.DB.prepare(
    "SELECT id, name, type, size, at FROM files WHERE form_id = ? AND final = 0 ORDER BY id",
  ).bind(id).all()).results;
  const finalPdf = await env.DB.prepare(
    "SELECT id, name, size, at FROM files WHERE form_id = ? AND final = 1 ORDER BY id DESC LIMIT 1",
  ).bind(id).first();
  const chain = parse(form.chain, []);
  const data = parse(form.data, {});
  // Approvals of the current round: after the last submission.
  let lastSubmit = -1;
  events.forEach((e, i) => { if (e.action === "submitted") lastSubmit = i; });
  const round = lastSubmit < 0 ? [] : events.slice(lastSubmit + 1);
  const sent = lastSubmit < 0 ? null : events[lastSubmit];
  const users = (await allUsers(env)).filter((u) => u.active).map(publicUser);
  const steps = chain.map(stepOf).map((s, i) => {
    const done = round.find((e) => e.action === "approved" && e.step === i);
    return {
      role: s.role,
      label: ROLES[s.role],
      person: s.name || null,
      done: done ? { name: done.user_name, at: done.at, remark: done.remark, signature: done.signature } : null,
      current: form.status === "pending" && form.step === i,
      holders: users.filter((u) => u.id !== form.owner_id && canAct(u, s, data.brand))
        .map((u) => u.name),
    };
  });
  return json({
    form: {
      ...summary(form), data, rule: form.rule, chain, step: form.step,
      created_at: form.created_at,
    },
    steps,
    submitted: sent ? { name: sent.user_name, at: sent.at, signature: sent.signature } : null,
    events: events.map((e) => ({ ...e, signature: undefined })),
    files,
    final_pdf: finalPdf || null,
    can: {
      edit: form.owner_id === user.id && ["draft", "returned"].includes(form.status),
      decide: canDecide(user, form),
      remove: form.status === "draft" && (form.owner_id === user.id || user.is_admin),
      assign: canAssign(user, form),
      so: canEnterSo(user, form),
      retry_attach: form.status === "done" && !!finalPdf && form.attach_status === "failed"
        && (canEnterSo(user, form) || user.roles.includes("sales_account")),
    },
  });
}

async function deleteForm(env, user, id) {
  const form = await loadForm(env, user, id);
  if (form.owner_id !== user.id && !user.is_admin) fail(403, "Only the person who made the form can delete it");
  if (form.status !== "draft") fail(409, "Only a draft that was never sent can be deleted");
  const res = await env.DB.batch([
    env.DB.prepare("DELETE FROM file_chunks WHERE file_id IN (SELECT id FROM files WHERE form_id = ?)").bind(id),
    env.DB.prepare("DELETE FROM files WHERE form_id = ?").bind(id),
    env.DB.prepare("DELETE FROM events WHERE form_id = ?").bind(id),
    env.DB.prepare("DELETE FROM forms WHERE id = ? AND status = 'draft'").bind(id),
  ]);
  if (!res[3].meta.changes) fail(409, "The form changed meanwhile; reload it");
  return json({ ok: true });
}

// ---------------------------------------------------------------- files

async function uploadFile(env, request, user, id) {
  const form = await loadForm(env, user, id);
  if (form.owner_id !== user.id || !["draft", "returned"].includes(form.status)) {
    fail(403, "Documents can be added by the sales person while the form is a draft");
  }
  const type = (request.headers.get("Content-Type") || "").split(";")[0].trim();
  if (!FILE_TYPES[type]) fail(415, "Only PDF, PNG and JPG files");
  const name = decodeURIComponent(request.headers.get("X-File-Name") || "document")
    .replace(/[^\w.\- ()]/g, "_").slice(0, 120);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length) fail(400, "The file is empty");
  if (bytes.length > MAX_FILE) fail(413, "Files can be up to 10 MB");
  if (!FILE_TYPES[type].every((b, i) => bytes[i] === b)) fail(415, `The file is not really a ${type.split("/")[1].toUpperCase()}`);
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM files WHERE form_id = ? AND final = 0").bind(id).first();
  if (count.n >= MAX_FILES) fail(409, `Up to ${MAX_FILES} documents per form`);
  const fileId = await storeFile(env, id, name, type, bytes, user.id, false);
  await (await event(env, id, user, "attached", { remark: name })).run();
  return json({ id: fileId, name });
}

async function storeFile(env, formId, name, type, bytes, userId, final) {
  const res = await env.DB.prepare(
    "INSERT INTO files (form_id, name, type, size, uploaded_by, final) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(formId, name, type, bytes.length, userId, final ? 1 : 0).run();
  const fileId = res.meta.last_row_id;
  const chunks = [];
  for (let seq = 0, at = 0; at < bytes.length; seq++, at += CHUNK) {
    chunks.push(env.DB.prepare("INSERT INTO file_chunks (file_id, seq, data) VALUES (?, ?, ?)")
      .bind(fileId, seq, bytes.slice(at, at + CHUNK)));
  }
  // D1 takes a limited number of statements per batch.
  for (let i = 0; i < chunks.length; i += 20) await env.DB.batch(chunks.slice(i, i + 20));
  return fileId;
}

/** The SAP user's browser uploads the finished PDF once the SO number is in. */
async function uploadFinalPdf(env, request, user, id) {
  const form = await loadForm(env, user, id);
  if (form.status !== "done" || !canEnterSo(user, form)) {
    fail(403, "The PDF for SAP is made by the SAP user once the SO number is entered");
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length < 5 || !FILE_TYPES["application/pdf"].every((b, i) => bytes[i] === b)) fail(415, "Not a PDF");
  if (bytes.length > MAX_FINAL_PDF) fail(413, "The PDF is larger than 60 MB");
  const old = (await env.DB.prepare("SELECT id FROM files WHERE form_id = ? AND final = 1").bind(id).all()).results;
  for (const f of old) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM file_chunks WHERE file_id = ?").bind(f.id),
      env.DB.prepare("DELETE FROM files WHERE id = ?").bind(f.id),
    ]);
  }
  await storeFile(env, id, `${form.number}_SO${form.so_number}.pdf`, "application/pdf", bytes, user.id, true);
  await env.DB.prepare(
    "UPDATE forms SET attach_status = 'waiting', attach_message = NULL, attached_at = NULL WHERE id = ?",
  ).bind(id).run();
  await (await event(env, id, user, "final_pdf", { remark: `${Math.round(bytes.length / 1024)} KB` })).run();
  return json({ ok: true });
}

async function retryAttach(env, user, id) {
  const form = await loadForm(env, user, id);
  if (form.status !== "done" || (!canEnterSo(user, form) && !user.roles.includes("sales_account"))) {
    fail(403, "Not allowed");
  }
  await env.DB.prepare(
    "UPDATE forms SET attach_status = 'waiting', attach_message = NULL WHERE id = ? AND status = 'done'",
  ).bind(id).run();
  await (await event(env, id, user, "attach_retry")).run();
  return json({ ok: true });
}

// The tray app on the SAP PC: it alone can reach SAP. It asks which
// forms wait to be attached, downloads each PDF, attaches it in VA02 and
// reports back. It proves itself with RELAY_TOKEN (a Worker secret).
async function relayAllowed(env, request) {
  const given = request.headers.get("X-Relay-Token") || "";
  if (!env.RELAY_TOKEN || !given) return false;
  return (await sha256(given)) === (await sha256(env.RELAY_TOKEN));
}

async function relay(env, request, path, method) {
  if (!(await relayAllowed(env, request))) fail(401, "Relay token missing or wrong");
  if (path === "/api/relay/attach-queue" && method === "GET") {
    const rows = (await env.DB.prepare(
      `SELECT f.id, f.number, f.so_number,
         (SELECT id FROM files WHERE form_id = f.id AND final = 1 ORDER BY id DESC LIMIT 1) AS file_id
       FROM forms f WHERE f.status = 'done' AND f.attach_status = 'waiting' ORDER BY f.updated_at LIMIT 20`,
    ).all()).results.filter((r) => r.file_id);
    return json({ forms: rows });
  }
  let m = /^\/api\/relay\/files\/(\d+)$/.exec(path);
  if (m && method === "GET") {
    const file = await env.DB.prepare("SELECT * FROM files WHERE id = ? AND final = 1").bind(Number(m[1])).first();
    if (!file) fail(404, "No such file");
    return fileResponse(env, file);
  }
  m = /^\/api\/relay\/forms\/(\d+)\/result$/.exec(path);
  if (m && method === "POST") {
    const { ok, message, so_number } = await body(request, 8192);
    const id = Number(m[1]);
    const form = await env.DB.prepare("SELECT * FROM forms WHERE id = ?").bind(id).first();
    if (!form) fail(404, "No such form");
    // A result for an SO number that has since been corrected is stale.
    if (String(so_number) !== String(form.so_number)) return json({ ok: false, stale: true });
    const text = String(message || "").slice(0, 1000);
    await env.DB.prepare(
      "UPDATE forms SET attach_status = ?, attach_message = ?, attached_at = ? WHERE id = ?",
    ).bind(ok ? "attached" : "failed", text, ok ? now() : null, id).run();
    const actor = { id: form.sap_user_id || form.owner_id, name: "SAP (tray app)" };
    await (await event(env, id, actor, ok ? "attach_ok" : "attach_failed",
      { remark: `SO ${form.so_number}: ${text}` })).run();
    return json({ ok: true });
  }
  fail(404, "Not found");
}

async function getFile(env, user, fileId) {
  const file = await env.DB.prepare("SELECT * FROM files WHERE id = ?").bind(fileId).first();
  if (!file) fail(404, "No such file");
  await loadForm(env, user, file.form_id);      // throws unless allowed to see the form
  return fileResponse(env, file);
}

async function fileResponse(env, file) {
  const fileId = file.id;
  const chunks = (await env.DB.prepare(
    "SELECT data FROM file_chunks WHERE file_id = ? ORDER BY seq",
  ).bind(fileId).all()).results;
  const out = new Uint8Array(file.size);
  let at = 0;
  for (const c of chunks) {
    const part = new Uint8Array(c.data);
    out.set(part, at);
    at += part.length;
  }
  return new Response(out, {
    headers: {
      "Content-Type": file.type,
      "Content-Disposition": `inline; filename="${file.name.replace(/"/g, "")}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function deleteFile(env, user, fileId) {
  const file = await env.DB.prepare("SELECT * FROM files WHERE id = ?").bind(fileId).first();
  if (!file) fail(404, "No such file");
  const form = await loadForm(env, user, file.form_id);
  if (form.owner_id !== user.id || !["draft", "returned"].includes(form.status)) {
    fail(403, "Documents can be removed while the form is a draft");
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM file_chunks WHERE file_id = ?").bind(fileId),
    env.DB.prepare("DELETE FROM files WHERE id = ?").bind(fileId),
    await event(env, form.id, user, "removed", { remark: file.name }),
  ]);
  return json({ ok: true });
}

// --------------------------------------------------------------- router

async function api(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method;

  // Writes only from this site's own pages.
  if (method !== "GET") {
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) fail(403, "Cross-site request refused");
  }

  if (path.startsWith("/api/relay/")) return relay(env, request, path, method);
  if (path === "/api/login" && method === "POST") return login(env, request);
  if (path === "/api/logout" && method === "POST") return logout(env, request);

  const user = await currentUser(env, request);
  if (!user) fail(401, "Please log in");
  if (path === "/api/me" && method === "GET") return json({ user: { ...user, signature: undefined }, roles: ROLES });
  if (path === "/api/me/password" && method === "POST") return changePassword(env, request, user);
  if (user.must_change) fail(403, "Change your temporary password first");
  if (path === "/api/me/signature" && method === "PUT") return saveSignature(env, request, user);
  if (path === "/api/me/signature" && method === "GET") return json({ image: user.signature || null });
  if (path === "/api/rules" && method === "GET") return json(await getSettings(env));
  // Who holds which role, so a form can show its approvers before it is sent.
  if (path === "/api/approvers" && method === "GET") {
    return json({
      approvers: (await allUsers(env)).filter((u) => u.active).map((u) => ({
        id: u.id, name: u.name, roles: parse(u.roles, []), brands: parse(u.brands, []),
      })),
    });
  }

  if (path === "/api/forms" && method === "GET") return listForms(env, user, url.searchParams.get("box") || "all");
  if (path === "/api/forms" && method === "POST") return createForm(env, request, user);
  let m = /^\/api\/forms\/(\d+)(?:\/(submit|decide|so|files|assign|final-pdf|attach-retry))?$/.exec(path);
  if (m) {
    const id = Number(m[1]);
    const action = m[2];
    if (!action && method === "GET") return formDetail(env, user, id);
    if (!action && method === "PUT") return updateForm(env, request, user, id);
    if (!action && method === "DELETE") return deleteForm(env, user, id);
    if (action === "submit" && method === "POST") return submitForm(env, user, id);
    if (action === "decide" && method === "POST") return decide(env, request, user, id);
    if (action === "so" && method === "POST") return setSoNumber(env, request, user, id);
    if (action === "assign" && method === "POST") return assignSap(env, request, user, id);
    if (action === "final-pdf" && method === "POST") return uploadFinalPdf(env, request, user, id);
    if (action === "attach-retry" && method === "POST") return retryAttach(env, user, id);
    if (action === "files" && method === "POST") return uploadFile(env, request, user, id);
  }
  m = /^\/api\/files\/(\d+)$/.exec(path);
  if (m && method === "GET") return getFile(env, user, Number(m[1]));
  if (m && method === "DELETE") return deleteFile(env, user, Number(m[1]));

  if (path.startsWith("/api/admin/")) {
    if (!user.is_admin) fail(403, "Admins only");
    if (path === "/api/admin/users" && method === "GET") return json({ users: (await allUsers(env)).map(publicUser) });
    if (path === "/api/admin/users" && method === "POST") return adminCreateUser(env, request);
    m = /^\/api\/admin\/users\/(\d+)$/.exec(path);
    if (m && method === "PUT") return adminUpdateUser(env, request, user, Number(m[1]));
    if (path === "/api/admin/rules" && method === "PUT") return saveRules(env, request);
  }
  fail(404, "Not found");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      return await api(request, env);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: "Something went wrong on the server" }, 500);
    }
  },
};
