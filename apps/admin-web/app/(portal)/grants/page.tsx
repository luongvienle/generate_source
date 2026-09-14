'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, apiFetch } from '../../../lib/api';
import {
  formatVietnamTime,
  type CreateGrantBody,
  type GrantListView,
  type GrantView,
  type ProductListView,
} from '../../../lib/commerce-types';

/**
 * FR-COM-04 — the owner grants and revokes access by hand.
 *
 * "Active", "expired" and "revoked" come from the server: `isActive` is §7.3's
 * `isGrantActive` and this page never recomputes it, because the grace period is
 * part of the answer and that arithmetic lives in exactly one place.
 *
 * The course and category pickers reuse the products list's bounded options —
 * there is no admin course-list endpoint, and the development database holds
 * thousands of courses.
 *
 * NFR-09: admin screens target 1280 px and wider.
 */
type Status = 'live' | 'revoked' | 'all';

export default function GrantsPage() {
  const [status, setStatus] = useState<Status>('live');
  const [learnerEmail, setLearnerEmail] = useState('');
  const [targetSearch, setTargetSearch] = useState('');
  const [grants, setGrants] = useState<GrantListView | null>(null);
  const [options, setOptions] = useState<ProductListView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  /**
   * Reloads go through this counter, never through a `load` captured earlier.
   *
   * A row's revoke finishes whenever the DELETE does. Had it called the `load`
   * from the render it was created in, a filter changed in the meantime would be
   * re-queried with the OLD filters, and that late response would replace the
   * list under the new ones — the page saying "Revoked" over live grants. Found by
   * the P8a browser scenario, which switches filters right after revoking.
   */
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((key) => key + 1), []);
  /** Only the most recently started request may write the list; older responses are dropped. */
  const latestRequest = useRef(0);

  const load = useCallback(async () => {
    const ticket = ++latestRequest.current;
    setFailure(null);
    try {
      const query = new URLSearchParams({ status, pageSize: '50' });
      if (learnerEmail.trim()) query.set('learnerEmail', learnerEmail.trim());
      const list = await apiFetch<GrantListView>(`/admin/grants?${query.toString()}`);
      if (ticket === latestRequest.current) setGrants(list);
    } catch (error) {
      if (ticket !== latestRequest.current) return;
      setFailure(error instanceof ApiError ? error.message : 'Could not load grants.');
    }
  }, [status, learnerEmail]);

  const loadOptions = useCallback(async () => {
    const query = new URLSearchParams({ pageSize: '1' });
    if (targetSearch.trim()) query.set('targetSearch', targetSearch.trim());
    try {
      setOptions(await apiFetch<ProductListView>(`/admin/products?${query.toString()}`));
    } catch {
      setOptions(null);
    }
  }, [targetSearch]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  useEffect(() => {
    void loadOptions();
  }, [loadOptions]);

  return (
    <section>
      <h1 className="text-xl font-semibold">Grants</h1>
      <p className="mt-1 text-sm text-slate-600">
        Access granted by purchase or by hand. A learner holds at most one live grant per course and
        per category; revoke one before granting that scope again.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          Status
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as Status)}
            data-testid="grants-status"
            className="rounded border border-slate-300 px-2 py-1"
          >
            <option value="live">Live (not revoked)</option>
            <option value="revoked">Revoked</option>
            <option value="all">All</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          Learner email
          <input
            type="search"
            value={learnerEmail}
            onChange={(event) => setLearnerEmail(event.target.value)}
            data-testid="grants-learner-filter"
            className="w-64 rounded border border-slate-300 px-2 py-1"
          />
        </label>
        {grants ? <span className="text-slate-500">{grants.total} grant(s)</span> : null}
      </div>

      {failure ? (
        <p className="mt-4 text-sm text-red-700" role="alert">
          {failure}
        </p>
      ) : null}

      <CreateGrantForm
        options={options}
        targetSearch={targetSearch}
        onTargetSearch={setTargetSearch}
        onSaved={reload}
      />

      {grants && grants.items.length === 0 ? (
        <p className="mt-6 text-slate-600" data-testid="grants-empty">
          No grants in this view.
        </p>
      ) : null}

      <ul className="mt-6 space-y-3" data-testid="grants-list">
        {grants?.items.map((grant) => (
          <GrantRow key={grant.grantId} grant={grant} onRevoked={reload} />
        ))}
      </ul>
    </section>
  );
}

function CreateGrantForm({
  options,
  targetSearch,
  onTargetSearch,
  onSaved,
}: {
  options: ProductListView | null;
  targetSearch: string;
  onTargetSearch: (value: string) => void;
  onSaved: () => void;
}) {
  const [learnerEmail, setLearnerEmail] = useState('');
  const [scopeType, setScopeType] = useState<'course' | 'category'>('course');
  const [targetId, setTargetId] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [perpetual, setPerpetual] = useState(false);
  const [gracePeriodDays, setGracePeriodDays] = useState('0');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setFailure(null);
    const terms = {
      learnerEmail: learnerEmail.trim(),
      expiresOn: perpetual ? null : expiresOn,
      gracePeriodDays: Number(gracePeriodDays),
    };
    const body: CreateGrantBody =
      scopeType === 'course'
        ? { scopeType, courseId: targetId, ...terms }
        : { scopeType, categoryId: targetId, ...terms };

    try {
      await apiFetch<GrantView>('/admin/grants', { method: 'POST', body: JSON.stringify(body) });
      setLearnerEmail('');
      setTargetId('');
      setExpiresOn('');
      setPerpetual(false);
      onSaved();
    } catch (error) {
      setFailure(explain(error));
    } finally {
      setBusy(false);
    }
  };

  const ready = learnerEmail.trim() && targetId && (perpetual || expiresOn);

  return (
    <div className="mt-6 rounded border border-slate-200 p-4" data-testid="grant-create">
      <h2 className="font-medium">Grant access</h2>
      <div className="mt-3 grid grid-cols-3 gap-3 text-sm">
        <label className="block">
          Learner email (an existing learner account)
          <input
            type="email"
            value={learnerEmail}
            onChange={(event) => setLearnerEmail(event.target.value)}
            data-testid="grant-learner-email"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
          />
        </label>
        <fieldset className="block">
          <legend>Scope</legend>
          <div className="mt-2 flex gap-4">
            {(['course', 'category'] as const).map((option) => (
              <label key={option} className="flex items-center gap-1">
                <input
                  type="radio"
                  name="grant-scope"
                  checked={scopeType === option}
                  onChange={() => {
                    setScopeType(option);
                    setTargetId('');
                  }}
                  data-testid={`grant-scope-${option}`}
                />
                {option === 'course' ? 'One course' : 'Whole category'}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="block">
          Find a course or category
          <input
            type="search"
            value={targetSearch}
            onChange={(event) => onTargetSearch(event.target.value)}
            placeholder="The list shows the 50 newest"
            data-testid="grant-target-search"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
          />
        </label>
        <label className="block">
          {scopeType === 'course' ? 'Course' : 'Category'}
          <select
            value={targetId}
            onChange={(event) => setTargetId(event.target.value)}
            data-testid="grant-target"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
          >
            <option value="">Choose…</option>
            {scopeType === 'course'
              ? options?.courseOptions.map((course) => (
                  <option key={course.id} value={course.id}>
                    {course.categoryName} · {course.levelLabel} — {course.title}
                  </option>
                ))
              : options?.categoryOptions.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.displayName}
                  </option>
                ))}
          </select>
        </label>
        <div className="block">
          <label className="block">
            Expiry date (Asia/Ho_Chi_Minh — access ends at 23:59 that day)
            <input
              type="date"
              value={expiresOn}
              onChange={(event) => setExpiresOn(event.target.value)}
              disabled={perpetual}
              data-testid="grant-expires-on"
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1 disabled:opacity-50"
            />
          </label>
          <label className="mt-2 flex items-center gap-2">
            <input
              type="checkbox"
              checked={perpetual}
              onChange={(event) => setPerpetual(event.target.checked)}
              data-testid="grant-perpetual"
            />
            No expiry (perpetual)
          </label>
        </div>
        <label className="block">
          Grace period (days)
          <input
            type="number"
            min={0}
            value={gracePeriodDays}
            onChange={(event) => setGracePeriodDays(event.target.value)}
            data-testid="grant-grace"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
          />
        </label>
      </div>
      <button
        type="button"
        onClick={save}
        disabled={busy || !ready}
        data-testid="grant-create-save"
        className="mt-4 rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
      >
        {busy ? 'Granting…' : 'Grant access'}
      </button>
      {failure ? (
        <p className="mt-3 text-sm text-red-700" data-testid="grant-create-error" role="alert">
          {failure}
        </p>
      ) : null}
    </div>
  );
}

function GrantRow({ grant, onRevoked }: { grant: GrantView; onRevoked: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const state = grant.revokedAt ? 'revoked' : grant.isActive ? 'active' : 'expired';

  const revoke = async () => {
    setBusy(true);
    setFailure(null);
    try {
      await apiFetch(`/admin/grants/${grant.grantId}`, { method: 'DELETE' });
      onRevoked();
    } catch (error) {
      setFailure(explain(error));
      setBusy(false);
    }
  };

  return (
    <li
      className="rounded border border-slate-200 p-4"
      data-testid="grant-row"
      data-grant-id={grant.grantId}
      data-state={state}
    >
      <div className="flex flex-wrap items-baseline gap-3">
        <strong>{grant.learnerEmail}</strong>
        <span className="text-sm text-slate-700">
          {grant.scopeType === 'course' ? 'Course' : 'Category'}: {grant.scopeName}
        </span>
        <StateBadge state={state} />
        <span className="text-sm text-slate-500">
          {grant.accessSource === 'purchase'
            ? `Purchase${grant.sourceProductName ? ` (${grant.sourceProductName})` : ''}`
            : `Granted by ${grant.grantedByEmail ?? 'owner'}`}
        </span>
        <span className="text-sm text-slate-600" data-testid="grant-expiry">
          {grant.expiresAt ? `Expires ${formatVietnamTime(grant.expiresAt)}` : 'No expiry'}
          {grant.gracePeriodDays > 0 ? ` · grace ${grant.gracePeriodDays} days` : ''}
          {grant.renewalCount > 0 ? ` · renewed ${grant.renewalCount}×` : ''}
        </span>
        {grant.revokedAt ? (
          <span className="text-sm text-slate-500">Revoked {formatVietnamTime(grant.revokedAt)}</span>
        ) : (
          <span className="ml-auto flex gap-2">
            {confirming ? (
              <>
                <button
                  type="button"
                  onClick={revoke}
                  disabled={busy}
                  data-testid="grant-revoke-confirm"
                  className="rounded bg-red-700 px-3 py-1 text-sm text-white disabled:opacity-50"
                >
                  {busy ? 'Revoking…' : 'Revoke now'}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="rounded border border-slate-300 px-3 py-1 text-sm"
                >
                  Keep
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                data-testid="grant-revoke"
                className="rounded border border-slate-300 px-3 py-1 text-sm"
              >
                Revoke
              </button>
            )}
          </span>
        )}
      </div>
      {failure ? (
        <p className="mt-3 text-sm text-red-700" role="alert">
          {failure}
        </p>
      ) : null}
    </li>
  );
}

function StateBadge({ state }: { state: 'active' | 'expired' | 'revoked' }) {
  const style =
    state === 'active'
      ? 'bg-emerald-100 text-emerald-900'
      : state === 'expired'
        ? 'bg-amber-100 text-amber-900'
        : 'bg-slate-200 text-slate-700';
  const label = state === 'active' ? 'Active' : state === 'expired' ? 'Expired' : 'Revoked';
  return (
    <span className={`rounded px-2 py-0.5 text-xs ${style}`} data-testid="grant-state">
      {label}
    </span>
  );
}

/** The server's error code decides the message; the form never guesses. */
function explain(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Could not save the grant.';
  const body = error.failure.body ?? {};
  switch (error.failure.errorCode) {
    case 'GRANT_ALREADY_EXISTS': {
      const existing = body['grant'] as
        | { accessSource: string; expiresAt: string | null }
        | undefined;
      const source = existing?.accessSource === 'purchase' ? 'a purchase' : 'an owner grant';
      const expiry = existing?.expiresAt
        ? `expiring ${formatVietnamTime(existing.expiresAt)}`
        : 'with no expiry';
      return `This learner already holds a live grant for that scope (${source}, ${expiry}). Revoke it first.`;
    }
    case 'USER_NOT_FOUND':
      return 'No account has that email. The learner must sign up in the learner app first.';
    case 'GRANT_TARGET_NOT_LEARNER':
      return 'That account is an owner or admin, not a learner.';
    case 'GRANT_EXPIRY_IN_PAST':
      return 'That expiry date has already ended in Vietnam.';
    case 'COURSE_NOT_FOUND':
      return 'That course no longer exists.';
    case 'CATEGORY_NOT_FOUND':
      return 'That category no longer exists.';
    case 'GRANT_NOT_FOUND':
      return 'This grant no longer exists.';
    case 'INVALID_BODY':
      return 'Check the fields: an expiry date or no expiry, and a grace period of zero or more.';
    default:
      return 'Could not save the grant.';
  }
}
