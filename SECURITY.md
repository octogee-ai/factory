# Security policy

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/octogee-ai/octogee-cloud/security/advisories/new).
If that is unavailable, email **support@octogee.com**. Do not publish exploit
details, credentials, or personal data in an issue, discussion, or pull request.

Include the affected version or commit, component, reproduction steps, expected
and observed behavior, impact, and any suggested mitigation. Use synthetic data
and redact credentials. Test only systems and accounts you own or are authorized
to test; permission to inspect this code does not authorize testing hosted services.

We aim to acknowledge reports within three business days and provide a triage
update within seven business days. These are targets, not a service guarantee.
If you receive no acknowledgment, follow up at support@octogee.com.

## Supported versions

Security fixes target the current `main` branch. Older snapshots are not maintained.

## Coordinated disclosure and advisories

Maintainers investigate reports privately and agree on a disclosure date with
the reporter. For a confirmed vulnerability, use a draft GitHub Security Advisory
(GHSA) and a private security fork when a fix needs collaboration. Record affected
versions, severity, impact, workarounds, and the patched version or commit.
Request a CVE through GitHub when eligible and no CVE has already been assigned.
Publish the advisory with the fix and release notes, crediting the reporter with
their consent. Never include live secrets or personal data in an advisory.

For exposed credentials, revoke or rotate them immediately and assess use;
removing a string from git does not invalidate the credential. Coordinate issues
in upstream dependencies with their maintainers through their private channels.

## Maintenance

The maintainers review GitHub security alerts and Dependabot pull requests at
least weekly, prioritizing active credentials, exploitable vulnerabilities, and
critical/high severity findings. Security updates go through the normal checks
and maintainer review before merge. Dismiss alerts only with a recorded reason.
Monitor failed scheduled scans as well as alert notifications.

CodeQL scans supported code and GitHub Actions; secret scanning and push
protection detect credential exposure. Dependabot checks dependencies and pinned
Actions weekly, while pull request dependency review rejects newly introduced
moderate, high, or critical known vulnerabilities. These checks complement review;
a passing scan is not a guarantee that the code is secure.
