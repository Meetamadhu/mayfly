import type { OrchestratorConfigView } from "./types";

/** The steps that take a fresh Mayfly from "installed" to "a pull request gets a preview". */
export interface SetupStep {
  id: "runtime" | "repositories" | "address" | "github" | "comments" | "first";
  title: string;
  /** What is true now (when done) or what to do (when not). */
  detail: string;
  /** A line to copy: a setting for the environment file, or an address for GitHub. */
  code?: string;
  done: boolean;
  /** Nothing breaks without it, so it doesn't hold the guide open. */
  optional?: boolean;
}

export function isLocalAddress(url: string) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    // "localhost:3000" with no scheme reads as a scheme, with no host.
    if (!host) return /localhost|127\.0\.0\.1/i.test(url);
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]" || host.endsWith(".localhost");
  } catch {
    return /localhost|127\.0\.0\.1/i.test(url);
  }
}

export function webhookAddress(origin: string) {
  return `${origin.replace(/\/+$/, "")}/api/webhooks/github`;
}

function listRepositories(names: string[]) {
  const shown = names.slice(0, 3).join(", ");
  return names.length > 3 ? `${shown} and ${names.length - 3} more` : shown;
}

/**
 * The guide for the person who installed Mayfly, from what the server already reports about itself.
 * `previewCount` is how many previews of real pull requests Mayfly has ever made. `origin` is the address this
 * page was opened on, which is where GitHub should send its messages.
 */
export function buildSetupSteps(input: {
  config: Pick<
    OrchestratorConfigView,
    "deployer" | "allowedRepositories" | "previewBaseUrl" | "webhookVerification" | "githubConnected" | "onRender"
  >;
  previewCount: number;
  origin: string;
}): SetupStep[] {
  const { config, previewCount, origin } = input;
  // The hosted demo only lists previews. There is nothing to set up on it.
  if (config.deployer === "fake") return [];

  const where = config.onRender ? "your Render dashboard (Environment)" : ".env.local";
  const restart = config.onRender ? "Render restarts Mayfly when you save." : "Then restart Mayfly.";
  const docker = config.allowedRepositories !== null;
  const repositories = config.allowedRepositories ?? [];
  const localAddress = isLocalAddress(config.previewBaseUrl);
  const signed = config.webhookVerification === "signed";

  const steps: SetupStep[] = [
    {
      id: "runtime",
      title: "Turn on real previews",
      done: docker,
      detail: docker
        ? "Each pull request is built and run in its own Docker container."
        : `Right now Mayfly only starts placeholder apps. To run your pull requests' code, add this to ${where}. Docker has to be installed on the server. ${restart}`,
      code: docker ? undefined : "PREVIEW_RUNTIME=docker",
    },
    {
      id: "repositories",
      title: "Choose which repositories get previews",
      done: repositories.length > 0,
      detail:
        repositories.length > 0
          ? `Allowed: ${listRepositories(repositories)}.`
          : `List the repositories Mayfly may build, as owner/name separated by commas. Pull requests from any other repository are refused. ${docker ? restart : "This needs the step above first."}`,
      code: repositories.length > 0 ? undefined : "PREVIEW_REPOS=owner/name",
    },
    {
      id: "address",
      title: "Set the public address",
      done: !localAddress,
      detail: localAddress
        ? `Links in pull request comments point at ${config.previewBaseUrl}, which only works on this computer. Set the address people reach this site on. ${restart}`
        : `Preview links start with ${config.previewBaseUrl}.`,
      code: localAddress ? "PREVIEW_BASE_URL=https://…" : undefined,
    },
    {
      id: "github",
      title: "Connect GitHub",
      done: signed,
      detail: signed
        ? `Mayfly checks that each message really comes from GitHub. The repository's webhook should point at ${webhookAddress(origin)}.`
        : `In each repository, open Settings, then Webhooks, and add the address below. Choose the content type application/json and the "Pull requests" event, and pick a secret. Then put that secret in ${where}. ${restart}${localAddress ? " GitHub can only reach a public address, so finish the step above first." : ""}`,
      code: signed ? undefined : `${webhookAddress(origin)}\nGITHUB_WEBHOOK_SECRET=…`,
    },
    {
      id: "comments",
      title: "Let Mayfly comment on pull requests",
      optional: true,
      done: config.githubConnected,
      detail: config.githubConnected
        ? "Mayfly puts the preview link and a check on each pull request."
        : `Optional. With a GitHub token, the preview link and build status show up on the pull request itself, so reviewers don't need to find this page. Add it to ${where}. ${restart}`,
      code: config.githubConnected ? undefined : "GITHUB_TOKEN=…",
    },
    {
      id: "first",
      title: "Open a pull request",
      done: previewCount > 0,
      detail:
        previewCount > 0
          ? "Mayfly has made its first preview."
          : "Open a pull request, or push to one, in an allowed repository. Its preview appears below within a few minutes. If the repository has no Dockerfile, Mayfly writes one when it can. You can also use New preview to start one by hand.",
    },
  ];
  return steps;
}

/** True once everything that matters is done. */
export function setupComplete(steps: SetupStep[]) {
  return steps.every((step) => step.done || step.optional);
}

/** The step to do next: the first one that isn't done and isn't optional. */
export function currentStep(steps: SetupStep[]) {
  return steps.find((step) => !step.done && !step.optional) ?? null;
}
