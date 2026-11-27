# Mayfly

Mayfly gives every pull request a preview that sleeps when nobody is using it, wakes on the next visit, and is deleted when the pull request closes. It is a prototype. Each preview is a placeholder Node app that shows the repository, branch, and commit. It does not build or run the pull request's real code.

**Stack:** Next.js (pages) + Express (API, webhooks, preview proxy) + MongoDB.

## How it works

Each preview is two Node processes. A gate listens on a private port on this machine (`127.0.0.1`), and the app process runs behind it. Nobody reaches the gate directly: Mayfly serves every preview at `/p/<owner>/<name>/<pr>` and forwards to it. After `PREVIEW_SLEEP_SECONDS` with no request, the gate stops the app. The next visit gets a "Waking up" page immediately, the gate starts the app, and the page loads itself. The reaper deletes a preview when its lifetime is over, when it is stuck, or when the pull request closes or merges. An idle preview is slept, and is left in place while the pull request is open. When `GITHUB_TOKEN` is set, Mayfly also comments on the pull request.

Open a preview at `/p/<owner>/<name>/<pr>` on this app.

## Run locally

From the project directory, in Linux or WSL:

```bash
npm ci
npm run dev
```

`npm run dev` starts Express with Next in development mode (hot reload for pages). The same two commands run in PowerShell. The app listens at http://localhost:3000 (or set `HOST` / `PORT`).

## Run with Docker

On Linux or a GitHub Codespace, with Docker running:

```bash
export PREVIEW_BASE_URL="https://${CODESPACE_NAME}-3000.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"
docker compose up -d --build
```

Open port 3000 and go to `/board`. The first build takes a few minutes. Preview apps still run in their own containers. If this Mayfly container restarts, live previews are started again. `.env.local` stays out of the image. Render does not run this compose file.

### Build real pull requests

With `PREVIEW_RUNTIME=docker`, set `PREVIEW_REPOS` (comma-separated `owner/name`) in `.env.local`. For a pull request on a listed repository, Mayfly clones it, checks out the exact commit, builds the repo-root `Dockerfile` as `mayfly-pr-<owner>-<name>-<pr>:<sha8>` (10 minute limit, last 20 log lines in the error), and runs that image in the same locked-down container. The app must listen on `$PORT` (3000) and work as the unprivileged user `1000:1000` with a read-only filesystem where only `/tmp` is writable, so images on any base (Node, Python, nginx, Go) run as long as they do not need root. A new commit rebuilds and swaps the container; sleep and wake reuse the image; closing the pull request removes the container and the image. Other repositories fail with "Repository not allowed", and fork pull requests are refused. A repository with no `Dockerfile` gets one written for it (see below). `DEMO_PREVIEW` keeps the placeholder app. Process mode is unchanged.

**No Dockerfile?** When there isn't one at the top of the repository, Mayfly looks at `package.json`, `requirements.txt` and the files at the top and writes one just for the build, without changing the repository. It recognises Next.js (`next start`), Vite, Create React App, Vue and Angular apps (built, then served as static files), Node.js servers with a `start` script or a `main` file, plain HTML sites, and Flask or FastAPI apps (or a `Procfile` `web:` line). The Node version comes from `engines.node` (18, 20, 22 or 24, default 22). The build log starts with a line saying the Dockerfile was written for a Next.js app, or whatever it found. If it can't tell what kind of app it is, the preview fails and says what to add. A repository's own Dockerfile is always used when it has one. Set `PREVIEW_AUTO_DOCKERFILE=false` to turn this off.

**First run.** Until the steps that matter are done, the Previews page shows the admin a "Get your first preview" checklist: turn on Docker previews, list the repositories, set the public address, connect the GitHub webhook (it shows the address to paste), and open a pull request. Optional steps, like the GitHub token, don't keep it open. Each step is ticked from what the server reports, and the checklist hides itself when the steps that matter are done (or with Hide).

**When something fails.** A failed preview shows a short "What to try" list under the error, written for the person who opened the pull request: the common causes (out of memory, a missing package, a base image that can't be pulled, an app that never listens on port 3000, a size limit) each get their own advice. Admins can also open a running preview's panel and press "Show what the app printed" to read its console output, which is where an app that starts and then crashes explains itself.

### Preview settings (variables and size)

Admins set, for each repository, the size of previews opened from GitHub and the variables every preview gets (a test database URL, test API keys, `NEXT_PUBLIC_` values), on **Admin → Preview settings**. Values are encrypted with `MAYFLY_SECRETS_KEY` (AES-256-GCM) before they're saved, so `data/state.json`, MongoDB and backups never hold them in plain text, and they're never sent back to the browser. Without the key, variables can't be saved; `deploy/aws/setup.sh` creates one. Changing the key makes saved values unreadable: previews start without them and the page asks for them again.

They're used in Docker mode only. The gate hands them to the container with `-e NAME` and the build with `--build-arg NAME` (only the ones marked "Needed while building"), with the value in Docker's environment, so no value is ever on a command line; values a Dockerfile prints are hidden in the build log. Names Mayfly or Docker rely on (`PORT`, `HOST`, `PATH`, `HOME`, `DOCKER_*`, `PREVIEW_*`, `MAYFLY_*`, `LD_*`, proxy settings and a few more) are refused. Changes apply to new previews and the next commit on open pull requests. **Every pull request's code can read its preview's variables**, so use test values only.

On the same page you can also: give every preview its own empty or seeded Postgres or MongoDB database (needs `PREVIEW_DB_POSTGRES_URL` or `PREVIEW_DB_MONGO_URL`, plus `MAYFLY_SECRETS_KEY`); list smoke-check pages that must answer a given status (posted on the pull request as **Mayfly — Smoke test**); and set a production address so Mayfly screenshots the preview next to production (needs Chrome or Edge on the server, or `PREVIEW_CHROME_PATH`).

### Cost and control

On the **Cost** page (admins):

- **Monthly budget.** Set a limit; Mayfly warns at 80% via `ALERT_WEBHOOK_URL`, and can pause previews at 100% (sleeping ones stay asleep, new ones aren't started). Resume for the rest of the month without raising the limit.
- **Cost by repository or team.** A table for the chosen week or month, with a CSV download. Teams come from `PREVIEW_TEAMS` (`web=acme/site,acme/shop;platform=acme/infra-*`). A weekly email of hours saved needs `SMTP_URL`, `REPORT_EMAIL_FROM` and `REPORT_EMAIL_TO` (optional `REPORT_WEEKDAY` / `REPORT_HOUR_UTC`).
- **Awake hours.** Keep a repository's previews awake on chosen days and times (for demos). On a preview's panel, schedule a one-off wake so it's warm before a review.

Once a preview is ready, its panel also shows the smoke-check result, the production comparison (preview / production / differences), and the scheduled wake controls.

### Build limits and the Docker socket proxy

Compose gives Mayfly no Docker socket. Only the `docker-proxy` service holds it, and Mayfly reaches Docker through it (`DOCKER_HOST=tcp://127.0.0.1:2375`, published on loopback only). The proxy allows containers, images and builds, and answers 403 to exec, volumes, networks, swarm, secrets, system, plugins and BuildKit sessions.

Builds use Docker's classic builder, because BuildKit cannot pass through the proxy. Each build step gets `PREVIEW_BUILD_MEMORY` (swap included) and `PREVIEW_BUILD_CPUS`. `PREVIEW_MAX_BUILDS` builds run at once and the rest wait their turn, and the 10 minute limit counts from when a build starts. A clone plus build context over `PREVIEW_MAX_REPO_MB` and an image over `PREVIEW_MAX_IMAGE_MB` fail the preview and leave nothing behind. Dockerfiles that need BuildKit-only features (`RUN --mount`, heredocs) will not build.

**What this does not protect.** The proxy filters by endpoint, not by request body, so it cannot stop a container created with `--privileged` or a bind mount of the host. Build steps still have network access, because they pull base images and packages. Anyone who can run code in Mayfly can still reach the host through Docker. For a public server, run Docker rootless or under Sysbox, or build on a separate host.

### Connect GitHub webhooks

A webhook creates, updates, and removes previews when pull requests change, with no simulator. GitHub must be able to reach Mayfly, so make port 3000 public (in a Codespace, set the port visibility to Public) and use that address as `PREVIEW_BASE_URL`. Set `GITHUB_WEBHOOK_SECRET` in `.env.local`, then create the hook without printing the secret:

```powershell
$secret = ((Get-Content .env.local | Where-Object { $_ -like "GITHUB_WEBHOOK_SECRET=*" }) -replace "^GITHUB_WEBHOOK_SECRET=", "").Trim('"')
@{ name = "web"; active = $true; events = @("pull_request"); config = @{ url = "$env:PREVIEW_BASE_URL/api/webhooks/github"; content_type = "json"; secret = $secret } } |
  ConvertTo-Json -Depth 5 | gh api repos/<owner>/<repo>/hooks --method POST --input -
```

On Linux or macOS, build the same JSON with `jq` and pipe it to `gh api ... --input -`. The content type must be `application/json`. A request with a missing or wrong signature gets `401` and creates nothing. Check deliveries with `gh api repos/<owner>/<repo>/hooks/<id>/deliveries`. Set `GITHUB_TOKEN` (or `MAYFLY_GITHUB_TOKEN`) in `.env.local` so Mayfly posts a **Mayfly — Preview** check and a PR comment with the preview link; without it both are skipped. The token needs commit status write and pull request comments. Docker Compose does not pass Codespace secrets into the container, so the value must be in `.env.local` even in a Codespace. Quick tunnels and other temporary addresses change, so update the hook's URL when the address changes.

Copy `.env.example` to `.env.local`. `.env.local` stays on this machine.

| Key | What it does |
|---|---|
| `MAX_CONCURRENT_ENVIRONMENTS` | Refuse new previews once this many are live. Example: `10`. |
| `PREVIEW_TTL_HOURS` | Delete a preview this many hours after it was created. A new commit resets the clock. Example: `168` (7 days). |
| `PREVIEW_IDLE_HOURS` | How far back "Mark idle" moves the last visit. The reaper does not delete for this. Example: `4`. |
| `PREVIEW_SLEEP_SECONDS` | Stop the preview app after this many seconds without a request. Example: `20`. |
| `PREVIEW_BOOT_DELAY_MS` | Optional delay before the placeholder app listens, so the waking page is visible. Simulated, and not a real cold start. Example: `0`. |
| `PREVIEW_STUCK_MINUTES` | Treat a preview stuck in provisioning, updating, or destroying as failed after this many minutes. Example: `10`. |
| `REAPER_INTERVAL_MS` | How often the in-process reaper checks for expired and stuck previews. Example: `60000`. |
| `DEPLOYER` | `process` starts one preview per pull request. `fake` only writes a local record. |
| `PREVIEW_RUNTIME` | `docker` runs the preview app in a container. `process` runs it as plain Node. This machine uses Docker. Render sets `process`. |
| `PREVIEW_MEMORY`, `PREVIEW_CPUS` | Container limits for docker previews. Defaults `256m` (no swap) and `0.5` CPU, plus 100 processes, user `1000:1000`, all capabilities dropped, no new privileges, read-only filesystem, and a 16 MB `/tmp`. |
| `MEMORY_ALERT_PERCENT` | Alert when the server's memory stays at or above this for three checks in a row (about three minutes). 50–99, default `90`. The Admin page shows server CPU and memory; preview cards show each awake preview's CPU and memory against its limits (Docker previews only). |
| `PREVIEW_PASSWORD` | Optional team password for every preview link. Visitors enter it once per browser; signed-in admins are never asked. Leave empty for public previews. Changing it signs everyone out. |
| `PREVIEW_ACCESS_DAYS` | How long a browser stays let in after the password. 1–90, default `7`. |
| `PREVIEW_FAKE_DELAY_MS` | Artificial delay for the fake deployer. Example: `700`. |
| `PREVIEW_BASE_URL` | Origin used in preview links. Example: `http://localhost:3000`. |
| `MONGODB_URI` | Optional. MongoDB connection string. When set, board/admin environment state is stored in MongoDB (`mayfly.state` plus locks) instead of `data/state.json`. Empty keeps the JSON file. |
| `GITHUB_WEBHOOK_SECRET` | Required in production. In development, an empty value accepts unsigned deliveries. |
| `GITHUB_TOKEN` | Optional. Posts a **Mayfly — Preview** commit check and a PR comment. Needs commit status write and pull-request comment access. Put it in `.env.local` (Docker Compose does not pass Codespace secrets into the container). `MAYFLY_GITHUB_TOKEN` is accepted too. |
| `MAYFLY_ADMIN_TOKEN` | Required for every action that changes things. Send it as `Authorization: Bearer <token>` or `x-mayfly-admin: <token>`, or paste it into the board's **Admin** field. When empty, those actions are always refused with 401. Generate one with `openssl rand -hex 32`. |
| `DEMO_PREVIEW` | Optional. Keep one preview alive for visitors. Quote it, because `#` starts a comment: `DEMO_PREVIEW="acme/web#1"`. Empty turns it off. The branch is `demo` and the commit is `d3m0d3m0`. It is not deleted when its time limit passes, and the card does not show an expiry. |

## Deploy temporarily

For a test on an AWS (or any Ubuntu) server with real Docker builds and HTTPS, see [deploy/aws/README.md](deploy/aws/README.md). It sets everything up with one script.

On a Linux server, build and run in production mode (not `npm run dev`):

```bash
npm ci
npm run build
npm start
```

`npm start` runs `dist/server.js`, which listens on `0.0.0.0:3000` by default. Override with `HOST` and `PORT` if needed.

Set at least these on the server: `MAYFLY_ADMIN_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `PREVIEW_BASE_URL` (the public address people open), and `PREVIEW_TTL_HOURS=168`. The simulator is off in production unless `ALLOW_SIMULATOR=true`.

## Alerts and health

`GET /api/health` answers **200** when Mayfly can do its job and **503** when it can't, so any uptime monitor can watch it. Everyone sees only `ok` and `status`; a signed-in admin (cookie or `Authorization: Bearer <MAYFLY_ADMIN_TOKEN>`) also sees each check: saved state readable, free disk space, Docker answering (Docker runtime only), and the clean-up loop finishing its rounds. Results are cached for 15 seconds.

Set `ALERT_WEBHOOK_URL` to a chat channel's incoming webhook (Slack, Discord, Google Chat, Mattermost or anything that accepts `{"text": "…"}`) and Mayfly posts a short message when:

- a preview fails to build (once per commit)
- a preview gets stuck and is removed
- free disk space drops below `ALERT_DISK_PERCENT` (default 15), and again when it recovers
- Docker stops answering for two checks in a row, and again when it answers
- the clean-up loop fails, and again when it recovers
- Mayfly starts, so an unexpected restart doesn't go unnoticed

The same problem isn't posted again for six hours. Messages contain the repository, pull request, commit, the first line of the error and a link to the board, never tokens or full logs. A chat webhook that's down or wrong never affects builds. Without `ALERT_WEBHOOK_URL`, alerts go to the log only (lines starting `[alert]`).

## Plans and usage billing (demo pricing)

Mayfly is priced on awake time, in rupees, like usage-based hosting: asleep previews cost nothing. The **Pricing** page (`/pricing`) shows three plans:

- **Sandbox** (free): 30 awake hours a month, 2 previews at a time, 1 repository, Small or Standard sizes.
- **Pay as you go**: ₹2.50, ₹5 or ₹10 per awake hour for Small, Standard or Large, billed by the second. No limits, no seat fees.
- **Enterprise**: custom rates and terms.

The page also shows this month's bill so far (from the awake time Mayfly already records, counted at Standard size) and where it's heading, a rates table, and a calculator that compares Pay as you go with previews that never sleep. Admins change plan through a **demo checkout** that switches straight away: no payment is taken, no card is asked for, and nothing is charged.

Limits are checked when a new preview would start. Over a limit (including the Sandbox's monthly hours), the preview doesn't start and the pull request gets a note saying why, with a link to the plans. A Large size picked by hand on the Sandbox is refused; a repository's saved Large size falls back to Standard. Running previews are never stopped by a plan change. A new install is on Pay as you go, so installs from before plans existed have no new limits; plans saved as Free, Team or Business load as Sandbox, Pay as you go and Pay as you go.

### Payments: prepaid credit with Razorpay

Admins add **prepaid credit** on the Pricing page (₹500, ₹1,000, ₹2,000 or their own amount, ₹100 to ₹50,000) and pay through **Razorpay Checkout**: UPI, cards, net banking and wallets. On Pay as you go, each awake second comes off the credit at the size's hourly rate. When it runs out, new previews wait (with a note on the pull request) until credit is added; running previews carry on.

Payments are off until you add keys, and then Pay as you go needs credit. To set up **test mode** (no real money):

1. Sign up at razorpay.com, switch the Dashboard to **Test Mode**, and generate API keys (Account & Settings → API Keys → Generate Key). Copy the secret straight away: the Dashboard shows it only once. Test key ids start with `rzp_test_`.
2. On the server, add them to `.env.local` with an editor (`nano ~/mayfly/.env.local`), never in the repository or a chat:
   `RAZORPAY_KEY_ID=rzp_test_…` and `RAZORPAY_KEY_SECRET=…`
3. Restart Mayfly: `sudo docker compose -f docker-compose.yml -f deploy/aws/docker-compose.aws.yml up -d --force-recreate mayfly`
4. Optional but recommended: in the Razorpay Dashboard add a webhook to `https://<your Mayfly>/api/webhooks/razorpay` with the events `order.paid` and `payment.captured`, choose a secret, and put it in `.env.local` as `RAZORPAY_WEBHOOK_SECRET`. It adds credit even if someone closes the tab mid-payment.

In test mode, pay with the UPI ID `success@razorpay` (or `failure@razorpay` to see a failure) or Razorpay's test cards. Mayfly checks Razorpay's signature on the server before adding any credit, uses its own record of each order's amount, and adds each payment once even if the browser and the webhook both report it. The key secret and webhook secret never leave the server. **Live keys** (`rzp_live_…`, real money) are refused unless `RAZORPAY_ALLOW_LIVE=true`; taking real payments also needs Razorpay's business KYC and your own refund and terms pages.

## Previews by person

Each preview records the GitHub username of whoever opened the pull request, and its card says **Opened by @username**. On the board, the **Opened by** menu shows one person's previews; clicking a name on a card does the same. The address becomes `/board?by=<username>`, so the link can be shared. The search box matches people too, and `@name` searches people only. Previews opened before this was recorded (or from the admin simulator) have no name until their next commit.

## Install as an app, and the Android APK

Mayfly has a web app manifest (`/manifest.webmanifest`) and an apple-touch icon, so Chrome offers **Install app** on desktop and Android, and Safari on iPhone can use Share → **Add to Home Screen** (the account menu reminds you on iOS). Installed on a phone it opens full screen (`display: standalone`) with safe-area padding for the notch. The native APK is Android only; iOS uses the installed web app.

The Android APK wraps the site in a Trusted Web Activity built with Bubblewrap. Its settings are in `android/twa-manifest.json` (package `com.meetamadhu.mayfly`, opening `https://mayfly-pkgs.onrender.com/board`). To build it:

1. Add the icons to `public/icons` and deploy, so `/icons/icon-512.png` and `/icons/maskable-512.png` load on that site.
2. Create a signing key once and keep a backup of it, because every later version must be signed with the same key or phones refuse the update. On any machine with Docker:
   `docker run --rm -it -v "$PWD":/k -w /k eclipse-temurin:17 keytool -genkeypair -v -keystore mayfly.keystore -alias mayfly -keyalg RSA -keysize 2048 -validity 10000`
3. Add two repository secrets: `ANDROID_KEYSTORE_BASE64` (the output of `base64 -w0 mayfly.keystore`) and `ANDROID_KEYSTORE_PASSWORD`. Add `ANDROID_KEY_PASSWORD` only if you gave the key its own, different password.
4. Run **Actions → Android app → Run workflow** with a version number. The signed APK is attached to the run, and the run summary shows the key's fingerprint.
5. On the site the app opens, set `ANDROID_PACKAGE_NAME=com.meetamadhu.mayfly` and `ANDROID_CERT_SHA256=<that fingerprint>`. Mayfly then serves `/.well-known/assetlinks.json`, and the app opens full screen without a browser bar.

The APK only shows what the site serves, so it needs that site to be up. To point it at another address, change `host` and the URLs in `android/twa-manifest.json` and build again.

## Backups

Once a day Mayfly saves its state (every preview record, the month's usage and the lifetime rules) as a gzip file in `data/backups`, and keeps the newest `BACKUP_KEEP` (default 7). The first is taken a few minutes after it starts. It works the same with the JSON file and with MongoDB. Tokens and secrets aren't in the state, so they aren't in backups either. If a backup fails, an alert is sent (see above).

Admins see the last backup on the Admin page, can take one now, and can download the latest. These files sit on the same disk as Mayfly, so they protect against a bug or a bad change, not against losing the server. Download one now and then, or snapshot the disk.

Restore only while Mayfly is stopped, so it can't overwrite the restored state:

```bash
node dist/restore.js list
node dist/restore.js show <name>
node dist/restore.js restore <name> --yes
```

`restore` refuses while Mayfly answers on `PORT`, and saves the current state as a `-before-restore` backup first, so a restore can be undone the same way. On the AWS setup, `deploy/aws/backup.sh` stops and starts Mayfly around it.

### Move to a new server

```bash
# On the old server (Mayfly can stay up for this step):
node dist/restore.js pack
# Copy the printed data/migrate/… folder AND .env.local to the new server.

# On the new server, with Mayfly STOPPED:
node dist/restore.js apply /path/to/mayfly-migrate-… --yes
# Then start Mayfly and open /api/health.
```

On the AWS compose setup, `deploy/aws/migrate.sh pack` and `deploy/aws/migrate.sh apply <folder>` stop and start Mayfly for you. Preview containers are not moved: after a restore onto a new Docker host, open pull requests rebuild on the next push.

## Health & ops

Signed-in admins get **Health & ops** (`/ops`): this host's name, health checks (storage, disk, Docker, clean-up loop), CPU and memory, and a CSV download of the audit log (every saved lifecycle event). Uptime monitors can hit `GET /api/health` (200 or 503). Set `MAYFLY_INSTANCE` so each host is easy to tell apart.

## Several servers

Each Mayfly process owns the Docker daemon on its machine. There is no shared pool that can run any preview on any host. To use more than one server, give each a **disjoint** `PREVIEW_REPOS` list, point each repository's GitHub webhook at the host that owns it, and optionally share one `MONGODB_URI` if you want one board. That is the supported way to scale out today.

## Keyboard shortcuts

- `Ctrl`/`⌘`+`K` or `?` — command palette (go to a page, toggle theme, New preview)
- `/` — focus the search box on pages that have one

## Connect GitHub

Create a webhook on the repository.

- Payload URL: `https://<your-host>/api/webhooks/github`
- Content type: `application/json`
- Secret: the same value as `GITHUB_WEBHOOK_SECRET`
- Events: Pull requests

The route also accepts a form body with a `payload` field. In production a missing or wrong signature returns 401.

## Demo

1. `npm run dev`
2. Open http://localhost:3000, click **Admin**, paste your `MAYFLY_ADMIN_TOKEN`, and choose **Use token**. Without the token the board is read-only.
3. Choose **Open**. The row shows **Awake**, and **Open preview** goes to `/p/...`.
4. Wait `PREVIEW_SLEEP_SECONDS` (20 in `.env.example`) without opening the preview. The row shows **Asleep**. On Linux, `ps -ef | grep preview-server` no longer lists that app. The gate process is still there.
5. Open the preview again. "Waking up this preview" shows at once, then the placeholder app loads.
6. Choose **Merge**. The preview is destroyed. On Linux, `ps -ef | grep preview-` no longer lists that gate or app.

To demo the time limit, set TTL minutes to `0`, choose **Open**, then choose **Run reaper**. The preview is destroyed with reason `expired`. **Mark idle** and **Run reaper** leave the preview in place.

## Security

`MAYFLY_ADMIN_TOKEN` protects `POST /api/environments/<id>?action=destroy`, `action=sleep`, `action=activity`, and `action=extend`, plus `POST /api/reaper` and `POST /api/events`. With no token configured those routes refuse every request; there is no exception for "local" requests, because the `Host` header is chosen by the sender. Scripts send the token as `Authorization: Bearer <token>` or `x-mayfly-admin`. People sign in on `/admin/login` and get a `mayfly_admin` cookie that holds an expiry and a signature, never the token. The cookie is `HttpOnly` and `SameSite=Lax` (and `Secure` in production), and lasts 8 hours. A request that changes anything and is authenticated by the cookie must also come from this host's own `Origin`, or it gets 403. The public board at `/board` is read-only. In production, webhook deliveries must be signed with `GITHUB_WEBHOOK_SECRET`.

Previews are served from the same address as Mayfly, so the preview proxy removes Mayfly's admin sign-in cookie (`mayfly_admin`) from every request it forwards, and drops any attempt by a preview to set it. A pull request's code never sees the admin's session. The preview's own cookies pass through as normal.

Preview processes receive only `PATH`, `NODE_ENV` and `PREVIEW_*` variables (plus the Windows system variables Node needs). `GITHUB_TOKEN`, `MAYFLY_GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET` and `MAYFLY_ADMIN_TOKEN` never reach them.

## Known limitations

Environment state is a JSON file by default, or MongoDB when `MONGODB_URI` is set. Local deployment records (`data/deployments.json`) stay on disk. Each preview container runs on the same machine as the Mayfly that built it; scale out by sharding repositories across hosts (see Several servers), not by a shared Docker pool. Render has no Docker daemon, so it keeps the plain Node app. Docker previews keep the last 300 lines each app printed, in the memory of that preview's gate, for admins to read in the preview's panel. They go when the preview is deleted or Mayfly restarts, values of the repository's preview variables are replaced with `[hidden]`, and nothing is written to disk. Process-mode apps' output is discarded. Process-mode and demo previews are still placeholder apps; Docker mode with `PREVIEW_REPOS` builds the pull request's own Dockerfile.

## Name

This project is unrelated to the NCCloud Mayfly Kubernetes operator.
