export interface PlaybookSeed {
  relPath: string;
  content: string;
}

export function projectPlaybookSeeds(projectName: string, today: string): PlaybookSeed[] {
  return [
    {
      relPath: "runbook/how-we-build.md",
      content: `# How we build ${projectName}

The way this project gets built, written down. Your agent reads this before
working here — change it (or ask your agent to) and the change holds from
then on.

## The basics

- Small steps that ship. One thing at a time, finished, before the next.
- Show, don't describe — a link someone can click beats a status update.
- When something matters, write it down here or in the decisions log.
  Conversations evaporate. The playbook doesn't.

## This project's defaults — edit these

- **Who it's for:** _fill in the customer_
- **The smallest real thing we ship first:** _fill it in_
- **Our rhythm:** _evenings? weekends? sprints? — whatever's true_
`,
    },
    {
      relPath: "runbook/what-done-means.md",
      content: `# What done means

"Done" is the standard your agent builds to — the bar held on every piece
of work in this project.

- It works for a real person, not just in theory.
- Every change carries a check that proves it — so once something is fixed,
  it stays fixed.
- Someone has actually seen it run. You count.
- It's live where people can reach it. Done means shipped.

Tighten this list as you learn. Every line you add here is a mistake that
can't happen twice.
`,
    },
    {
      relPath: "runbook/working-with-your-agent.md",
      content: `# Working with your agent

- Talk through what you want while it's fresh. Your agent turns it into a
  plan before any building starts — at your speed, in your words.
- Big ideas go one piece at a time. Your agent will propose the split.
- Disagree out loud. "That's not what I meant" early beats a rebuild later.
- When you decide something that should stick, say **"record a decision"** —
  it lands in this project's decisions log, and your agent honors it from
  then on.
- Stuck or curious? Ask your agent to explain what it's doing and why.
  The answer should always come back in plain language.
`,
    },
    {
      relPath: "DECISIONS.md",
      content: `# Decisions — ${projectName}

Why things are the way they are in this project. One entry per decision,
newest first. Say "record a decision" and your agent adds it here — then
honors it every time it works on ${projectName}.

## ${today} — ${projectName} keeps a decisions log

Why: choices made in chat get lost. Choices written here are read by your
agent before every session in this project, forever.
`,
    },
  ];
}
