# Octogee broker discovery

The installed plugin uses public Native provider/catalog SDK hooks. Its distinct
`octogee-broker` discovery owner returns scoped model rows for the existing
`anthropic`, `platform-openai` and `platform-openrouter` transports. It does not
register replacement inference, auth, replay or embedding owners. Managed config
keeps the discovery owner enabled alongside the original providers.

Catalog requests authenticate with the selected agent's existing provider
credential. Responses must match its canonical agent, provider, model purpose
and configured transport. The adapter resolves credentials again before
publishing, keeps no metadata cache, bounds responses to 2 MiB and cancels after
eight seconds. Discovery does not admit inference or reserve spend. Missing
runtime facts/pricing remain unavailable; numeric costs are USD per million.
Models with incomplete runtime metadata remain picker rows with a warning.
Existing authored model configuration and broker admission remain authoritative.

`octogee.broker.inspect` is an `operator.read` RPC accepting only `agentId`.
The Native host's attested user/profile and current authority are required.
The private internal broker endpoint checks current allocation, canonical
workspace/project ownership and interactive account access before and after
billing reads. The RPC checks client authority again and projects only named
metadata fields. Inference tokens grant no private billing read. No private
balance is returned by Native's Gateway-global usage hooks; those return handled
metadata-unavailable without fallback. No separate read token is issued.

Inspection reports the shared billing contract's fixed four-hour windows,
Thursday 00:00 UTC seven-day reset, credits when applicable, and the active
signup offer's ledger spend, unlocked cap, next unlock and expiry. Missing offer
accounting fails closed. These values are not monthly or unmetered allowances.

Run behavioral coverage with `npm test --prefix infra/gateway/extensions/platform/octogee-broker-tools`.
For an exact, clean Native source checkout:

```sh
node infra/gateway/verify-broker-plugin-contract.mjs <source> <full-sha>
node infra/gateway/verify-broker-plugin-runtime.mjs <source> <full-sha>
```

The runtime check builds the actual shipped bundle, loads the installed public
SDK/registry with the original Anthropic owner, checks usage suppression, and
resolves a synthetic agent credential through the public catalog callback.
It does not exercise live inference, a deployed image or customer credentials.
Explicit Native provider-filtered discovery may exclude this separate owner;
it must not be enabled by claiming another provider's ownership or aliases.
