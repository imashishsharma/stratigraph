# ADR-0004: Distribution — one npm package, a fetched extractor jar, a Docker image

- Status: accepted
- Date: 2026-07-28
- Milestone: M0

## Context

`stratigraph` is meant to be installed and used by people who did not build it.
It has a TypeScript core and a JVM extractor (ADR-0001). Users must not have to
care about that, and must not have to match a particular Node or Java version to
run it.

Two hazards:

1. **Node version.** The core must run on the Node a user already has.
2. **Java version.** OpenRewrite needs a JDK 17+ toolchain to parse modern Java.
   Most enterprise machines have *a* JDK, often an old one — the machine this was
   developed on has JDK 8. Requiring an upgrade before the tool runs at all is a
   good way to never be run.

## Decision

**One npm package, `stratigraph`.** `npx stratigraph analyze .` is the install
story. Not split into core/cli/mcp packages until someone asks to consume the
core independently — early fragmentation is a tax paid forever.

**Node support: `>=18.18`, tested on 18, 20 and 22 across Linux, macOS and
Windows in CI.** The core uses no API newer than Node 18. Notably it does *not*
use `node:sqlite`, which would restrict us to Node 22.5+.

**The Java extractor ships as a jar fetched on first use, not bundled.** An
OpenRewrite fat jar is tens of megabytes; putting it in the npm tarball would
make every install pay for a language they may not use. Instead — the pattern
`esbuild` and `sharp` use — the jar is downloaded from the GitHub release that
matches the installed package version, verified against a checksum pinned in the
package, and cached under the platform cache dir (`~/.cache/stratigraph/` on
Linux). Version-pinning the jar to the package version means the two can never
drift.

**The JVM is discovered, not assumed** (`src/toolchain/java.ts`): explicit
`java.home` config, then `JAVA_HOME`, then `java` on `PATH`. A missing or too-old
JDK is reported by `stratigraph doctor` with the required version named, and it
disables the Java extractor only — every other extractor and every analysis over
already-extracted facts still runs. It is never a stack trace.

**Docker is the second channel**, published to `ghcr.io`. It sidesteps the
toolchain question entirely and is the form CI pipelines and enterprise teams
adopt. Expected shape:

```
docker run --rm -v "$PWD:/repo" ghcr.io/<owner>/stratigraph analyze /repo
```

**Release automation**: one GitHub Actions workflow on tag — build the jar,
build the TypeScript, publish to npm with `--provenance` (OIDC, no long-lived
token), attach the jar to the GitHub release, build and push the image.

## Alternatives considered

**Bundle the jar in the npm tarball.** Rejected: tens of megabytes on every
install, including for pure-Angular repos.

**GraalVM `native-image` for the extractor**, removing the JVM requirement.
Rejected for now: OpenRewrite is reflection-heavy, so this is a weekend sink for
a benefit nobody has asked for. Revisit if JVM absence turns out to be the main
adoption blocker.

**Vendor a JRE per platform (jlink/jpackage).** Rejected: multiplies release
artefacts by platform for the same benefit as the Docker channel, which we get
almost free.

**Publish the extractor to Maven Central.** Deferred: Sonatype account, GPG
signing and staging repositories are real ceremony, and nothing needs the
extractor as an embeddable library yet. Do it when a JVM user asks.

**`node:sqlite` instead of `better-sqlite3`**, to drop the native dependency.
Rejected: it requires Node 22.5+, which is a harder constraint than a native
module with prebuilt binaries. Worth revisiting when Node 22 is the floor.

## Consequences

- Users on any supported Node get a working install with no compiler, provided
  `better-sqlite3` has a prebuild for their platform. When it does not, npm
  falls back to `node-gyp` and they need build tools — the Docker channel is the
  answer for those users, and `doctor` should say so.
- First run of the Java extractor needs network access to fetch the jar. This
  does not violate the "extraction runs locally with no network access" rule —
  that is about the code under analysis never leaving the machine — but the
  download must be explicit, logged, checksum-verified, and skippable via a
  pre-populated cache or an offline flag for air-gapped users.
- Three release artefacts to keep in step: npm package, jar, image. The tag
  workflow builds all three from one commit or none.
