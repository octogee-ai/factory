# Portable Octo starters

These packages carry Octo's coach/project working style into a new ordinary
OpenClaw agent. They require the receiving host's configured model and ordinary
workspace tools. They declare no skills, plugins, MCP services or automations;
no Octogee service credentials or hosted capabilities are included.

From the repository root, using the pinned OpenClaw runtime:

```sh
openclaw claws validate templates/claws/coach
openclaw claws dev templates/claws/coach
openclaw claws build templates/claws/coach --out /private/tmp/octogee-coach-0.1.0.tgz
openclaw claws validate templates/claws/project
openclaw claws dev templates/claws/project
openclaw claws build templates/claws/project --out /private/tmp/octogee-project-0.1.0.tgz
```

Review the package directory with `openclaw claws inspect templates/claws/coach`
(or `templates/claws/project`). The pinned CLI inspects directories/manifests;
extract a built archive into a fresh directory before inspecting it. Add requires Claws enabled in
the receiving host's Labs settings; authoring and inspection do not. Add always
chooses an unused agent ID and never updates an existing agent. The receiving
host's tool and permission policy remains authoritative.

These are optional starters, separate from hosted provisioning and Barn/Builder
migration. They do not include an existing agent's store UUID, conversations,
memory or files. Existing authored-workspace portability uses Octogee's GitHub
integration model; Claw Add does not export an existing agent. Full runtime
export/import is outside the current implementation scope.
