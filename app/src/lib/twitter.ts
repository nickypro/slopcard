// Best-effort Twitter profile fetcher using public mirrors (no auth required).
// 1. api.fxtwitter.com — clean JSON, includes name + description + avatar + stats.
// 2. api.vxtwitter.com — fallback with similar data.
// 3. unavatar.io — last resort, just an avatar URL.
//
// Twitter's own syndication endpoints no longer expose profile metadata,
// and Nitter instances are mostly Cloudflare-blocked, so we lean on the
// fx/vx mirrors that the broader Twitter-embed community maintains.

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

export interface TwitterProfile {
  handle: string;
  displayName: string;
  description: string;
  avatarUrl: string;
  followers?: number;
  following?: number;
  source: "fxtwitter" | "vxtwitter" | "fallback";
}

export async function fetchTwitterProfile(
  rawHandle: string
): Promise<TwitterProfile> {
  const handle = rawHandle.replace(/^@/, "").trim();

  const fx = await tryFxTwitter(handle).catch(() => null);
  if (fx) return fx;

  const vx = await tryVxTwitter(handle).catch(() => null);
  if (vx) return vx;

  return {
    handle,
    displayName: "",
    description: "",
    avatarUrl: `https://unavatar.io/twitter/${encodeURIComponent(handle)}`,
    source: "fallback",
  };
}

interface FxUser {
  screen_name?: string;
  name?: string;
  description?: string;
  avatar_url?: string;
  followers?: number;
  following?: number;
}
interface FxResponse {
  code?: number;
  user?: FxUser;
}

async function tryFxTwitter(handle: string): Promise<TwitterProfile | null> {
  const url = `https://api.fxtwitter.com/${encodeURIComponent(handle)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as FxResponse;
  if (data.code !== 200 || !data.user || !data.user.screen_name) return null;
  const u = data.user;
  return {
    handle: u.screen_name!,
    displayName: u.name || "",
    description: u.description || "",
    avatarUrl: upscaleAvatar(u.avatar_url || ""),
    followers: u.followers,
    following: u.following,
    source: "fxtwitter",
  };
}

interface VxUser {
  screen_name?: string;
  name?: string;
  description?: string;
  profile_image_url?: string;
  followers_count?: number;
  following_count?: number;
}

async function tryVxTwitter(handle: string): Promise<TwitterProfile | null> {
  const url = `https://api.vxtwitter.com/${encodeURIComponent(handle)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const u = (await res.json()) as VxUser;
  if (!u.screen_name) return null;
  return {
    handle: u.screen_name,
    displayName: u.name || "",
    description: u.description || "",
    avatarUrl: upscaleAvatar(u.profile_image_url || ""),
    followers: u.followers_count,
    following: u.following_count,
    source: "vxtwitter",
  };
}

function upscaleAvatar(url: string): string {
  if (!url) return "";
  // twitter avatars: foo_normal.jpg → foo_400x400.jpg
  return url.replace("_normal.", "_400x400.");
}
