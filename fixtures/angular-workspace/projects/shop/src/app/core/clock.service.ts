import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class ClockService {
  now(): number {
    return Date.now();
  }
}
