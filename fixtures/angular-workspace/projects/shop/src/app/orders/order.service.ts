import { Injectable } from '@angular/core';

import { FormatService } from '@shop/ui-kit';

export interface Sink {
  write(line: string): void;
}

@Injectable({ providedIn: 'root' })
export class OrderService {
  constructor(private readonly format: FormatService) {}

  total(cents: number): string {
    return this.format.money(cents);
  }

  record(sink: Sink): void {
    sink.write(this.total(100));
  }
}
