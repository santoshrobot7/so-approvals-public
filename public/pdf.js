// The approved form as one PDF, built in the browser with pdf-lib:
// the form in the paper layout, the signatures, the history, then every
// supporting document (PDF pages copied in, photos one per page).
import { MARGINS, ROLES, SECTIONS, money, npt, totals } from "./shared.js";

const A4 = [595.28, 841.89];
const M = 36;

// Helvetica covers Windows-1252 only; anything else (e.g. Nepali script)
// would stop the PDF, so it is replaced.
const safe = (text) => String(text ?? "")
  .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
  .replace(/[–—]/g, "-").replace(/→/g, "->")
  .replace(/[^\x20-\x7e\xa0-\xff\n]/g, "?");

export async function buildPdf(detail, loadFile) {
  const { PDFDocument, StandardFonts, rgb } = window.PDFLib || {};
  if (!PDFDocument) throw new Error("The PDF tool did not load; check the internet connection and reload");
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.08, 0.1, 0.13);
  const grey = rgb(0.42, 0.45, 0.5);
  const shade = rgb(0.85, 0.87, 0.9);
  const line = rgb(0.55, 0.58, 0.62);
  const { form, steps, events, files } = detail;
  const data = form.data;
  const t = totals(data);

  doc.setTitle(`${form.number} Sales Order for Billing`);
  doc.setSubject(form.so_number ? `SAP sales order ${form.so_number}` : "Sales order approval");

  let page;
  let y;
  const newPage = () => {
    page = doc.addPage(A4);
    y = A4[1] - M;
  };
  const room = (h) => { if (y - h < M) newPage(); };
  const width = A4[0] - 2 * M;

  const wrap = (text, f, size, max) => {
    const out = [];
    for (const para of safe(text).split("\n")) {
      let current = "";
      for (const word of para.split(/\s+/)) {
        const next = current ? `${current} ${word}` : word;
        if (f.widthOfTextAtSize(next, size) > max && current) {
          out.push(current);
          current = word;
        } else current = next;
      }
      out.push(current);
    }
    return out;
  };
  const text = (s, x, yy, opts = {}) => page.drawText(safe(s), {
    x, y: yy, size: opts.size || 9, font: opts.bold ? bold : font, color: opts.color || ink,
  });

  // ------------------------------------------------------------ header
  newPage();
  page.drawRectangle({ x: M, y: y - 22, width, height: 22, color: shade });
  const title = "CG Motors Pvt. Ltd";
  text(title, M + (width - bold.widthOfTextAtSize(title, 14)) / 2, y - 16, { size: 14, bold: true });
  y -= 36;
  const sub = "Sales Order for Billing";
  text(sub, M + (width - bold.widthOfTextAtSize(sub, 10)) / 2, y, { size: 10, bold: true });
  y -= 18;
  const meta = [
    ["Form", form.number], ["ASM / Prepared by", form.owner_name],
    ["Dealer", data.dealer], ["Date", npt(form.created_at).slice(0, 10)],
    ["SAP sales order", form.so_number || "(not yet created)"], ["Approval rule", form.rule || ""],
  ];
  for (let i = 0; i < meta.length; i += 2) {
    for (let j = 0; j < 2 && i + j < meta.length; j++) {
      const [k, v] = meta[i + j];
      const x = M + j * (width / 2);
      text(`${k}:`, x, y, { bold: true });
      text(v, x + 100, y);
    }
    y -= 13;
  }
  y -= 6;

  // ------------------------------------------------------- the sections
  const labelW = 190;
  const row = (label, value, opts = {}) => {
    const lines = wrap(value, opts.bold ? bold : font, 9, width - labelW - 10);
    const labels = wrap(label, opts.bold ? bold : font, 9, labelW - 8);
    const h = Math.max(14, Math.max(lines.length, labels.length) * 11 + 4);
    room(h);
    page.drawRectangle({ x: M, y: y - h, width, height: h, borderColor: line, borderWidth: 0.5,
      color: opts.fill || undefined });
    page.drawLine({ start: { x: M + labelW, y }, end: { x: M + labelW, y: y - h }, thickness: 0.5, color: line });
    labels.forEach((l, i) => text(l, M + 4, y - 10 - i * 11, { bold: opts.bold }));
    lines.forEach((l, i) => text(l, M + labelW + 6, y - 10 - i * 11, { bold: opts.bold }));
    y -= h;
  };
  const heading = (s) => {
    room(34);
    y -= 4;
    page.drawRectangle({ x: M, y: y - 16, width, height: 16, color: shade });
    text(s, M + 4, y - 12, { size: 10.5, bold: true });
    y -= 16;
  };

  for (const [title2, fields] of SECTIONS) {
    heading(title2);
    for (const [key, label, kind] of fields) {
      if (kind === "list") {
        const items = Array.isArray(data[key]) ? data[key] : [];
        row(label, items.length ? items.join("\n") : "-");
        continue;
      }
      if (title2 === "Billing Amount Details" && key === "units") {
        row("Total Discount", money(t.discount), { bold: true });
        row("Unit", data.units || "");
        row("Billing Price", money(t.billing), { bold: true });
        continue;
      }
      let value = data[key] ?? "";
      if (kind === "number" && value !== "") value = money(value);
      if (MARGINS.some(([k]) => k === key) && value === "") value = "-";
      row(label, value || "");
    }
    if (title2 === "Billing Amount Details") row("Invoice Value", money(t.invoice), { bold: true });
  }

  // -------------------------------------------------------- signatures
  heading("Approvals");
  const sent = detail.submitted || {};
  const boxes = [{ role: "Prepared by (ASM)", name: form.owner_name, at: sent.at || "", sig: sent.signature || null },
    ...steps.map((s) => ({
      role: s.label || ROLES[s.role], name: s.done ? s.done.name : "",
      at: s.done ? s.done.at : "", sig: s.done ? s.done.signature : null,
      remark: s.done ? s.done.remark : "",
    }))];
  const cols = 3;
  const boxW = width / cols;
  const boxH = 96;
  for (let i = 0; i < boxes.length; i += cols) {
    room(boxH);
    for (let j = 0; j < cols && i + j < boxes.length; j++) {
      const b = boxes[i + j];
      const x = M + j * boxW;
      page.drawRectangle({ x, y: y - boxH, width: boxW, height: boxH, borderColor: line, borderWidth: 0.5 });
      text(b.role, x + 5, y - 12, { bold: true });
      if (b.sig) {
        try {
          const png = await doc.embedPng(b.sig);
          const scale = Math.min((boxW - 12) / png.width, 40 / png.height, 1);
          page.drawImage(png, { x: x + 6, y: y - 60, width: png.width * scale, height: png.height * scale });
        } catch { /* a broken signature image leaves the box blank */ }
      }
      text(b.name ? `Name: ${b.name}` : "Name:", x + 5, y - 72);
      text(b.at ? `Date: ${npt(b.at)} (Nepal)` : "Date:", x + 5, y - 83, { color: grey, size: 8 });
      if (b.remark) text(wrap(b.remark, font, 7.5, boxW - 10)[0], x + 5, y - 93, { size: 7.5, color: grey });
    }
    y -= boxH;
  }

  // ----------------------------------------------------------- history
  heading("History (Nepal time)");
  for (const e of events) {
    const what = `${npt(e.at)}  ${e.user_name}: ${e.action.replace("_", " ")}${e.role ? ` (${ROLES[e.role] || e.role})` : ""}${e.remark ? ` - ${e.remark}` : ""}`;
    for (const l of wrap(what, font, 8, width - 8)) {
      room(11);
      text(l, M + 4, y - 9, { size: 8 });
      y -= 11;
    }
  }
  if (files.length) {
    y -= 6;
    room(12);
    text(`Attached documents (${files.length}) follow: ${files.map((f) => f.name).join(", ")}`, M + 4, y - 9, { size: 8, color: grey });
  }

  // ------------------------------------------------------- attachments
  for (const f of files) {
    const bytes = await loadFile(f);
    try {
      if (f.type === "application/pdf") {
        const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
        const pages = await doc.copyPages(src, src.getPageIndices());
        pages.forEach((p) => doc.addPage(p));
      } else {
        const img = f.type === "image/png" ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
        newPage();
        text(`Attachment: ${f.name}`, M, y - 10, { size: 9, bold: true });
        const maxW = width;
        const maxH = A4[1] - 2 * M - 24;
        const scale = Math.min(maxW / img.width, maxH / img.height, 1);
        page.drawImage(img, {
          x: M + (maxW - img.width * scale) / 2, y: M, width: img.width * scale, height: img.height * scale,
        });
      }
    } catch {
      newPage();
      text(`Attachment ${f.name} could not be added to this PDF (damaged or protected).`, M, y - 12, { bold: true });
      text("Open it from the form on the website instead.", M, y - 26);
    }
  }

  // Page numbers on every page.
  const all = doc.getPages();
  all.forEach((p, i) => {
    p.drawText(safe(`${form.number}  -  page ${i + 1} of ${all.length}`), {
      x: M, y: 16, size: 7, font, color: grey,
    });
  });
  return doc.save();
}
