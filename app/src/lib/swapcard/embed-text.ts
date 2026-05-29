// The prose serialization of an attendee used as input to both the embedding
// model and the BM25 index. Joining as natural language (rather than a keyword
// bag) lets the sentence-embedding model do useful work; the same text feeds
// BM25 because keyword overlap on the same fields is what RRF fusion expects.
//
// Kept in its own file so the ingest path, the runtime retrieval path, and any
// future re-embedding job all see identical text.

import type { Attendee } from "./types";

export function embedText(a: Attendee): string {
  return [
    `${a.firstName} ${a.lastName}`.trim(),
    a.jobTitle,
    a.company,
    a.country,
    a.careerStage,
    a.biography,
    a.expertise.join(", "),
    a.interests.join(", "),
    a.helpOthers ? `Can help others with: ${a.helpOthers}` : "",
    a.needHelp ? `Needs help with: ${a.needHelp}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// A separate "BM25 fit profile" string, mirroring the kryjak tool's two-field
// index. Excludes country/careerStage (low keyword signal) and keeps the
// person's needs in a separate field for offered/needed asymmetry.
export function bm25FitProfile(a: Attendee): string {
  return [
    a.biography,
    a.expertise.join(" "),
    a.interests.join(" "),
    a.helpOthers,
    a.jobTitle,
    a.company,
  ]
    .filter(Boolean)
    .join("\n");
}

// Used for LLM context blocks — readable, citation-friendly. Order chosen so
// the LLM sees identity, role, and freeform prose in that order.
export function profileForLlm(a: Attendee): string {
  const meta = [
    a.jobTitle,
    a.company ? `at ${a.company}` : "",
    a.country ? `(${a.country})` : "",
    a.careerStage,
  ]
    .filter(Boolean)
    .join(", ");
  const lines: string[] = [`**${a.firstName} ${a.lastName}** — ${meta}`];
  if (a.biography) lines.push(`Bio: ${a.biography}`);
  if (a.expertise.length) lines.push(`Expertise: ${a.expertise.join("; ")}`);
  if (a.interests.length) lines.push(`Interests: ${a.interests.join("; ")}`);
  if (a.helpOthers) lines.push(`Offers: ${a.helpOthers}`);
  if (a.needHelp) lines.push(`Seeking: ${a.needHelp}`);
  return lines.join("\n");
}
