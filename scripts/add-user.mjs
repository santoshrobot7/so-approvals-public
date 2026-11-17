// Adds a person straight into the database, for the first admin (after
// that, admins add people on the Users page). Prints a temporary
// password, which must be changed at first login.
//
//   node scripts/add-user.mjs <username> "<Full Name>" [--admin] [--roles a,b] [--local]
import { execFileSync } from "node:child_process";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const [username, name] = args;
if (!username || !name) {
  console.log('usage: node scripts/add-user.mjs <username> "<Full Name>" [--admin] [--roles a,b] [--local]');
  process.exit(1);
}
const admin = args.includes("--admin");
const local = args.includes("--local");
const rolesAt = args.indexOf("--roles");
const roles = rolesAt > 0 ? args[rolesAt + 1].split(",").filter(Boolean) : [];
const password = process.env.SOA_PASSWORD
  || `${randomBytes(9).toString("base64url")}7a`;   // letters and digits, 14 characters

const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, 100000, 32, "sha256").toString("hex");
const stored = `pbkdf2$100000$${salt.toString("hex")}$${hash}`;
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const sql = `INSERT INTO users (username, name, roles, brands, is_admin, password, must_change)
  VALUES (${q(username)}, ${q(name)}, ${q(JSON.stringify(roles))}, '[]', ${admin ? 1 : 0}, ${q(stored)}, 1);`;

// Through a file: the Windows shell would mangle the quotes in --command.
const file = join(mkdtempSync(join(tmpdir(), "soa-")), "user.sql");
writeFileSync(file, sql);
try {
  execFileSync("npx", ["wrangler", "d1", "execute", "so-approvals", local ? "--local" : "--remote",
    "--file", file, "--yes"], { stdio: ["ignore", "ignore", "inherit"], shell: process.platform === "win32" });
} finally {
  rmSync(dirname(file), { recursive: true, force: true });
}
console.log(`Added ${username}${admin ? " (admin)" : ""}. Temporary password: ${password}`);
