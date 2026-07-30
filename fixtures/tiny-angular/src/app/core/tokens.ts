import { InjectionToken, inject } from '@angular/core';

export const API_BASE = new InjectionToken<string>('API_BASE');

/** Injects a value rather than a class: no injects edge, and a diagnostic. */
export function apiBase(): string {
  return inject(API_BASE);
}
