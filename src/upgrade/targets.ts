/**
 * The upgrade paths `stratigraph upgrade` knows, and the recipe versions it
 * pins — ADR-0047. Pinned so a run is reproducible; overridable because
 * rewrite-spring moves faster than stratigraph releases.
 */

export interface UpgradeTarget {
  /** As given on the command line. */
  id: string;
  /** The Boot line the recipe lands on. */
  boot: string;
  recipe: string;
  /** The lowest Java the target Boot line runs on. */
  minJava: number;
}

export const TARGETS: Record<string, UpgradeTarget> = {
  '3.5': {
    id: '3.5',
    boot: '3.5',
    recipe: 'org.openrewrite.java.spring.boot3.UpgradeSpringBoot_3_5',
    minJava: 17,
  },
  '4.0': {
    id: '4.0',
    boot: '4.0',
    recipe: 'org.openrewrite.java.spring.boot4.UpgradeSpringBoot_4_0',
    minJava: 17,
  },
};

/** The versions the gap map ran (bench/upgrade-gap, 2026-09-29). */
export const REWRITE_PLUGIN_VERSION = '6.46.1';
export const REWRITE_SPRING_VERSION = '6.37.1';

/** True when `version` is older than the target line (so there is an upgrade to do). */
export function needsUpgrade(version: string, target: UpgradeTarget): boolean {
  const [major, minor] = version.split('.').map((part) => Number.parseInt(part, 10));
  const [tMajor, tMinor] = target.boot.split('.').map((part) => Number.parseInt(part, 10));
  if (major === undefined || Number.isNaN(major)) return true;
  if (major !== tMajor) return major < (tMajor as number);
  return (minor ?? 0) < (tMinor ?? 0);
}
