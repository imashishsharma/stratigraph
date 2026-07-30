import { CommonModule } from '@angular/common';
import { NgModule } from '@angular/core';

import { OrderListComponent } from './order-list.component';

@NgModule({
  imports: [CommonModule, OrderListComponent],
})
export class OrdersModule {}
