// One-command deploy for BodyDash: uploads the Vite build to S3 and refreshes CloudFront.
//
// Usage:
//   npm run deploy                                 build, upload, and clear the CloudFront cache
//   npm run build; node scripts/deploy.mjs --dry-run  show what would change, upload nothing
//     (the two-step dry run avoids a PowerShell quirk that swallows "--" in npm arguments)
//
// Requires AWS CLI v2.32.0+ and an active "aws login" session (see DEPLOY.md).

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const CONFIG = {
  accountId: "782083514989", // the Sunrise Sprint project account (not the AWS Settings account)
  region: "us-east-2",
  distributionId: "EQAFN7YQ3MY5U",
  // Leave empty to read the bucket name from the CloudFront origin automatically.
  bucket: "",
  distDir: "dist",
};

const DRY_RUN = process.argv.includes("--dry-run");

function step(message) {
  console.log(`\n-> ${message}`);
}

function warn(message) {
  console.warn(`   WARNING: ${message}`);
}

function fail(message) {
  console.error(`\nERROR: ${message}\n`);
  process.exit(1);
}

// Default install locations, used when a terminal was opened before the CLI was
// installed (or VS Code is still running with its old PATH).
const AWS_CLI_FALLBACKS = [
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Amazon", "AWSCLIV2", "aws.exe"),
  process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Amazon", "AWSCLIV2", "aws.exe"),
  "/usr/local/bin/aws",
  "/opt/homebrew/bin/aws",
].filter(Boolean);

let awsBin = "aws";

// Finds the AWS CLI: first on PATH, then in its default install folders.
function locateAwsCli() {
  const probe = spawnSync("aws", ["--version"], { stdio: "ignore" });
  if (!probe.error) return;
  if (probe.error.code !== "ENOENT") {
    fail(`Could not run the AWS CLI: ${probe.error.message}`);
  }
  const found = AWS_CLI_FALLBACKS.find((candidate) => existsSync(candidate));
  if (!found) {
    fail("AWS CLI not found. Install it (DEPLOY.md step 1), then open a NEW terminal and retry.");
  }
  awsBin = found;
  warn(`This terminal can't see the AWS CLI on its PATH, so using ${found} directly.`);
  warn("To fix it permanently, fully quit and reopen VS Code (or close every terminal window).");
}

// Runs the AWS CLI directly (no shell), so arguments like "/*" reach AWS unchanged
// on Windows, macOS, and Linux alike.
function aws(args, { capture = false } = {}) {
  const result = spawnSync(awsBin, args, {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: { ...process.env, AWS_PAGER: "" },
  });
  if (result.error) {
    fail(`Could not run the AWS CLI: ${result.error.message}`);
  }
  return result;
}

function awsJson(args, errorMessage) {
  const result = aws([...args, "--output", "json"], { capture: true });
  if (result.status !== 0) {
    fail(`${errorMessage}\n   ${result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout);
}

function checkBuild() {
  step("Checking the build");
  const indexPath = path.join(CONFIG.distDir, "index.html");
  if (!existsSync(indexPath)) {
    fail(`No ${indexPath} found. Use "npm run deploy", which builds the project first.`);
  }
  console.log(`   Found ${indexPath}`);
}

function checkCliVersion() {
  step("Checking the AWS CLI");
  locateAwsCli();
  const result = aws(["--version"], { capture: true });
  const output = `${result.stdout}${result.stderr}`;
  const match = output.match(/aws-cli\/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    fail(`Unexpected output from "aws --version": ${output.trim()}`);
  }
  const [major, minor, patch] = match.slice(1).map(Number);
  console.log(`   AWS CLI ${major}.${minor}.${patch}`);
  if (major < 2 || (major === 2 && minor < 32)) {
    warn('This version is older than 2.32.0 and does not support "aws login". Reinstall the latest v2 (DEPLOY.md step 1).');
  }
}

function checkLogin() {
  step("Checking your AWS login");
  const result = aws(["sts", "get-caller-identity", "--output", "json"], { capture: true });
  if (result.status !== 0) {
    fail(`You are not logged in to AWS (or your session expired). Run "aws login", then retry.\n   ${result.stderr.trim()}`);
  }
  const { Account, Arn } = JSON.parse(result.stdout);
  if (Account !== CONFIG.accountId) {
    fail(
      `You are logged in to account ${Account}, but BodyDash lives in ${CONFIG.accountId}.\n` +
        '   Run "aws logout", then "aws login" and pick the Sunrise Sprint project session.'
    );
  }
  console.log(`   Account ${Account}`);
  console.log(`   Identity ${Arn}`);
}

function readDistribution() {
  step(`Reading CloudFront distribution ${CONFIG.distributionId}`);
  const { Distribution } = awsJson(
    ["cloudfront", "get-distribution", "--id", CONFIG.distributionId],
    `Could not read CloudFront distribution ${CONFIG.distributionId}. Check the ID in CONFIG.`
  );
  const config = Distribution.DistributionConfig;

  if (config.DefaultRootObject !== "index.html") {
    warn('Default root object is not "index.html", so the homepage will show AccessDenied.');
    warn("Fix: CloudFront > your distribution > General > Settings > Edit > Default root object.");
  }
  if (config.DefaultCacheBehavior?.ViewerProtocolPolicy === "allow-all") {
    warn('Plain HTTP is allowed. The camera only works over HTTPS, so set "Redirect HTTP to HTTPS" in Behaviors.');
  }

  let bucket = CONFIG.bucket;
  if (!bucket) {
    const originDomains = (config.Origins?.Items ?? []).map((origin) => origin.DomainName);
    const s3Origin = originDomains.find((domain) => /\.s3[.-]/.test(domain));
    const match = s3Origin?.match(/^(.+?)\.s3[.-]/);
    if (!match) {
      fail(`No S3 origin found on the distribution (origins: ${originDomains.join(", ") || "none"}). Set CONFIG.bucket in scripts/deploy.mjs.`);
    }
    bucket = match[1];
  }

  console.log(`   Bucket ${bucket}`);
  console.log(`   Domain ${Distribution.DomainName}`);
  return { bucket, domain: Distribution.DomainName };
}

// Vite fingerprints asset filenames (e.g. index-a1b2c3.js), so they can be cached for a year.
// Assets go up first so the new index.html never points at files that don't exist yet.
function upload(bucket) {
  const target = `s3://${bucket}`;
  const dryRunFlag = DRY_RUN ? ["--dryrun"] : [];

  step(`Uploading assets to ${target}${DRY_RUN ? " (dry run)" : ""}`);
  const sync = aws([
    "s3", "sync", CONFIG.distDir, target,
    "--delete",
    "--exclude", "index.html",
    "--cache-control", "public,max-age=31536000,immutable",
    "--region", CONFIG.region,
    ...dryRunFlag,
  ]);
  if (sync.status !== 0) fail("Asset upload failed. See the AWS error above.");

  // index.html is never cached by browsers, so players always load the newest build.
  step(`Uploading index.html${DRY_RUN ? " (dry run)" : ""}`);
  const copy = aws([
    "s3", "cp", path.join(CONFIG.distDir, "index.html"), `${target}/index.html`,
    "--cache-control", "no-cache",
    "--content-type", "text/html; charset=utf-8",
    "--region", CONFIG.region,
    ...dryRunFlag,
  ]);
  if (copy.status !== 0) fail("index.html upload failed. See the AWS error above.");
}

function invalidateCache() {
  if (DRY_RUN) {
    step("Skipping the CloudFront cache refresh (dry run)");
    return;
  }
  step("Clearing the CloudFront cache");
  const { Invalidation } = awsJson(
    ["cloudfront", "create-invalidation", "--distribution-id", CONFIG.distributionId, "--paths", "/*"],
    "Files uploaded, but clearing the cache failed. Do it manually: CloudFront > Invalidations > Create > /*"
  );
  console.log(`   Invalidation ${Invalidation.Id} started (usually finishes in 1-2 minutes)`);
}

checkBuild();
checkCliVersion();
checkLogin();
const { bucket, domain } = readDistribution();
upload(bucket);
invalidateCache();

console.log(
  DRY_RUN
    ? "\nDry run complete. Nothing was uploaded. Run \"npm run deploy\" to publish for real.\n"
    : `\nDeployed! BodyDash is live at https://${domain}\n`
);
