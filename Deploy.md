# Deploying BodyDash to AWS (S3 + CloudFront)

BodyDash deploys with one command from your laptop:

```
npm run deploy
   │
   ├─ vite build ─────────────► dist/
   │
   └─ scripts/deploy.mjs
        ├─ preflight checks: AWS CLI installed, logged in to the right account,
        │                    CloudFront settings correct
        ├─ aws s3 sync ───────► private S3 bucket (us-east-2)
        └─ cache refresh ─────► CloudFront (HTTPS CDN) ──► https://xxxx.cloudfront.net
```

**Time:** about 20 minutes the first time, then about 30 seconds per deploy.

## Your setup

| Setting | Value |
|---|---|
| AWS account ID | `435636069010` |
| Region | `us-east-2` |
| CloudFront distribution ID | `EQAFN7YQ3MY5U` |
| S3 bucket | Detected automatically from the CloudFront origin |
| AWS plan | Free plan, ends **Apr 6, 2027** (see the reminder at the bottom) |

These values are already filled in at the top of `scripts/deploy.mjs`.

---

## Step 1 — Check your CloudFront settings (~3 min)

Open the AWS Console from your **Sunrise Sprint** project, go to **CloudFront**, and open distribution `EQAFN7YQ3MY5U`.

1. **General** tab, then **Settings**, then **Edit**: make sure **Default root object** is `index.html`. Save if you changed it.
2. **Behaviors** tab: make sure **Viewer protocol policy** is **Redirect HTTP to HTTPS**. The camera only works over HTTPS.
3. Go to **S3**, open your bucket, then **Permissions**, then **Bucket policy**. It should mention `cloudfront.amazonaws.com`. If it's empty, go back to CloudFront, open the **Origins** tab, edit the origin, and use **Copy policy**. Then paste it into the bucket policy and save.

You don't need to memorize these. The deploy script also warns you if the root object or HTTPS setting is wrong.

---

## Step 2 — Install the AWS CLI (~5 min)

1. In PowerShell, run AWS's official install script:

   ```powershell
   irm https://awscli.amazonaws.com/v2/install.ps1 | iex
   ```

2. **Close every terminal and open a new one.** The `aws` command won't be found until you do.
3. Check the version:

   ```bash
   aws --version
   ```

   You need **2.32.0 or newer**, which is the version that added `aws login`. If it's older, run the installer again.

---

## Step 3 — Log in (~1 min)

```bash
aws login
```

The first time, it asks `AWS Region [us-east-1]:`. Type only `us-east-2` and press Enter. Then your browser opens. Pick your active console session, or sign in, and return to the terminal.

Confirm it worked:

```bash
aws sts get-caller-identity
```

You should see `"Account": "435636069010"`.

This gives the CLI short-lived credentials that refresh automatically, so you never create or store access keys. When the session eventually expires, the deploy script tells you, and you just run `aws login` again.

---

## Step 4 — Add the files (~2 min)

| File | What to do |
|---|---|
| `scripts/deploy.mjs` | New file. Create a `scripts` folder in the project root and put it there. |
| `package.json` | Add this one line inside `"scripts"`: `"deploy": "vite build && node scripts/deploy.mjs"` |
| `DEPLOY.md` | Replace the old version with this one. |

**Important:** if you added `.github/workflows/deploy.yml` from the earlier plan, **delete it**. Otherwise every push to GitHub will show a failed workflow run.

---

## Step 5 — Dry run first (~1 min)

```bash
npm run deploy -- --dry-run
```

This builds the project and runs every check. It lists what *would* be uploaded but changes nothing. If all the checks pass without errors, you're ready.

---

## Step 6 — Deploy (~1 min)

```bash
npm run deploy
```

The last line prints your live link:

```
Deployed! BodyDash is live at https://dxxxxxxxxxxxx.cloudfront.net
```

Open it, click **Start camera**, and allow access. Give the first deploy 1–2 minutes for CloudFront to pick it up.

---

## Step 7 — Commit (~1 min)

```bash
git add scripts/deploy.mjs package.json DEPLOY.md
git commit -m "Add one-command AWS deploy (S3 + CloudFront)"
git push
```

## Every future update

```bash
npm run deploy
```

If it says you're not logged in, run `aws login` first.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `aws` is not recognized | Open a new terminal after installing. If it still fails, run the installer again. |
| `Invalid choice: 'login'` | Your CLI is older than 2.32.0. Run the installer again to upgrade. |
| `ERROR: You are not logged in` | Run `aws login`. |
| `ERROR: You are logged in to account ...` | Run `aws logout`, then `aws login`, and pick the Sunrise Sprint session. |
| `AccessDenied` during upload or the cache refresh | Make sure the console session you chose during `aws login` is the Sunrise Sprint project's. If it still fails, use the manual fallback below. |
| Site shows an XML `AccessDenied` page | Recheck step 1: the bucket policy or default root object. |
| Old version still showing | Wait 1–2 minutes, then hard-refresh with Ctrl+Shift+R. |
| Camera doesn't start | Use the `https://` link, and check site permissions (the lock icon in the address bar). |
| `No S3 origin found` | Set `bucket: "your-bucket-name"` in the `CONFIG` block at the top of `scripts/deploy.mjs`. |

### Manual fallback (no CLI needed)

1. Run `npm run build`.
2. In **S3**, open your bucket, choose **Upload**, and drag in the **contents** of `dist/` (the `index.html` file and the `assets` folder, not the `dist` folder itself). Then choose **Upload**.
3. In **CloudFront**, open your distribution, go to **Invalidations**, choose **Create invalidation**, enter `/*`, and create it.

---

## Free plan reminder

Your account is on the Free plan, which ends **Apr 6, 2027**. When it ends, AWS suspends the account along with the site. If you want the link to stay live after that, upgrade to the Paid plan a few weeks before. Set a calendar reminder now.

---

## Interview talking points

- **Why CloudFront in front of S3?** Browsers only allow webcam access over HTTPS. S3 website hosting is HTTP-only, so a CDN with TLS was required. It also serves the game from edge locations near players.
- **Why a private bucket?** Origin Access Control means only this CloudFront distribution can read the bucket. Nobody can bypass the CDN.
- **How are credentials handled?** `aws login` issues short-lived credentials from the console session and rotates them automatically. No long-term access keys exist anywhere to leak.
- **Caching strategy:** Vite fingerprints asset filenames, so those are cached for a year, while `index.html` is never cached. Assets upload before `index.html`, so a new page never references files that aren't there yet.
- **Deploy safety:** the script refuses to run against the wrong AWS account, warns about misconfigured CloudFront settings before uploading, and supports a `--dry-run` mode.