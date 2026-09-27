import { Component } from '@angular/core';

import { OrderService } from '../order.service';

@Component({
  selector: 'shop-order-list',
  template: '<p>{{ label }}</p>',
})
export class OrderListComponent {
  label: string;

  constructor(private readonly orders: OrderService) {
    this.label = this.orders.total(250);
  }
}
