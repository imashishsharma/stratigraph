import { Routes } from '@angular/router';

import { OrderListComponent } from './orders/order-list.component';

export const routes: Routes = [
  { path: '', component: OrderListComponent },
  {
    path: 'orders',
    children: [
      { path: '', component: OrderListComponent },
      {
        path: ':id',
        loadComponent: () =>
          import('./orders/order-row.component').then((m) => m.OrderRowComponent),
      },
    ],
  },
];
