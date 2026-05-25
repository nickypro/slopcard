// Best-effort Twitter profile fetcher. No paid API, no auth.
// 1. Try syndication.twitter.com timeline-profile HTML — parse __NEXT_DATA__ for full bio.
// 2. Fallback: cdn.syndication.twimg.com followbutton — name + pic, no bio.
// 3. Fallback: unavatar.io — just a pic.
// Always returns something; the form is always editable so partial data is fine.

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

export interface TwitterProfile {
  handle: string;
  displayName: string;
  description: string;
  avatarUrl: string;
  source: "syndication" | "followbutton" | "fallback";
}

export async function fetchTwitterProfile(
  rawHandle: string
): Promise<TwitterProfile> {
  const handle = rawHandle.replace(/^@/, "").trim();

  const syndication = await trySyndication(handle).catch(() => null);
  if (syndication) return syndication;

  const followbutton = await tryFollowButton(handle).catch(() => null);
  if (followbutton) return followbutton;

  return {
    handle,
    displayName: "",
    description: "",
    avatarUrl: `https://unavatar.io/twitter/${encodeURIComponent(handle)}`,
    source: "fallback",
  };
}

async function trySyndication(handle: string): Promise<TwitterProfile | null> {
  const url = `https://syndication.twitter.com/srv/timeline-profile/screen-name/${encodeURIComponent(handle)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA },
    cache: "no-store",
  });
  if (!res.ok) return null;
  const html = await res.text();

  const m = html.match(
    /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/
  );
  if (!m) return null;

  let data: unknown;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return null;
  }

  const user = findUser(data, handle.toLowerCase());
  if (!user) return null;

  return {
    handle: user.screen_name || handle,
    displayName: user.name || "",
    description: user.description || "",
    avatarUrl: upscaleAvatar(user.profile_image_url_https || ""),
    source: "syndication",
  };
}

interface TwitterUser {
  screen_name?: string;
  name?: string;
  description?: string;
  profile_image_url_https?: string;
}

function findUser(obj: unknown, handleLower: string): TwitterUser | null {
  if (!obj || typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;
  if (
    typeof rec.screen_name === "string" &&
    rec.screen_name.toLowerCase() === handleLower &&
    typeof rec.profile_image_url_https === "string"
  ) {
    return rec as TwitterUser;
  }
  for (const key of Object.keys(rec)) {
    const found = findUser(rec[key], handleLower);
    if (found) return found;
  }
  return null;
}

async function tryFollowButton(
  handle: string
): Promise<TwitterProfile | null> {
  const url = `https://cdn.syndication.twimg.com/widgets/followbutton/info.json?screen_names=${encodeURIComponent(handle)}&lang=en`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA },
    cache: "no-store",
  });
  if (!res.ok) return null;
  const data = (await res.json()) as unknown;
  if (!Array.isArray(data) || data.length === 0) return null;
  const u = data[0] as TwitterUser;
  if (!u.screen_name) return null;
  return {
    handle: u.screen_name,
    displayName: u.name || "",
    description: "",
    avatarUrl: upscaleAvatar(u.profile_image_url_https || ""),
    source: "followbutton",
  };
}

function upscaleAvatar(url: string): string {
  if (!url) return "";
  return url.replace("_normal.", "_400x400.");
}
