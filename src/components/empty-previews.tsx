"use client";

/**
 * What to do when the board has no previews yet: open a PR, finish setup, or start one by hand.
 */
export function EmptyPreviews({
  signedIn,
  setupNeeded,
  onNewPreview,
}: {
  signedIn: boolean;
  setupNeeded: boolean;
  onNewPreview?: () => void;
}) {
  return (
    <section className="pv-empty-card" aria-labelledby="pv-empty-title">
      <h2 id="pv-empty-title">No previews yet</h2>
      <p>Mayfly makes one for each pull request it hears about. Pick a way to get the first one:</p>
      <ol className="pv-empty-steps">
        <li>
          <strong>Open a pull request</strong>
          <span> on a repository Mayfly is allowed to build. Its preview appears here within a few minutes.</span>
        </li>
        {signedIn ? (
          <li>
            <strong>Start one by hand</strong>
            <span>
              {" "}
              with{" "}
              {onNewPreview ? (
                <button type="button" className="pv-link" onClick={onNewPreview}>
                  New preview
                </button>
              ) : (
                "New preview"
              )}
              , or try a practice pull request on the Admin page.
            </span>
          </li>
        ) : (
          <li>
            <strong>Running this Mayfly?</strong>
            <span>
              {" "}
              <a href="/admin/login">Sign in</a> to finish setup and open a practice pull request.
            </span>
          </li>
        )}
        {setupNeeded && signedIn ? (
          <li>
            <strong>Finish setup</strong>
            <span> using the checklist above: Docker previews, allowed repositories, and the GitHub webhook.</span>
          </li>
        ) : null}
      </ol>
      <p className="pv-empty-foot">
        Tip: press <kbd>Ctrl</kbd>+<kbd>K</kbd> (or <kbd>⌘</kbd>+<kbd>K</kbd>) for the command palette.
      </p>
    </section>
  );
}
