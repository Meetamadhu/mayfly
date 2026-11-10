diff --git a/.env.example b/.env.example
index 819d935..9e974e0 100644
--- a/.env.example
+++ b/.env.example
@@ -1,9 +1,15 @@
 # Hard stop. New previews are refused once this many are live.
 MAX_CONCURRENT_ENVIRONMENTS=10
 
-# Maximum lifetime of a preview, in hours. A new commit resets this clock.
+# A preview expires this many hours after it was created or last updated (a new commit resets the clock).
 PREVIEW_TTL_HOURS=168
 
+# Extending a preview can never push its expiry past this many hours after it was created.
+PREVIEW_MAX_LIFETIME_HOURS=168
+
+# Assumed cost of one preview container running for an hour, for the board's savings estimate.
+PREVIEW_COST_PER_HOUR=0.05
+
 # Reference window for the board's 'Mark idle' button. The reaper no longer deletes idle previews;
 # an idle preview is slept by its gate (the app process exits, the gate stays up) and wakes on the next visit.
 PREVIEW_IDLE_HOURS=4
@@ -49,11 +55,11 @@ PREVIEW_MAX_IMAGE_MB=1024
 # Artificial delay for the fake deployer so the board can show in-progress states.
 PREVIEW_FAKE_DELAY_MS=700
 
-# Optional. Neon (or other Postgres) connection string for board/admin environment state.
-# When set, Mayfly stores environments in Postgres instead of data/state.json.
-# Use Neon's pooled connection string. Leave empty to keep the local JSON file.
-# Example: DATABASE_URL=postgresql://user:pass@ep-xxx.region.aws.neon.tech/neondb?sslmode=require
-DATABASE_URL=
+# Optional. MongoDB connection string (for example MongoDB Atlas). When set, the list of previews and the
+# monthly savings totals are stored in MongoDB (database "mayfly") instead of data/state.json.
+# Leave empty to keep the local JSON file. Only one running Mayfly should use a given database.
+# Example: MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>.mongodb.net/?retryWrites=true&w=majority
+MONGODB_URI=
 
 # Openable origin for preview links. Defaults to this app on localhost.
 # Leave this empty on GitHub Codespaces. Mayfly uses the codespace address for port 3000.
@@ -76,3 +82,6 @@ MAYFLY_ADMIN_TOKEN=
 # Example: DEMO_PREVIEW="acme/web#1"
 # Empty turns it off. The branch is demo and the commit is d3m0d3m0.
 DEMO_PREVIEW=
+
+# Set to true to allow the admin simulator (Open PR, Push commit…) when NODE_ENV=production.
+ALLOW_SIMULATOR=
diff --git a/README.md b/README.md
index 2d512dc..fe86207 100644
--- a/README.md
+++ b/README.md
@@ -1,124 +1,148 @@
 # Mayfly
 
-Mayfly gives every pull request a preview that sleeps when nobody is using it, wakes on the next visit, and is deleted when the pull request closes. It is a prototype. Each preview is a placeholder Node app that shows the repository, branch, and commit. It does not build or run the pull request's real code.
+Mayfly gives every pull request its own live preview. It builds the pull request's code in a container, puts the preview to sleep when nobody is using it, wakes it on the next visit, and removes it when the pull request closes. Staging capacity is only used while someone is actually looking.
 
-## How it works
-
-Each preview is two Node processes. A gate listens on a private port on this machine (`127.0.0.1`), and the app process runs behind it. Nobody reaches the gate directly: Mayfly serves every preview at `/p/<owner>/<name>/<pr>` and forwards to it. After `PREVIEW_SLEEP_SECONDS` with no request, the gate stops the app. The next visit gets a "Waking up" page immediately, the gate starts the app, and the page loads itself. The reaper deletes a preview when its lifetime is over, when it is stuck, or when the pull request closes or merges. An idle preview is slept, and is left in place while the pull request is open. When `GITHUB_TOKEN` is set, Mayfly also comments on the pull request.
+**Live demo:** https://solid-eureka-g4x7jj996g553v5pv-3000.app.github.dev/board (runs in a GitHub codespace; if GitHub shows a warning page first, click **Continue**). An always-on copy with placeholder previews runs at https://mayfly-pkgs.onrender.com/board.
 
-Open a preview at `/p/<owner>/<name>/<pr>` on this app.
+Mayfly is a working prototype that runs on one machine.
 
-## Run locally
+## What it does
 
-From the project directory, in Linux or WSL:
+- **Real builds.** When a pull request is opened or updated, a signed GitHub webhook tells Mayfly. In Docker mode, Mayfly clones the pull request at its exact commit, builds the repository's `Dockerfile`, and runs the image in its own locked-down container.
+- **Sleep and wake.** After `PREVIEW_SLEEP_SECONDS` without a visitor, the preview's container is stopped and removed, so a sleeping preview uses no memory or CPU. The next visit shows a "Waking up" page and starts a new container from the already-built image, without rebuilding.
+- **Clean exit.** Closing or merging the pull request, or reaching the end of the preview's lifetime, removes the container and its image.
+- **Lifetime.** A preview expires `PREVIEW_TTL_HOURS` after it was created or last updated. An admin can extend it by 2, 4, 12 or 24 hours, up to `PREVIEW_MAX_LIFETIME_HOURS` after it was created.
+- **Savings estimate.** The board shows an estimate of the money saved this month: hours that previews spent asleep × `PREVIEW_COST_PER_HOUR`. It is labelled as an estimate on the board.
+- **Demo preview.** `DEMO_PREVIEW` keeps one placeholder preview always available, so visitors can try sleep and wake without the admin token.
 
-```bash
-npm ci
-npm run dev
-```
+## Pages
 
-The same two commands run in PowerShell. The app listens at http://localhost:3000.
+| Page | Who | What |
+|---|---|---|
+| `/` | Everyone | Home page explaining Mayfly. |
+| `/board` | Everyone | Read-only list of live previews, their status and the savings estimate. |
+| `/admin/login`, `/admin` | Admins | Sign in with `MAYFLY_ADMIN_TOKEN` for an 8-hour session. Sleep, extend or destroy a preview, and simulate pull requests (**Open PR**, **Push commit**, **Close PR**, **Merge PR**, **Run reaper**). |
+| `/p/<owner>/<repo>/<pr>` | Everyone | The preview itself. |
 
-## Run with Docker
+In the simulator, leave **Commit** empty to use the pull request's latest commit from GitHub.
 
-On Linux or a GitHub Codespace, with Docker running:
+## How it works
 
-```bash
-export PREVIEW_BASE_URL="https://${CODESPACE_NAME}-3000.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"
-docker compose up -d --build
-```
+Mayfly is a Next.js app. Each preview has a small **gate** process that listens on a private port (`127.0.0.1`). Visitors never reach the gate directly: Mayfly serves every preview at `/p/<owner>/<repo>/<pr>` and forwards to that preview's gate. The gate starts the app when a request arrives and stops it after the idle time.
 
-Open port 3000 and go to `/board`. The first build takes a few minutes. Preview apps still run in their own containers. If this Mayfly container restarts, live previews are started again. `.env.local` stays out of the image. Render does not run this compose file.
+- **Docker mode** (`PREVIEW_RUNTIME=docker`, set by Docker Compose): the app is the pull request's own image, running in a container. Repositories must be listed in `PREVIEW_REPOS`.
+- **Process mode** (the default, used on Render, which has no Docker): the app is a placeholder Node page that shows the repository, branch and commit.
 
-### Build real pull requests
+A background **reaper** runs every `REAPER_INTERVAL_MS`. It removes expired and stuck previews and records how long previews spend asleep and awake for the savings estimate.
 
-With `PREVIEW_RUNTIME=docker`, set `PREVIEW_REPOS` (comma-separated `owner/name`) in `.env.local`. For a pull request on a listed repository, Mayfly clones it, checks out the exact commit, builds the repo-root `Dockerfile` as `mayfly-pr-<owner>-<name>-<pr>:<sha8>` (10 minute limit, last 20 log lines in the error), and runs that image in the same locked-down container. The app must listen on `$PORT` (3000) and work as the unprivileged user `1000:1000` with a read-only filesystem where only `/tmp` is writable, so images on any base (Node, Python, nginx, Go) run as long as they do not need root. A new commit rebuilds and swaps the container; sleep and wake reuse the image; closing the pull request removes the container and the image. Other repositories fail with "Repository not allowed", a missing `Dockerfile` fails with "No Dockerfile at repo root", and fork pull requests are refused. `DEMO_PREVIEW` keeps the placeholder app. Process mode is unchanged.
+### Where state is stored
 
-### Build limits and the Docker socket proxy
+- With `MONGODB_URI` set, the list of previews and the monthly totals are stored in MongoDB: database `mayfly`, collection `state` (one document) and collection `locks`. Every change runs under a lease lock that expires after 30 seconds, so simultaneous webhooks and admin actions never overwrite each other, and a crashed server can't hold the lock forever.
+- Without `MONGODB_URI`, the same data is kept in `data/state.json`.
+- Each machine keeps its own record of running gates and containers in `data/deployments.json`.
 
-Compose gives Mayfly no Docker socket. Only the `docker-proxy` service holds it, and Mayfly reaches Docker through it (`DOCKER_HOST=tcp://127.0.0.1:2375`, published on loopback only). The proxy allows containers, images and builds, and answers 403 to exec, volumes, networks, swarm, secrets, system, plugins and BuildKit sessions.
+Only one running copy of Mayfly should use a given database.
 
-Builds use Docker's classic builder, because BuildKit cannot pass through the proxy. Each build step gets `PREVIEW_BUILD_MEMORY` (swap included) and `PREVIEW_BUILD_CPUS`. `PREVIEW_MAX_BUILDS` builds run at once and the rest wait their turn, and the 10 minute limit counts from when a build starts. A clone plus build context over `PREVIEW_MAX_REPO_MB` and an image over `PREVIEW_MAX_IMAGE_MB` fail the preview and leave nothing behind. Dockerfiles that need BuildKit-only features (`RUN --mount`, heredocs) will not build.
+## Run it
 
-**What this does not protect.** The proxy filters by endpoint, not by request body, so it cannot stop a container created with `--privileged` or a bind mount of the host. Build steps still have network access, because they pull base images and packages. Anyone who can run code in Mayfly can still reach the host through Docker. For a public server, run Docker rootless or under Sysbox, or build on a separate host.
+### Locally (placeholder previews)
 
-### Connect GitHub webhooks
+```bash
+npm ci
+npm run dev
+```
 
-A webhook creates, updates, and removes previews when pull requests change, with no simulator. GitHub must be able to reach Mayfly, so make port 3000 public (in a Codespace, set the port visibility to Public) and use that address as `PREVIEW_BASE_URL`. Set `GITHUB_WEBHOOK_SECRET` in `.env.local`, then create the hook without printing the secret:
+Open http://localhost:3000. This runs in process mode.
 
-```powershell
-$secret = ((Get-Content .env.local | Where-Object { $_ -like "GITHUB_WEBHOOK_SECRET=*" }) -replace "^GITHUB_WEBHOOK_SECRET=", "").Trim('"')
-@{ name = "web"; active = $true; events = @("pull_request"); config = @{ url = "$env:PREVIEW_BASE_URL/api/webhooks/github"; content_type = "json"; secret = $secret } } |
-  ConvertTo-Json -Depth 5 | gh api repos/<owner>/<repo>/hooks --method POST --input -
-```
+### With Docker (real pull request builds)
 
-On Linux or macOS, build the same JSON with `jq` and pipe it to `gh api ... --input -`. The content type must be `application/json`. A request with a missing or wrong signature gets `401` and creates nothing. Check deliveries with `gh api repos/<owner>/<repo>/hooks/<id>/deliveries`. Set `GITHUB_TOKEN` to have Mayfly also comment on the pull request; without it Mayfly skips the comment. Quick tunnels and other temporary addresses change, so update the hook's URL when the address changes.
-
-Copy `.env.example` to `.env.local`. `.env.local` stays on this machine.
-
-| Key | What it does |
-|---|---|
-| `MAX_CONCURRENT_ENVIRONMENTS` | Refuse new previews once this many are live. Example: `10`. |
-| `PREVIEW_TTL_HOURS` | Delete a preview this many hours after it was created. A new commit resets the clock. Example: `168` (7 days). |
-| `PREVIEW_IDLE_HOURS` | How far back "Mark idle" moves the last visit. The reaper does not delete for this. Example: `4`. |
-| `PREVIEW_SLEEP_SECONDS` | Stop the preview app after this many seconds without a request. Example: `20`. |
-| `PREVIEW_BOOT_DELAY_MS` | Optional delay before the placeholder app listens, so the waking page is visible. Simulated, and not a real cold start. Example: `0`. |
-| `PREVIEW_STUCK_MINUTES` | Treat a preview stuck in provisioning, updating, or destroying as failed after this many minutes. Example: `10`. |
-| `REAPER_INTERVAL_MS` | How often the in-process reaper checks for expired and stuck previews. Example: `60000`. |
-| `DEPLOYER` | `process` starts one preview per pull request. `fake` only writes a local record. |
-| `PREVIEW_RUNTIME` | `docker` runs the preview app in a container. `process` runs it as plain Node. This machine uses Docker. Render sets `process`. |
-| `PREVIEW_MEMORY`, `PREVIEW_CPUS` | Container limits for docker previews. Defaults `256m` (no swap) and `0.5` CPU, plus 100 processes, user `1000:1000`, all capabilities dropped, no new privileges, read-only filesystem, and a 16 MB `/tmp`. |
-| `PREVIEW_FAKE_DELAY_MS` | Artificial delay for the fake deployer. Example: `700`. |
-| `PREVIEW_BASE_URL` | Origin used in preview links. Example: `http://localhost:3000`. |
-| `DATABASE_URL` | Optional. Neon (or Postgres) connection string. When set, board/admin environment state is stored in Postgres (`mayfly_state`) instead of `data/state.json`. Use Neon's pooled URL. Empty keeps the JSON file. |
-| `GITHUB_WEBHOOK_SECRET` | Required in production. In development, an empty value accepts unsigned deliveries. |
-| `GITHUB_TOKEN` | Optional. When set, preview comments are also posted on the pull request. |
-| `MAYFLY_ADMIN_TOKEN` | Required for every action that changes things. Send it as `Authorization: Bearer <token>` or `x-mayfly-admin: <token>`, or paste it into the board's **Admin** field. When empty, those actions are always refused with 401. Generate one with `openssl rand -hex 32`. |
-| `DEMO_PREVIEW` | Optional. Keep one preview alive for visitors. Quote it, because `#` starts a comment: `DEMO_PREVIEW="acme/web#1"`. Empty turns it off. The branch is `demo` and the commit is `d3m0d3m0`. It is not deleted when its time limit passes, and the card does not show an expiry. |
-
-## Deploy temporarily
-
-On a Linux server, build and run in production mode (not `npm run dev`):
+On Linux or a GitHub codespace, with Docker running:
 
 ```bash
-npm ci
-npm run build
-npm start -- -H 0.0.0.0
+docker compose up -d --build
 ```
 
-Set at least these on the server: `MAYFLY_ADMIN_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `PREVIEW_BASE_URL` (the public address people open), and `PREVIEW_TTL_HOURS=168`. The simulator is off in production unless `ALLOW_SIMULATOR=true`.
-
-## Connect GitHub
-
-Create a webhook on the repository.
+Open port 3000 and go to `/board`. The first build takes a few minutes. Compose starts two services: `mayfly` and `docker-proxy` (see Security).
 
-- Payload URL: `https://<your-host>/api/webhooks/github`
-- Content type: `application/json`
-- Secret: the same value as `GITHUB_WEBHOOK_SECRET`
-- Events: Pull requests
+### In the GitHub codespace
 
-The route also accepts a form body with a `payload` field. In production a missing or wrong signature returns 401.
+```bash
+git pull && docker compose up -d --build mayfly
+```
 
-## Demo
+- Use Docker Compose only. Don't run `npm start` in the codespace: port 3000 already belongs to the Mayfly container.
+- After every restart, set port 3000 to **Public** in the **Ports** tab, or visitors get a GitHub sign-in page instead of Mayfly.
+- `PREVIEW_BASE_URL` can stay empty; Mayfly uses the codespace's address for port 3000.
+- Visitors may see GitHub's "development port" warning page first and need to click **Continue**.
+- If a network's DNS refuses `*.app.github.dev`, use a different DNS service (for example Cloudflare's 1.1.1.1).
 
-1. `npm run dev`
-2. Open http://localhost:3000, click **Admin**, paste your `MAYFLY_ADMIN_TOKEN`, and choose **Use token**. Without the token the board is read-only.
-3. Choose **Open**. The row shows **Awake**, and **Open preview** goes to `/p/...`.
-4. Wait `PREVIEW_SLEEP_SECONDS` (20 in `.env.example`) without opening the preview. The row shows **Asleep**. On Linux, `ps -ef | grep preview-server` no longer lists that app. The gate process is still there.
-5. Open the preview again. "Waking up this preview" shows at once, then the placeholder app loads.
-6. Choose **Merge**. The preview is destroyed. On Linux, `ps -ef | grep preview-` no longer lists that gate or app.
+## Connect GitHub
 
-To demo the time limit, set TTL minutes to `0`, choose **Open**, then choose **Run reaper**. The preview is destroyed with reason `expired`. **Mark idle** and **Run reaper** leave the preview in place.
+On each repository listed in `PREVIEW_REPOS`, add a webhook:
+
+- **Payload URL:** `https://<your-mayfly-address>/api/webhooks/github`
+- **Content type:** `application/json`
+- **Secret:** the same value as `GITHUB_WEBHOOK_SECRET`
+- **Events:** Pull requests only
+
+GitHub must be able to reach Mayfly, so the address must be public. A delivery with a missing or wrong signature gets `401` and changes nothing. Check results under the webhook's **Recent Deliveries**, where any delivery can be sent again with **Redeliver**. If Mayfly's address changes, update the webhook's URL.
+
+With `GITHUB_TOKEN` set, Mayfly also posts the preview link as a comment on the pull request. Use a fine-grained token limited to the repositories Mayfly builds.
+
+## What a pull request needs
+
+- A `Dockerfile` at the repository root (otherwise: "No Dockerfile at repo root").
+- The app listens on port `3000` (`$PORT`).
+- It works as the unprivileged user `1000:1000` with a read-only filesystem where only `/tmp` is writable.
+- Dockerfiles that need BuildKit-only features (`RUN --mount`, heredocs) won't build, because builds use Docker's classic builder.
+- Pull requests from forks are never built.
+
+## Settings
+
+Copy `.env.example` to `.env.local` and fill it in. `.env.local` stays on the machine and is never copied into an image or committed.
+
+| Key | What it does | Default |
+|---|---|---|
+| `MAYFLY_ADMIN_TOKEN` | Required. Protects every action that changes something. Generate with `openssl rand -hex 32`. | (none: all actions refused) |
+| `GITHUB_WEBHOOK_SECRET` | Required in production. Checks that webhook deliveries come from GitHub. | |
+| `GITHUB_TOKEN` | Optional. Posts preview links as pull request comments. | |
+| `MONGODB_URI` | Optional. MongoDB connection string. When empty, Mayfly uses `data/state.json`. | |
+| `PREVIEW_RUNTIME` | `docker` runs previews in containers. Anything else uses process mode. Compose sets `docker`. | `process` |
+| `PREVIEW_REPOS` | Docker mode. Comma-separated `owner/name` list of repositories whose pull requests are built. | |
+| `PREVIEW_BASE_URL` | Public address used in preview links. Leave empty on Render and in a codespace. | this app |
+| `ALLOW_SIMULATOR` | Set to `true` to allow the admin simulator in production. | off in production |
+| `DEMO_PREVIEW` | Optional always-on placeholder preview. Quote it: `DEMO_PREVIEW="owner/repo#1"`. | |
+| `PREVIEW_SLEEP_SECONDS` | Stop a preview after this many seconds without a visitor. | `20` |
+| `PREVIEW_TTL_HOURS` | A preview expires this many hours after it was created or last updated. | `8` |
+| `PREVIEW_MAX_LIFETIME_HOURS` | Extending can never push expiry past this many hours after creation. | `168` |
+| `MAX_CONCURRENT_ENVIRONMENTS` | New previews are refused once this many are live. | `10` |
+| `PREVIEW_COST_PER_HOUR` | Assumed cost of one preview container per hour, for the savings estimate. | `0.05` |
+| `PREVIEW_MEMORY`, `PREVIEW_CPUS` | Limits for each preview container. | `256m`, `0.5` |
+| `PREVIEW_MAX_BUILDS` | Builds that run at once; the rest wait. | `1` |
+| `PREVIEW_BUILD_MEMORY`, `PREVIEW_BUILD_CPUS` | Limits for each build step. | `1g`, `1` |
+| `PREVIEW_MAX_REPO_MB`, `PREVIEW_MAX_IMAGE_MB` | Largest clone and largest built image. | `200`, `1024` |
+| `PREVIEW_STUCK_MINUTES` | A preview stuck building, updating or removing is failed after this long. | `10` |
+| `REAPER_INTERVAL_MS` | How often the reaper runs. | `60000` |
+| `PREVIEW_IDLE_HOURS` | Reference value shown in the admin settings. Previews are never deleted for being idle; they sleep. | `4` |
+| `PREVIEW_BOOT_DELAY_MS` | Process mode only. Simulated start-up delay so the waking page is visible. | `0` |
+| `DEPLOYER` | `process` starts real gates; `fake` only writes records (for testing). | `process` |
 
 ## Security
 
-`MAYFLY_ADMIN_TOKEN` protects `POST /api/environments/<id>?action=destroy`, `action=sleep`, and `action=activity`, plus `POST /api/reaper` and `POST /api/events`. With no token configured those routes refuse every request; there is no exception for "local" requests, because the `Host` header is chosen by the sender. Scripts send the token as `Authorization: Bearer <token>` or `x-mayfly-admin`. People sign in on `/admin/login` and get a `mayfly_admin` cookie that holds an expiry and a signature, never the token. The cookie is `HttpOnly` and `SameSite=Strict` (and `Secure` in production), and lasts 8 hours. A request that changes anything and is authenticated by the cookie must also come from this host's own `Origin`, or it gets 403. The public board at `/board` is read-only. In production, webhook deliveries must be signed with `GITHUB_WEBHOOK_SECRET`.
-
-Preview processes receive only `PATH`, `NODE_ENV` and `PREVIEW_*` variables (plus the Windows system variables Node needs). `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET` and `MAYFLY_ADMIN_TOKEN` never reach them.
+- **Admin actions.** `MAYFLY_ADMIN_TOKEN` protects `POST /api/environments/<id>` (sleep, extend, destroy), `POST /api/events` (the simulator) and `POST /api/reaper`. Scripts send `Authorization: Bearer <token>` or `x-mayfly-admin: <token>`. People sign in at `/admin/login` and get an `HttpOnly`, `SameSite=Lax` cookie (`Secure` in production) that holds a signed expiry, never the token, and lasts 8 hours. A cookie-authenticated request must come from Mayfly's own `Origin`, or it gets `403`. With no token configured, every action is refused.
+- **Webhooks** must be signed with `GITHUB_WEBHOOK_SECRET` in production.
+- **Preview isolation.** Previews are served from the same address as the admin panel, so every preview response carries `Content-Security-Policy: sandbox …` without `allow-same-origin`. The browser treats a preview as a separate, untrusted site: its JavaScript can't use the admin's sign-in, and requests it sends are refused. Any `Set-Cookie` from a preview for Mayfly's admin cookie is dropped. Mayfly's own waking page is the only exception, marked by the gate, which strips that marker from the app's own responses. The trade-off is that a preview can't use cookies, `localStorage` or service workers. Serving previews from a separate domain would remove this limit.
+- **Containers.** Each preview runs as user `1000:1000`, read-only, with all capabilities dropped, no new privileges, and memory, CPU and 100-process limits. Mayfly's own secrets are removed from the environment before `git` or `docker` runs.
+- **Docker access.** Mayfly has no Docker socket. Only the `docker-proxy` service holds it, and Mayfly reaches Docker through it on `127.0.0.1:2375`. The proxy allows containers, images and builds, and refuses exec, volumes, networks, swarm, secrets, system and plugins. **It can't stop a container created with `--privileged` or a host bind mount**, because it filters by endpoint, not by request body. Anyone who can run code in Mayfly could still reach the host through Docker, so a public server needs rootless Docker, Sysbox, or a separate build host.
+- **Allow-list.** Only repositories in `PREVIEW_REPOS` are built, and pull requests from forks are refused.
 
 ## Known limitations
 
-Mayfly runs on one machine. Environment state is a JSON file by default, or Neon/Postgres when `DATABASE_URL` is set. Local deployment records (`data/deployments.json`) stay on disk. On this machine each preview app can run in its own Docker container. Render has no Docker daemon, so it keeps the plain Node app. On Vercel the deployer is a simulation: it writes records and does not start preview processes, and that state is ephemeral unless `DATABASE_URL` is set. Mayfly does not save preview logs; the app's output is discarded. Process-mode and demo previews are still placeholder apps; Docker mode with `PREVIEW_REPOS` builds the pull request's own Dockerfile.
+- One machine. No autoscaling, and one container per pull request (no per-preview databases or extra services yet).
+- In the codespace, links change if the codespace is recreated, and the codespace must be running with port 3000 Public.
+- Render has no Docker, so its previews are placeholders.
+- Preview logs aren't kept; the last 20 build log lines appear in a failed build's error.
+- The savings figure is an estimate based on an assumed hourly cost.
 
 ## Name