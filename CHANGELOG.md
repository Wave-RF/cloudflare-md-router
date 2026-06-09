# Changelog

All notable changes to `@wave-rf/cloudflare-md-router` are documented here. From
the next release onward this file is maintained automatically by
[release-please](https://github.com/googleapis/release-please) from
[Conventional Commit](https://www.conventionalcommits.org/) messages — don't
hand-edit it.

The entries below predate automated releases (the package was distributed via
`github:` install before being published to npm).

## [0.2.1](https://github.com/Wave-RF/cloudflare-md-router/compare/v0.2.0...v0.2.1) (2026-06-09)


### Features

* advertise the .md twin via an RFC 8288 Link header ([62f38f3](https://github.com/Wave-RF/cloudflare-md-router/commit/62f38f35bbbeab70d63aaafbd12ee6725eddf6f3))
* advertise the .md twin via an RFC 8288 Link header ([493466f](https://github.com/Wave-RF/cloudflare-md-router/commit/493466f59ca78ff2a8a228921655608b8bf4bb61))

## 0.2.0

- **feat:** advertise each HTML page's `.md` twin via an RFC 8288 `Link` header (`rel="alternate"; type="text/markdown"`) so an agent can discover the twin from a plain GET; on by default for a `200 text/html` reply to an extension-less GET, disabled with `advertiseTwin: false`.

## 0.1.0

- Initial release: a Cloudflare Worker that serves the `.md` twin of a static page for known LLM crawlers (or an explicit `Accept: text/markdown`), falling back to the HTML response when the twin is missing.
