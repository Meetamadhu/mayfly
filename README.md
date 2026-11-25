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

With `PREVIEW_RUNTIME=docker`, set `PREVIEW_REPOS` (comma-separated `owner/name`) in `.env.local`. For a pull request on a listed repository, Mayfly clones it, checks out the exact commit, builds the repo-root `Dockerfile` as `mayfly-pr-<owner>-<name>-<pr>:<sha8>` (10 minute limit, last 20 log lines in the error), and runs that image in the same locked-down container. The app must listen on `$PORT` (3000) and work as the unprivileged user `1000:1000` with a read-only filesystem where only `/tmp` is writable, so images on any base (Node, Python, nginx, Go) run as long as they do not need root. A new commit rebuilds and swaps the container; sleep and wake reuse the image; closing the pull request removes the container and the image. Other repositories fail with "Repository not allowed", a missing `Dockerfile` fails with "No Dockerfile at repo root", and fork pull requests are refused. `DEMO_PREVIEW` keeps the placeholder app. Process mode is unchanged.

### Preview settings (variables and size)

Admins set, for each repository, the size of previews opened from GitHub and the variables every preview gets (a test database URL, test API keys, `NEXT_PUBLIC_` values), on **Admin → Preview settings**. Values are encrypted with `MAYFLY_SECRETS_KEY` (AES-256-GCM) before they're saved, so `data/state.json`, MongoDB and backups never hold them in plain text, and they're never sent back to the browser. Without the key, variables can't be saved; `deploy/aws/setup.sh` creates one. Changing the key makes saved values unreadable: previews start without them and the page asks for them again.

They're used in Docker mode only. The gate hands them to the container with `-e NAME` and the build with `--build-arg NAME` (only the ones marked "Needed while building"), with the value in Docker's environment, so no value is ever on a command line; values a Dockerfile prints are hidden in the build log. Names Mayfly or Docker rely on (`PORT`, `HOST`, `PATH`, `HOME`, `DOCKER_*`, `PREVIEW_*`, `MAYFLY_*`, `LD_*`, proxy settings and a few more) are refused. Changes apply to new previews and the next commit on open pull requests. **Every pull request's code can read its preview's variables**, so use test values only.

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

## Previews by person

Each preview records the GitHub username of whoever opened the pull request, and its card says **Opened by @username**. On the board, the **Opened by** menu shows one person's previews; clicking a name on a card does the same. The address becomes `/board?by=<username>`, so the link can be shared. The search box matches people too, and `@name` searches people only. Previews opened before this was recorded (or from the admin simulator) have no name until their next commit.

## Install as an app, and the Android APK

Mayfly has a web app manifest (`/manifest.webmanifest`), so once its icons are in `public/icons` (see the README there), Chrome offers **Install app** on desktop and Android and Safari can add it to the iPhone home screen.

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

Mayfly runs on one machine. Environment state is a JSON file by default, or MongoDB when `MONGODB_URI` is set. Local deployment records (`data/deployments.json`) stay on disk. On this machine each preview app can run in its own Docker container. Render has no Docker daemon, so it keeps the plain Node app. Mayfly does not save preview logs; the app's output is discarded. Process-mode and demo previews are still placeholder apps; Docker mode with `PREVIEW_REPOS` builds the pull request's own Dockerfile.

## Name

This project is unrelated to the NCCloud Mayfly Kubernetes operator.
