import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_CHAIN, canAct, checkForm, holds, money, normBrands, npt, parsePicks, pickChain, stepOf, totals, vinList,
} from "../public/shared.js";

// A sample form; every value is made up.
const FORM = {
  dealer: "Individual Customer", customer_name: "Test Customer", customer_address: "Test Address",
  contact: "9800000000", pan: "123456789", brand: "GAC", model: "Test Model",
  mfg_year: "2024", vins: "TESTVIN0000000001", mrp: "5,000,000.00",
  regular_margin: "1,000,000.00", units: "1",
};

test("totals match the paper form", () => {
  const t = totals(FORM);
  assert.equal(t.discount, 1000000);
  assert.equal(t.billing, 4000000);
  assert.equal(t.invoice, 4000000);
  assert.ok(Math.abs(t.discount_pct - 20) < 0.01);
});

test("amounts typed with commas print correctly", () => {
  assert.equal(money("5,000,000"), "5,000,000.00");
  assert.equal(money(""), "0.00");
});

test("all margins add up and units multiply", () => {
  const t = totals({ mrp: "100", regular_margin: "10", bulk_margin: "5", exchange_margin: "",
    infra_margin: "1", hr_margin: "2", other_margin: "2", units: "3" });
  assert.equal(t.discount, 20);
  assert.equal(t.invoice, 240);
});

test("a complete form passes", () => {
  assert.deepEqual(checkForm(FORM), []);
});

test("missing and wrong fields are named", () => {
  const p = checkForm({ ...FORM, pan: "", mrp: "abc", units: "2" });
  assert.ok(p.includes("PAN No. is empty"));
  assert.ok(p.some((x) => x.includes("Price MRP 'abc' is not a number")));
  assert.ok(p.includes("2 unit(s) but 1 VIN(s)"));
});

test("discount above MRP and duplicate VINs are refused", () => {
  assert.ok(checkForm({ ...FORM, regular_margin: "7000000" }).includes("Total discount is more than the MRP"));
  assert.ok(checkForm({ ...FORM, units: "2", vins: "AAA\naaa" }).includes("A VIN is listed twice"));
  assert.deepEqual(vinList({ vins: "a1, b2\n c3" }), ["A1", "B2", "C3"]);
});

test("first matching rule picks the chain, else the default", () => {
  const rules = [
    { name: "Big discount", brands: [], min_discount_pct: 20, min_invoice: null, chain: ["supervisor", "hod", "sales_account", "cfo", "ceo"] },
    { name: "GAC", brands: ["gac"], min_discount_pct: null, min_invoice: null, chain: ["supervisor", "agm", "sales_account", "cfo", "dceo"] },
  ];
  assert.equal(pickChain(rules, FORM).rule, "Big discount");
  assert.equal(pickChain(rules, { ...FORM, regular_margin: "100000" }).rule, "GAC");
  const other = pickChain(rules, { ...FORM, brand: "Xpeng", regular_margin: "100000" });
  assert.equal(other.rule, "No rule fits (default chain)");
  assert.deepEqual(other.chain, DEFAULT_CHAIN);
});

test("invoice threshold and blank conditions", () => {
  const rules = [{ name: "Over 6M", brands: [], min_discount_pct: "", min_invoice: 5000000, chain: ["cfo"] }];
  assert.equal(pickChain(rules, FORM).rule, "No rule fits (default chain)");
  assert.equal(pickChain(rules, { ...FORM, regular_margin: "0" }).rule, "Over 6M");
});

test("role holders can be limited to brands", () => {
  const u = { roles: ["supervisor"], brands: ["GAC"] };
  assert.ok(holds(u, "supervisor", "gac"));
  assert.ok(!holds(u, "supervisor", "Xpeng"));
  assert.ok(!holds(u, "hod", "GAC"));
  assert.ok(holds({ roles: ["hod"], brands: [] }, "hod", "anything"));
});

test("ALL, ANY or * mean every brand, for people and for rules", () => {
  assert.deepEqual(normBrands(["ALL"]), []);
  assert.deepEqual(normBrands([" gac ", "Xpeng", "GAC"]), ["GAC", "XPENG"]);
  assert.ok(holds({ roles: ["sales_account"], brands: ["ALL"] }, "sales_account", "kyc"));
  assert.ok(holds({ roles: ["cfo"], brands: ["*"] }, "cfo", "GAC"));
  const rules = [{ name: "all", brands: ["ALL"], min_discount_pct: 5, min_invoice: 100,
    chain: ["supervisor", "sales_account", "cfo"] }];
  assert.equal(pickChain(rules, { ...FORM, brand: "kyc" }).rule, "all");
});

test("the default chain can be set; times show in Nepal time", () => {
  const picked = pickChain([], FORM, ["supervisor", "sales_account", "cfo"]);
  assert.deepEqual(picked.chain, ["supervisor", "sales_account", "cfo"]);
  assert.deepEqual(pickChain([], FORM, []).chain, DEFAULT_CHAIN);
  assert.equal(npt("2026-10-05 13:44:36"), "2026-10-05 19:29");
  assert.equal(npt("2026-10-05 20:00:00"), "2026-10-06 01:45");
  assert.equal(npt(""), "");
});

test("a picked step is for that person only; a role step for anyone holding it", () => {
  assert.deepEqual(parsePicks(["5:cfo", "x:cfo", "3:boss", "7:hod"]),
    [{ user_id: 5, role: "cfo" }, { user_id: 7, role: "hod" }]);
  const cfo = { id: 5, roles: ["cfo"], brands: ["GAC"] };
  const other = { id: 6, roles: ["cfo"], brands: [] };
  assert.ok(canAct(cfo, { role: "cfo", user_id: 5 }, "Xpeng"));
  assert.ok(!canAct(other, { role: "cfo", user_id: 5 }, "Xpeng"));
  assert.ok(canAct(other, "cfo", "Xpeng"));
  assert.ok(!canAct(cfo, "cfo", "Xpeng"));
  assert.deepEqual(stepOf("hod"), { role: "hod" });
});
