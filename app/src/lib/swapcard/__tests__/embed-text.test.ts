import { describe, it, expect } from "vitest";
import {
  embedText,
  bm25FitProfile,
  profileForLlm,
} from "@/lib/swapcard/embed-text";
import type { Attendee } from "@/lib/swapcard/types";

function makeAttendee(overrides: Partial<Attendee> = {}): Attendee {
  return {
    eventId: "eag-london-2026",
    personId: "EventPeople_1",
    firstName: "Alice",
    lastName: "Smith",
    company: "Acme",
    jobTitle: "Engineer",
    careerStage: "Mid-career",
    biography: "Builds things.",
    expertise: ["python", "ml"],
    interests: ["safety", "policy"],
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

describe("embedText", () => {
  it("joins all non-empty fields with newlines", () => {
    const a = makeAttendee();
    const text = embedText(a);
    expect(text).toContain("Alice Smith");
    expect(text).toContain("Engineer");
    expect(text).toContain("Acme");
    expect(text).toContain("UK");
    expect(text).toContain("Mid-career");
    expect(text).toContain("Builds things.");
    expect(text).toContain("python, ml");
    expect(text).toContain("safety, policy");
  });

  it("skips empty fields (no trailing newlines, no consecutive newlines)", () => {
    const a = makeAttendee({
      company: "",
      country: "",
      careerStage: "",
      biography: "",
      expertise: [],
      interests: [],
    });
    const text = embedText(a);
    // Should not produce blank lines from the skipped fields.
    expect(text).not.toMatch(/\n\n/);
    expect(text).not.toMatch(/\n$/);
    // What's left is just the name and jobTitle.
    expect(text).toBe("Alice Smith\nEngineer");
  });

  it("joins expertise and interests with comma-space", () => {
    const a = makeAttendee({
      expertise: ["python", "rust", "ml"],
      interests: ["safety"],
    });
    const text = embedText(a);
    expect(text).toContain("python, rust, ml");
    expect(text).toContain("safety");
  });

  it('prefixes helpOthers with "Can help others with:"', () => {
    const a = makeAttendee({ helpOthers: "career advice" });
    const text = embedText(a);
    expect(text).toContain("Can help others with: career advice");
  });

  it('prefixes needHelp with "Needs help with:"', () => {
    const a = makeAttendee({ needHelp: "intro to funders" });
    const text = embedText(a);
    expect(text).toContain("Needs help with: intro to funders");
  });

  it("does not add the prefixes when helpOthers/needHelp are empty", () => {
    const a = makeAttendee({ helpOthers: "", needHelp: "" });
    const text = embedText(a);
    expect(text).not.toContain("Can help others with:");
    expect(text).not.toContain("Needs help with:");
  });

  it("handles a fully-empty attendee (just whitespace name) gracefully", () => {
    const a = makeAttendee({
      firstName: "",
      lastName: "",
      jobTitle: "",
      company: "",
      country: "",
      careerStage: "",
      biography: "",
      expertise: [],
      interests: [],
      helpOthers: "",
      needHelp: "",
    });
    // The first field is `${firstName} ${lastName}`.trim() which becomes "",
    // and gets filter(Boolean)-removed. Same for the joined arrays.
    const text = embedText(a);
    expect(text).toBe("");
  });
});

describe("bm25FitProfile", () => {
  it("joins biography, expertise, interests, helpOthers, jobTitle, company", () => {
    const a = makeAttendee({
      biography: "bio text",
      expertise: ["a", "b"],
      interests: ["c", "d"],
      helpOthers: "help text",
    });
    const text = bm25FitProfile(a);
    expect(text).toContain("bio text");
    expect(text).toContain("a b");
    expect(text).toContain("c d");
    expect(text).toContain("help text");
    expect(text).toContain("Engineer");
    expect(text).toContain("Acme");
  });

  it("skips empty entries with no extra newlines", () => {
    const a = makeAttendee({
      biography: "",
      expertise: [],
      interests: [],
      helpOthers: "",
      jobTitle: "Eng",
      company: "",
    });
    const text = bm25FitProfile(a);
    expect(text).toBe("Eng");
  });
});

describe("profileForLlm", () => {
  it("formats name in bold and meta with em-dash separator", () => {
    const a = makeAttendee();
    const text = profileForLlm(a);
    expect(text.split("\n")[0]).toBe(
      "**Alice Smith** — Engineer, at Acme, (UK), Mid-career"
    );
  });

  it("includes bio, expertise, interests, helpOthers, needHelp when present", () => {
    const a = makeAttendee({
      biography: "bio here",
      expertise: ["x", "y"],
      interests: ["foo", "bar"],
      helpOthers: "can help",
      needHelp: "need help",
    });
    const text = profileForLlm(a);
    expect(text).toContain("Bio: bio here");
    expect(text).toContain("Expertise: x; y");
    expect(text).toContain("Interests: foo; bar");
    expect(text).toContain("Offers: can help");
    expect(text).toContain("Seeking: need help");
  });

  it("omits sections that are empty", () => {
    const a = makeAttendee({
      biography: "",
      expertise: [],
      interests: [],
      helpOthers: "",
      needHelp: "",
    });
    const text = profileForLlm(a);
    expect(text).not.toContain("Bio:");
    expect(text).not.toContain("Expertise:");
    expect(text).not.toContain("Interests:");
    expect(text).not.toContain("Offers:");
    expect(text).not.toContain("Seeking:");
  });

  it("omits empty meta segments cleanly", () => {
    const a = makeAttendee({
      company: "",
      country: "",
      careerStage: "",
      biography: "",
      expertise: [],
      interests: [],
      helpOthers: "",
      needHelp: "",
    });
    const text = profileForLlm(a);
    // Only jobTitle remains in the meta block.
    expect(text).toBe("**Alice Smith** — Engineer");
  });
});
