import { Component, Input } from '@angular/core';

import { Order } from '../core/order';

@Component({
  selector: 'app-order-row',
  standalone: true,
  template: '<span>{{ order.customerRef }}</span>',
})
export class OrderRowComponent {
  @Input() order!: Order;
}
