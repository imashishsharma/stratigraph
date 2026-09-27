import { Component, inject } from '@angular/core';

import { ClockService } from '../core/clock.service';
import { StatsComponent } from './widgets/stats.component';

@Component({
  selector: 'shop-admin-page',
  standalone: true,
  imports: [StatsComponent],
  template: '<shop-stats />',
})
export class AdminPageComponent {
  private readonly clock = inject(ClockService);

  openedAt = this.clock.now();
}
