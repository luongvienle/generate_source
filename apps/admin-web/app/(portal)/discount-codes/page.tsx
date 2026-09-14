'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, apiFetch } from '../../../lib/api';
import {
  formatVietnamTime,
  vietnamDateOf,
  type CreateDiscountCodeBody,
  type DiscountCodeListView,
  type DiscountCodeView,
  type ProductListView,
  type UpdateDiscountCodeBody,
} from '../../../lib/commerce-types';

/**
 * Discount codes — a percentage off chosen products (specs/p8a-commerce/spec.md).
 *
 * The code, the percentage and the product list are fixed once created, so a row
 * edits only its window, cap, flags and active state. Limits are enforced at
 * checkout; an order already in flight when a code is deactivated still grants at
 * the price its learner paid.
 *
 * NFR-09: admin screens target 1280 px and wider.
 */
export default function DiscountCodesPage() {
  const [codes, setCodes] = useState<DiscountCodeListView | null>(null);
  const [products, setProducts] = useState<ProductListView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async () => {
    setFailure(null);
    try {
      const [codeList, productList] = await Promise.all([
        apiFetch<DiscountCodeListView>('/admin/discount-codes?pageSize=50'),
        apiFetch<ProductListView>('/admin/products?pageSize=50'),
      ]);
      setCodes(codeList);
      setProducts(productList);
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : 'Could not load discount codes.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section>
      <h1 className="text-xl font-semibold">Discount codes</h1>
      <p className="mt-1 text-sm text-slate-600">
        A percentage off chosen products. Learners enter codes in any case. A redemption is a paid
        order; limits apply at checkout.
      </p>

      {failure ? (
        <p className="mt-4 text-sm text-red-700" role="alert">
          {failure}
        </p>
      ) : null}

      {products ? <CreateCodeForm products={products} onSaved={() => void load()} /> : null}

      {codes && codes.items.length === 0 ? (
        <p className="mt-6 text-slate-600" data-testid="codes-empty">
          No discount codes yet.
        </p>
      ) : null}

      <ul className="mt-6 space-y-3" data-testid="codes-list">
        {codes?.items.map((code) => (
          <CodeRow key={code.codeId} code={code} onSaved={() => void load()} />
        ))}
      </ul>
    </section>
  );
}

function CreateCodeForm({ products, onSaved }: { products: ProductListView; onSaved: () => void }) {
  const [code, setCode] = useState('');
  const [percentOff, setPercentOff] = useState('10');
  const [allProducts, setAllProducts] = useState(false);
  const [productIds, setProductIds] = useState<string[]>([]);
  const [startsOn, setStartsOn] = useState('');
  const [endsOn, setEndsOn] = useState('');
  const [maxRedemptions, setMaxRedemptions] = useState('');
  const [oncePerLearner, setOncePerLearner] = useState(false);
  const [newPurchasesOnly, setNewPurchasesOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const toggleProduct = (productId: string) =>
    setProductIds((current) =>
      current.includes(productId) ? current.filter((id) => id !== productId) : [...current, productId],
    );

  const save = async () => {
    setBusy(true);
    setFailure(null);
    const body: CreateDiscountCodeBody = {
      code: code.trim(),
      percentOff: Number(percentOff),
      ...(allProducts ? { appliesToAllProducts: true } : { productIds }),
      startsOn: startsOn || null,
      endsOn: endsOn || null,
      maxRedemptions: maxRedemptions ? Number(maxRedemptions) : null,
      oncePerLearner,
      newPurchasesOnly,
    };
    try {
      await apiFetch<DiscountCodeView>('/admin/discount-codes', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setCode('');
      setProductIds([]);
      setAllProducts(false);
      onSaved();
    } catch (error) {
      setFailure(explain(error));
    } finally {
      setBusy(false);
    }
  };

  const ready = code.trim().length >= 3 && percentOff && (allProducts || productIds.length > 0);

  return (
    <div className="mt-6 rounded border border-slate-200 p-4" data-testid="code-create">
      <h2 className="font-medium">New code</h2>
      <div className="mt-3 grid grid-cols-4 gap-3 text-sm">
        <label className="block">
          Code (letters, digits, hyphens)
          <input
            value={code}
            onChange={(event) => setCode(event.target.value)}
            maxLength={32}
            data-testid="code-value"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1 uppercase"
          />
        </label>
        <label className="block">
          Percent off (1–100)
          <input
            type="number"
            min={1}
            max={100}
            value={percentOff}
            onChange={(event) => setPercentOff(event.target.value)}
            data-testid="code-percent"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
          />
        </label>
        <label className="block">
          Starts (Asia/Ho_Chi_Minh, optional)
          <input
            type="date"
            value={startsOn}
            onChange={(event) => setStartsOn(event.target.value)}
            data-testid="code-starts"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
          />
        </label>
        <label className="block">
          Ends (Asia/Ho_Chi_Minh, optional)
          <input
            type="date"
            value={endsOn}
            onChange={(event) => setEndsOn(event.target.value)}
            data-testid="code-ends"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
          />
        </label>
        <label className="block">
          Redemption cap (optional)
          <input
            type="number"
            min={1}
            value={maxRedemptions}
            onChange={(event) => setMaxRedemptions(event.target.value)}
            data-testid="code-cap"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
          />
        </label>
        <label className="flex items-end gap-2 pb-1">
          <input
            type="checkbox"
            checked={oncePerLearner}
            onChange={(event) => setOncePerLearner(event.target.checked)}
            data-testid="code-once"
          />
          Once per learner
        </label>
        <label className="flex items-end gap-2 pb-1">
          <input
            type="checkbox"
            checked={newPurchasesOnly}
            onChange={(event) => setNewPurchasesOnly(event.target.checked)}
            data-testid="code-new-only"
          />
          New purchases only
        </label>
      </div>

      <fieldset className="mt-4 text-sm">
        <legend className="font-medium">Applies to</legend>
        <label className="mt-2 flex items-center gap-2">
          <input
            type="checkbox"
            checked={allProducts}
            onChange={(event) => setAllProducts(event.target.checked)}
            data-testid="code-all-products"
          />
          All products
        </label>
        {allProducts ? null : (
          <div className="mt-2 grid max-h-48 grid-cols-2 gap-1 overflow-y-auto rounded border border-slate-200 p-2">
            {products.items.map((product) => (
              <label key={product.productId} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={productIds.includes(product.productId)}
                  onChange={() => toggleProduct(product.productId)}
                  data-testid="code-product"
                  data-product-id={product.productId}
                />
                {product.displayName}
                <span className="text-slate-500">
                  ({product.productType === 'single_course' ? 'course' : 'bundle'})
                </span>
              </label>
            ))}
          </div>
        )}
      </fieldset>

      <button
        type="button"
        onClick={save}
        disabled={busy || !ready}
        data-testid="code-create-save"
        className="mt-4 rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
      >
        {busy ? 'Saving…' : 'Create code'}
      </button>
      {failure ? (
        <p className="mt-3 text-sm text-red-700" data-testid="code-create-error" role="alert">
          {failure}
        </p>
      ) : null}
    </div>
  );
}

function CodeRow({ code, onSaved }: { code: DiscountCodeView; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);

  const window =
    code.startsAt || code.endsAt
      ? `${code.startsAt ? formatVietnamTime(code.startsAt) : 'any time'} → ${
          code.endsAt ? formatVietnamTime(code.endsAt) : 'no end'
        }`
      : 'No window';

  return (
    <li
      className="rounded border border-slate-200 p-4"
      data-testid="code-row"
      data-code={code.code}
      data-active={code.isActive ? 'true' : 'false'}
    >
      <div className="flex flex-wrap items-baseline gap-3">
        <strong className="font-mono">{code.code}</strong>
        <span className="text-sm">{code.percentOff}% off</span>
        {code.isActive ? null : (
          <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900">Inactive</span>
        )}
        <span className="text-sm text-slate-600">
          {code.appliesToAllProducts
            ? 'All products'
            : code.products.map((product) => product.displayName).join(', ')}
        </span>
        <span className="text-sm text-slate-600" data-testid="code-redemptions">
          Used {code.redemptionCount}
          {code.maxRedemptions !== null ? ` / ${code.maxRedemptions}` : ''}
        </span>
        <span className="text-sm text-slate-500">{window}</span>
        {code.oncePerLearner ? <span className="text-xs text-slate-500">once per learner</span> : null}
        {code.newPurchasesOnly ? <span className="text-xs text-slate-500">new purchases only</span> : null}
        <button
          type="button"
          onClick={() => setEditing(!editing)}
          data-testid="code-edit-toggle"
          className="ml-auto rounded border border-slate-300 px-3 py-1 text-sm"
        >
          {editing ? 'Close' : 'Edit'}
        </button>
      </div>
      {editing ? (
        <EditCodeForm
          code={code}
          onSaved={() => {
            setEditing(false);
            onSaved();
          }}
        />
      ) : null}
    </li>
  );
}

function EditCodeForm({ code, onSaved }: { code: DiscountCodeView; onSaved: () => void }) {
  const [startsOn, setStartsOn] = useState(code.startsAt ? vietnamDateOf(code.startsAt) : '');
  const [endsOn, setEndsOn] = useState(code.endsAt ? vietnamDateOf(code.endsAt) : '');
  const [maxRedemptions, setMaxRedemptions] = useState(
    code.maxRedemptions === null ? '' : String(code.maxRedemptions),
  );
  const [oncePerLearner, setOncePerLearner] = useState(code.oncePerLearner);
  const [newPurchasesOnly, setNewPurchasesOnly] = useState(code.newPurchasesOnly);
  const [isActive, setIsActive] = useState(code.isActive);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const save = async () => {
    const body: UpdateDiscountCodeBody = {
      startsOn: startsOn || null,
      endsOn: endsOn || null,
      maxRedemptions: maxRedemptions ? Number(maxRedemptions) : null,
      oncePerLearner,
      newPurchasesOnly,
      isActive,
    };
    setBusy(true);
    setFailure(null);
    try {
      await apiFetch<DiscountCodeView>(`/admin/discount-codes/${code.codeId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      onSaved();
    } catch (error) {
      setFailure(explain(error));
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 border-t border-slate-200 pt-4" data-testid="code-edit">
      <p className="text-sm text-slate-600">
        The code, percentage and products are fixed. To change them, deactivate this code and create
        another.
      </p>
      <div className="mt-3 grid grid-cols-3 gap-3 text-sm">
        <label className="block">
          Starts (Asia/Ho_Chi_Minh)
          <input
            type="date"
            value={startsOn}
            onChange={(event) => setStartsOn(event.target.value)}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
          />
        </label>
        <label className="block">
          Ends (Asia/Ho_Chi_Minh)
          <input
            type="date"
            value={endsOn}
            onChange={(event) => setEndsOn(event.target.value)}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
          />
        </label>
        <label className="block">
          Redemption cap
          <input
            type="number"
            min={1}
            value={maxRedemptions}
            onChange={(event) => setMaxRedemptions(event.target.value)}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
          />
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={oncePerLearner}
            onChange={(event) => setOncePerLearner(event.target.checked)}
          />
          Once per learner
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={newPurchasesOnly}
            onChange={(event) => setNewPurchasesOnly(event.target.checked)}
          />
          New purchases only
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={isActive}
            onChange={(event) => setIsActive(event.target.checked)}
            data-testid="code-edit-active"
          />
          Active
        </label>
      </div>
      <button
        type="button"
        onClick={save}
        disabled={busy}
        data-testid="code-edit-save"
        className="mt-4 rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
      >
        {busy ? 'Saving…' : 'Save'}
      </button>
      {failure ? (
        <p className="mt-3 text-sm text-red-700" role="alert">
          {failure}
        </p>
      ) : null}
    </div>
  );
}

/** The server's error code decides the message; the form never guesses. */
function explain(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Could not save the code.';
  switch (error.failure.errorCode) {
    case 'DISCOUNT_CODE_ALREADY_EXISTS':
      return 'That code already exists (codes are case-insensitive).';
    case 'DISCOUNT_CODE_NOT_FOUND':
      return 'This code no longer exists.';
    case 'PRODUCT_NOT_FOUND':
      return 'One of the chosen products no longer exists.';
    case 'INVALID_BODY':
      return error.failure.reason
        ? `Check the fields: ${error.failure.reason}.`
        : 'Check the fields: 3–32 letters, digits or hyphens, 1–100 percent, and either all products or at least one.';
    default:
      return 'Could not save the code.';
  }
}
