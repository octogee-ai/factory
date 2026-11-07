# Contributing

Read `AGENTS.md` first. It is the contract every agent and every contributor works under here, and the handbook chapters in `docs/handbook/` are the rules it points at.
Open one focused pull request per change, with the smallest test that proves the changed behavior.
Every commit needs a Developer Certificate of Origin sign-off: commit with `git commit -s`, which adds a `Signed-off-by` line with your name and email. The certificate you are signing is at https://developercertificate.org, and the `dco` check fails a pull request with an unsigned commit.
Files that `.factory-source.json` lists are published from the Octogee monorepo and are overwritten by the next publish, so propose a change to one of them in an issue and I carry it over; the templates, the workflows, and anything the pin does not list take pull requests here directly. Say which monorepo commit your change targets; the pin names the one this tree was published from.
This repository carries files, not the hosted service, so questions about an Octogee account belong on octogee.com rather than in an issue here.
