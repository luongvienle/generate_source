'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, apiFetch } from '../../../lib/api';
import {
  formatVnd,
  type CreateProductBody,
  type PriceCheckView,
  type ProductListView,
  type ProductSaveView,
  type ProductType,
  type ProductView,
  type ProductWarning,
  type UpdateProductBody,
} from '../../../lib/commerce-types';

/**
 * FR-COM-01 — the owner prices courses and bundles.
 *
 * Save warnings render inline and never block: FR-COM-01 says the bundle
 * price-check "warns, without blocking", and a deactivation that leaves a course
 * unsellable is the owner's call to make. Every rule — whole VND, one active
 * product per target, the fixed fields — is enforced by products.service.ts;
 * this form only avoids building bodies the API will refuse.
 *
 * NFR-09: admin screens target 1280 px and wider.
 */
export default function ProductsPage() {
  const [includeInactive, setIncludeInactive] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [targetSearch, setTargetSearch] = useState('');
  const [list, setList] = useState<ProductListView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<readonly ProductWarning[]>([]);
  /**
   * Reloads after a save go through this counter rather than a `load` captured
   * when the row rendered, and only the latest request may write the list — the
   * same out-of-order guard the Grants page needed, for the same reason: a save
   * that finishes after a filter change must not re-query the old filters.
   */
  const [reloadKey, setReloadKey] = useState(0);
  const latestRequest = useRef(0);

  const load = useCallback(async () => {
    const ticket = ++latestRequest.current;
    setFailure(null);
    try {
      const query = new URLSearchParams({ pageSize: '50', includeInactive: String(includeInactive) });
      if (categoryFilter) query.set('categoryId', categoryFilter);
      if (targetSearch.trim()) query.set('targetSearch', targetSearch.trim());
      const products = await apiFetch<ProductListView>(`/admin/products?${query.toString()}`);
      if (ticket === latestRequest.current) setList(products);
    } catch (error) {
      if (ticket !== latestRequest.current) return;
      setFailure(error instanceof ApiError ? error.message : 'Could not load products.');
    }
  }, [includeInactive, categoryFilter, targetSearch]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const onSaved = useCallback((save: ProductSaveView) => {
    setWarnings(save.warnings);
    setReloadKey((key) => key + 1);
  }, []);

  return (
    <section>
      <h1 className="text-xl font-semibold">Products</h1>
      <p className="mt-1 text-sm text-slate-600">
        A product sells one course or a whole category. At most one is active per course and per
        category. Prices are whole VND.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          Category
          <select
            value={categoryFilter}
            onChange={(event) => setCategoryFilter(event.target.value)}
            data-testid="products-category-filter"
            className="rounded border border-slate-300 px-2 py-1"
          >
            <option value="">All categories</option>
            {list?.categoryOptions.map((category) => (
              <option key={category.id} value={category.id}>
                {category.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(event) => setIncludeInactive(event.target.checked)}
            data-testid="products-include-inactive"
          />
          Show inactive
        </label>
        <label className="flex items-center gap-2">
          Find a course or category
          <input
            type="search"
            value={targetSearch}
            onChange={(event) => setTargetSearch(event.target.value)}
            placeholder="Pickers show the 50 newest"
            data-testid="products-target-search"
            className="w-64 rounded border border-slate-300 px-2 py-1"
          />
        </label>
        {list ? <span className="text-slate-500">{list.total} product(s)</span> : null}
      </div>

      {failure ? (
        <p className="mt-4 text-sm text-red-700" role="alert">
          {failure}
        </p>
      ) : null}

      {list ? <CreateProductForm list={list} onSaved={onSaved} /> : null}

      <WarningList warnings={warnings} onDismiss={() => setWarnings([])} />

      {list && list.items.length === 0 ? (
        <p className="mt-6 text-slate-600" data-testid="products-empty">
          No products in this view.
        </p>
      ) : null}

      <ul className="mt-6 space-y-3" data-testid="products-list">
        {list?.items.map((product) => (
          <ProductRow key={product.productId} product={product} onSaved={onSaved} />
        ))}
      </ul>
    </section>
  );
}

function CreateProductForm({
  list,
  onSaved,
}: {
  list: ProductListView;
  onSaved: (save: ProductSaveView) => void;
}) {
  const [productType, setProductType] = useState<ProductType>('single_course');
  const [targetId, setTargetId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [priceAmount, setPriceAmount] = useState('');
  const [accessDurationDays, setAccessDurationDays] = useState('365');
  const [gracePeriodDays, setGracePeriodDays] = useState('0');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setFailure(null);
    const terms = {
      displayName: displayName.trim(),
      priceAmount: priceAmount.trim(),
      accessDurationDays: Number(accessDurationDays),
      gracePeriodDays: Number(gracePeriodDays),
    };
    const body: CreateProductBody =
      productType === 'single_course'
        ? { productType, courseId: targetId, ...terms }
        : { productType, categoryId: targetId, ...terms };

    try {
      const saved = await apiFetch<ProductSaveView>('/admin/products', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setDisplayName('');
      setPriceAmount('');
      setTargetId('');
      onSaved(saved);
    } catch (error) {
      setFailure(explain(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-6 rounded border border-slate-200 p-4" data-testid="product-create">
      <h2 className="font-medium">New product</h2>
      <div className="mt-3 flex flex-wrap gap-4 text-sm">
        {(['single_course', 'category_bundle'] as const).map((option) => (
          <label key={option} className="flex items-center gap-1">
            <input
              type="radio"
              name="product-type"
              checked={productType === option}
              onChange={() => {
                setProductType(option);
                setTargetId('');
              }}
              data-testid={`product-type-${option}`}
            />
            {option === 'single_course' ? 'Single course' : 'Category bundle'}
          </label>
        ))}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
        <label className="block">
          {productType === 'single_course' ? 'Course' : 'Category'}
          <select
            value={targetId}
            onChange={(event) => setTargetId(event.target.value)}
            data-testid="product-target"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
          >
            <option value="">Choose…</option>
            {productType === 'single_course'
              ? list.courseOptions.map((course) => (
                  <option key={course.id} value={course.id}>
                    {course.categoryName} · {course.levelLabel} — {course.title}
                    {course.publicationStatus === 'published' ? '' : ' (not published)'}
                  </option>
                ))
              : list.categoryOptions.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.displayName}
                  </option>
                ))}
          </select>
        </label>
        <label className="block">
          Display name
          <input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            maxLength={120}
            data-testid="product-display-name"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
          />
        </label>
        <label className="block">
          Price (whole VND)
          <input
            value={priceAmount}
            onChange={(event) => setPriceAmount(event.target.value)}
            inputMode="numeric"
            pattern="\d{1,10}"
            data-testid="product-price"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
          />
        </label>
        <label className="block">
          Access duration (days)
          <input
            type="number"
            min={1}
            value={accessDurationDays}
            onChange={(event) => setAccessDurationDays(event.target.value)}
            data-testid="product-duration"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
          />
        </label>
        <label className="block">
          Grace period (days)
          <input
            type="number"
            min={0}
            value={gracePeriodDays}
            onChange={(event) => setGracePeriodDays(event.target.value)}
            data-testid="product-grace"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
          />
        </label>
      </div>

      <button
        type="button"
        onClick={save}
        disabled={busy || !targetId || !displayName.trim() || !priceAmount.trim()}
        data-testid="product-create-save"
        className="mt-4 rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
      >
        {busy ? 'Saving…' : 'Create product'}
      </button>
      {failure ? (
        <p className="mt-3 text-sm text-red-700" data-testid="product-create-error" role="alert">
          {failure}
        </p>
      ) : null}
    </div>
  );
}

function ProductRow({
  product,
  onSaved,
}: {
  product: ProductView;
  onSaved: (save: ProductSaveView) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [priceCheck, setPriceCheck] = useState<PriceCheckView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const target =
    product.target.scopeType === 'course'
      ? `${product.target.categoryName} · ${product.target.courseTitle ?? ''}`
      : `${product.target.categoryName} (whole category)`;

  const togglePriceCheck = async () => {
    if (priceCheck) {
      setPriceCheck(null);
      return;
    }
    setFailure(null);
    try {
      setPriceCheck(
        await apiFetch<PriceCheckView>(`/admin/products/${product.productId}/price-check`),
      );
    } catch (error) {
      setFailure(explain(error));
    }
  };

  return (
    <li
      className="rounded border border-slate-200 p-4"
      data-testid="product-row"
      data-product-id={product.productId}
      data-active={product.isActive ? 'true' : 'false'}
    >
      <div className="flex flex-wrap items-baseline gap-3">
        <strong>{product.displayName}</strong>
        <span className="rounded bg-slate-100 px-2 py-0.5 text-xs">
          {product.productType === 'single_course' ? 'Single course' : 'Bundle'}
        </span>
        {product.isActive ? null : (
          <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900">Inactive</span>
        )}
        <span className="text-sm text-slate-600">{target}</span>
        <span className="text-sm" data-testid="product-row-price">
          {formatVnd(product.priceAmount)}
        </span>
        <span className="text-sm text-slate-500">
          {product.accessDurationDays} days · grace {product.gracePeriodDays}
        </span>
        <span className="ml-auto flex gap-2">
          {product.productType === 'category_bundle' ? (
            <button
              type="button"
              onClick={togglePriceCheck}
              data-testid="product-price-check-toggle"
              className="rounded border border-slate-300 px-3 py-1 text-sm"
            >
              {priceCheck ? 'Hide price check' : 'Price check'}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setEditing(!editing)}
            data-testid="product-edit-toggle"
            className="rounded border border-slate-300 px-3 py-1 text-sm"
          >
            {editing ? 'Close' : 'Edit'}
          </button>
        </span>
      </div>

      {priceCheck ? <PriceCheckPanel check={priceCheck} /> : null}

      {editing ? (
        <EditProductForm
          product={product}
          onSaved={(save) => {
            setEditing(false);
            setPriceCheck(null);
            onSaved(save);
          }}
        />
      ) : null}

      {failure ? (
        <p className="mt-3 text-sm text-red-700" role="alert">
          {failure}
        </p>
      ) : null}
    </li>
  );
}

function EditProductForm({
  product,
  onSaved,
}: {
  product: ProductView;
  onSaved: (save: ProductSaveView) => void;
}) {
  const [priceAmount, setPriceAmount] = useState(product.priceAmount);
  const [accessDurationDays, setAccessDurationDays] = useState(String(product.accessDurationDays));
  const [gracePeriodDays, setGracePeriodDays] = useState(String(product.gracePeriodDays));
  const [isActive, setIsActive] = useState(product.isActive);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const save = async () => {
    // Only what changed: the PATCH refuses an empty body, and sending unchanged
    // fields would make every save look like a price edit.
    const body: UpdateProductBody = {};
    if (priceAmount.trim() !== product.priceAmount) body.priceAmount = priceAmount.trim();
    if (Number(accessDurationDays) !== product.accessDurationDays) {
      body.accessDurationDays = Number(accessDurationDays);
    }
    if (Number(gracePeriodDays) !== product.gracePeriodDays) {
      body.gracePeriodDays = Number(gracePeriodDays);
    }
    if (isActive !== product.isActive) body.isActive = isActive;
    if (Object.keys(body).length === 0) {
      setFailure('Nothing changed.');
      return;
    }

    setBusy(true);
    setFailure(null);
    try {
      onSaved(
        await apiFetch<ProductSaveView>(`/admin/products/${product.productId}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        }),
      );
    } catch (error) {
      setFailure(explain(error));
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 border-t border-slate-200 pt-4" data-testid="product-edit">
      <p className="text-sm text-slate-600">
        Type, target and display name are fixed. To change them, deactivate this product and create
        another. Changes apply to later checkouts; existing grants keep their terms.
      </p>
      <div className="mt-3 grid grid-cols-4 gap-3 text-sm">
        <label className="block">
          Price (whole VND)
          <input
            value={priceAmount}
            onChange={(event) => setPriceAmount(event.target.value)}
            inputMode="numeric"
            data-testid="product-edit-price"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
          />
        </label>
        <label className="block">
          Duration (days)
          <input
            type="number"
            min={1}
            value={accessDurationDays}
            onChange={(event) => setAccessDurationDays(event.target.value)}
            data-testid="product-edit-duration"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
          />
        </label>
        <label className="block">
          Grace (days)
          <input
            type="number"
            min={0}
            value={gracePeriodDays}
            onChange={(event) => setGracePeriodDays(event.target.value)}
            data-testid="product-edit-grace"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
          />
        </label>
        <label className="flex items-end gap-2 pb-1">
          <input
            type="checkbox"
            checked={isActive}
            onChange={(event) => setIsActive(event.target.checked)}
            data-testid="product-edit-active"
          />
          Active
        </label>
      </div>
      <button
        type="button"
        onClick={save}
        disabled={busy}
        data-testid="product-edit-save"
        className="mt-4 rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
      >
        {busy ? 'Saving…' : 'Save'}
      </button>
      {failure ? (
        <p className="mt-3 text-sm text-red-700" data-testid="product-edit-error" role="alert">
          {failure}
        </p>
      ) : null}
    </div>
  );
}

function PriceCheckPanel({ check }: { check: PriceCheckView }) {
  return (
    <div className="mt-3 rounded bg-slate-50 p-3 text-sm" data-testid="price-check-panel">
      <p>
        Bundle {formatVnd(check.bundlePriceAmount)} against single prices totalling{' '}
        <span data-testid="price-check-sum">{formatVnd(check.sumOfSinglePriceAmounts)}</span>
        {check.isBelowSum ? ' — below the sum.' : ' — not below the sum.'}
      </p>
      {check.includedCourses.length > 0 ? (
        <ul className="mt-2 list-disc pl-5">
          {check.includedCourses.map((course) => (
            <li key={course.courseId}>
              {course.title}: {formatVnd(course.priceAmount)}
            </li>
          ))}
        </ul>
      ) : null}
      {check.coursesWithoutSingleProduct.length > 0 ? (
        <p className="mt-2 text-slate-600">
          Published courses with no single price, left out of the sum:{' '}
          {check.coursesWithoutSingleProduct.map((course) => course.title).join(', ')}
        </p>
      ) : null}
    </div>
  );
}

function WarningList({
  warnings,
  onDismiss,
}: {
  warnings: readonly ProductWarning[];
  onDismiss: () => void;
}) {
  if (warnings.length === 0) return null;
  return (
    <div
      className="mt-4 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
      role="status"
      data-testid="product-warnings"
    >
      <p className="font-medium">Saved, with warnings:</p>
      <ul className="mt-2 list-disc pl-5">
        {warnings.map((warning) =>
          warning.code === 'BUNDLE_PRICE_NOT_BELOW_SUM' ? (
            <li key={warning.code} data-testid="product-warning" data-code={warning.code}>
              The bundle price {formatVnd(warning.priceCheck.bundlePriceAmount)} is not below the sum
              of its courses&apos; single prices ({formatVnd(warning.priceCheck.sumOfSinglePriceAmounts)}).
            </li>
          ) : (
            <li key={warning.code} data-testid="product-warning" data-code={warning.code}>
              No longer for sale:{' '}
              {warning.courses.map((course) => course.title).join(', ')}. No active product covers
              these published paid courses.
            </li>
          ),
        )}
      </ul>
      <button type="button" onClick={onDismiss} className="mt-2 underline">
        Dismiss
      </button>
    </div>
  );
}

/** The server's error code decides the message; the form never guesses. */
function explain(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Could not save the product.';
  switch (error.failure.errorCode) {
    case 'PRODUCT_ALREADY_ACTIVE':
      return 'Another product is already active for this course or category. Deactivate it first.';
    case 'COURSE_NOT_FOUND':
      return 'That course no longer exists.';
    case 'CATEGORY_NOT_FOUND':
      return 'That category no longer exists.';
    case 'PRODUCT_NOT_FOUND':
      return 'This product no longer exists.';
    case 'PRICE_CHECK_NOT_BUNDLE':
      return 'Only a bundle has a price check.';
    case 'INVALID_BODY':
      return 'Check the fields: the price is whole VND digits, the duration at least one day.';
    default:
      return 'Could not save the product.';
  }
}
