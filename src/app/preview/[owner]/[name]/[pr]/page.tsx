import Link from "next/link";
import { getPreview } from "@/lib/lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ owner: string; name: string; pr: string }> };

export default async function PreviewPage({ params }: RouteContext) {
  const { owner, name, pr } = await params;
  const prNumber = Number(pr);
  const repository = `${decodeURIComponent(owner)}/${decodeURIComponent(name)}`.toLowerCase();
  const preview = Number.isInteger(prNumber) ? await getPreview(repository, prNumber) : { environment: null, deployment: null };
  const environment = preview.environment;
  const deployment = preview.deployment;
  const running = Boolean(deployment) && environment?.status !== "destroyed" && environment?.status !== "failed";

  return (
    <main className="preview panel">
      <p className="eyebrow">Pull request preview</p>
      <h1>
        {repository}#{Number.isInteger(prNumber) ? prNumber : pr}
      </h1>
      {running && environment ? (
        <>
          <p className="meta">
            <span className="status" data-status={environment.status}>{environment.status}</span>
            <span className="chip">{deployment?.branch}</span>
            <span className="chip mono">{deployment?.sha.slice(0, 12)}</span>
          </p>
          <p>
            This preview is running. It stays up while the pull request is open and in use, then Mayfly
            deletes it.
          </p>
          {deployment?.url ? (
            <p>
              <a className="open-link" href={deployment.url} target="_blank" rel="noreferrer">
                Open preview
              </a>
            </p>
          ) : null}
        </>
      ) : environment ? (
        <p>This preview was removed{environment.destroyReason ? ` (${environment.destroyReason})` : ""}.</p>
      ) : (
        <p>
          No preview is deployed for this pull request. This site keeps the record. Open the preview on the
          computer where Mayfly is running.
        </p>
      )}
      <p>
        <Link href="/">Back to the board</Link>
      </p>
    </main>
  );
}
