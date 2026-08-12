import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BrandError,
  contrast,
  mix,
  paletteFrom,
  parseHex,
  resolveBrand,
} from '../src/present/brand.js';

const noBrand = { name: null, logo: null, accent: null };

describe('colour arithmetic', () => {
  it('parses #rrggbb and rejects everything else', () => {
    expect(parseHex('#2a78d6')).toEqual([0x2a, 0x78, 0xd6]);
    for (const bad of ['2a78d6', '#2a78d', '#2a78d6ff', 'blue', '#gg0000']) {
      expect(() => parseHex(bad)).toThrow(BrandError);
    }
  });

  it('computes WCAG contrast symmetrically', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 0);
  });

  it('mixes deterministically', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mix('#2a78d6', '#ffffff', 0)).toBe('#2a78d6');
  });
});

describe('resolveBrand', () => {
  it('passes a legible accent through unchanged, with no notes', () => {
    const brand = resolveBrand({ ...noBrand, accent: '#2a78d6' });
    expect(brand.accent).toEqual({ light: '#2a78d6', dark: '#2a78d6' });
    expect(brand.notes).toEqual([]);
  });

  it('steps an illegible accent until it holds 3:1, and says so', () => {
    // Bright yellow cannot hold 3:1 on the light surface.
    const brand = resolveBrand({ ...noBrand, accent: '#fab219' });
    expect(brand.accent).not.toBeNull();
    const { light, dark } = brand.accent as { light: string; dark: string };
    expect(contrast(light, '#f9f9f7')).toBeGreaterThanOrEqual(3);
    expect(light).not.toBe('#fab219');
    // On the dark surface the same yellow is fine as it is.
    expect(dark).toBe('#fab219');
    expect(brand.notes.some((note) => note.includes('#fab219'))).toBe(true);
  });

  it('is a pure function: same accent, same result', () => {
    const first = resolveBrand({ ...noBrand, accent: '#fab219' });
    const second = resolveBrand({ ...noBrand, accent: '#fab219' });
    expect(first).toEqual(second);
  });

  it('embeds a logo as a data URI', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stratigraph-brand-'));
    const logo = join(dir, 'logo.svg');
    writeFileSync(logo, '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const brand = resolveBrand({ ...noBrand, logo });
    expect(brand.logo).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it('refuses an unreadable logo rather than shipping a report without it', () => {
    expect(() => resolveBrand({ ...noBrand, logo: '/nowhere/logo.png' })).toThrow(
      BrandError,
    );
  });

  it('refuses a logo type it cannot name a mime for', () => {
    expect(() => resolveBrand({ ...noBrand, logo: '/anywhere/logo.pdf' })).toThrow(
      /unsupported type/,
    );
  });
});

describe('paletteFrom', () => {
  it('derives every slot from the accent by fixed ratios', () => {
    const palette = paletteFrom('#7c3aed');
    expect(palette.fill['system']).toBe(mix('#7c3aed', '#ffffff', 0.68));
    expect(palette.stroke['container']).toBe('#7c3aed');
    expect(palette.stereotype).toBe(mix('#7c3aed', '#000000', 0.3));
    // Neutral kinds stay neutral: a datastore is not the customer's colour.
    expect(palette.fill['datastore']).toBe('#f0efec');
  });

  it('is deterministic', () => {
    expect(paletteFrom('#7c3aed')).toEqual(paletteFrom('#7c3aed'));
  });
});
