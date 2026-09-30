/**
 * The facts `upgrade` needs from a Maven POM, and the few exact edits the
 * known fixes make to one — ADR-0047.
 *
 * Deliberately not a full POM model: no inheritance resolution, no profiles.
 * What cannot be read here (a version inherited from a corporate parent) is
 * reported as unknown, and the build itself is the authority on the rest.
 * Edits are textual and surgical so a reviewer's diff shows only the change.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PomFacts {
  path: string;
  /** Spring Boot version, resolved through one level of ${property}; null when not declared here. */
  bootVersion: string | null;
  /** Where the Boot version came from, for the plan's citation. */
  bootVersionFrom: string | null;
  /** Declared Java level (java.version, maven.compiler.release/source). */
  javaVersion: string | null;
  packaging: string;
  modules: string[];
  properties: Map<string, string>;
  /** artifactIds of build plugins, anywhere in the POM. */
  plugins: Set<string>;
  /** groupId:artifactId of declared dependencies, anywhere in the POM. */
  dependencies: Set<string>;
}

export function readPom(repoPath: string, file = 'pom.xml'): PomFacts | null {
  const path = join(repoPath, file);
  if (!existsSync(path)) return null;
  return parsePom(readFileSync(path, 'utf8'), file);
}

export function parsePom(xml: string, path = 'pom.xml'): PomFacts {
  const text = stripComments(xml);
  const properties = new Map<string, string>();
  const props = /<properties>([\s\S]*?)<\/properties>/.exec(text)?.[1] ?? '';
  for (const match of props.matchAll(/<([\w.-]+)>([^<]*)<\/\1>/g)) {
    properties.set(match[1] as string, (match[2] as string).trim());
  }
  const resolve = (value: string | null) =>
    value === null ? null : value.replace(/\$\{([\w.-]+)\}/g, (whole, name: string) => properties.get(name) ?? whole);

  let bootVersion: string | null = null;
  let bootVersionFrom: string | null = null;
  const parent = /<parent>([\s\S]*?)<\/parent>/.exec(text)?.[1] ?? '';
  if (/<artifactId>\s*spring-boot-starter-parent\s*<\/artifactId>/.test(parent)) {
    bootVersion = resolve(tag(parent, 'version'));
    bootVersionFrom = 'parent spring-boot-starter-parent';
  }
  if (bootVersion === null) {
    for (const block of blocks(text, 'dependency')) {
      if (tag(block, 'artifactId') === 'spring-boot-dependencies') {
        bootVersion = resolve(tag(block, 'version'));
        bootVersionFrom = 'dependencyManagement import spring-boot-dependencies';
        break;
      }
    }
  }
  if (bootVersion === null && properties.has('spring-boot.version')) {
    bootVersion = properties.get('spring-boot.version') ?? null;
    bootVersionFrom = 'property spring-boot.version';
  }

  const javaVersion =
    properties.get('java.version') ??
    properties.get('maven.compiler.release') ??
    properties.get('maven.compiler.source') ??
    null;

  return {
    path,
    bootVersion: bootVersion !== null && bootVersion.includes('${') ? null : bootVersion,
    bootVersionFrom,
    javaVersion: resolve(javaVersion),
    packaging: tag(text.replace(/<parent>[\s\S]*?<\/parent>/, ''), 'packaging') ?? 'jar',
    modules: [...text.matchAll(/<module>([^<]+)<\/module>/g)].map((m) => (m[1] as string).trim()),
    properties,
    plugins: new Set(blocks(text, 'plugin').map((block) => tag(block, 'artifactId')).filter((id): id is string => id !== null)),
    dependencies: new Set(
      blocks(text, 'dependency')
        .map((block) => `${tag(block, 'groupId') ?? ''}:${tag(block, 'artifactId') ?? ''}`)
        .filter((id) => id !== ':'),
    ),
  };
}

function stripComments(xml: string): string {
  // Keep line count: a POM line number from Maven must still point at the same line.
  return xml.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ' '));
}

function tag(block: string, name: string): string | null {
  const match = new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(block);
  return match ? (match[1] as string) : null;
}

function blocks(text: string, name: string): string[] {
  return [...text.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g'))].map((m) => m[1] as string);
}

/** Major Java version from "1.8", "8", "17", "${java.version}"-resolved text. */
export function javaMajor(version: string | null): number | null {
  if (version === null) return null;
  const match = /^(?:1\.)?(\d+)/.exec(version.trim());
  return match ? Number(match[1]) : null;
}

// ---------------------------------------------------------------------------
// Edits. Each returns the new text, or null when the edit does not apply, so
// a known fix that cannot be made exactly is not made at all.

/** Add `<name>value</name>` to <properties>, or change it if present. */
export function setProperty(xml: string, name: string, value: string): string | null {
  const existing = new RegExp(`(<${escape(name)}>)[^<]*(</${escape(name)}>)`);
  if (existing.test(xml)) return xml.replace(existing, `$1${value}$2`);
  const open = /(\n([ \t]*)<properties>)/.exec(xml);
  if (!open) return null;
  const indent = `${open[2]}${indentUnit(xml)}`;
  return xml.replace(open[1] as string, `${open[1]}\n${indent}<${name}>${value}</${name}>`);
}

/** Remove a property; null when absent. */
export function removeProperty(xml: string, name: string): string | null {
  const line = new RegExp(`\\n[ \\t]*<${escape(name)}>[^<]*</${escape(name)}>[ \\t]*(?=\\n)`);
  return line.test(xml) ? xml.replace(line, '') : null;
}

/**
 * Give the dependency `groupId:artifactId` that has no <version> an explicit
 * one, placed after its <artifactId>. Null when there is no such dependency.
 */
export function addDependencyVersion(xml: string, groupId: string, artifactId: string, version: string): string | null {
  let changed = false;
  const out = xml.replace(/([ \t]*)<dependency>([\s\S]*?)<\/dependency>/g, (whole, indent: string, body: string) => {
    if (changed) return whole;
    if (tag(body, 'groupId') !== groupId || tag(body, 'artifactId') !== artifactId || /<version>/.test(body)) return whole;
    changed = true;
    return whole.replace(
      /(\n([ \t]*)<artifactId>[^<]*<\/artifactId>)/,
      (line, _all, inner: string) => `${line}\n${inner}<version>${version}</version>`,
    );
  });
  return changed ? out : null;
}

/**
 * Add a dependency to the project's own <dependencies> (not
 * dependencyManagement's, not a plugin's). Null when that section is not found
 * or the dependency is already there.
 */
export function addDependency(xml: string, groupId: string, artifactId: string, scope?: string): string | null {
  if (parsePom(xml).dependencies.has(`${groupId}:${artifactId}`)) return null;
  const at = projectDependenciesClose(xml);
  if (at === null) return null;
  const lineStart = xml.lastIndexOf('\n', at) + 1;
  const outer = /^[ \t]*/.exec(xml.slice(lineStart))?.[0] ?? '';
  const unit = indentUnit(xml);
  const inner = `${outer}${unit}`;
  const block =
    `${inner}<dependency>\n${inner}${unit}<groupId>${groupId}</groupId>\n${inner}${unit}<artifactId>${artifactId}</artifactId>\n` +
    (scope ? `${inner}${unit}<scope>${scope}</scope>\n` : '') +
    `${inner}</dependency>\n`;
  return xml.slice(0, lineStart) + block + xml.slice(lineStart);
}

/** Offset of the `</dependencies>` closing the project's own dependency list. */
function projectDependenciesClose(xml: string): number | null {
  const text = stripComments(xml);
  const token = /<(\/?)(dependencies|dependencyManagement|plugin|profile|build)>/g;
  const stack: string[] = [];
  let found: number | null = null;
  for (const match of text.matchAll(token)) {
    const closing = match[1] === '/';
    const name = match[2] as string;
    if (!closing) {
      stack.push(name);
      continue;
    }
    stack.pop();
    // Directly under <project>: nothing else is open once it closes.
    if (name === 'dependencies' && stack.length === 0) found = match.index ?? null;
  }
  return found;
}

/** Replace a dependency's artifactId (e.g. a renamed artifact). */
export function renameArtifact(xml: string, groupId: string, from: string, to: string): string | null {
  let changed = false;
  const out = xml.replace(/<dependency>([\s\S]*?)<\/dependency>/g, (whole, body: string) => {
    if (tag(body, 'groupId') !== groupId || tag(body, 'artifactId') !== from) return whole;
    changed = true;
    return whole.replace(`<artifactId>${from}</artifactId>`, `<artifactId>${to}</artifactId>`);
  });
  return changed ? out : null;
}

function indentUnit(xml: string): string {
  const match = /\n([ \t]+)<modelVersion>/.exec(xml) ?? /\n([ \t]+)</.exec(xml);
  return match?.[1] ?? '    ';
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
