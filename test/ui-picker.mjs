// Browser check (not part of npm test): with rules switched off, a sales
// person fills a form with the sample button, picks two approvers and
// sends it.   node test/ui-picker.mjs <output folder>
import { execFileSync, spawn } from "node:child_process";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
const PORT = 8797;
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
const people = [["admin", "Admin Person", []], ["sales", "salesman", ["sales"]],
  ["sup", "Sup Visor", ["supervisor"]],
  ["acc", "acc", ["sales_account"]], ["cfo", "Cfo Person", ["cfo"]],
  ["sap1", "Sap One", ["sap_user"]], ["sap2", "Sap Two", ["sap_user"]]];
writeFileSync(join(STATE, "seed.sql"), people.map(([u, n, r]) =>
  `INSERT INTO users (username, name, roles, is_admin, password, must_change) VALUES ('${u}', '${n}', '${JSON.stringify(r)}', ${u === "admin" ? 1 : 0}, '${hash(PASSWORD)}', 0);`).join("\n")
  + "\nINSERT OR REPLACE INTO settings (key, value) VALUES ('rules_active', 'false');");
wrangler("d1", "execute", "so-approvals", "--local", "--persist-to", STATE, "--file", join(STATE, "seed.sql"), "--yes");
const server = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--ip", "127.0.0.1", "--persist-to", STATE,
  "--log-level", "warn"], { stdio: "ignore", shell: win });
const stop = () => { try { execFileSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* gone */ } };

try {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/api/me`)).status === 401) break; } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  const browser = await chromium.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" });
  const login = async (user) => {
    const page = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
    page.on("pageerror", (e) => console.log(`PAGE ERROR (${user}):`, e.message));
    await page.goto(BASE);
    await page.fill("input[name=username]", user);
    await page.fill("input[name=password]", PASSWORD);
    await page.click("button.primary");
    await page.waitForSelector("h1:has-text('Forms')");
    return page;
  };
  // The Rules page: add a rule, change the fallback chain, switch rules
  // on and off, save -- with no error on the page.
  const admin = await login("admin");
  await admin.click("#nav a:has-text('Rules')");
  await admin.waitForSelector("text=Use approval rules");
  await admin.click("#addRule");
  await admin.fill(".rule[data-i='0'] [data-f=brands]", "GAC");
  await admin.locator(".rule[data-i='0'] [data-f=brands]").dispatchEvent("change");
  await admin.selectOption("[data-chain=default] [data-add]", { label: "AGM" });
  await admin.check("#active");
  await admin.click("#saveRules");
  await admin.waitForSelector(".toast.show:has-text('Rules saved')");
  if (await admin.$(".note.bad")) throw new Error(await admin.textContent(".note.bad"));
  await admin.uncheck("#active");
  await admin.click("#saveRules");
  await admin.waitForSelector("text=Off: the sales person chooses");
  await admin.screenshot({ path: join(OUT, "rules.png"), fullPage: true });
  console.log("rules page: saved on and off, no errors");

  // A sales supervisor can start a form too.
  const sup = await login("sup");
  await sup.waitForSelector("main a:has-text('New form')");
  console.log("supervisor sees New form");

  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const sign = (page) => page.evaluate(async (img) => {
    await fetch("/api/me/signature", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: img }) });
  }, PNG);

  const sales = await login("sales");
  await sales.click("main a:has-text('New form')");
  await sales.click("#sample");
  await sales.waitForSelector("text=No first approver chosen yet");
  await sales.click("#send");
  await sales.waitForSelector(".note.bad:has-text('choose who approves this form first')");
  const groups = await sales.$$eval("#pick-first optgroup", (g) => g.map((x) => `${x.label}: ${[...x.children].map((o) => o.textContent).join(", ")}`));
  console.log("first-approver list:");
  groups.forEach((g) => console.log(`  ${g}`));
  await sales.selectOption("#pick-first", { label: "Sup Visor (Sales supervisor)" });
  await sales.waitForSelector("text=First approver:");
  await sales.locator("#chain").screenshot({ path: join(OUT, "first-approver.png") });
  await sales.click("#send");
  console.log("confirm:", await okModal(sales));
  await sales.waitForSelector(".pill:has-text('With Sup Visor')");
  const formUrl = sales.url();

  // Each approver sends it on from the page.
  const passOn = async (user, nextLabel) => {
    const page = await login(user);
    await sign(page);
    await page.goto(formUrl);
    await page.reload();
    await page.waitForSelector("#approve:not([disabled])");
    const finalShown = !!(await page.$("input[name=route][value=final]"));
    if (user === "acc") {
      await page.selectOption("#decideSap", { label: "Sap One" });     // SAP user chosen while approving
    }
    if (nextLabel) {
      await page.selectOption("#next", { label: nextLabel });
      if (user === "sup") await page.locator("#actions").screenshot({ path: join(OUT, "send-on.png") });
    } else {
      await page.check("input[name=route][value=final]");
    }
    await page.click("#approve");
    console.log(`${user}:`, await okModal(page));
    await page.waitForSelector(".toast.show:has-text('Approved')");
    console.log(`  final approval offered to ${user}: ${finalShown}`);
  };
  await passOn("sup", "acc (Sales Account)");
  await passOn("acc", "Cfo Person (CFO)");
  await passOn("cfo", null);
  await sales.reload();
  await sales.waitForSelector(".pill:has-text('With SAP user Sap One')");
  console.log("final approval sent it straight to Sap One");
  // Sap One is busy: acc sends it to Sap Two instead.
  const acc = await login("acc");
  await acc.goto(formUrl);
  await acc.reload();
  await acc.selectOption("#sapUser", { label: "Sap Two" });
  await acc.click("#assign");
  await acc.waitForSelector(".pill:has-text('With SAP user Sap Two')");
  await acc.locator("#actions").screenshot({ path: join(OUT, "change-sap.png") });
  console.log("acc changed the SAP user to Sap Two");
  await sales.screenshot({ path: join(OUT, "routed-approved.png"), fullPage: true });
  console.log("fully approved after Sup -> acc -> Cfo (final)");
  await browser.close();
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  stop();
}
