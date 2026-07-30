import { Component, OnInit } from '@angular/core';

import { Order } from '@app/core/order';
import { OrderService } from '@app/core/order.service';
import { OrderRowComponent } from './order-row.component';

@Component({
  selector: 'app-order-list',
  standalone: true,
  imports: [OrderRowComponent],
  templateUrl: './order-list.component.html',
})
export class OrderListComponent implements OnInit {
  orders: Order[] = [];

  constructor(private readonly service: OrderService) {}

  ngOnInit(): void {
    // Subscribed and never torn down. The leak M5 asks to be reported — as a
    // finding, not as a fact.
    this.service.findOne(1).subscribe((order) => this.orders.push(order));
  }
}
