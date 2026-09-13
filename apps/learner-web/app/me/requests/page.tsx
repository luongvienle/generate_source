import Link from 'next/link';
import { isSignedIn, serverApiFetch } from '../../../lib/server-api';
import type { MyRequestsView } from '../../../lib/request-types';
import { WithdrawButton } from '../../../components/requests/withdraw-button';

/**
 * The caller's own topic requests.
 *
 * Exists because the board carries no attribution: with no submitter field
 * there, this is the only place a learner can find their own rows, see what the
 * owner decided, and withdraw one that is still pending.
 *
 * Per-learner, so never cached — the same reason /me/courses is force-dynamic.
 */
export const dynamic = 'force-dynamic';

const STATUS_LABEL: Record<string, string> = {
  pending: 'Đang chờ duyệt',
  accepted: 'Đã chấp nhận',
  rejected: 'Đã từ chối',
  duplicated: 'Trùng với đề xuất khác',
};

export default async function MyRequestsPage() {
  if (!(await isSignedIn())) {
    return (
      <main className="wide-main">
        <h1 className="text-2xl font-semibold">Đề xuất của tôi</h1>
        <p className="mt-4 text-neutral-700" data-testid="my-requests-signin">
          <Link href="/signin" className="underline">
            Đăng nhập
          </Link>{' '}
          để xem các đề xuất bạn đã gửi.
        </p>
      </main>
    );
  }

  const mine = await serverApiFetch<MyRequestsView>('/me/topic-requests', { cache: 'no-store' });

  return (
    <main className="wide-main">
      <h1 className="text-2xl font-semibold">Đề xuất của tôi</h1>
      <p className="mt-2 text-neutral-700" data-testid="pending-cap">
        Đang chờ duyệt: {mine.pendingCount} / {mine.pendingCap}
      </p>

      {mine.items.length === 0 ? (
        <p className="mt-6 text-neutral-700" data-testid="my-requests-empty">
          Bạn chưa gửi đề xuất nào.{' '}
          <Link href="/requests" className="underline">
            Xem bảng đề xuất
          </Link>
          .
        </p>
      ) : (
        <ul className="mt-6 space-y-3" data-testid="my-requests-list">
          {mine.items.map((item) => (
            <li
              key={item.id}
              data-testid="my-request-row"
              data-request-id={item.id}
              data-status={item.requestStatus}
              className="flex flex-wrap items-start gap-4 rounded border border-neutral-200 p-4"
            >
              <div className="min-w-0 flex-1">
                <p className="font-medium">{item.requestedTopicTitle}</p>
                {item.requestDescription ? (
                  <p className="mt-1 text-sm text-neutral-700">{item.requestDescription}</p>
                ) : null}
                <p className="mt-1 text-sm">
                  <span className="rounded bg-neutral-100 px-2 py-0.5 text-xs">
                    {STATUS_LABEL[item.requestStatus] ?? item.requestStatus}
                  </span>
                  <span className="ml-2 text-neutral-600">▲ {item.upvoteCount}</span>
                </p>
                {item.reviewerNote ? (
                  <p className="mt-2 text-sm text-neutral-700" data-testid="my-request-note">
                    Ghi chú của quản trị viên: {item.reviewerNote}
                  </p>
                ) : null}
                {item.linkedCourse ? (
                  <p className="mt-2 text-sm">
                    <Link
                      href={`/courses/${item.linkedCourse.slug}`}
                      className="underline"
                      data-testid="my-request-course"
                    >
                      Mở khoá học: {item.linkedCourse.title}
                    </Link>
                  </p>
                ) : null}
              </div>
              {item.canWithdraw ? (
                <div className="shrink-0">
                  <WithdrawButton requestId={item.id} />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
