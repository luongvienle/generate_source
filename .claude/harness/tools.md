# Development Tools

`detect.sh` found **no tool configuration files of any kind** in this repository
[verified] (`tool_configs` and `ci` sections both empty). Every section below is
therefore `Unknown` rather than empty-by-choice: nothing has been configured
yet, and no command can be invoked.

## Linters

`Unknown`. No ESLint, Biome, Oxlint, Stylelint or equivalent config file exists
[verified]. The spec names no linter.

## Formatters

`Unknown`. No Prettier, Biome, `.editorconfig` or equivalent config file exists
[verified]. The spec names no formatter.

## Test Frameworks

`Unknown` — no test framework is configured and no test file exists [verified].

The spec does mandate specific tests without naming a framework `[declared]`:

- A regression test covering **both** `GET /lessons/:lessonId` and
  `GET /media/:mediaId/signed-url` for entitlement (§7.3, requirement E-01).
- A dedicated unit test for the **early-renewal stacking** case, where renewing
  two months early must yield fourteen months rather than twelve (§7.4).
- Idempotency of the publish job (§5.7, FR-PUB-02) and of payment webhook
  handling (§5.9, FR-COM-03; NFR-06).

## Static Analysis

`Unknown`. No TypeScript config, no type-checking setup, and no static analysis
tooling exists [verified].

## Security Scanners

`Unknown`. No scanner config, no dependency audit configuration, and no CI
pipeline exists [verified].

Security-relevant requirements the spec states, for whoever configures scanning
later `[declared]`: signed media URLs must expire within 15 minutes (NFR-02,
§7.3 E-03); access is granted only by a signature-verified webhook, never by a
browser redirect (§5.9, FR-COM-03); role is read from the session on every
request, never from client input (§5.1, FR-AUTH-02).

## Notes

