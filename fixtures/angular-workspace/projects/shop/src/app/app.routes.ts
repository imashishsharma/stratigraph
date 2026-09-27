import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: 'orders',
    loadChildren: () => import('./orders/orders.module').then((m) => m.OrdersModule),
  },
  {
    path: 'admin',
    loadComponent: () => import('./admin/admin-page.component').then((m) => m.AdminPageComponent),
  },
];
