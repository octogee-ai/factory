export function notesWelcomeSeed(scopeName) {
    return {
        relPath: "notes/welcome.md",
        content: `# Welcome to notes

This is a note — the scratch layer of ${scopeName}. Half-formed thinking
lives here before it becomes anything official: ideas, open questions,
drafts you want another set of eyes on. Everyone in ${scopeName} sees the
same notes, and so does your agent.

When a note hardens into something real, promote it — ask your agent to
move it into the decisions log or the playbook — and then delete the note.
Notes that go nowhere just get deleted. That's the point of scratch.

Delete this one whenever you're ready.
`,
    };
}
export function projectPlaybookSeeds(projectName, today) {
    return [
        {
            relPath: "runbook/how-we-build.md",
            content: `# How we build ${projectName}

The way this project gets built, written down. Your agent reads this before
working here. Change it, or ask your agent to, and the change holds from
then on.

## The basics

- Small steps that ship. One visible change at a time, finished before the next.
- Show, do not summarize. A link someone can click beats a status update.
- Keep the project playbook about how ${projectName} works. Use the workspace
  Platform Playbook for Octogee platform behavior and limits.
- When something should stick, write it here or in the decisions log.
  Conversations evaporate. The repo does not.

## This project's defaults — edit these

- **Who it's for:** _fill in the customer_
- **The smallest real thing we ship first:** _fill it in_
- **Our proof link:** _the URL someone can open_
- **Our rhythm:** _evenings? weekends? sprints? whatever's true_
`,
        },
        {
            relPath: "runbook/what-done-means.md",
            content: `# What done means

"Done" is the standard your agent builds to: the bar held on every piece
of work in this project.

- It works for a real person, not just in theory.
- Every change carries a check that proves it — so once something is fixed,
  it stays fixed.
- Someone has actually seen it run. You count.
- It has a preview or live link where people can reach it.
- It is live when the work matters outside the workspace. Done means shipped.

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
            relPath: "runbook/shipping-on-gcp.md",
            content: `# Shipping on Octogee and Google Cloud

${projectName} ships through Octogee's managed Google Cloud path unless the
decisions log says otherwise.

## Defaults

- Every merge ships. Main is not a storage shelf.
- Preview before prod when the change changes behavior, copy, data, or layout.
- The default public shape is Firebase Hosting on
  octogee-{workspaceSlug}-{projectSlug}.web.app.
- Secrets belong in the Octogee platform, never in the repo, screenshots, or chat.
- If this project needs another GCP target, ask Octo to propose the smallest
  option and record the decision before wiring it.

## Before calling it shipped

- The preview link opens.
- The production link opens after merge.
- The changed path is checked by a person.
- The repo has enough context for the next session to continue without guessing.

Use the workspace Platform Playbook for how Octogee provisions workspaces,
deploys projects, and handles platform boundaries. Keep this page about this
project's shipping rules.
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
