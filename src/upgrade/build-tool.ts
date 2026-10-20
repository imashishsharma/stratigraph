/**
 * Maven or Gradle: what differs between them for an upgrade — ADR-0047,
 * amended. The loop is the same for both; this is what it asks the build
 * tool: the project's facts, the command that builds and tests, how to run the
 * recipe, and how to read the output.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseBuildLog, type BuildLog } from './build-log.js';
import { git } from './git.js';
import { isGradleProject, parseGradleLog, readGradleFacts, rewriteInitScript } from './gradle.js';
import { VERIFY } from './maven.js';
import { readPom } from './pom.js';
import { REWRITE_GRADLE_PLUGIN_VERSION, REWRITE_PLUGIN_VERSION, REWRITE_SPRING_VERSION, type UpgradeTarget } from './targets.js';

export type BuildToolKind = 'maven' | 'gradle';

export interface ProjectFacts {
  tool: BuildToolKind;
  buildFile: string;
  bootVersion: string | null;
  bootVersionFrom: string | null;
  javaVersion: string | null;
  /** Gradle only: the wrapper's Gradle version. */
  gradleVersion: string | null;
  kotlinDsl: boolean;
  /** Build plugins (Maven artifactIds, Gradle plugin ids), for known fixes. */
  plugins: Set<string>;
}

export interface RecipeRun {
  label: string;
  args: string[];
}

export interface BuildTool {
  kind: BuildToolKind;
  facts: ProjectFacts;
  /** Build and test, carrying on past failing tests. */
  verify: string[];
  parse: (log: string, repoPath: string) => BuildLog;
  /** Arguments that skip the build's formatting check; empty when it has none we know. */
  formatCheckSkip: string[];
  /** How to run the recipe, in the order to try them. */
  recipeRuns: (target: UpgradeTarget, versions: { plugin?: string | undefined; spring?: string | undefined }, logDir: string) => RecipeRun[];
}

export function detectBuildTool(repoPath: string): BuildTool | null {
  const pom = readPom(repoPath);
  if (pom !== null) {
    return {
      kind: 'maven',
      facts: {
        tool: 'maven',
        buildFile: 'pom.xml',
        bootVersion: pom.bootVersion,
        bootVersionFrom: pom.bootVersionFrom,
        javaVersion: pom.javaVersion,
        gradleVersion: null,
        kotlinDsl: false,
        plugins: pom.plugins,
      },
      verify: VERIFY,
      parse: parseBuildLog,
      formatCheckSkip: [
        ...(pom.plugins.has('spotless-maven-plugin') ? ['-Dspotless.check.skip=true'] : []),
        ...(pom.plugins.has('spring-javaformat-maven-plugin') ? ['-Dspring-javaformat.skip=true'] : []),
      ],
      recipeRuns: (target, versions) => {
        const exclusions = gradleWrapperFiles(repoPath);
        const args = (goal: string) => [
          `org.openrewrite.maven:rewrite-maven-plugin:${versions.plugin ?? REWRITE_PLUGIN_VERSION}:${goal}`,
          `-Drewrite.recipeArtifactCoordinates=org.openrewrite.recipe:rewrite-spring:${versions.spring ?? REWRITE_SPRING_VERSION}`,
          `-Drewrite.activeRecipes=${target.recipe}`,
          ...(exclusions ? [`-Drewrite.exclusions=${exclusions}`] : []),
        ];
        // `run` compiles first; on the target JDK the old code may not, and
        // runNoFork parses without that compile.
        return [
          { label: 'recipe', args: args('run') },
          { label: 'recipe-nofork', args: args('runNoFork') },
        ];
      },
    };
  }
  if (isGradleProject(repoPath)) {
    const gradle = readGradleFacts(repoPath);
    if (gradle === null) return null;
    return {
      kind: 'gradle',
      facts: {
        tool: 'gradle',
        buildFile: gradle.buildFile,
        bootVersion: gradle.bootVersion,
        bootVersionFrom: gradle.bootVersionFrom,
        javaVersion: gradle.javaVersion,
        gradleVersion: gradle.gradleVersion,
        kotlinDsl: gradle.kotlinDsl,
        plugins: gradle.plugins,
      },
      verify: ['clean', 'check', '--continue', '--console=plain'],
      parse: parseGradleLog,
      formatCheckSkip: [
        ...(gradle.plugins.has('com.diffplug.spotless') ? ['-x', 'spotlessCheck'] : []),
        ...(gradle.plugins.has('io.spring.javaformat') ? ['-x', 'checkFormat'] : []),
      ],
      recipeRuns: (target, versions, logDir) => {
        // The plugin is applied by an init script, so the build files are not
        // edited to add it (the Maven run invokes it by coordinates for the
        // same reason).
        mkdirSync(logDir, { recursive: true });
        const init = join(logDir, 'rewrite-init.gradle');
        writeFileSync(
          init,
          rewriteInitScript(
            versions.plugin ?? REWRITE_GRADLE_PLUGIN_VERSION,
            `org.openrewrite.recipe:rewrite-spring:${versions.spring ?? REWRITE_SPRING_VERSION}`,
            target.recipe,
            [],
          ),
        );
        return [{ label: 'recipe', args: ['--init-script', init, 'rewriteRun', '--console=plain'] }];
      },
    };
  }
  return null;
}

/** A Maven project that also carries a Gradle wrapper makes the recipe try to download Gradle (gap map). */
function gradleWrapperFiles(repoPath: string): string | null {
  const files = git(repoPath, ['ls-files', 'gradlew', 'gradlew.bat', 'gradle/wrapper']).trim();
  return files === '' ? null : 'gradle/wrapper/**,gradlew,gradlew.bat';
}
