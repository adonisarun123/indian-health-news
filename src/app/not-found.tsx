import Link from "next/link";

export default function NotFound() {
  return (
    <div className="prose">
      <h1 className="page-title">Page not found</h1>
      <p>There is nothing at this address. It may have been mistyped, or the page may never have existed.</p>
      <p>
        <Link className="button primary" href="/latest">
          Latest updates
        </Link>{" "}
        <Link className="button" href="/search">
          Search
        </Link>
      </p>
    </div>
  );
}
