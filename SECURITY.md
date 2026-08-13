# Security

## Reporting a vulnerability

Please **do not open a public issue.**

Use GitHub's private vulnerability reporting on this repository
(Security → Report a vulnerability), or email <6ashishs@gmail.com> with
`stratigraph security` in the subject.

Please include what you would want to receive: the version (`stratigraph
--version`), what you did, what happened, and what you expected. A proof of
concept helps and is not required to report something.

I will acknowledge within a week. This is a small project maintained by one
person — there is no on-call rotation, and pretending otherwise would be worse
than saying so.

## What this tool touches

Worth stating plainly, because it is pointed at source code people cannot
share:

**Extraction and history mining are entirely local.** Parsing your repository
and mining its git history make no network request of any kind. Neither does
`analyze --no-llm`, `report`, `diff`, `prune` or the MCP server.

**One command reaches the network on purpose.** `stratigraph fetch-extractor`
downloads the JVM extractor jar from a GitHub release. It is verified against
a SHA-256 pinned inside the npm package by the same release job that built and
attached the jar — so the digest does not arrive from the same place as the
file it describes. There is no flag to skip verification, and a mismatch writes
nothing. `STRATIGRAPH_CACHE_HOME` lets an air-gapped machine pre-populate the
cache instead.

**The interpretation layer is the only thing that sends anything anywhere**, it
is optional, and `--no-llm` disables it. By default it sends *structural
metadata* — package names, edges, file paths, commit subjects. Sending raw
source bodies requires `--send-source`, which is off by default and logged
loudly when used. Everything structural runs with no credential at all.

**Credentials.** A key may live in `~/.config/stratigraph/config.json` (written
`chmod 600`), in `stratigraph.config.local.json`, in a file named by
`apiKeyFile`, or in an environment variable. The committed
`stratigraph.config.json` is **refused if it contains a key** — by the time
anyone notices a key in a committed file it has to be rotated rather than
deleted. `doctor` and `config` report *where* a credential came from and never
the credential itself, because that output is the first thing anyone pastes
into an issue.

**The fact store** is a local SQLite file, by default under your working
directory and never inside the repository being analysed. It contains file
paths, identifiers, commit subjects and author names and emails from the
history you mined. Treat it as you would the repository it describes.

**The HTML report** is self-contained: no script, no network request, no
external reference. It opens from a file share with scripting disabled.

**The MCP server** opens the store read-only and never starts an extractor.

## Scope

In scope: anything that makes the tool send data somewhere it should not,
execute code it should not, or write outside the paths it documents; a
checksum or verification bypass in `fetch-extractor`; a credential appearing in
output.

Out of scope: vulnerabilities in the *analysed* repository — reporting those is
what the tool is for.
