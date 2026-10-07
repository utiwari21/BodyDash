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
        └─ cache refresh ─────► CloudFront (HTTPS CDN) ──► https://d1p30moihm4q7m.cloudfront.net
```

**Live link:** https://d1p30moihm4q7m.cloudfront.net

## Your setup

| Setting | Value |
|---|---|
| AWS account ID (Sunrise Sprint project) | `782083514989` |
| Region | `us-east-2` |
| S3 bucket | `bodydash-utiwari21` (private, read only by CloudFront) |
| CloudFront distribution ID | `EQAFN7YQ3MY5U` |
| CloudFront domain | `d1p30moihm4q7m.cloudfront.net` |
| AWS plan | Free plan, ends **Apr 6, 2027** (see the reminder at the bottom) |

**About the two account IDs:** on AWS's simplified setup, each project runs in its own AWS account. `782083514989` is the Sunrise Sprint project account, where the bucket and distribution live. You'll also see `435636069010` in AWS Settings; that's the top-level account and isn't used for deploys.

These values are already filled in at the top of `scripts/deploy.mjs`.

---

## Step 1 — Install the AWS CLI (~5 min, one time)

1. In PowerShell, run AWS's official install script:

   ```powershell
   irm https://awscli.amazonaws.com/v2/install.ps1 | iex
   ```

2. **Close every terminal and open a new one.** If you use VS Code's built-in terminal, quit VS Code completely and reopen it, because its terminals keep the old settings even when you open a new tab. The `aws` command won't be found until you do.
3. Check the version:

   ```powershell
   aws --version
   ```

   You need **2.32.0 or newer**, which is the version that added `aws login`.

---

## Step 2 — Log in (~1 min)

```powershell
aws login
```

The first time, it asks `AWS Region [us-east-1]:`. Type only `us-east-2` and press Enter. Then your browser opens. Pick the **Sunrise Sprint** console session (open it from AWS Settings → Sunrise Sprint → AWS Console first if needed), and return to the terminal.

Confirm you're in the right account:

```powershell
aws sts get-caller-identity
```

You should see `"Account": "782083514989"` and an ARN containing `AccountFullAccessRole`. If it shows any other account, run `aws logout` and log in again, picking the Sunrise Sprint session.

This gives the CLI short-lived credentials that refresh automatically, so no access keys are ever created or stored. When the session eventually expires, the deploy script tells you, and you just run `aws login` again.

---

## Step 3 — Verify the AWS settings (~1 min, one time)

These checks were already run and passed. Use them again if anything stops working.

**CloudFront origin, homepage, and HTTPS:**

```powershell
aws cloudfront get-distribution --id EQAFN7YQ3MY5U --query "Distribution.DistributionConfig.{Origin:Origins.Items[0].DomainName,RootObject:DefaultRootObject,Protocol:DefaultCacheBehavior.ViewerProtocolPolicy}" --output table
```

Expected:

| Field | Value |
|---|---|
| Origin | `bodydash-utiwari21.s3.us-east-2.amazonaws.com` |
| Protocol | `redirect-to-https` |
| RootObject | `index.html` |

**Bucket policy (CloudFront can read the bucket):**

```powershell
aws s3api get-bucket-policy --bucket bodydash-utiwari21 --query Policy --output text
```

Expected: a policy allowing `cloudfront.amazonaws.com` to `s3:GetObject`, with the condition `arn:aws:cloudfront::782083514989:distribution/EQAFN7YQ3MY5U`.

---

## Step 4 — Make sure the project files are in place

```
RealSubwaySurfer/
├── .gitignore
├── DEPLOY.md
├── README.md
├── index.html
├── package.json        ← contains the "deploy" script
├── package-lock.json
├── scripts/
│   └── deploy.mjs      ← the deploy script
└── src/
    ├── main.js
    └── style.css
```

If you added `.github/workflows/deploy.yml` from an earlier plan, delete it. Otherwise every push to GitHub will show a failed workflow run.

---

## Step 5 — Dry run (~1 min)

From the project folder:

```powershell
cd C:\Users\tiwar\RealSubwaySurfer
npm run build
node scripts/deploy.mjs --dry-run
```

The build and the dry run are two separate commands on purpose. PowerShell can swallow the `--` in `npm run deploy -- --dry-run`, and then npm treats `--dry-run` as its own flag instead of passing it to the script.

You should see the checks pass (account `782083514989`, bucket `bodydash-utiwari21`, domain `d1p30moihm4q7m.cloudfront.net`), then lines starting with `(dryrun) upload:`, ending with `Dry run complete. Nothing was uploaded.` Any `WARNING` or `ERROR` line tells you exactly what to fix.

---

## Step 6 — Deploy (~1 min)

```powershell
npm run deploy
```

The last line prints:

```
Deployed! BodyDash is live at https://d1p30moihm4q7m.cloudfront.net
```

Wait 1–2 minutes, then open the link, click **Start camera**, and allow access.

---

## Step 7 — Commit

```powershell
git add scripts/deploy.mjs package.json DEPLOY.md
git commit -m "Add one-command AWS deploy (S3 + CloudFront)"
git push
```

## Every future update

```powershell
npm run deploy
```

If it says you're not logged in, run `aws login` first.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `aws` is not recognized | Quit VS Code completely (or close every terminal window) and reopen it. For the current window only, run `set PATH=%PATH%;C:\Users\tiwar\AppData\Local\Programs\Amazon\AWSCLIV2` in Command Prompt. |
| `WARNING: This terminal can't see the AWS CLI on its PATH` | The deploy still works; the script found the CLI in its install folder. Quit and reopen VS Code to stop the warning. |
| `Invalid choice: 'login'` | Your CLI is older than 2.32.0. Rerun the install command to upgrade. |
| Region prompt error `doesn't match a supported format` | At the `AWS Region` prompt, type only `us-east-2`, not a full command. |
| `ERROR: You are not logged in` | Run `aws login`. |
| `ERROR: You are logged in to account ...` | Run `aws logout`, then `aws login`, and pick the Sunrise Sprint session. |
| `AccessDenied` during upload or the cache refresh | Confirm `aws sts get-caller-identity` shows `782083514989`. If it does and it still fails, use the manual fallback below. |
| Site shows an XML `AccessDenied` page | Rerun the step 3 checks, or wait for the first deploy to finish. |
| Old version still showing | Wait 1–2 minutes, then hard-refresh with Ctrl+Shift+R. |
| Camera doesn't start | Use the `https://` link, and check site permissions (the lock icon in the address bar). |

### Manual fallback (no CLI needed)

1. Run `npm run build`.
2. In the Sunrise Sprint console, open **S3**, then `bodydash-utiwari21`, and choose **Upload**. Drag in the **contents** of `dist/` (the `index.html` file and the `assets` folder, not the `dist` folder itself), then choose **Upload**.
3. In **CloudFront**, open `EQAFN7YQ3MY5U`, go to **Invalidations**, choose **Create invalidation**, enter `/*`, and create it.

---

## Free plan reminder

Your account is on the Free plan, which ends **Apr 6, 2027**. When it ends, AWS suspends the account along with the site. If you want the link to stay live after that, upgrade to the Paid plan a few weeks before. Set a calendar reminder now.

---

## Interview talking points

- **Why CloudFront in front of S3?** Browsers only allow webcam access over HTTPS. S3 website hosting is HTTP-only, so a CDN with TLS was required. It also serves the game from edge locations near players.
- **Why a private bucket?** Origin Access Control means only this CloudFront distribution can read the bucket. Nobody can bypass the CDN.
- **How are credentials handled?** `aws login` issues short-lived credentials from the console session and rotates them automatically. No long-term access keys exist anywhere to leak.
- **Caching strategy:** Vite fingerprints asset filenames, so those are cached for a year, while `index.html` is never cached. Assets upload before `index.html`, so a new page never references files that aren't there yet.
- **Deploy safety:** the script refuses to run against the wrong AWS account, warns about misconfigured CloudFront settings before uploading, and supports a dry-run mode. The account guard caught a real login mix-up during setup.