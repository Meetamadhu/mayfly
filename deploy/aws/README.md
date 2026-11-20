# Run Mayfly on an AWS server

For a short test on one Ubuntu 24.04 server: AWS EC2 `m7i-flex.large` (2 CPUs, 8 GB) or anything similar.
Mayfly builds real pull requests in Docker, and Caddy gives it a free HTTPS address like
`https://1-2-3-4.sslip.io`, so GitHub webhooks work without buying a domain.

## Before you start

The server's security group must allow:

- **SSH (22)** from your IP, or from EC2 Instance Connect if you connect from the browser
- **HTTP (80)** and **HTTPS (443)** from anywhere

Don't open 3000 or 2375. Mayfly listens only on 127.0.0.1, and the Docker proxy must never be public.

## Set it up

In the server's terminal:

```bash
git clone https://github.com/Meetamadhu/mayfly.git ~/mayfly
bash ~/mayfly/deploy/aws/setup.sh
```

The script:

- installs Docker
- creates `.env.local` with a new admin token and webhook secret (it never prints them)
- builds Mayfly and starts it behind Caddy
- waits until `https://<address>` answers

At the end it prints the next steps:

1. Show the admin token and webhook secret on the server.
2. Point each sample repository's webhook at `https://<address>/api/webhooks/github`.
3. Add your GitHub token with `bash ~/mayfly/deploy/aws/setup.sh --github-token`. It asks for the token without showing it, refuses one that was pasted twice or cut off, saves it and rebuilds.

## GitHub token

Create a fine-grained token limited to the repositories in `PREVIEW_REPOS`, with **Contents: Read-only**, **Pull requests: Read and write** and **Commit statuses: Read and write**. Without Commit statuses, PR comments still work but the **Mayfly — Preview** check is refused with 403.

Every run of `setup.sh` checks the saved token: that it looks like one token, and that GitHub accepts it for each repository in `PREVIEW_REPOS`. GitHub doesn't let it check write permissions, so a missing permission shows up only in the logs when Mayfly tries to post.

State is kept in `~/mayfly/data/state.json`. Leave `MONGODB_URI` empty here, because only one Mayfly may use a database.

Only one Mayfly should receive a repository's webhook. When you point the webhooks here, a codespace that was using them stops getting events.

## Update to the latest code

```bash
cd ~/mayfly && git pull && bash deploy/aws/setup.sh
```

## Logs

```bash
cd ~/mayfly
sudo docker compose -f docker-compose.yml -f deploy/aws/docker-compose.aws.yml logs --tail=50 mayfly
sudo docker compose -f docker-compose.yml -f deploy/aws/docker-compose.aws.yml logs --tail=30 caddy
```

## Keep the address stable

A stopped and restarted EC2 server gets a new public IP, so its sslip.io address changes. If that happens:

1. Run `setup.sh` again.
2. Update the webhook URLs to the new address.

## When the test is over

1. Remove or switch off the webhooks on GitHub.
2. In EC2, choose **Instance state → Terminate**. Stopping it isn't enough, because the disk is still billed.

## Limits

- Anyone who can get code built by Mayfly can reach the server through Docker. That's why only the repositories in `PREVIEW_REPOS` are built, and pull requests from forks never are.
- This setup is fine for a short test with your own repositories. For long-term use, see "What this does not protect" in the main README.
