# Mayfly

Mayfly gives every pull request a preview that sleeps when nobody is using it, wakes on the next visit, and is deleted when the pull request closes. It is a prototype. Each preview is a placeholder Node app that shows the repository, branch, and commit. It does not build or run the pull request's real code.

## How it works

Each preview is two Node processes. A gate listens on a private port on this machine (`127.0.0.1`), and the app process runs behind it. Nobody reaches the gate directly: Mayfly serves every preview at `/p/<owner>/<name>/<pr>` and forwards to it. After `PREVIEW_SLEEP_SECONDS` with no request, the gate stops the app. The next visit gets a "Waking up" page immediately, the gate starts the app, and the page loads itself. The reaper deletes a preview when its lifetime is over, when it is stuck, or when the pull request closes or merges. An idle preview is slept, and is left in place while the pull request is open. When `GITHUB_TOKEN` is set, Mayfly also comments on the pull request.

Open a preview at `/p/<owner>/<name>/<pr>` on this app.

## Run locally

From the project directory, in Linux or WSL:

```bash
npm ci
npm run dev
```

The same two commands run in PowerShell. The app listens at http://localhost:3000.

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
| `DEPLOYER` | `process` starts one Node server per pull request. `fake` only writes a local record. |
| `PREVIEW_FAKE_DELAY_MS` | Artificial delay for the fake deployer. Example: `700`. |
| `PREVIEW_BASE_URL` | Origin used in preview links. Example: `http://localhost:3000`. |
| `GITHUB_WEBHOOK_SECRET` | Required in production. In development, an empty value accepts unsigned deliveries. |
| `GITHUB_TOKEN` | Optional. When set, preview comments are also posted on the pull request. |
| `MAYFLY_ADMIN_TOKEN` | Required for every action that changes things. Send it as `Authorization: Bearer <token>` or `x-mayfly-admin: <token>`, or paste it into the board's **Admin** field. When empty, those actions are always refused with 401. Generate one with `openssl rand -hex 32`. |
| `DEMO_PREVIEW` | Optional. Keep one preview alive for visitors. Quote it, because `#` starts a comment: `DEMO_PREVIEW="acme/web#1"`. Empty turns it off. The branch is `demo` and the commit is `d3m0d3m0`. It is not deleted when its time limit passes, and the card does not show an expiry. |

## Deploy temporarily

On a Linux server, build and run in production mode (not `npm run dev`):

```bash
npm ci
npm run build
npm start -- -H 0.0.0.0
```

Set at least these on the server: `MAYFLY_ADMIN_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `PREVIEW_BASE_URL` (the public address people open), and `PREVIEW_TTL_HOURS=168`. The simulator is off in production unless `ALLOW_SIMULATOR=true`.

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

`MAYFLY_ADMIN_TOKEN` protects `POST /api/environments/<id>?action=destroy`, `action=sleep`, and `action=activity`, plus `POST /api/reaper` and `POST /api/events`. With no token configured those routes refuse every request; there is no exception for "local" requests, because the `Host` header is chosen by the sender. The board keeps the token in the browser tab's `sessionStorage` only and sends it as a Bearer header; it never appears in the page or the API. In production, webhook deliveries must be signed with `GITHUB_WEBHOOK_SECRET`.

Preview processes receive only `PATH`, `NODE_ENV` and `PREVIEW_*` variables (plus the Windows system variables Node needs). `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET` and `MAYFLY_ADMIN_TOKEN` never reach them.

## Known limitations

Mayfly runs on one machine and stores state in a JSON file. It does not use Docker. On Vercel the deployer is a simulation: it writes records and does not start preview processes, and that state is ephemeral. Mayfly does not save preview logs; the app's output is discarded. Previews are placeholder apps, so running real pull request code would still need build isolation (for example containers).

## Name

This project is unrelated to the NCCloud Mayfly Kubernetes operator.
