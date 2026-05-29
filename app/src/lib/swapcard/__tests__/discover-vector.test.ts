import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Attendee } from "@/lib/swapcard/types";

// Unit tests for runVectorOnlyDiscover's input-shaping logic. We stub the DB
// (so no sqlite handle is needed) and stub retrieveCandidates (so we can
// inspect the exact retrieve-input the orchestrator constructed without
// running the embed model or the BM25 index).

const dbMock = vi.hoisted(() => ({
  listSwapcardAttendees: vi.fn(),
  getSheetSignature: vi.fn(),
}));
vi.mock("@/lib/db", () => dbMock);

const retrieveMock = vi.hoisted(() => ({
  retrieveCandidates: vi.fn(),
}));
vi.mock("@/lib/swapcard/retrieve", () => retrieveMock);

// Avoid pulling @xenova/transformers — the orchestrator imports blobToVector
// from embed.ts at the top level. The retrieve mock above means embedOne is
// never called; blobToVector just needs to be a no-op for the mapped rows.
vi.mock("@/lib/swapcard/embed", () => ({
  blobToVector: () => new Float32Array(384),
}));

function makeAttendee(overrides: Partial<Attendee> = {}): Attendee {
  return {
    eventId: "evt",
    personId: "PERSON_1",
    firstName: "Alice",
    lastName: "Smith",
    company: "Acme",
    jobTitle: "Engineer",
    careerStage: "mid",
    biography: "I work on widgets.",
    expertise: ["rust", "compilers"],
    interests: ["climbing"],
    needHelp: "",
    helpOthers: "",
    country: "UK",
    seekingWork: "",
    recruitment: [],
    swapcardUrl: "",
    linkedinUrl: "",
    ...overrides,
  };
}

function makeDbRow(personId: string | null, name: string) {
  return {
    eventId: "evt",
    personId,
    eventPeopleId: null,
    firstName: name,
    lastName: "Z",
    profileJson: JSON.stringify(makeAttendee({ personId, firstName: name })),
    embedding: Buffer.alloc(384 * 4),
    photoUrl: null,
    sheetSignature: "sig-v1",
    fetchedAt: 0,
  };
}

describe("runVectorOnlyDiscover", () => {
  beforeEach(() => {
    dbMock.listSwapcardAttendees.mockReset();
    dbMock.getSheetSignature.mockReset();
    retrieveMock.retrieveCandidates.mockReset();
    dbMock.getSheetSignature.mockReturnValue("sig-v1");
    dbMock.listSwapcardAttendees.mockReturnValue([
      makeDbRow("PERSON_1", "Alice"),
      makeDbRow("PERSON_2", "Bob"),
      makeDbRow("PERSON_3", "Carol"),
    ]);
    retrieveMock.retrieveCandidates.mockResolvedValue({
      primary: [],
      lateral: [],
    });
  });

  it("falls back to name-based query when bio/goals/prompt are all empty", async () => {
    const { runVectorOnlyDiscover } = await import(
      "@/lib/swapcard/discover-vector"
    );
    const requester = makeAttendee({
      biography: "",
      firstName: "Alice",
      lastName: "Smith",
      jobTitle: "Engineer",
      company: "Acme",
    });
    const run = await runVectorOnlyDiscover({
      requester,
      requesterPersonId: "PERSON_1",
      eventId: "evt",
      goals: "",
      customPrompt: "",
    });
    expect(run.searchQuery.query).toBe("Alice Smith Engineer Acme");
    expect(run.searchQuery.query).not.toBe("");
    // retrieveCandidates received the same non-empty semantic query.
    const args = retrieveMock.retrieveCandidates.mock.calls[0][0];
    expect(args.semanticQuery).toBe("Alice Smith Engineer Acme");
  });

  it("joins bio + goals + customPrompt with double-newline when present", async () => {
    const { runVectorOnlyDiscover } = await import(
      "@/lib/swapcard/discover-vector"
    );
    const requester = makeAttendee({ biography: "bio text" });
    const run = await runVectorOnlyDiscover({
      requester,
      requesterPersonId: "PERSON_1",
      eventId: "evt",
      goals: "find cofounders",
      customPrompt: "AI safety focus",
    });
    expect(run.searchQuery.query).toBe(
      "bio text\n\nfind cofounders\n\nAI safety focus"
    );
  });

  it("dedupes expertise + interests and caps at 30 keywords", async () => {
    const { runVectorOnlyDiscover } = await import(
      "@/lib/swapcard/discover-vector"
    );
    // 25 unique expertise + duplicates + 10 interests with 5 overlapping the
    // expertise list. Expected: unique count = 25 + 5 = 30 (exactly at the cap).
    const expertise = [
      ...Array.from({ length: 25 }, (_, i) => `exp${i}`),
      "exp0", // dupe
      "EXP1", // case-only dupe
    ];
    const interests = [
      ...Array.from({ length: 10 }, (_, i) => `int${i}`),
      "exp0", // overlaps expertise
      "exp2",
      "exp3",
      "exp4",
      "exp5",
    ];
    const requester = makeAttendee({ expertise, interests });
    const run = await runVectorOnlyDiscover({
      requester,
      requesterPersonId: "PERSON_1",
      eventId: "evt",
      goals: "",
    });
    expect(run.searchQuery.wanted.length).toBe(30);
    // No case-insensitive duplicates remain.
    const lowered = run.searchQuery.wanted.map((k) => k.toLowerCase());
    expect(new Set(lowered).size).toBe(run.searchQuery.wanted.length);
    // First occurrence wins → "exp1" (lowercase) stays, "EXP1" is dropped.
    expect(run.searchQuery.wanted).toContain("exp1");
    expect(run.searchQuery.wanted).not.toContain("EXP1");
  });

  it("returns empty lateral keywords (no fake serendipity without an LLM)", async () => {
    const { runVectorOnlyDiscover } = await import(
      "@/lib/swapcard/discover-vector"
    );
    const run = await runVectorOnlyDiscover({
      requester: makeAttendee(),
      requesterPersonId: "PERSON_1",
      eventId: "evt",
      goals: "some goals",
    });
    expect(run.searchQuery.lateral).toEqual([]);
    const args = retrieveMock.retrieveCandidates.mock.calls[0][0];
    expect(args.lateralKeywords).toEqual([]);
    expect(args.topLateral).toBe(0);
  });

  it("returns empty recommendations and empty retrieved.lateral", async () => {
    const { runVectorOnlyDiscover } = await import(
      "@/lib/swapcard/discover-vector"
    );
    const run = await runVectorOnlyDiscover({
      requester: makeAttendee(),
      requesterPersonId: "PERSON_1",
      eventId: "evt",
      goals: "g",
    });
    expect(run.recommendations).toEqual([]);
    expect(run.retrieved.lateral).toEqual([]);
    expect(run.lateralRetrieved).toBe(0);
  });

  it("returns runId undefined (vector-tier runs are not persisted)", async () => {
    const { runVectorOnlyDiscover } = await import(
      "@/lib/swapcard/discover-vector"
    );
    const run = await runVectorOnlyDiscover({
      requester: makeAttendee(),
      requesterPersonId: "PERSON_1",
      eventId: "evt",
      goals: "g",
    });
    expect(run.runId).toBeUndefined();
  });

  it("throws when no sheet signature is loaded", async () => {
    dbMock.getSheetSignature.mockReturnValueOnce(null);
    const { runVectorOnlyDiscover } = await import(
      "@/lib/swapcard/discover-vector"
    );
    await expect(
      runVectorOnlyDiscover({
        requester: makeAttendee(),
        requesterPersonId: "PERSON_1",
        eventId: "evt",
        goals: "g",
      })
    ).rejects.toThrow(/No attendee data ingested/i);
  });

  it("throws when the attendee cache is empty", async () => {
    dbMock.listSwapcardAttendees.mockReturnValueOnce([]);
    const { runVectorOnlyDiscover } = await import(
      "@/lib/swapcard/discover-vector"
    );
    await expect(
      runVectorOnlyDiscover({
        requester: makeAttendee(),
        requesterPersonId: "PERSON_1",
        eventId: "evt",
        goals: "g",
      })
    ).rejects.toThrow(/cache is empty/i);
  });
});
