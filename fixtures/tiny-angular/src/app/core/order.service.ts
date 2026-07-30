import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { Order } from './order';

@Injectable({ providedIn: 'root' })
export class OrderService {
  private readonly base = '/api';

  private readonly http = inject(HttpClient);

  /** A literal URL. Matchable against a Spring endpoint, as an inference. */
  findOne(id: number): Observable<Order> {
    return this.http.get<Order>(`/api/orders/${id}`);
  }

  /** A computed URL. No http_calls edge, and a diagnostic saying why. */
  findBy(path: string): Observable<Order[]> {
    return this.http.get<Order[]>(this.base + path);
  }
}
