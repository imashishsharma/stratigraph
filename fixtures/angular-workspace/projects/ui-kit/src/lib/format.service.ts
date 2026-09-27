import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class FormatService {
  money(cents: number): string {
    return `${(cents / 100).toFixed(2)}`;
  }
}
