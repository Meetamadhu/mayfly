/**
 * Turns a failed preview's error text into what a person can do about it, in plain words. The build log shows what
 * happened, but only admins can read it; this reads the same text and answers "why, and what do I try?" for
 * everyone. It only matches known messages and returns fixed sentences, so nothing from the log is repeated.
 */

export interface FailureHelp {
  /** What went wrong, in a few words. */
  title: string;
  /** What to try, most likely first. */
  steps: string[];
}

interface Rule {
  test: RegExp;
  help: FailureHelp;
}

// The first rule that matches is used, so the specific ones come before the general ones.
const RULES: Rule[] = [
  {
    // The headline decides this one: the lines under it are the app's own output, which can mention anything.
    test: /^\s*(the app didn'?t start listening|preview app did not wake)/i,
    help: {
      title: "The app started, but nothing answered on port 3000",
      steps: [
        "The app must listen on the port in the PORT environment variable (3000) and on 0.0.0.0, not only on localhost.",
        "An admin can read what the app printed when it started: open this preview and look at App output.",
        "Check that it doesn't need a database or a secret that isn't set. Preview settings has a place for variables.",
      ],
    },
  },
  {
    test: /no dockerfile at the top of the repository/i,
    help: {
      title: "Mayfly doesn't know how to run this app",
      steps: [
        "Add a Dockerfile at the top of the repository that starts the app on port 3000, then push again.",
        "Mayfly writes one itself for Next.js, Vite, React, Vue and Angular apps, Node.js servers with a start script, plain HTML sites, and Flask or FastAPI apps. If yours is one of those, check that package.json or requirements.txt is at the top of the repository.",
      ],
    },
  },
  {
    test: /isn'?t on mayfly'?s list of allowed repositories/i,
    help: {
      title: "This repository isn't allowed yet",
      steps: ["Ask an admin to add the repository to Mayfly's list of allowed repositories (PREVIEW_REPOS), then push again."],
    },
  },
  {
    test: /repository is (bigger|larger) than/i,
    help: {
      title: "The repository is too big",
      steps: [
        "Remove large files from the repository (videos, datasets, build output), or move them to storage outside git.",
        "An admin can raise the limit with PREVIEW_MAX_REPO_MB.",
      ],
    },
  },
  {
    test: /the built app is \d+ mb/i,
    help: {
      title: "The built app is too big",
      steps: [
        "Make the Docker image smaller: use a slim base image, and don't copy node_modules or build caches into it (a .dockerignore helps).",
        "An admin can raise the limit with PREVIEW_MAX_IMAGE_MB.",
      ],
    },
  },
  {
    test: /build timed out/i,
    help: {
      title: "The build took too long",
      steps: [
        "Builds are stopped after 10 minutes. Cache installs by copying package files before the rest of the code, and drop steps a preview doesn't need (tests, linting).",
        "If the build waits on a download, check that the server can reach it.",
      ],
    },
  },
  {
    test: /downloading the code took longer/i,
    help: {
      title: "Downloading the code took too long",
      steps: ["This is usually a one-off: push an empty commit to try again.", "If it keeps happening, the repository may be too large to download in 2 minutes."],
    },
  },
  {
    test: /a newer commit .* was pushed while/i,
    help: {
      title: "A newer commit arrived while this one was building",
      steps: ["Nothing to do: Mayfly is building the newest commit instead."],
    },
  },
  {
    test: /could not read username|authentication failed|terminal prompts disabled|repository not found|could not read from remote/i,
    help: {
      title: "Mayfly couldn't download the code",
      steps: [
        "Mayfly can only download public repositories at the moment. If this one is private, a preview can't be built for it yet.",
        "If the repository is public, check that its name is spelled right in Mayfly's settings.",
      ],
    },
  },
  {
    test: /git is not installed|docker is not installed|cannot connect to the docker daemon|docker daemon/i,
    help: {
      title: "The server can't build previews right now",
      steps: ["This is a problem with the server, not with the code. Tell an admin: Docker or git isn't available on it."],
    },
  },
  {
    test: /exit 137\b|^\s*(#\d+\s+[\d.]+\s+)?killed\s*$|out of memory|\benomem\b|cannot allocate memory/im,
    help: {
      title: "The build ran out of memory",
      steps: [
        "Builds get 1 GB of memory. Use a lighter build (for Next.js, turn off source maps for previews), or build the app in an earlier CI step.",
        "An admin can raise the limit with PREVIEW_BUILD_MEMORY.",
      ],
    },
  },
  {
    test: /pull access denied|manifest unknown|manifest for .* not found|repository does not exist|failed to resolve (source )?metadata/i,
    help: {
      title: "The Dockerfile's base image couldn't be found",
      steps: ["Check the image named on the FROM line of the Dockerfile: its name and tag must exist on a public registry like Docker Hub."],
    },
  },
  {
    test: /copy failed|not found in build context|failed to compute cache key|no such file or directory.*(copy|add)/i,
    help: {
      title: "The Dockerfile copies a file that isn't there",
      steps: [
        "Check the COPY and ADD lines in the Dockerfile: the files must be in the repository.",
        "Also check .dockerignore: a file listed there is left out of the build.",
      ],
    },
  },
  {
    test: /missing script|npm err! missing script|npm error missing script/i,
    help: {
      title: "package.json has no script the build needs",
      steps: ["Add the missing script (for example \"build\" or \"start\") to package.json, or change the Dockerfile to run something that exists."],
    },
  },
  {
    test: /eresolve|could not resolve dependency/i,
    help: {
      title: "The packages conflict with each other",
      steps: [
        "Run the install on your own machine. If it fails there too, fix the versions in package.json.",
        "If it works there, commit your lock file: the build uses it to install the same versions.",
      ],
    },
  },
  {
    test: /cannot find module|module not found|can't resolve|err_module_not_found/i,
    help: {
      title: "The code needs a package that isn't installed",
      steps: ["Add the package to dependencies in package.json (not only devDependencies) and commit the updated lock file."],
    },
  },
  {
    test: /gyp err!|node-gyp.*(failed|error)|(gcc|g\+\+|make|cc): (command )?not found|error: command .*(gcc|g\+\+|cc).* failed|failed building wheel|python.*not found/i,
    help: {
      title: "A package needs build tools the image doesn't have",
      steps: [
        "Some packages compile code when they install. Add a Dockerfile that installs the tools first (for Debian: apt-get install -y build-essential python3).",
        "Or switch to a version of the package that ships a ready-made binary.",
      ],
    },
  },
  {
    test: /no matching distribution|could not find a version that satisfies/i,
    help: {
      title: "A Python package couldn't be found",
      steps: ["Check the names and versions in requirements.txt, and that the Python version in the Dockerfile supports them."],
    },
  },
  {
    test: /eacces|permission denied|read-only file system|erofs/i,
    help: {
      title: "The app tried to write somewhere it isn't allowed to",
      steps: [
        "Previews run as a normal user with a read-only filesystem. Only /tmp can be written to.",
        "Write files (caches, uploads, SQLite databases) under /tmp, or turn off the feature that needs the disk.",
      ],
    },
  },
  {
    test: /did not accept connections|preview process returned|econnrefused|connection refused|failed to wake/i,
    help: {
      title: "The app started, but nothing answered on port 3000",
      steps: [
        "The app must listen on the port in the PORT environment variable (3000) and on 0.0.0.0, not only on localhost.",
        "An admin can read what the app printed when it started: open this preview and look at App output.",
        "Check that it doesn't need a database or a secret that isn't set. Preview settings has a place for variables.",
      ],
    },
  },
  {
    test: /build failed \(exit \d+\)/i,
    help: {
      title: "The build stopped with an error",
      steps: [
        "An admin can open the build log: the last lines name the step that failed.",
        "To see the same error yourself, run docker build . in the repository on your own machine.",
        "Then push the fix: Mayfly builds again on every new commit.",
      ],
    },
  },
];

/** Plain-language help for a failed preview's error text, or null when it isn't one Mayfly recognises. */
export function explainFailure(error: string | null | undefined): FailureHelp | null {
  if (!error) return null;
  for (const rule of RULES) {
    if (rule.test.test(error)) return rule.help;
  }
  return null;
}
