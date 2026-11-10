# EMI Manager (MySoulSchool)

Internal MERN app that tracks every high-ticket student's fee, EMI schedule and payments by **Program → Batch → Enrollment → Instalments → Payments**, built from the product spec. Statuses, overdue days, KPIs and charts are always **calculated from instalments and payments, never stored or typed**.

- **Backend:** Node + Express + Mongoose (JWT auth, 4 roles), `server/`
- **Frontend:** React (Vite) + Recharts, `client/`
- In production the Express server also serves the built React app, so it deploys as one service.

## Run locally

Needs Node 20+ and a MongoDB (local or Atlas).

```bash
npm run install:all
cp server/.env.example server/.env      # set MONGODB_URI, JWT_SECRET, admin email/password
npm run seed                            # admin user, SUPER + RGM programs, adjustment list, settings
npm run seed:demo                       # optional: a demo batch with 7 students in different states
npm run build                           # builds the React app
npm start                               # http://localhost:5000
```

For development with hot reload, run `npm run dev --prefix server` and `npm run dev --prefix client` (the client proxies `/api` to port 5000). Sign in with the seeded admin, then **change the password**. Create the rest of the team in Settings → Users & roles.

## What is built

**Phase 1 (core), all of it**
- Settings: programs (add more without code), batches (instantly become tabs; archive, never delete), previous-program adjustments (with "only credited against" restriction), payment modes, reminder rules, message templates, users and roles with optional per-CRM batch restriction.
- New enrollment: 4-step form with live fee summary, existing-student lookup by phone (links instead of duplicating), adjustments, discount, application and commitment fee with proof, auto-split EMIs (remainder on the last EMI) with per-row editing, exact-sum and ascending-date validation, optional signed agreement, welcome message with the schedule.
- Record payment: mandatory screenshot, mode and unique UTR; live preview of what will clear; excess rolls to later EMIs oldest first; partial payments; override of the next due date with a reason; thank-you message ready after save.
- EMI Tracker: instalment-level rows, all the spec's quick filters, WhatsApp (pre-filled `wa.me` link, auto-logged), Log call with outcome and promised date (row leaves the queue until that date), bulk reminders.
- Batch dashboard KPI cards (clickable, open the filtered student list), Students tab and student profile, Payments tab.
- CSV import with preview and per-row error flags (EMI sum mismatch, bad phone/date, unknown batch) before anything is saved.

**Phase 2 (visibility)**: charts (expected vs collected by month, status donut, overdue ageing, collections by mode), Home cross-program view with a "due today" list, Accounts verification queue, activity log screen, Excel export per batch.

**Business rules enforced on the server** (spec section 9): whole rupees; instalments must always sum to net payable; paid instalments are locked; duplicate phone-in-batch and duplicate UTR blocked; adjustments cannot exceed the fee; discounts above the limit need a Manager; payments are never deleted, only reversed by an Admin; dropped/refunded enrollments waive unpaid instalments but keep revenue; every create/edit is written to the activity log; dates are `DD MMM YYYY`, Asia/Kolkata.

**Not built (Phase 3 / "later")**: Razorpay payment links and webhook, automatic WhatsApp sending, 9am Slack digest, receipt PDFs, collector performance, cash-flow forecast, GST/invoice fields, student self-view.

## Defaults I chose for the spec's open questions (all editable in Settings)
- Application and commitment fee are **per student**; program defaults are left at 0.
- Grace period **2 days**; defaulter after **30 days** overdue.
- Only the Tarot L1 (₹10,000) and Reiki L1+L2 (₹6,999) credit amounts were in the spec; the other adjustment programs are seeded at ₹0 for you to fill in.
- International payments: stored in INR, with the original currency and amount noted on the payment.
- "Verifies payments" is allowed for Admin, Manager, and any user ticked **Can verify payments** (for Accounts, who can otherwise be read-only Viewers).

## Database
All collections are prefixed `emi_` (emi_programs, emi_users, ...), so the app can safely share a MongoDB database or Atlas cluster with other projects.

## Deploying
- Set `JWT_SECRET` (the server refuses to start in production without it) and `MONGODB_URI`.
- **Screenshots are saved on disk** (`UPLOAD_DIR`). On hosts with an ephemeral disk (Render free tier, Vercel, Heroku) they would disappear on every deploy, so mount a persistent disk or move uploads to S3 / Google Drive first. They are only served to signed-in users.
- Put it behind HTTPS.

## Tests
`npm test` runs 21 unit tests over the calculation core: your worked example (₹1,83,001 → 5 × 30,500 + 1 × 30,501), month stepping, every status rule, grace period, allocation, reversal ledger, KPIs, ageing, tracker filters, promised-date hiding, and the CSV row parser.
