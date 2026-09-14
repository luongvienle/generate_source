'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, apiFetch } from '../../../lib/api';
import {
  formatVietnamTime,
  formatVnd,
  type AdminOrderListView,
  type OrderStatus,
} from '../../../lib/commerce-types';

/**
 * The owner's read-only view of payment orders (specs/p8a-commerce/spec.md).
 *
 * Nothing here changes an order: settling one is the verified webhook's job alone
 * (FR-COM-03), and a refund happens outside the app, followed by revoking the
 * grant on the Grants page. A failed order may be a declined payment or an
 * amount mismatch; the API log carries which.
 *
 * NFR-09: admin screens target 1280 px and wider.
 */
const STATUS_LABEL: Record<OrderStatus, string> = {
  pending: 'Pending',
  paid: 'Paid',
  failed: 'Failed',
  refunded: 'Refunded',
};

export default function OrdersPage() {
  const [status, setStatus] = useState<OrderStatus | 'all'>('all');
  const [learnerEmail, setLearnerEmail] = useState('');
  const [orders, setOrders] = useState<AdminOrderListView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async () => {
    setFailure(null);
    try {
      const query = new URLSearchParams({ status, pageSize: '50' });
      if (learnerEmail.trim()) query.set('learnerEmail', learnerEmail.trim());
      setOrders(await apiFetch<AdminOrderListView>(`/admin/orders?${query.toString()}`));
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : 'Could not load orders.');
    }
  }, [status, learnerEmail]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section>
      <h1 className="text-xl font-semibold">Orders</h1>
      <p className="mt-1 text-sm text-slate-600">
        Every checkout, newest first. Read-only: only a verified payment webhook settles an order.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          Status
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as OrderStatus | 'all')}
            data-testid="orders-status"
            className="rounded border border-slate-300 px-2 py-1"
          >
            <option value="all">All</option>
            <option value="pending">Pending</option>
            <option value="paid">Paid</option>
            <option value="failed">Failed</option>
            <option value="refunded">Refunded</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          Learner email
          <input
            type="search"
            value={learnerEmail}
            onChange={(event) => setLearnerEmail(event.target.value)}
            data-testid="orders-learner-filter"
            className="w-64 rounded border border-slate-300 px-2 py-1"
          />
        </label>
        {orders ? <span className="text-slate-500">{orders.total} order(s)</span> : null}
      </div>

      {failure ? (
        <p className="mt-4 text-sm text-red-700" role="alert">
          {failure}
        </p>
      ) : null}

      {orders && orders.items.length === 0 ? (
        <p className="mt-6 text-slate-600" data-testid="orders-empty">
          No orders in this view.
        </p>
      ) : null}

      {orders && orders.items.length > 0 ? (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full text-left text-sm" data-testid="orders-table">
            <thead className="border-b border-slate-200 text-slate-500">
              <tr>
                <th className="py-2 pr-4 font-normal">Created</th>
                <th className="py-2 pr-4 font-normal">Learner</th>
                <th className="py-2 pr-4 font-normal">Product</th>
                <th className="py-2 pr-4 font-normal">Amount</th>
                <th className="py-2 pr-4 font-normal">Code</th>
                <th className="py-2 pr-4 font-normal">Status</th>
                <th className="py-2 font-normal">Provider reference</th>
              </tr>
            </thead>
            <tbody>
              {orders.items.map((order) => (
                <tr
                  key={order.orderId}
                  className="border-b border-slate-100 align-top"
                  data-testid="order-row"
                  data-order-id={order.orderId}
                  data-status={order.orderStatus}
                >
                  <td className="py-2 pr-4 whitespace-nowrap">{formatVietnamTime(order.createdAt)}</td>
                  <td className="py-2 pr-4">{order.learnerEmail}</td>
                  <td className="py-2 pr-4">
                    {order.productName}
                    <div className="text-xs text-slate-500">
                      {order.target.courseTitle ?? `${order.target.categoryName} (whole category)`}
                    </div>
                  </td>
                  <td className="py-2 pr-4 whitespace-nowrap" data-testid="order-amount">
                    {formatVnd(order.amount)}
                    {order.amount !== order.listPriceAmount ? (
                      <div className="text-xs text-slate-500 line-through">
                        {formatVnd(order.listPriceAmount)}
                      </div>
                    ) : null}
                  </td>
                  <td className="py-2 pr-4 font-mono">{order.discountCode ?? '—'}</td>
                  <td className="py-2 pr-4">
                    <span
                      className={`rounded px-2 py-0.5 text-xs ${
                        order.orderStatus === 'paid'
                          ? 'bg-emerald-100 text-emerald-900'
                          : order.orderStatus === 'pending'
                            ? 'bg-slate-100 text-slate-700'
                            : 'bg-red-100 text-red-900'
                      }`}
                    >
                      {STATUS_LABEL[order.orderStatus]}
                    </span>
                    {order.completedAt ? (
                      <div className="mt-1 text-xs text-slate-500">
                        {formatVietnamTime(order.completedAt)}
                      </div>
                    ) : null}
                  </td>
                  <td className="py-2 font-mono text-xs text-slate-500">
                    {order.providerName}: {order.providerOrderReference}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
