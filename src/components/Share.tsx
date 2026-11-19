"use client";

import { useEffect, useState } from "react";

/**
 * Story actions (UX-01). The WhatsApp link is a plain anchor and works with
 * scripts blocked. Native share and copy appear only where the browser
 * supports them. The shared URL is always the clean canonical address.
 */
export function Share({ url, title }: { url: string; title: string }) {
  const [canShare, setCanShare] = useState(false);
  const [canCopy, setCanCopy] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    setCanShare(typeof navigator.share === "function");
    setCanCopy(Boolean(navigator.clipboard?.writeText));
  }, []);

  const share = async () => {
    try {
      await navigator.share({ title, url });
    } catch {
      /* The reader closed the share sheet. */
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setStatus("Link copied.");
    } catch {
      setStatus("Could not copy. Select the address bar to copy the link.");
    }
  };

  return (
    <div className="share" role="group" aria-label="Share this story">
      {canShare && (
        <button type="button" className="button" onClick={share}>
          Share
        </button>
      )}
      {canCopy && (
        <button type="button" className="button" onClick={copy}>
          Copy link
        </button>
      )}
      <a className="button" href={`https://wa.me/?text=${encodeURIComponent(`${title} ${url}`)}`} rel="noopener">
        Share on WhatsApp
      </a>
      <p className="share-status" role="status" aria-live="polite">
        {status}
      </p>
    </div>
  );
}
