// Canned `customPrompt` strings the user can one-click into the discover
// form. The prompt is appended to the requester's conference goals before
// the query-construction LLM call, so each preset is written as guidance
// to the LLM rather than as user-facing copy. Keep these short and
// composable — the user can edit after clicking.

export interface PromptPreset {
  id: string;
  label: string;
  emoji: string;
  prompt: string;
}

export const PROMPT_PRESETS: PromptPreset[] = [
  {
    id: "technical-cofounders",
    label: "technical co-founders",
    emoji: "🔧",
    prompt:
      "Heavily weight people building or technically leading EA-adjacent startups or research orgs (CEOs, CTOs, founders, technical leads). Skip anyone whose primary role is recruiter, comms, ops, or grant-making — those are valuable but I'm specifically looking for technical building partners this conference.",
  },
  {
    id: "first-timers",
    label: "fellow first-timers",
    emoji: "🌱",
    prompt:
      "Bias toward people early in their EA journey: students, attendees with shorter career stages, people whose biographies flag they're new to the space or transitioning into EA-adjacent work. The goal is to find peers I can grow alongside rather than mentors.",
  },
  {
    id: "researchers-not-recruiters",
    label: "researchers, not recruiters",
    emoji: "🔬",
    prompt:
      "Strongly prefer active researchers and practitioners over recruiters, talent leads, or anyone whose stated 'how I can help' is primarily hiring. I want substantive technical or empirical conversations.",
  },
  {
    id: "ai-safety",
    label: "AI safety focus",
    emoji: "🛡️",
    prompt:
      "Focus on AI safety technical research, AI governance, evaluations, interpretability, agent foundations, RSP/AISI work. Within that, prefer people whose expertise/interest fields explicitly include those areas over generalists.",
  },
  {
    id: "global-health",
    label: "global health & development",
    emoji: "🌍",
    prompt:
      "Focus on global health and development practitioners, especially anyone running field programs in LMICs, working on policy implementation, or doing rigorous impact evaluation. Skip pure AI/longtermism unless they have GHD crossover.",
  },
  {
    id: "career-pivot",
    label: "career pivot advice",
    emoji: "🧭",
    prompt:
      "Find people who've successfully made career pivots into EA-aligned work from adjacent fields, especially those who are now in roles where they hire or advise. The aim is concrete advice on navigating a transition, not job interviews.",
  },
];

export function getPromptPresetById(id: string): PromptPreset | undefined {
  return PROMPT_PRESETS.find((p) => p.id === id);
}
