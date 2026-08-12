/**
 * White-label branding for the report (ADR-0025).
 *
 * Brand is config data validated at load: a malformed colour or an unreadable
 * logo is an error, never a fallback. The logo embeds as a data URI so the
 * page stays self-contained (ADR-0020), and the accent is contrast-checked
 * against the surface it will sit on — corrected deterministically when it
 * fails, with the correction reported rather than silent.
 */

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

export interface BrandConfig {
  name: string | null;
  /** Path to a logo file, already resolved to an absolute path. */
  logo: string | null;
  /** `#rrggbb`. */
  accent: string | null;
}

export interface ResolvedBrand {
  name: string | null;
  /** `data:` URI, ready for an `<img src>`. */
  logo: string | null;
  /** Contrast-checked accents, one per scheme. Null means the default palette. */
  accent: { light: string; dark: string } | null;
  /** Human-readable adjustments made, for the limits panel. Empty when none. */
  notes: string[];
}

export class BrandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrandError';
  }
}

const LOGO_MIME: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

/** Past this the page stops being something you attach to an email. */
const LOGO_WARN_BYTES = 512 * 1024;

/** The surfaces the accent has to hold 3:1 against (ADR-0024's tokens). */
const LIGHT_SURFACE = '#f9f9f7';
const DARK_SURFACE = '#0d0d0d';
const MIN_CONTRAST = 3;

export function resolveBrand(config: BrandConfig): ResolvedBrand {
  const notes: string[] = [];

  let logo: string | null = null;
  if (config.logo !== null) {
    const mime = LOGO_MIME[extname(config.logo).toLowerCase()];
    if (mime === undefined) {
      throw new BrandError(
        `logo ${config.logo}: unsupported type — svg, png, jpeg or webp`,
      );
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(config.logo);
    } catch {
      throw new BrandError(`logo ${config.logo}: cannot be read`);
    }
    if (bytes.length > LOGO_WARN_BYTES) {
      notes.push(
        `The logo is ${Math.round(bytes.length / 1024)} KB and is embedded whole; ` +
          'the page carries it everywhere it goes.',
      );
    }
    logo = `data:${mime};base64,${bytes.toString('base64')}`;
  }

  let accent: ResolvedBrand['accent'] = null;
  if (config.accent !== null) {
    const light = ensureContrast(config.accent, LIGHT_SURFACE, 'darker');
    const dark = ensureContrast(config.accent, DARK_SURFACE, 'lighter');
    if (light !== config.accent) {
      notes.push(
        `The brand accent ${config.accent} cannot hold 3:1 contrast on the light ` +
          `surface and was stepped to ${light} there. The colour, not the meaning, changed.`,
      );
    }
    if (dark !== config.accent) {
      notes.push(
        `The brand accent ${config.accent} cannot hold 3:1 contrast on the dark ` +
          `surface and was stepped to ${dark} there.`,
      );
    }
    accent = { light, dark };
  }

  return { name: config.name, logo, accent, notes };
}

/** `#rrggbb` → [r,g,b] 0..255, or an error naming the value. */
export function parseHex(hex: string): [number, number, number] {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (match === null) {
    throw new BrandError(`not a colour: ${JSON.stringify(hex)} — expected #rrggbb`);
  }
  const value = match[1] as string;
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

function toHex([r, g, b]: [number, number, number]): string {
  const channel = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((channel) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Mix `hex` toward `target` by `ratio` (0 = hex, 1 = target). Pure arithmetic. */
export function mix(hex: string, target: string, ratio: number): string {
  const a = parseHex(hex);
  const b = parseHex(target);
  return toHex([
    a[0] + (b[0] - a[0]) * ratio,
    a[1] + (b[1] - a[1]) * ratio,
    a[2] + (b[2] - a[2]) * ratio,
  ]);
}

/**
 * Step the colour toward black or white in fixed 4% mixes until it holds
 * 3:1 against the surface. Fixed steps make the result a pure function of the
 * input, which is what keeps the report's bytes deterministic (ADR-0020).
 */
function ensureContrast(hex: string, surface: string, direction: 'darker' | 'lighter'): string {
  const target = direction === 'darker' ? '#000000' : '#ffffff';
  let colour = parseHex(hex) && hex;
  for (let step = 0; step < 25 && contrast(colour, surface) < MIN_CONTRAST; step++) {
    colour = mix(colour, target, 0.04 * (step + 1) > 1 ? 1 : 0.04);
  }
  return colour;
}

/** The SVG palette derived from one accent — fixed ratios, same bytes every run. */
export interface DiagramPalette {
  fill: Record<string, string>;
  stroke: Record<string, string>;
  headerFill: Record<string, string>;
  stereotype: string;
}

export function paletteFrom(accentLight: string): DiagramPalette {
  const tint = (ratio: number) => mix(accentLight, '#ffffff', ratio);
  const shade = (ratio: number) => mix(accentLight, '#000000', ratio);
  return {
    fill: {
      system: tint(0.68),
      container: tint(0.8),
      component: '#fcfcfb',
      datastore: '#f0efec',
      external: '#f0efec',
      entity: '#fcfcfb',
      type: '#fcfcfb',
    },
    stroke: {
      system: shade(0.3),
      container: accentLight,
      component: tint(0.5),
      datastore: '#898781',
      external: '#898781',
      entity: '#c3c2b7',
      type: '#c3c2b7',
    },
    headerFill: { entity: tint(0.8), type: '#e9e8e3' },
    stereotype: shade(0.3),
  };
}
