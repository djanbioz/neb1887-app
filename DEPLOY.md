# NEB 1887 — Deployment Guide
**From zero to live app in ~30 minutes**

---

## STEP 1 — Run the Database Schema in Supabase

1. Go to **https://supabase.com** → Sign up free
2. Click **New Project** → name it `neb1887` → choose a strong password → Create
3. Wait ~2 minutes for it to spin up
4. Go to **SQL Editor** (left sidebar) → **New Query**
5. Paste the entire contents of `schema.sql` → click **Run**
6. You should see "Success" — your tables, seed data, and views are ready

---

## STEP 2 — Get Your Supabase Keys

1. In Supabase → **Project Settings** (gear icon) → **API**
2. Copy these two values:
   - **Project URL** → looks like `https://abcxyz.supabase.co`
   - **anon public key** → a long string starting with `eyJ...`

---

## STEP 3 — Add Your Keys to the App

Open `src/supabaseClient.js` and replace:

```js
const SUPABASE_URL = 'https://YOUR_PROJECT_ID.supabase.co'  // ← paste Project URL
const SUPABASE_KEY = 'YOUR_ANON_PUBLIC_KEY'                  // ← paste anon key
```

---

## STEP 4 — Create Your Admin Login

1. In Supabase → **Authentication** → **Users** → **Add User**
2. Enter your email and a strong password
3. This is the login you'll use to open the app

---

## STEP 5 — Install Node.js (if you haven't)

Download from **https://nodejs.org** → install the LTS version

---

## STEP 6 — Run Locally to Test

Open a terminal in this folder and run:

```bash
npm install
npm run dev
```

Open **http://localhost:5173** in your browser.
Log in with the email/password you created in Step 4.
Test recording a payment — check Supabase → Table Editor → transactions to confirm it saved.

---

## STEP 7 — Push to GitHub

```bash
# First time only — install Git from https://git-scm.com if needed
git init
git add .
git commit -m "NEB 1887 initial deploy"
```

1. Go to **https://github.com** → New repository → name it `neb1887-app`
2. Copy the remote URL it gives you, then:

```bash
git remote add origin https://github.com/YOUR_USERNAME/neb1887-app.git
git push -u origin main
```

---

## STEP 8 — Deploy to Vercel (Free Hosting)

1. Go to **https://vercel.com** → Sign in with GitHub
2. Click **Add New Project** → Import `neb1887-app`
3. Vercel auto-detects Vite — just click **Deploy**
4. Your app goes live at `https://neb1887-app.vercel.app` (or similar)

> Every time you push a change to GitHub, Vercel redeploys automatically.

---

## STEP 9 — Add GCash QR Image

1. Register at **https://business.gcash.com.ph** for a GCash for Business account
2. Download your official merchant QR code image
3. Save it as `public/gcash-qr.png` in this project folder
4. In `src/App.jsx`, find the QR placeholder section and replace with:

```jsx
<img src="/gcash-qr.png" alt="GCash QR" style={{ width:140, height:140 }}/>
```

5. Push to GitHub → Vercel auto-redeploys

---

## STEP 10 — Add to Phone Home Screen

Share your Vercel URL with staff. On their phones:

**iPhone:** Open in Safari → Share button → *Add to Home Screen*
**Android:** Open in Chrome → ⋮ menu → *Add to Home Screen*

It will appear as a real app icon — no App Store needed!

---

## File Structure

```
neb1887-app/
├── index.html              ← App entry point
├── package.json            ← Dependencies
├── vite.config.js          ← Build config
├── schema.sql              ← Run this in Supabase once
├── DEPLOY.md               ← This guide
├── public/
│   └── gcash-qr.png        ← Add your GCash QR here
└── src/
    ├── main.jsx            ← React root
    ├── App.jsx             ← Full app code
    └── supabaseClient.js   ← ← PASTE YOUR KEYS HERE
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Invalid API key" error | Double-check keys in supabaseClient.js |
| Login fails | Create user in Supabase → Authentication → Users |
| Data not saving | Check Supabase → Table Editor → RLS policies |
| App not loading | Run `npm install` first, then `npm run dev` |
| Vercel deploy fails | Check build logs — usually a missing import |

---

## Monthly Maintenance

- **Change rates:** Open app → Settings → adjust sliders → Save
- **Add a student:** Supabase → Table Editor → students → Insert row
- **Export data:** Supabase → Table Editor → any table → Export CSV
- **View reports:** Supabase → Table Editor → monthly_summary view

---

*Built for Lucky Shining Star Dev. Corp. · NEB 1887*
