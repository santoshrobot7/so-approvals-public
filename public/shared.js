// Logic used by both the browser and the Worker: roles, form fields,
// totals and which approval chain a form gets. Kept free of DOM and
// Worker APIs so both sides (and the tests) import the same file.

export const ROLES = {
  sales: "Sales person",
  supervisor: "Sales supervisor",
  hod: "HOD",
  agm: "AGM",
  sr_manager: "Sr. Manager",
  buh: "BUH",
  sales_account: "Sales Account",
  cfo: "CFO",
  dceo: "Dep. CEO",
  ceo: "CEO",
  sap_user: "SAP user",
};

/** Roles that may fill in a new form. */
export const CREATOR_ROLES = ["sales", "supervisor"];

/** With rules off, who may give the final approval (others send it on). */
export const FINAL_ROLES = ["cfo", "dceo", "ceo"];

/** Roles that can be a step in an approval chain. */
export const APPROVER_ROLES = Object.keys(ROLES).filter((r) => !["sales", "sap_user"].includes(r));

export const DEFAULT_CHAIN = ["supervisor", "hod", "sales_account", "cfo", "ceo"];

export const DEFAULT_FOC = [
  "6.6 KW Charger",
  "One Fiscal Year Road Tax",
  "Tyre 185/60R 16 (170 MM) -4 unit",
  "1 year Comprehensive Insurance",
  "1 Unit Stepny Tyre",
  "Tyre Jack Tool Set",
  "Floor Mat (4 units)",
];

/** The margins that add up to the total discount, in form order. */
export const MARGINS = [
  ["regular_margin", "Regular Dealer Margin"],
  ["bulk_margin", "Bulk Deal Margin"],
  ["exchange_margin", "Exchange Margin"],
  ["infra_margin", "Infra Margin"],
  ["hr_margin", "HR Margin"],
  ["other_margin", "Other If any"],
];

/**
 * The paper form, section by section: [key, label, kind, required].
 * kind: text | number | date | textarea | list
 */
export const SECTIONS = [
  ["Customer Details", [
    ["dealer", "Dealer (or Individual Customer)", "text", true],
    ["customer_name", "Customer Name / Billing Customer Name", "text", true],
    ["customer_address", "Customer Full Address", "text", true],
    ["contact", "Contact Number", "text", true],
    ["pan", "PAN No.", "text", true],
  ]],
  ["BFIS Details", [
    ["bfis_bank", "Bank Name", "text"],
    ["bfis_branch", "Branch", "text"],
    ["bfis_supporter", "Bank Supporter Name (if possible)", "text"],
    ["do_amount", "DO Amount", "number"],
    ["do_date", "DO Date", "date"],
  ]],
  ["PDC/ODC Details if any", [
    ["pdc_bank", "Bank Name", "text"],
    ["pdc_branch", "Branch", "text"],
    ["cheque_amount", "Cheque Amount", "number"],
    ["cheque_date", "Cheque Date", "date"],
  ]],
  ["Vehicle Details", [
    ["brand", "Brand", "text", true],
    ["model", "Model No.", "text", true],
    ["mfg_year", "Manufacture Year", "text", true],
    ["color", "Color", "text"],
    ["motor_no", "Motor No.", "text"],
    ["vins", "VIN (one per line)", "textarea", true],
    ["reg_no", "Vehicle Reg. No.", "text"],
  ]],
  ["Billing Amount Details", [
    ["mrp", "Price MRP", "number", true],
    ...MARGINS.map(([k, l]) => [k, l, "number"]),
    ["units", "Unit", "number", true],
    ["billing_notes", "Notes (deal amount, credit note, exchange top up...)", "textarea"],
    ["booking_amount", "Booking", "number"],
    ["booking_date", "Booking Date", "date"],
    ["down_payment", "Down Payment", "number"],
    ["down_payment_ref", "Down Payment Date / Bank", "text"],
    ["dues", "Total dues with/out DO", "number"],
    ["dues_details", "Dues details", "text"],
  ]],
  ["FOC Details (Scheme / if any)", [
    ["scheme", "Scheme If any", "text"],
    ["foc", "Regular FOC (per vehicle)", "list"],
  ]],
  ["Other Details", [
    ["vin_verify", "Stock VIN Verify details", "text"],
    ["vin_verify_by", "Verified by", "text"],
    ["place", "Place", "text"],
    ["delivered_reason", "If already delivered, explain reason", "text"],
    ["rebilling", "If re-billing", "text"],
    ["sales_return", "If sales return", "text"],
    ["new_so", "If new sales order", "text"],
  ]],
];

export const FIELDS = SECTIONS.flatMap(([, fields]) => fields);

export function num(value) {
  if (value === null || value === undefined || value === "") return 0;
  const n = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : NaN;
}

/** Total discount, billing price per unit and invoice value. */
export function totals(data) {
  const discount = MARGINS.reduce((sum, [k]) => sum + (num(data[k]) || 0), 0);
  const mrp = num(data.mrp) || 0;
  const units = num(data.units) || 0;
  const billing = mrp - discount;
  return {
    discount,
    billing,
    invoice: billing * units,
    discount_pct: mrp > 0 ? (discount / mrp) * 100 : 0,
  };
}

export function vinList(data) {
  return String(data.vins || "")
    .split(/[\s,;]+/)
    .map((v) => v.trim().toUpperCase())
    .filter(Boolean);
}

/** Problems that stop a form being submitted; empty when it may go. */
export function checkForm(data) {
  const problems = [];
  for (const [key, label, kind, required] of FIELDS) {
    const value = data[key];
    const blank = value === undefined || value === null || String(value).trim() === ""
      || (Array.isArray(value) && value.length === 0);
    if (required && blank) problems.push(`${label} is empty`);
    if (kind === "number" && !blank && Number.isNaN(num(value))) {
      problems.push(`${label} '${value}' is not a number`);
    }
    if (kind === "number" && !blank && num(value) < 0) {
      problems.push(`${label} cannot be negative`);
    }
  }
  const t = totals(data);
  const units = num(data.units);
  if (units && (!Number.isInteger(units) || units < 1)) {
    problems.push("Unit must be a whole number, 1 or more");
  }
  if (num(data.mrp) > 0 && t.billing < 0) {
    problems.push("Total discount is more than the MRP");
  }
  const vins = vinList(data);
  if (units >= 1 && vins.length && vins.length !== units) {
    problems.push(`${units} unit(s) but ${vins.length} VIN(s)`);
  }
  if (new Set(vins).size !== vins.length) problems.push("A VIN is listed twice");
  return problems;
}

/**
 * A brand list as stored: upper case, and [] for "every brand". People
 * naturally type ALL (or ANY, *) for that, so those words mean the same
 * as leaving the box blank.
 */
export function normBrands(list) {
  const brands = (list || []).map((b) => String(b).trim().toUpperCase()).filter(Boolean);
  return brands.some((b) => ["ALL", "ANY", "*"].includes(b)) ? [] : [...new Set(brands)];
}

/**
 * The chain for a form: the first rule whose conditions all hold, or
 * DEFAULT_CHAIN. A condition left blank always holds.
 *   rule = { name, brands: [], min_discount_pct, min_invoice, chain: [] }
 */
export function pickChain(rules, data, fallback = DEFAULT_CHAIN) {
  const t = totals(data);
  const brand = String(data.brand || "").trim().toUpperCase();
  for (const rule of rules || []) {
    const brands = normBrands(rule.brands);
    if (brands.length && !brands.includes(brand)) continue;
    if (rule.min_discount_pct !== null && rule.min_discount_pct !== undefined
        && rule.min_discount_pct !== "" && t.discount_pct < Number(rule.min_discount_pct)) continue;
    if (rule.min_invoice !== null && rule.min_invoice !== undefined
        && rule.min_invoice !== "" && t.invoice < Number(rule.min_invoice)) continue;
    if (Array.isArray(rule.chain) && rule.chain.length) {
      return { rule: rule.name || "Rule", chain: rule.chain.slice() };
    }
  }
  const chain = Array.isArray(fallback) && fallback.length ? fallback : DEFAULT_CHAIN;
  return { rule: "No rule fits (default chain)", chain: chain.slice() };
}

/**
 * A chain step. From the rules a step is a role ("hod"): anyone holding
 * it for the form's brand may act. When the rules are switched off, the
 * sales person picks people, and a step is { role, user_id, name }: only
 * that person may act.
 */
export function stepOf(step) {
  return typeof step === "string" ? { role: step } : { ...step };
}

/** May this user act on this step of a form of this brand? */
export function canAct(user, step, brand) {
  const s = stepOf(step);
  if (s.user_id) return !!user && user.id === s.user_id && (user.roles || []).includes(s.role);
  return holds(user, s.role, brand);
}

/** Picked approvers as kept in a draft: ["5:supervisor", "3:cfo"]. */
export function parsePicks(list) {
  return (Array.isArray(list) ? list : []).map((x) => {
    const [id, role] = String(x).split(":");
    return { user_id: Number(id), role };
  }).filter((p) => Number.isInteger(p.user_id) && p.user_id > 0 && ROLES[p.role]);
}

/** "2026-10-05 13:44:36" (UTC, as stored) as Nepal time, "2026-10-05 19:29". */
export function npt(stamp) {
  if (!stamp) return "";
  const t = Date.parse(`${String(stamp).replace(" ", "T").slice(0, 19)}Z`);
  if (Number.isNaN(t)) return String(stamp);
  return new Date(t + 345 * 60000).toISOString().slice(0, 16).replace("T", " ");
}

/** Does this user hold `role`, for this brand? */
export function holds(user, role, brand) {
  if (!user || !(user.roles || []).includes(role)) return false;
  const brands = normBrands(user.brands);
  return !brands.length || brands.includes(String(brand || "").trim().toUpperCase());
}

export function money(value) {
  // Through num(): typed amounts carry commas ("6,499,000").
  const n = num(value) || 0;
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export const STATUS = {
  draft: "Draft",
  returned: "Returned for changes",
  pending: "Waiting for approval",
  approved: "Approved, Sales Account to send to an SAP user",
  with_sap: "With SAP user for SO creation",
  done: "SO created",
};
