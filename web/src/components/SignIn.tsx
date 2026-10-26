// Sign-in screen shown when there is no session (any 401) or the Discord account isn't on the access list.
import type { AuthProblem } from "../api";

export function SignIn({ problem }: { problem: AuthProblem }) {
  const next = `${window.location.pathname}${window.location.hash}`;
  return (
    <div className="signin">
      <section className="card signin-card stack-sm">
        <div className="brand">
          <span className="logo" aria-hidden>
            TD
          </span>
          <span className="app-name">Trade Desk</span>
        </div>
        {problem === "not_allowed" ? (
          <div className="notice warn">This Discord account isn't on the list yet — ask the league owner.</div>
        ) : (
          <p className="muted no-margin">Sign in to see your team.</p>
        )}
        <a className="btn primary signin-btn" href={`/auth/login?next=${encodeURIComponent(next)}`}>
          Sign in with Discord
        </a>
        <p className="muted small no-margin">We only read your Discord name and avatar.</p>
      </section>
    </div>
  );
}
