/**
 * Project README templates + renderer.
 *
 * Per PROJECTS-CANVAS-SPEC §D3 the provisioner seeds `README.md` into
 * every new project so Canvas has real content on day 1. Templates are
 * plain markdown embedded as TypeScript strings so they ship inside every
 * package's compile output — no fs lookup, no deploy-image layout worry.
 *
 * Shared between `workspace-api` (UI-driven project creation, phase 5)
 * and `scripts/lib/projects.ts` (Face-driven project creation).
 *
 * Placeholders recognized by `renderReadmeTemplate`:
 *   {{name}}            - human-readable project name
 *   {{tagline}}         - one-line project description (placeholder used when blank)
 *   {{owner}}           - owning username (workspace slug)
 *   {{workspaceSlug}}   - same as owner; aliased for clarity in template bodies
 *   {{projectSlug}}     - project slug
 *   {{date}}            - ISO date (YYYY-MM-DD) of README generation
 *
 * Unknown placeholders are left as literal `{{var}}` — surfaces template
 * bugs at provisioning instead of silently rendering blanks.
 */

export interface ReadmeTemplateVars {
  name: string;
  tagline: string;
  owner: string;
  workspaceSlug: string;
  projectSlug: string;
  date?: string;
}

const DEFAULT = `# {{name}}

{{tagline}}

Created by [@{{owner}}]({{workspaceSlug}}) on {{date}}.

## What is this?

This is where **{{name}}** takes shape. Edit this file to tell visitors what you're building, why it matters, and how they can follow along.

## Next steps

- [ ] Replace this section with your own intro
- [ ] Drop a screenshot or diagram into this README
- [ ] Share the project with a friend — public projects appear in Discover
- [ ] Commit your first real code change

---

_Canvas renders this file. If you'd rather show a running app, set a \`previewUrl\` in project settings._
`;

const GAME = `# {{name}}

{{tagline}}

A game in progress by [@{{owner}}]({{workspaceSlug}}), started {{date}}.

## The idea

Tell players what they'll do, why it's fun, and what makes it yours.

## Tech

- Engine / stack:
- Genre:
- Target platform(s):

## Next steps

- [ ] Write the one-sentence pitch above the idea section
- [ ] Add a short GIF or screenshot
- [ ] Ship a playable build and set \`previewUrl\` in project settings
- [ ] Invite a playtester

---

_Canvas renders this file. Ship the game, set a \`previewUrl\`, and Canvas switches to the live app automatically._
`;

const TRIP = `# {{name}}

{{tagline}}

Trip plan by [@{{owner}}]({{workspaceSlug}}). Started {{date}}.

## Overview

Where you're going, who's going with you, and what you're excited about.

## Itinerary

| Day | Where | Plan |
|-----|-------|------|
|     |       |      |

## Packing / logistics

- [ ] Flights booked
- [ ] Lodging confirmed
- [ ] Ground transport sorted
- [ ] Passports / visas valid through return date

## Next steps

- [ ] Fill in the itinerary table above
- [ ] Drop photos or maps into this README
- [ ] Share the workspace with co-travelers

---

_Canvas renders this file. Update the itinerary and everyone in the workspace sees it live._
`;

const SOCIAL = `# {{name}}

{{tagline}}

A social project by [@{{owner}}]({{workspaceSlug}}), started {{date}}.

## What it's about

Describe the community you're gathering, what brings them together, and where it happens.

## The plan

- Who's the audience?
- What do they get from showing up?
- Where does the conversation live?

## Next steps

- [ ] Finish the three questions above
- [ ] Invite the first five people
- [ ] Post your first update to the project chat channel

---

_Canvas renders this file. Project chat lives under this project in the sidebar — a great place for a welcome post._
`;

const PLANNER = `# {{name}}

{{tagline}}

A planning project by [@{{owner}}]({{workspaceSlug}}). Started {{date}}.

## Goal

What's this plan driving toward? One sentence, concrete.

## Milestones

- [ ] Milestone 1 —
- [ ] Milestone 2 —
- [ ] Milestone 3 —

## Working notes

Put ideas, open questions, decisions here. The README is the living doc.

## Next steps

- [ ] Write the goal above
- [ ] Fill in at least one milestone
- [ ] Set a rough target date

---

_Canvas renders this file. Edit freely — every commit to this repo updates the Canvas in place._
`;

const TEMPLATES: Record<string, string> = {
  default: DEFAULT,
  game: GAME,
  trip: TRIP,
  social: SOCIAL,
  planner: PLANNER,
};

export function renderReadmeTemplate(
  projectType: string | null | undefined,
  vars: ReadmeTemplateVars,
): string {
  const key = projectType && Object.prototype.hasOwnProperty.call(TEMPLATES, projectType)
    ? projectType
    : "default";
  return substitute(TEMPLATES[key], {
    ...vars,
    tagline: vars.tagline?.trim() || "Describe your project in one sentence.",
    date: vars.date ?? new Date().toISOString().slice(0, 10),
  });
}

/**
 * Pure string substitution — exported so unit tests can lock the
 * behavior without touching the filesystem.
 */
export function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match;
  });
}
