// End-to-end: starts the Worker locally on a fresh database, then runs a
// form from draft to SO number, plus the checks that must refuse things.
//   node test/api.test.mjs
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STATE = ".test-state";
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = "Test-pass-2026";
const win = process.platform === "win32";

rmSync(STATE, { recursive: true, force: true });
mkdirSync(STATE, { recursive: true });
const wrangler = (...a) => execFileSync("npx", ["wrangler", ...a], { stdio: "pipe", shell: win });
wrangler("d1", "migrations", "apply", "so-approvals", "--local", "--persist-to", STATE);

const hash = (p) => {
  const salt = randomBytes(16);
  return `pbkdf2$100000$${salt.toString("hex")}$${pbkdf2Sync(p, salt, 100000, 32, "sha256").toString("hex")}`;
};
const people = [
  ["admin", "Admin Person", [], 1, [], 0],
  ["ram", "Ram Sales", ["sales"], 0, [], 0],
  ["sita", "Sita Sales", ["sales"], 0, [], 0],
  ["sup", "Sup Visor", ["supervisor"], 0, ["GAC"], 0],
  ["hod", "Sap Two HOD", ["hod"], 0, [], 0],
  ["acc", "Acc Person", ["sales_account"], 0, [], 0],
  ["cfo", "Cfo CFO", ["cfo"], 0, [], 0],
  ["ceo", "Ceo Person", ["ceo", "dceo"], 0, [], 0],
  ["newbie", "New Person", ["sales"], 0, [], 1],
  ["sapu", "Sap User", ["sap_user"], 0, [], 0],
  ["sapu2", "Busy Sap", ["sap_user"], 0, [], 0],
];
const sql = people.map(([u, n, r, a, b, mc]) => `INSERT INTO users (username, name, roles, brands, is_admin, password, must_change)
  VALUES ('${u}', '${n}', '${JSON.stringify(r)}', '${JSON.stringify(b)}', ${a}, '${hash(PASSWORD)}', ${mc});`).join("\n");
writeFileSync(join(STATE, "seed.sql"), sql);
wrangler("d1", "execute", "so-approvals", "--local", "--persist-to", STATE, "--file", join(STATE, "seed.sql"), "--yes");

const server = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--ip", "127.0.0.1",
  "--persist-to", STATE, "--log-level", "warn"], { stdio: "pipe", shell: win });
let serverLog = "";
server.stdout.on("data", (d) => { serverLog += d; });
server.stderr.on("data", (d) => { serverLog += d; });
const stop = () => {
  if (win) { try { execFileSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* gone */ } }
  else server.kill();
};

async function waitUp() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${BASE}/api/me`);
      if (r.status === 401) return;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`wrangler dev did not start:\n${serverLog}`);
}

function client() {
  let cookie = "";
  const req = async (method, path, body, headers = {}) => {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body !== undefined && !(body instanceof Uint8Array) ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const type = res.headers.get("content-type") || "";
    return { status: res.status, body: type.includes("json") ? await res.json() : new Uint8Array(await res.arrayBuffer()) };
  };
  return {
    req,
    login: async (u, p = PASSWORD) => req("POST", "/api/login", { username: u, password: p }),
  };
}

const FORM = {
  dealer: "Individual Customer", customer_name: "Test Customer", customer_address: "Test Address",
  contact: "9800000000", pan: "123456789", brand: "GAC", model: "Test Model",
  mfg_year: "2024", vins: "TESTVIN0000000001", mrp: "5000000", regular_margin: "1000000",
  units: "1", billing_notes: "Deal Amount 4000000, Credit Note 500000",
};
const SIG = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64")}`;
const PDF = new Uint8Array(Buffer.from("%PDF-1.4\n% test\n"));
let passed = 0;
const check = async (name, fn) => {
  await fn();
  passed++;
  console.log(`ok  ${name}`);
};

try {
  await waitUp();
  const ram = client(); const sita = client(); const sup = client(); const hod = client();
  const acc = client(); const cfo = client(); const ceo = client(); const admin = client();
  const sapu = client(); const sapu2 = client();
  for (const [c, u] of [[ram, "ram"], [sita, "sita"], [sup, "sup"], [hod, "hod"], [acc, "acc"],
    [cfo, "cfo"], [ceo, "ceo"], [admin, "admin"], [sapu, "sapu"], [sapu2, "sapu2"]]) {
    assert.equal((await c.login(u)).status, 200, `login ${u}`);
  }

  await check("wrong password is refused, and 5 in a row lock the account", async () => {
    const c = client();
    for (let i = 0; i < 5; i++) assert.equal((await c.login("sita", "wrong-pass-1")).status, 401);
    const locked = await c.login("sita");
    assert.equal(locked.status, 429);
  });

  await check("a temporary password must be changed before anything else", async () => {
    const c = client();
    assert.equal((await c.login("newbie")).status, 200);
    assert.equal((await c.req("GET", "/api/forms")).status, 403);
    assert.equal((await c.req("POST", "/api/me/password", { old_password: PASSWORD, new_password: "short" })).status, 400);
    assert.equal((await c.req("POST", "/api/me/password", { old_password: PASSWORD, new_password: "Brand-new-pass-1" })).status, 200);
    assert.equal((await c.req("GET", "/api/forms")).status, 200);
  });

  await check("a request from another site is refused", async () => {
    const r = await ram.req("POST", "/api/forms", { data: FORM }, { Origin: "https://evil.example" });
    assert.equal(r.status, 403);
  });

  let id;
  await check("sales person makes a draft; an incomplete form cannot be sent", async () => {
    const r = await ram.req("POST", "/api/forms", { data: { ...FORM, pan: "" } });
    assert.equal(r.status, 200);
    id = r.body.id;
    assert.match(r.body.number, /^SOA-\d{4}-0001$/);
    const s = await ram.req("POST", `/api/forms/${id}/submit`);
    assert.equal(s.status, 400);
    assert.ok(s.body.problems.includes("PAN No. is empty"));
  });

  await check("supervisors only see forms once their role is in the chain; others never", async () => {
    assert.equal((await sup.req("GET", `/api/forms/${id}`)).status, 404);
    assert.equal((await sita.req("GET", `/api/forms/${id}`)).status, 404);
  });

  await check("documents: PDF accepted, a fake PDF and other types refused", async () => {
    const ok = await ram.req("POST", `/api/forms/${id}/files`, PDF,
      { "Content-Type": "application/pdf", "X-File-Name": "do-letter.pdf" });
    assert.equal(ok.status, 200);
    const fake = await ram.req("POST", `/api/forms/${id}/files`, new Uint8Array(Buffer.from("hello")),
      { "Content-Type": "application/pdf", "X-File-Name": "x.pdf" });
    assert.equal(fake.status, 415);
    const exe = await ram.req("POST", `/api/forms/${id}/files`, PDF,
      { "Content-Type": "application/x-msdownload", "X-File-Name": "x.exe" });
    assert.equal(exe.status, 415);
    const back = await ram.req("GET", `/api/files/${ok.body.id}`);
    assert.deepEqual([...back.body], [...PDF]);
  });

  await check("a complete form is sent along the default chain", async () => {
    assert.equal((await ram.req("PUT", `/api/forms/${id}`, { data: FORM })).status, 200);
    const s = await ram.req("POST", `/api/forms/${id}/submit`);
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.deepEqual(s.body.chain, ["supervisor", "hod", "sales_account", "cfo", "ceo"]);
    assert.equal((await ram.req("PUT", `/api/forms/${id}`, { data: FORM })).status, 409);
  });

  await check("only the current step can act; approving needs a signature", async () => {
    assert.equal((await hod.req("POST", `/api/forms/${id}/decide`, { action: "approve" })).status, 403);
    assert.equal((await ram.req("POST", `/api/forms/${id}/decide`, { action: "approve" })).status, 403);
    const todo = await sup.req("GET", "/api/forms?box=todo");
    assert.equal(todo.body.forms.length, 1);
    assert.equal((await sup.req("POST", `/api/forms/${id}/decide`, { action: "approve" })).status, 400);
    for (const c of [sup, hod, acc, cfo, ceo]) {
      assert.equal((await c.req("PUT", "/api/me/signature", { image: SIG })).status, 200);
    }
    assert.equal((await sup.req("POST", `/api/forms/${id}/decide`, { action: "approve", remark: "ok" })).status, 200);
    assert.equal((await sup.req("POST", `/api/forms/${id}/decide`, { action: "approve" })).status, 403);
  });

  await check("returning needs a reason and sends the form back to the start", async () => {
    assert.equal((await hod.req("POST", `/api/forms/${id}/decide`, { action: "return" })).status, 400);
    const r = await hod.req("POST", `/api/forms/${id}/decide`, { action: "return", remark: "Attach the DO letter copy" });
    assert.equal(r.status, 200);
    const d = await ram.req("GET", `/api/forms/${id}`);
    assert.equal(d.body.form.status, "returned");
    assert.equal(d.body.can.edit, true);
  });

  await check("resent, it goes through every step to approved", async () => {
    assert.equal((await ram.req("POST", `/api/forms/${id}/submit`)).status, 200);
    for (const c of [sup, hod, acc, cfo]) {
      assert.equal((await c.req("POST", `/api/forms/${id}/decide`, { action: "approve" })).status, 200);
    }
    const last = await ceo.req("POST", `/api/forms/${id}/decide`, { action: "approve", remark: "Approved" });
    assert.equal(last.body.status, "approved");
    const d = await ram.req("GET", `/api/forms/${id}`);
    assert.equal(d.body.steps.length, 5);
    assert.ok(d.body.steps.every((s) => s.done && s.done.signature === SIG));
    assert.equal(d.body.steps[0].done.name, "Sup Visor");
    assert.equal(d.body.can.so, false, "the sales person no longer enters the SO number");
    assert.equal((await acc.req("GET", `/api/forms/${id}`)).body.can.assign, true);
    assert.ok((await acc.req("GET", "/api/forms?box=todo")).body.forms.some((x) => x.id === id));
  });

  await check("Sales Account sends it to an SAP user, who alone enters the SO number", async () => {
    const { users } = (await admin.req("GET", "/api/admin/users")).body;
    const sapId = users.find((u) => u.username === "sapu").id;
    assert.equal((await sapu.req("GET", `/api/forms/${id}`)).status, 404, "not yet sent to them");
    assert.equal((await ram.req("POST", `/api/forms/${id}/so`, { so_number: "3100001234" })).status, 409);
    assert.equal((await ram.req("POST", `/api/forms/${id}/assign`, { user_id: sapId })).status, 403);
    assert.equal((await acc.req("POST", `/api/forms/${id}/assign`, { user_id: users.find((u) => u.username === "cfo").id })).status, 400);
    assert.equal((await acc.req("POST", `/api/forms/${id}/assign`, { user_id: sapId })).status, 200);
    const list = (await sapu.req("GET", "/api/forms?box=todo")).body.forms;
    assert.equal(list.length, 1);
    assert.equal(list[0].sap_name, "Sap User");
    assert.equal((await ram.req("POST", `/api/forms/${id}/so`, { so_number: "3100001234" })).status, 403);
    assert.equal((await sita.req("POST", `/api/forms/${id}/so`, { so_number: "1234567" })).status, 404);
    assert.equal((await sapu.req("POST", `/api/forms/${id}/so`, { so_number: "12AB" })).status, 400);
    assert.equal((await sapu.req("POST", `/api/forms/${id}/so`, { so_number: "3100001234" })).status, 200);
    const d = await ram.req("GET", `/api/forms/${id}`);
    assert.equal(d.body.form.status, "done");
    assert.equal(d.body.form.so_number, "3100001234");
    assert.ok(d.body.events.some((e) => e.action === "assigned" && e.remark === "to Sap User"));
    assert.equal((await acc.req("POST", `/api/forms/${id}/assign`, { user_id: sapId })).status, 403);
  });

  await check("the SAP user's PDF waits for the tray app, which reports back", async () => {
    const FINAL = new Uint8Array(Buffer.from("%PDF-1.4 the final form"));
    assert.equal((await ram.req("POST", `/api/forms/${id}/final-pdf`, FINAL, { "Content-Type": "application/pdf" })).status, 403);
    assert.equal((await sapu.req("POST", `/api/forms/${id}/final-pdf`, new Uint8Array(Buffer.from("nope")),
      { "Content-Type": "application/pdf" })).status, 415);
    assert.equal((await sapu.req("POST", `/api/forms/${id}/final-pdf`, FINAL, { "Content-Type": "application/pdf" })).status, 200);
    let d = await ram.req("GET", `/api/forms/${id}`);
    assert.equal(d.body.form.attach_status, "waiting");
    assert.ok(d.body.final_pdf && !d.body.files.some((f) => f.id === d.body.final_pdf.id), "not listed as a document");

    const relay = (method, path, body, token = "local-test-relay-token") => fetch(BASE + path, {
      method, headers: { "X-Relay-Token": token, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    assert.equal((await relay("GET", "/api/relay/attach-queue", null, "")).status, 401);
    assert.equal((await relay("GET", "/api/relay/attach-queue", null, "wrong")).status, 401);
    const q = await (await relay("GET", "/api/relay/attach-queue")).json();
    const item = q.forms.find((f) => f.id === id);
    assert.equal(item.so_number, "3100001234");
    const pdf = new Uint8Array(await (await relay("GET", `/api/relay/files/${item.file_id}`)).arrayBuffer());
    assert.deepEqual([...pdf], [...FINAL]);
    assert.equal((await relay("GET", `/api/relay/files/${d.body.files[0].id}`)).status, 404, "only final PDFs");

    const stale = await (await relay("POST", `/api/relay/forms/${id}/result`, { ok: true, message: "x", so_number: "999" })).json();
    assert.equal(stale.stale, true);
    await relay("POST", `/api/relay/forms/${id}/result`, { ok: false, message: "VA02 did not open", so_number: "3100001234" });
    d = await sapu.req("GET", `/api/forms/${id}`);
    assert.equal(d.body.form.attach_status, "failed");
    assert.equal(d.body.can.retry_attach, true);
    assert.equal((await sapu.req("POST", `/api/forms/${id}/attach-retry`)).status, 200);
    assert.ok((await (await relay("GET", "/api/relay/attach-queue")).json()).forms.some((f) => f.id === id));
    await relay("POST", `/api/relay/forms/${id}/result`, { ok: true, message: "stored as 'Approval SOA'", so_number: "3100001234" });
    d = await ram.req("GET", `/api/forms/${id}`);
    assert.equal(d.body.form.attach_status, "attached");
    assert.ok(d.body.form.attached_at);
    assert.ok(!(await (await relay("GET", "/api/relay/attach-queue")).json()).forms.some((f) => f.id === id));
  });

  await check("rules: admin only; a brand rule changes the chain; missing role holder blocks sending", async () => {
    const rule = { name: "Xpeng", brands: ["XPENG"], chain: ["supervisor", "agm", "ceo"] };
    assert.equal((await ram.req("PUT", "/api/admin/rules", { rules: [rule] })).status, 403);
    assert.equal((await admin.req("PUT", "/api/admin/rules", { rules: [{ ...rule, chain: ["boss"] }] })).status, 400);
    assert.equal((await admin.req("PUT", "/api/admin/rules", { rules: [rule] })).status, 200);
    const f = await ram.req("POST", "/api/forms", { data: { ...FORM, brand: "Xpeng", vins: "TESTVIN0000000002" } });
    const s = await ram.req("POST", `/api/forms/${f.body.id}/submit`);
    assert.equal(s.status, 400);
    assert.ok(s.body.problems.some((p) => p.includes("Sales supervisor")), JSON.stringify(s.body));
    assert.ok(s.body.problems.some((p) => p.includes("AGM")));
  });

  await check("admin adds a person; the person must change the password", async () => {
    const weak = await admin.req("POST", "/api/admin/users", { username: "gita", name: "Gita", password: "123", roles: ["agm"] });
    assert.equal(weak.status, 400);
    const r = await admin.req("POST", "/api/admin/users", { username: "gita", name: "Gita AGM", password: "Temp-pass-123", roles: ["agm"] });
    assert.equal(r.status, 200);
    const g = client();
    const l = await g.login("gita", "Temp-pass-123");
    assert.equal(l.body.user.must_change, true);
    assert.equal((await ram.req("GET", "/api/admin/users")).status, 403);
  });

  await check("admin sets the chain for forms no rule fits, and it is used", async () => {
    const r = await admin.req("PUT", "/api/admin/rules", { rules: [], default_chain: ["supervisor", "sales_account", "cfo"] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual((await ram.req("GET", "/api/rules")).body.default_chain, ["supervisor", "sales_account", "cfo"]);
    assert.equal((await admin.req("PUT", "/api/admin/rules", { rules: [], default_chain: [] })).status, 400);
    assert.equal((await ram.req("PUT", "/api/me/signature", { image: SIG })).status, 200);
    const f = await ram.req("POST", "/api/forms", { data: { ...FORM, vins: "VINDEFAULT0001" } });
    const s = await ram.req("POST", `/api/forms/${f.body.id}/submit`);
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.deepEqual(s.body.chain, ["supervisor", "sales_account", "cfo"]);
    const d = await ram.req("GET", `/api/forms/${f.body.id}`);
    assert.equal(d.body.submitted.name, "Ram Sales");
    assert.equal(d.body.submitted.signature, SIG);
  });

  await check("an approver limited to one brand does not see other brands' forms", async () => {
    const { users } = (await admin.req("GET", "/api/admin/users")).body;
    const ceoUser = users.find((u) => u.username === "ceo");
    assert.equal((await admin.req("PUT", `/api/admin/users/${ceoUser.id}`, { roles: ["ceo", "dceo", "supervisor"] })).status, 200);
    const f = await ram.req("POST", "/api/forms", { data: { ...FORM, brand: "Xpeng", vins: "VINXPENG00001" } });
    assert.equal((await ram.req("POST", `/api/forms/${f.body.id}/submit`)).status, 200);
    assert.equal((await sup.req("GET", `/api/forms/${f.body.id}`)).status, 404);
    assert.ok(!(await sup.req("GET", "/api/forms?box=all")).body.forms.some((x) => x.id === f.body.id));
    assert.ok((await ceo.req("GET", "/api/forms?box=todo")).body.forms.some((x) => x.id === f.body.id));
  });

  await check("a draft can be deleted by its owner; a sent form cannot", async () => {
    const f = await ram.req("POST", "/api/forms", { data: { ...FORM, vins: "VINDELETE0001" } });
    assert.equal((await sita.req("DELETE", `/api/forms/${f.body.id}`)).status, 404);
    assert.equal((await ram.req("DELETE", `/api/forms/${f.body.id}`)).status, 200);
    assert.equal((await ram.req("GET", `/api/forms/${f.body.id}`)).status, 404);
    assert.equal((await ram.req("DELETE", `/api/forms/${id}`)).status, 409);
    const next = await ram.req("POST", "/api/forms", { data: FORM });
    assert.notEqual(next.body.number, f.body.number, "a deleted form's number is not reused");
  });

  await check("rules switched off: first approver chosen, each sends it on, CFO/DCEO/CEO finish", async () => {
    const { users } = (await admin.req("GET", "/api/admin/users")).body;
    const uid = (name) => users.find((u) => u.username === name).id;
    const off = await admin.req("PUT", "/api/admin/rules", {
      rules: [], default_chain: ["supervisor", "sales_account", "cfo"], rules_active: false });
    assert.equal(off.status, 200);
    assert.equal((await ram.req("GET", "/api/rules")).body.rules_active, false);

    const base = { ...FORM, brand: "Xpeng", vins: "VINPICK00001" };
    const f = await ram.req("POST", "/api/forms", { data: base });
    const none = await ram.req("POST", `/api/forms/${f.body.id}/submit`);
    assert.equal(none.status, 400);
    assert.ok(none.body.problems[0].includes("Choose who approves"));
    assert.equal((await ram.req("PUT", `/api/forms/${f.body.id}`, { data: { ...base, approvers: [`${uid("ram")}:sales`] } })).status, 200);
    const selfSend = await ram.req("POST", `/api/forms/${f.body.id}/submit`);
    assert.equal(selfSend.status, 400);
    assert.ok(selfSend.body.problems[0].includes("cannot approve"), JSON.stringify(selfSend.body));

    // First approver: the GAC-only supervisor, on an Xpeng form.
    assert.equal((await ram.req("PUT", `/api/forms/${f.body.id}`, { data: { ...base, approvers: [`${uid("sup")}:supervisor`] } })).status, 200);
    const sent = await ram.req("POST", `/api/forms/${f.body.id}/submit`);
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.deepEqual(sent.body.chain.map((x) => x.name), ["Sup Visor"]);
    assert.equal((await ceo.req("GET", `/api/forms/${f.body.id}`)).status, 404, "not chosen, not visible");
    assert.equal((await ram.req("GET", "/api/forms?box=mine")).body.forms.find((x) => x.id === f.body.id).waiting_name, "Sup Visor");

    // The supervisor must send it on: no next, final, back to the owner, or to self are refused.
    const decide = (c, b) => c.req("POST", `/api/forms/${f.body.id}/decide`, { action: "approve", ...b });
    assert.equal((await decide(sup, {})).status, 400);
    const notFinal = await decide(sup, { final: true });
    assert.equal(notFinal.status, 400);
    assert.ok(notFinal.body.error.includes("CFO, Dep. CEO or CEO"));
    assert.equal((await decide(sup, { next: `${uid("ram")}:sales` })).status, 400);
    assert.equal((await decide(sup, { next: `${uid("sup")}:supervisor` })).status, 400);
    assert.equal((await decide(sup, { next: `${uid("hod")}:hod` })).status, 200);
    // HOD sends it on to the CFO, who gives the final approval.
    assert.equal((await decide(hod, { next: `${uid("cfo")}:cfo` })).status, 200);
    assert.equal((await decide(cfo, { final: true })).status, 200);
    const d = await ram.req("GET", `/api/forms/${f.body.id}`);
    assert.equal(d.body.form.status, "approved");
    assert.deepEqual(d.body.steps.map((x) => x.done.name), ["Sup Visor", "Sap Two HOD", "Cfo CFO"]);
    assert.ok(d.body.events.some((e) => e.action === "sent_on" && e.remark.includes("Sap Two HOD")));
  });

  await check("rules switched back on: picks are ignored and the rules decide", async () => {
    assert.equal((await admin.req("PUT", "/api/admin/rules", {
      rules: [], default_chain: ["supervisor", "sales_account", "cfo"], rules_active: true })).status, 200);
    const f = await ram.req("POST", "/api/forms", { data: { ...FORM, vins: "VINRULESON01", approvers: ["999:cfo"] } });
    const s = await ram.req("POST", `/api/forms/${f.body.id}/submit`);
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.deepEqual(s.body.chain, ["supervisor", "sales_account", "cfo"]);
  });

  await check("a sales supervisor can fill in a form; other roles cannot", async () => {
    const f = await sup.req("POST", "/api/forms", { data: { ...FORM, vins: "VINSUPERVISOR1" } });
    assert.equal(f.status, 200, JSON.stringify(f.body));
    assert.equal((await sup.req("GET", `/api/forms/${f.body.id}`)).body.can.edit, true);
    assert.equal((await cfo.req("POST", "/api/forms", { data: FORM })).status, 403);
  });

  await check("Sales Account picks the SAP user while approving; it can be changed later", async () => {
    const { users } = (await admin.req("GET", "/api/admin/users")).body;
    const uid = (name) => users.find((u) => u.username === name).id;
    // Rules are on, default chain supervisor -> sales_account -> cfo (set above).
    const f = await ram.req("POST", "/api/forms", { data: { ...FORM, vins: "VINSAPEARLY01" } });
    assert.equal((await ram.req("POST", `/api/forms/${f.body.id}/submit`)).status, 200);
    const decide = (c, b) => c.req("POST", `/api/forms/${f.body.id}/decide`, { action: "approve", ...b });
    assert.equal((await decide(sup, { sap_user_id: uid("sapu") })).status, 403, "only Sales Account picks it");
    assert.equal((await decide(sup, {})).status, 200);
    assert.equal((await decide(acc, { sap_user_id: uid("cfo") })).status, 400, "must be an SAP user");
    assert.equal((await decide(acc, { sap_user_id: uid("sapu2") })).status, 200);
    let d = await ram.req("GET", `/api/forms/${f.body.id}`);
    assert.equal(d.body.form.status, "pending");
    assert.equal(d.body.form.sap_name, "Busy Sap");
    // Still with the CFO: Sales Account changes the SAP user.
    assert.equal((await acc.req("POST", `/api/forms/${f.body.id}/assign`, { user_id: uid("sapu") })).status, 200);
    assert.equal((await ram.req("GET", `/api/forms/${f.body.id}`)).body.form.status, "pending");
    // Final approval: straight to the SAP user, no extra step.
    const last = await decide(cfo, {});
    assert.equal(last.body.status, "with_sap");
    assert.ok((await sapu.req("GET", "/api/forms?box=todo")).body.forms.some((x) => x.id === f.body.id));
    assert.equal((await sapu2.req("GET", `/api/forms/${f.body.id}`)).status, 404, "replaced, no longer sees it");
    // The SAP user is busy: Sales Account sends it to the other one.
    assert.equal((await acc.req("POST", `/api/forms/${f.body.id}/assign`, { user_id: uid("sapu2") })).status, 200);
    assert.equal((await sapu.req("POST", `/api/forms/${f.body.id}/so`, { so_number: "3100005555" })).status, 404);
    assert.equal((await sapu2.req("POST", `/api/forms/${f.body.id}/so`, { so_number: "3100005555" })).status, 200);
    d = await ram.req("GET", `/api/forms/${f.body.id}`);
    assert.equal(d.body.form.status, "done");
    assert.deepEqual(d.body.events.filter((e) => e.action === "assigned").map((e) => e.remark),
      ["to Busy Sap", "to Sap User (was Busy Sap)", "to Busy Sap (was Sap User)"]);
  });

  await check("logging out ends the session", async () => {
    assert.equal((await cfo.req("POST", "/api/logout")).status, 200);
    assert.equal((await cfo.req("GET", "/api/forms")).status, 401);
  });

  await check("pages are served with security headers", async () => {
    const res = await fetch(`${BASE}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-security-policy") || "", /frame-ancestors 'none'/);
  });

  console.log(`\n${passed} API checks passed`);
} catch (e) {
  console.error(e);
  console.error(`\n--- wrangler dev log ---\n${serverLog.slice(-3000)}`);
  process.exitCode = 1;
} finally {
  stop();
}
