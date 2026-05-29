"use client";

// Default profile picture. Renders the cached Swapcard photo when we have
// one, otherwise a colored initials disc. Hue is hashed from personId so the
// same attendee renders the same color across the whole app — visually stable
// without needing a DB column.

const PHOTO_QUERY = "?w=56";

// FNV-1a 32-bit. Good enough hash spread for the ~2k attendees we'll ever
// render and zero deps. Returns an unsigned int.
function hashStringFNV(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// Muted hue: low saturation + high lightness keeps colors as soft pastels so
// the initials stay readable in either theme.
function colorForId(id: string): string {
  const hue = hashStringFNV(id) % 360;
  return `hsl(${hue}, 35%, 70%)`;
}

function initialsOf(firstName: string, lastName: string): string {
  const a = firstName.trim().charAt(0).toUpperCase();
  const b = lastName.trim().charAt(0).toUpperCase();
  const out = `${a}${b}`;
  return out || "?";
}

export interface AvatarProps {
  personId: string | null;
  eventPeopleId: string | null;
  hasPhoto: boolean;
  firstName: string;
  lastName: string;
  size?: number;
}

export default function Avatar({
  personId,
  eventPeopleId,
  hasPhoto,
  firstName,
  lastName,
  size = 36,
}: AvatarProps) {
  // Photos route through the cached /api/swapcard/photo endpoint — same as
  // the inline <img> blocks this component replaces.
  const photoIdForUrl = personId ?? eventPeopleId;
  if (hasPhoto && photoIdForUrl) {
    const src = `/api/swapcard/photo/${encodeURIComponent(photoIdForUrl)}${PHOTO_QUERY}`;
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        referrerPolicy="no-referrer"
        loading="lazy"
        style={{
          borderRadius: "50%",
          background: "rgba(0,0,0,0.06)",
          objectFit: "cover",
          flexShrink: 0,
        }}
      />
    );
  }

  // Fallback disc. Hue derived from the same ID we'd have used for the photo
  // URL so identity remains stable across pages. Empty ID → neutral grey via
  // the hash collapsing on the empty string.
  const seed = photoIdForUrl ?? `${firstName}:${lastName}`;
  const bg = colorForId(seed);
  const initials = initialsOf(firstName, lastName);
  // Font size scales with the disc so the initials look right at any size.
  const fontSize = Math.round(size * 0.42);
  return (
    <div
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: bg,
        color: "rgba(255,255,255,0.95)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize,
        fontWeight: 600,
        lineHeight: 1,
        flexShrink: 0,
        userSelect: "none",
      }}
    >
      {initials}
    </div>
  );
}
