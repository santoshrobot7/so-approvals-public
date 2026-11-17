# SO Approvals

The paper "Sales Order for Billing" form for CG Motors, made digital. A
sales person fills it in and adds supporting documents. It then goes
along an approval chain (for example Sales supervisor → HOD → Sales
Account → CFO → CEO). Each approver signs with the signature they drew
once. When the last approval is in, the sales person creates the sales
order in SAP, enters the SO number here, downloads the PDF and attaches
it to the order in VA02 (Services for Object → Create attachment).

Site: https://so-approvals.salesb.workers.dev

## How it is built

- **Cloudflare Worker** (`src/worker.js`) serves the API under `/api/`.
  The pages in `public/` are served as static assets.
- **D1 database** `so-approvals` holds users, sessions, forms, the
  approval history and the documents. Documents are stored in 1 MB
  pieces. The schema is in `migrations/`.
- **`public/shared.js`** holds the form's fields, the totals and the
  choice of approval chain. Browser, Worker and tests all import it.
- **The PDF is built in the browser** (`public/pdf.js`, pdf-lib from
  cdnjs, pinned with an integrity hash). It contains the form in the
  paper layout, every signature, the history, then each attached PDF's
  pages and each photo on its own page.

## Rules and roles

Admins set up people (Users page) and approval rules (Rules page).

- **Rules:** when a form is sent, the first rule whose conditions all
  hold picks the chain. A rule can match on brand, minimum discount % of
  MRP and minimum invoice value. If no rule fits, the form goes to
  Sales supervisor → HOD → Sales Account → CFO → CEO. A form keeps the
  chain it was sent with.
- **Brands:** a person's role can be limited to certain brands. A GAC
  supervisor sees only GAC forms.
- **Who acts:** anyone holding the role of the current step may approve
  or return. No one can approve their own form. Returning needs a
  reason and sends the form back to the sales person. Sending it again
  starts the chain from the first step.

## Security

- Passwords are stored as PBKDF2-SHA256 hashes (100,000 rounds).
  Temporary passwords must be changed at first login.
- After 5 wrong passwords an account is locked for 15 minutes.
- Sessions are HttpOnly, Secure, SameSite=Strict cookies lasting 12
  hours; only a hash of each session token is stored. Writes from other
  sites are refused.
- A form is visible only to its sales person, to admins, and to people
  whose role is in its chain.
- Uploads must be PDF, PNG or JPG, checked by their content and not
  only their name, up to 10 MB each and 15 per form.

## Commands

    npm install
    npx wrangler login
    npm test                      unit tests + end-to-end API test (local)
    node test/ui-smoke.mjs out    browser test with headless Edge
    npx wrangler dev              run locally
    npx wrangler d1 migrations apply so-approvals --remote
    npx wrangler deploy
    node scripts/add-user.mjs <username> "<Full Name>" --admin
                                  first admin; prints a temporary password
