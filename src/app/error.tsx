"use client";

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="prose">
      <h1 className="page-title">This page could not be loaded</h1>
      <p>The service had a problem. Your connection may also have dropped.</p>
      <p>
        <button type="button" className="button primary" onClick={reset}>
          Try again
        </button>{" "}
        <a className="button" href="/">
          Go to the homepage
        </a>
      </p>
    </div>
  );
}
