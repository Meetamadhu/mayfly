# Mayfly

Mayfly gives every pull request its own live preview. It builds the pull request's code in a container, puts the preview to sleep when nobody is using it, wakes it on the next visit, and removes it when the pull request closes. Staging capacity is only used while someone is actually looking.

**Live demo:** https://solid-eureka-g4x7jj996g553v5pv-3000.app.github.dev/board (runs in a GitHub codespace; if GitHub shows a warning page first, click **Continue**). An always-on copy with placeholder previews runs at https://mayfly-pkgs.onrender.com/board.

Mayfly is a working prototype that runs on one machine.

## What it does

- **Real builds.** When a pull request is opened or updated, a signed GitHub webhook tells Mayfly. In Docker mode, Mayfly clones the pull request at its exact commit, builds the repository's `Dockerfile`, and runs the image in its own locked-down container.
- **Sleep and wake.** After `PREVIEW_SLEEP_SECONDS` without a visitor, the preview's container is stopped and removed, so a sleeping preview uses no memory or CPU. The next visit shows a "Waking up" page and starts a new container from the already-built image, without rebuilding.
- **Clean exit.** Closing or merging the pull request, or reaching the end of the preview's lifetime, removes the container and its image.
- **Lifetime.** A preview expires `PREVIEW_TTL_HOURS` after it was created or last updated. An admin can extend it by 2, 4, 12 or 24 hours, up to `PREVIEW_MAX_LIFETIME_HOURS` after it was created.
- **Savings estimate.** The board shows an estimate of the money saved this month: hours that previews spent asleep × `PREVIEW_COST_PER_HOUR`. It is labelled as an estimate on the board.
- **Demo preview.** `DEMO_PREVIEW` keeps one placeholder preview always available, so visitors can try sleep and wake without the admin token.

## Pages

| Page | Who | What |
|---|---|---|
| `/` | Everyone | Home page explaining Mayfly. |
| `/board` | Everyone | Read-only list of live previews, their status and the savings estimate. |
| `/admin/login`, `/admin` | Admins | Sign in with `MAYFLY_ADMIN_TOKEN` for an 8-hour session. Sleep, extend or destroy a preview, and simulate pull requests (**Open PR**, **Push commit**, **Close PR**, **Merge PR**, **Run reaper**). |
| `/p/<owner>/<repo>/<pr>` | Everyone | The preview itself. |

In the simulator, leave **Commit** empty to use the pull request's latest commit from GitHub.

## How it works

Mayfly is a Next.js app. Each preview has a small **gate** process that listens on a private port (`127.0.0.1`). Visitors never reach the gate directly: Mayfly serves every preview at `/p/<owner>/<repo>/<pr>` and forwards to that preview's gate. The gate starts the app when a request arrives and stops it after the idle time.

- **Docker mode** (`PREVIEW_RUNTIME=docker`, set by Docker Compose): the app is the pull request's own image, running in a container. Repositories must be listed in `PREVIEW_REPOS`.
- **Process mode** (the default, used on Render, which has no Docker): the app is a placeholder Node page that shows the repository, branch and commit.

A background **reaper** runs every `REAPER_INTERVAL_MS`. It removes expired and stuck previews and records how long previews spend asleep and awake for the savings estimate.

### Where state is stored

- With `MONGODB_URI` set, the list of previews and the monthly totals are stored in MongoDB: database `mayfly`, collection `state` (one document) and collection `locks`. Every change runs under a lease lock that expires after 30 seconds, so simultaneous webhooks and admin actions never overwrite each other, and a crashed server can't hold the lock forever.
- Without `MONGODB_URI`, the same data is kept in `data/state.json`.
- Each machine keeps its own record of running gates and containers in `data/deployments.json`.

Only one running copy of Mayfly should use a given database.

## Run it

### Locally (placeholder previews)

```bash
npm ci
npm run dev
```

Open http://localhost:3000. This runs in process mode.

### With Docker (real pull request builds)

On Linux or a GitHub codespace, with Docker running:

```bash
docker compose up -d --build
```

Open port 3000 and go to `/board`. The first build takes a few minutes. Compose starts two services: `mayfly` and `docker-proxy` (see Security).

### In the GitHub codespace

```bash
git pull && docker compose up -d --build mayfly
```

- Use Docker Compose only. Don't run `npm start` in the codespace: port 3000 already belongs to the Mayfly container.
- After every restart, set port 3000 to **Public** in the **Ports** tab, or visitors get a GitHub sign-in page instead of Mayfly.
- `PREVIEW_BASE_URL` can stay empty; Mayfly uses the codespace's address for port 3000.
- Visitors may see GitHub's "development port" warning page first and need to click **Continue**.
- If a network's DNS refuses `*.app.github.dev`, use a different DNS service (for example Cloudflare's 1.1.1.1).

## Connect GitHub

On each repository listed in `PREVIEW_REPOS`, add a webhook:

- **Payload URL:** `https://<your-mayfly-address>/api/webhooks/github`
- **Content type:** `application/json`
- **Secret:** the same value as `GITHUB_WEBHOOK_SECRET`
- **Events:** Pull requests only

GitHub must be able to reach Mayfly, so the address must be public. A delivery with a missing or wrong signature gets `401` and changes nothing. Check results under the webhook's **Recent Deliveries**, where any delivery can be sent again with **Redeliver**. If Mayfly's address changes, update the webhook's URL.

With `GITHUB_TOKEN` set, Mayfly also posts the preview link as a comment on the pull request. Use a fine-grained token limited to the repositories Mayfly builds.

## What a pull request needs

- A `Dockerfile` at the repository root (otherwise: "No Dockerfile at repo root").
- The app listens on port `3000` (`$PORT`).
- It works as the unprivileged user `1000:1000` with a read-only filesystem where only `/tmp` is writable.
- Dockerfiles that need BuildKit-only features (`RUN --mount`, heredocs) won't build, because builds use Docker's classic builder.
- Pull requests from forks are never built.

## Settings

Copy `.env.example` to `.env.local` and fill it in. `.env.local` stays on the machine and is never copied into an image or committed.

| Key | What it does | Default |
|---|---|---|
| `MAYFLY_ADMIN_TOKEN` | Required. Protects every action that changes something. Generate with `openssl rand -hex 32`. | (none: all actions refused) |
| `GITHUB_WEBHOOK_SECRET` | Required in production. Checks that webhook deliveries come from GitHub. | |
| `GITHUB_TOKEN` | Optional. Posts preview links as pull request comments. | |
| `MONGODB_URI` | Optional. MongoDB connection string. When empty, Mayfly uses `data/state.json`. | |
| `PREVIEW_RUNTIME` | `docker` runs previews in containers. Anything else uses process mode. Compose sets `docker`. | `process` |
| `PREVIEW_REPOS` | Docker mode. Comma-separated `owner/name` list of repositories whose pull requests are built. | |
| `PREVIEW_BASE_URL` | Public address used in preview links. Leave empty on Render and in a codespace. | this app |
| `ALLOW_SIMULATOR` | Set to `true` to allow the admin simulator in production. | off in production |
| `DEMO_PREVIEW` | Optional always-on placeholder preview. Quote it: `DEMO_PREVIEW="owner/repo#1"`. | |
| `PREVIEW_SLEEP_SECONDS` | Stop a preview after this many seconds without a visitor. | `20` |
| `PREVIEW_TTL_HOURS` | A preview expires this many hours after it was created or last updated. | `8` |
| `PREVIEW_MAX_LIFETIME_HOURS` | Extending can never push expiry past this many hours after creation. | `168` |
| `MAX_CONCURRENT_ENVIRONMENTS` | New previews are refused once this many are live. | `10` |
| `PREVIEW_COST_PER_HOUR` | Assumed cost of one preview container per hour, for the savings estimate. | `0.05` |
| `PREVIEW_MEMORY`, `PREVIEW_CPUS` | Limits for each preview container. | `256m`, `0.5` |
| `PREVIEW_MAX_BUILDS` | Builds that run at once; the rest wait. | `1` |
| `PREVIEW_BUILD_MEMORY`, `PREVIEW_BUILD_CPUS` | Limits for each build step. | `1g`, `1` |
| `PREVIEW_MAX_REPO_MB`, `PREVIEW_MAX_IMAGE_MB` | Largest clone and largest built image. | `200`, `1024` |
| `PREVIEW_STUCK_MINUTES` | A preview stuck building, updating or removing is failed after this long. | `10` |
| `REAPER_INTERVAL_MS` | How often the reaper runs. | `60000` |
| `PREVIEW_IDLE_HOURS` | Reference value shown in the admin settings. Previews are never deleted for being idle; they sleep. | `4` |
| `PREVIEW_BOOT_DELAY_MS` | Process mode only. Simulated start-up delay so the waking page is visible. | `0` |
| `DEPLOYER` | `process` starts real gates; `fake` only writes records (for testing). | `process` |

## Security

- **Admin actions.** `MAYFLY_ADMIN_TOKEN` protects `POST /api/environments/<id>` (sleep, extend, destroy), `POST /api/events` (the simulator) and `POST /api/reaper`. Scripts send `Authorization: Bearer <token>` or `x-mayfly-admin: <token>`. People sign in at `/admin/login` and get an `HttpOnly`, `SameSite=Lax` cookie (`Secure` in production) that holds a signed expiry, never the token, and lasts 8 hours. A cookie-authenticated request must come from Mayfly's own `Origin`, or it gets `403`. With no token configured, every action is refused.
- **Webhooks** must be signed with `GITHUB_WEBHOOK_SECRET` in production.
- **Preview isolation.** Previews are served from the same address as the admin panel, so every preview response carries `Content-Security-Policy: sandbox …` without `allow-same-origin`. The browser treats a preview as a separate, untrusted site: its JavaScript can't use the admin's sign-in, and requests it sends are refused. Any `Set-Cookie` from a preview for Mayfly's admin cookie is dropped. Mayfly's own waking page is the only exception, marked by the gate, which strips that marker from the app's own responses. The trade-off is that a preview can't use cookies, `localStorage` or service workers. Serving previews from a separate domain would remove this limit.
- **Containers.** Each preview runs as user `1000:1000`, read-only, with all capabilities dropped, no new privileges, and memory, CPU and 100-process limits. Mayfly's own secrets are removed from the environment before `git` or `docker` runs.
- **Docker access.** Mayfly has no Docker socket. Only the `docker-proxy` service holds it, and Mayfly reaches Docker through it on `127.0.0.1:2375`. The proxy allows containers, images and builds, and refuses exec, volumes, networks, swarm, secrets, system and plugins. **It can't stop a container created with `--privileged` or a host bind mount**, because it filters by endpoint, not by request body. Anyone who can run code in Mayfly could still reach the host through Docker, so a public server needs rootless Docker, Sysbox, or a separate build host.
- **Allow-list.** Only repositories in `PREVIEW_REPOS` are built, and pull requests from forks are refused.

## Known limitations

- One machine. No autoscaling, and one container per pull request (no per-preview databases or extra services yet).
- In the codespace, links change if the codespace is recreated, and the codespace must be running with port 3000 Public.
- Render has no Docker, so its previews are placeholders.
- Preview logs aren't kept; the last 20 build log lines appear in a failed build's error.
- The savings figure is an estimate based on an assumed hourly cost.

## Name

This project is unrelated to the NCCloud Mayfly Kubernetes operator.
