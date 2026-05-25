// Build absolute URLs for redirects. Using SITE_URL (instead of req.url) so
// the location header is always the public hostname, not whatever Next.js
// reconstructs from the inbound container request.

export function siteUrl(path = "/"): string {
  const base = (process.env.SITE_URL || "http://localhost:3000").replace(
    /\/$/,
    ""
  );
  if (!path.startsWith("/")) path = "/" + path;
  return base + path;
}
