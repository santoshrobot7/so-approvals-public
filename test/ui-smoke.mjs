// Browser smoke test (not part of npm test): local Worker + headless Edge.
// Logs in, fills a form through the page, draws a signature on the pad,
// approves through the API, then downloads the PDF the page builds.
//   node test/ui-smoke.mjs <output folder>
import { execFileSync, spawn } from "node:child_process";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

/** Answer the page's confirmation dialog with OK; returns its wording. */
async function okModal(page) {
  await page.waitForSelector(".modal-back.show");
  const text = (await page.textContent("#modal-title")) + " " + (await page.textContent("#modal-text"));
  await page.click("#modal-ok");
  await page.waitForSelector(".modal-back.show", { state: "hidden" });
  return text.replace(/\s+/g, " ").trim();
}

const OUT = process.argv[2] || ".ui-out";
const STATE = ".ui-state";
const PORT = 8798;
const BASE = `http://localhost:${PORT}`;
const PASSWORD = "Test-pass-2026";
const win = process.platform === "win32";
mkdirSync(OUT, { recursive: true });
rmSync(STATE, { recursive: true, force: true });
mkdirSync(STATE, { recursive: true });
const wrangler = (...a) => execFileSync("npx", ["wrangler", ...a], { stdio: "pipe", shell: win });
wrangler("d1", "migrations", "apply", "so-approvals", "--local", "--persist-to", STATE);
const hash = (p) => {
  const salt = randomBytes(16);
  return `pbkdf2$100000$${salt.toString("hex")}$${pbkdf2Sync(p, salt, 100000, 32, "sha256").toString("hex")}`;
};
const people = [["ram", "Ram Sales", ["sales"]], ["sup", "Sup Visor", ["supervisor"]],
  ["hod", "Hod Person", ["hod"]], ["acc", "Acc Person", ["sales_account"]],
  ["cfo", "Cfo Person", ["cfo"]], ["ceo", "Ceo Person", ["ceo"]], ["sapu", "Sap One", ["sap_user"]]];
writeFileSync(join(STATE, "seed.sql"), people.map(([u, n, r]) =>
  `INSERT INTO users (username, name, roles, password, must_change) VALUES ('${u}', '${n}', '${JSON.stringify(r)}', '${hash(PASSWORD)}', 0);`).join("\n"));
writeFileSync(join(STATE, "seed.sql"), readFileSync(join(STATE, "seed.sql"), "utf8")
  + `
UPDATE settings SET value = '[{"name":"Nobody brand","brands":["NOBODY"],"chain":["agm"]}]' WHERE key = 'rules';`);
wrangler("d1", "execute", "so-approvals", "--local", "--persist-to", STATE, "--file", join(STATE, "seed.sql"), "--yes");

const server = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--ip", "127.0.0.1", "--persist-to", STATE,
  "--log-level", "warn"], { stdio: "ignore", shell: win });
const stop = () => { try { execFileSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* gone */ } };

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

async function api(page, method, path, body) {
  return page.evaluate(async ([m, p, b]) => {
    const r = await fetch(p, { method: m, headers: { "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined });
    return { status: r.status, body: await r.json() };
  }, [method, path, body]);
}

try {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/api/me`)).status === 401) break; } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log("server up");
  const browser = await chromium.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" });
  const session = async (user) => {
    const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, acceptDownloads: true });
    const page = await context.newPage();
    page.on("pageerror", (e) => console.log(`PAGE ERROR (${user}):`, e.message));
    await page.goto(BASE);
    await page.fill("input[name=username]", user);
    await page.fill("input[name=password]", PASSWORD);
    await page.click("button.primary");
    await page.waitForSelector("h1:has-text('Forms')");
    return page;
  };

  // Sales person fills the form on the page.
  const ram = await session("ram");
  // A new form that cannot be sent (nobody is AGM) must say why on the page.
  await ram.click("main a:has-text('New form')");
  await ram.waitForSelector("[data-k=customer_name]");
  for (const [k, v] of Object.entries({ dealer: "D", customer_name: "C", customer_address: "A", contact: "1",
    pan: "2", brand: "nobody", model: "M", mfg_year: "2025", vins: "VINNOBODY1", mrp: "100", units: "1" })) {
    await ram.fill(`[data-k=${k}]`, v);
  }
  await ram.waitForSelector("text=Nobody can approve this step");
  await ram.click("#send");
  await okModal(ram);
  await ram.waitForSelector(".note.bad:has-text('Not sent')");
  await ram.screenshot({ path: join(OUT, "0-not-sent.png"), fullPage: true });
  console.log("unsendable form explains itself");
  await ram.goto(`${BASE}/#/`);
  await ram.waitForSelector("h1:has-text('Forms')");
  await page_fill(ram);
  async function page_fill(page) {
    await page.click("main a:has-text('New form')");
    await page.waitForSelector("[data-k=customer_name]");
    const values = {
      dealer: "Individual Customer", customer_name: "Test Customer", customer_address: "Test Address",
      contact: "9800000000", pan: "123456789", bfis_bank: "Test Bank",
      bfis_branch: "Test Branch", brand: "GAC", model: "Test Model", mfg_year: "2024",
      color: "Test Colour", vins: "TESTVIN0000000001", mrp: "5,000,000", regular_margin: "1,000,000",
      billing_notes: "Deal Amount: 4000000\nCredit Note: 500000 (Exchange Top Up)",
    };
    for (const [k, v] of Object.entries(values)) await page.fill(`[data-k=${k}]`, v);
    await page.fill("[data-k=do_date]", "2026-09-18");
    await page.screenshot({ path: join(OUT, "1-form-filled.png"), fullPage: true });
    await page.click("#save");
    await page.waitForURL(/#\/form\/\d+/);
    await page.waitForSelector("#upload", { state: "attached" });
  }
  console.log("form saved");
  const id = Number(ram.url().split("/").pop());
  const fileInput = ram.locator("#upload");
  await fileInput.setInputFiles({ name: "customer-citizenship.png", mimeType: "image/png",
    buffer: readFileSync("C:/pay-for-staff/print/pay-for-staff-qr.png") });
  await ram.waitForSelector("a:has-text('customer-citizenship.png')");
  await ram.click("#send");
  await okModal(ram);
  await ram.waitForSelector(".pill:has-text('With Sales supervisor')");
  await ram.screenshot({ path: join(OUT, "2-sent.png"), fullPage: true });

  console.log("form sent");
  // Supervisor draws a signature on the pad, then approves on the page.
  const sup = await session("sup");
  await sup.screenshot({ path: join(OUT, "3-sup-inbox.png") });
  await sup.goto(`${BASE}/#/me`);
  const pad = await sup.waitForSelector("#pad");
  const box = await pad.boundingBox();
  await sup.mouse.move(box.x + 30, box.y + 120);
  await sup.mouse.down();
  for (let i = 0; i <= 40; i++) {
    await sup.mouse.move(box.x + 30 + i * 8, box.y + 100 + Math.sin(i / 3) * 40);
  }
  await sup.mouse.up();
  await sup.click("#saveSig");
  await sup.waitForSelector("img.sigshow");
  await sup.goto(`${BASE}/#/form/${id}`);
  await sup.waitForSelector("#approve");
  await sup.fill("#remark", "Deal checked with BFIS");
  await sup.click("#approve");
  await okModal(sup);
  await sup.waitForSelector(".pill:has-text('With HOD')");

  console.log("supervisor signed and approved");
  // The rest approve through the API, each in their own session.
  for (const user of ["hod", "acc", "cfo", "ceo"]) {
    const p = await session(user);
    await api(p, "PUT", "/api/me/signature", { image: PNG });
    const r = await api(p, "POST", `/api/forms/${id}/decide`, { action: "approve", remark: user === "ceo" ? "Approved" : "" });
    if (r.status !== 200) throw new Error(`${user}: ${JSON.stringify(r.body)}`);
    await p.context().close();
  }

  console.log("all approved");
  // Sales Account sends it to the SAP user, on the page.
  const acc = await session("acc");
  await acc.click("text=Waiting for me");
  await acc.click(`tr[data-id='${id}']`);
  await acc.selectOption("#sapUser", { label: "Sap One" });
  await acc.click("#assign");
  await acc.waitForSelector(".pill:has-text('With SAP user Sap One')");
  console.log("Sales Account sent it to the SAP user");
  // The SAP user finds it waiting, enters the SO number, downloads the PDF.
  const sapu = await session("sapu");
  await sapu.click(`tr[data-id='${id}']`);
  await sapu.waitForSelector("#saveSo");
  await sapu.fill("#so", "3100001234");
  await sapu.click("#saveSo");
  await sapu.waitForSelector(".pill:has-text('SO created')");
  await sapu.screenshot({ path: join(OUT, "4-done.png"), fullPage: true });
  const [download] = await Promise.all([sapu.waitForEvent("download"), sapu.click("#pdf")]);
  await download.saveAs(join(OUT, "form.pdf"));
  console.log("SAP user entered the SO number and downloaded the PDF");
  const [tab] = await Promise.all([sapu.waitForEvent("popup"), sapu.click("#viewPdf")]);
  await tab.waitForURL(/^blob:/, { timeout: 30000 });
  console.log("View PDF opened a tab on the PDF:", tab.url().slice(0, 30));
  await tab.close();
  await ram.setViewportSize({ width: 390, height: 844 });
  await ram.goto(`${BASE}/#/`);
  await ram.waitForSelector("h1:has-text('Forms')");
  await ram.screenshot({ path: join(OUT, "5-phone-list.png"), fullPage: true });
  await browser.close();
  console.log(`done: form ${id}, files in ${OUT}`);
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  stop();
}
