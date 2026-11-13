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

_Canvas renders this file. If you'd rather show a running app, **Publish** it and Canvas displays the live app._
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
- [ ] Ship a playable build and **Publish** it — Canvas switches to the live app
- [ ] Invite a playtester

---

_Canvas renders this file. Ship the game and **Publish** it, and Canvas switches to the live app automatically._
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
const RESEARCH = `# {{name}}

{{tagline}}

A research project by [@{{owner}}]({{workspaceSlug}}). Started {{date}}.

## The question

The one decision this project exists to make. Write it so it can be answered.

## Who it affects

- Deciding:
- Affected:
- Decision date:

## Options on the table

| Option | The case for | The case against |
|--------|--------------|------------------|
|        |              |                  |

## Next steps

- [ ] Write the question above in one sentence
- [ ] Set the decision date
- [ ] Add one note per source in notes/
- [ ] Record the decision — and its why — in DECISIONS.md

---

_Canvas renders this file. Keep the question and the options current here and everyone can see where the decision stands._
`;
const EVENT = `# {{name}}

{{tagline}}

An event organized by [@{{owner}}]({{workspaceSlug}}). Started {{date}}.

## What, when, where

- **What:**
- **When:**
- **Where:**
- **Why come:**

## Run of show

| Time | What happens | Who runs it |
|------|--------------|-------------|
|      |              |             |

## Organizer checklist

- [ ] Venue or platform confirmed
- [ ] Invites sent
- [ ] Reminder scheduled
- [ ] Day-of roles assigned
- [ ] Backup plan for whatever is most likely to go wrong

## Next steps

- [ ] Fill in what, when, and where above
- [ ] **Publish** this page and share the link
- [ ] Draft the invite, reminder, and thank-you in notes/
- [ ] Write the recap after

---

_Canvas renders this file. Publish it early and update it often — the page is the answer to every question you'd otherwise repeat._
`;
const TEMPLATES = {
    default: DEFAULT,
    game: GAME,
    trip: TRIP,
    social: SOCIAL,
    planner: PLANNER,
    research: RESEARCH,
    event: EVENT,
};
export function renderReadmeTemplate(projectType, vars) {
    const key = projectType && Object.prototype.hasOwnProperty.call(TEMPLATES, projectType)
        ? projectType
        : "default";
    return substitute(TEMPLATES[key], {
        ...vars,
        tagline: vars.tagline?.trim() || "Describe your project in one sentence.",
        date: vars.date ?? new Date().toISOString().slice(0, 10),
    });
}
export function substitute(template, vars) {
    return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
        return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match;
    });
}
