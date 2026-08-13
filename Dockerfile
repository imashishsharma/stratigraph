# The second distribution channel (ADR-0004): an image that carries its own JDK,
# for the machines where the answer to "which Java do you have" is a meeting.
#
# Two stages, so the 22 MB extractor jar is built from this exact source rather
# than downloaded, and the JDK that built it never ships. The runtime stage
# needs a JRE to *run* the extractor in, not a JDK to build with.

# ---------------------------------------------------------------- build the jar
FROM maven:3.9-eclipse-temurin-17 AS jar
WORKDIR /src
# The pom alone first: dependency resolution is the slow half and it only has to
# happen again when the pom changes, not when a parser does.
COPY extractors/java/pom.xml ./extractors/java/pom.xml
RUN mvn -B -f extractors/java/pom.xml -q dependency:go-offline
COPY extractors/java ./extractors/java
RUN mvn -B -f extractors/java/pom.xml -DskipTests package

# ------------------------------------------------------------- build the core
FROM node:20-bookworm-slim AS core
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY extractors/typescript ./extractors/typescript
RUN npm run build
# Prune to runtime dependencies after building, so the TypeScript compiler and
# vitest do not ride along in the image.
RUN npm prune --omit=dev

# ----------------------------------------------------------------- the runtime
FROM node:20-bookworm-slim

# git, because history mining shells out to it and an image without it would
# silently offer half the tool. eclipse-temurin's JRE comes from the jar stage's
# base rather than apt, so the version is the one the extractor was built for.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=eclipse-temurin:17-jre /opt/java/openjdk /opt/java/openjdk
ENV JAVA_HOME=/opt/java/openjdk
ENV PATH="${JAVA_HOME}/bin:${PATH}"

WORKDIR /opt/stratigraph
COPY --from=core /src/node_modules ./node_modules
COPY --from=core /src/dist ./dist
# LICENSE and NOTICE ride along: the image redistributes the shaded extractor
# jar, and Apache-2.0 section 4(d) wants the attribution with it.
COPY package.json stratigraph.config.example.json LICENSE NOTICE ./

# Baked in rather than fetched: an image that downloads its own extractor on
# first run would defeat the point of shipping one that needs no network.
COPY --from=jar /src/extractors/java/target/stratigraph-java-extractor.jar ./extractors/java/target/
ENV STRATIGRAPH_JAVA_JAR=/opt/stratigraph/extractors/java/target/stratigraph-java-extractor.jar

RUN ln -s /opt/stratigraph/dist/cli.js /usr/local/bin/stratigraph \
  && chmod +x /opt/stratigraph/dist/cli.js

# The repository is mounted, and the fact store is written to the working
# directory — never inside the repository being analysed, same as the CLI.
WORKDIR /work
ENTRYPOINT ["stratigraph"]
CMD ["doctor"]
