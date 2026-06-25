import { buildLoginUrl } from "../lib/apiClient";

type StartupScreenProps = {
  authRequired: boolean;
  error: string;
  label: string;
};

export function StartupScreen({
  authRequired,
  error,
  label,
}: StartupScreenProps) {
  return (
    <div className="startup-screen">
      <div className="startup-card">
        <div className="startup-brand">
          <img
            src="/Fresh Coast-R3-05.png"
            alt="Fresh Coast"
            onError={(event) => {
              event.currentTarget.hidden = true;
            }}
          />
        </div>
        <div>
          <div className="startup-eyebrow">Denmark</div>
          <h1>Bringing the dispatch board online</h1>
          <p>
            {error
              ? error
              : `${label}. Hold tight while the queue gets its facts straight.`}
          </p>
        </div>

        {error ? (
          <button
            type="button"
            className="startup-action"
            onClick={() => window.location.reload()}
          >
            Try again
          </button>
        ) : authRequired ? (
          <button
            type="button"
            className="startup-action"
            onClick={() => {
              window.location.assign(buildLoginUrl());
            }}
          >
            Sign in
          </button>
        ) : (
          <div className="startup-progress" aria-label="Loading">
            <span />
          </div>
        )}
      </div>
    </div>
  );
}
