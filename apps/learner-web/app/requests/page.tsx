import Link from 'next/link';
import { isSignedIn, serverApiFetch } from '../../lib/server-api';
import type { BoardView } from '../../lib/request-types';
import { SubmitForm } from '../../components/requests/submit-form';
import { VoteButton } from '../../components/requests/vote-button';

/**
 * FR-REQ-01's board.
 *
 * `force-dynamic`, and it must stay that way. Vote counts change constantly and
 * the response varies per viewer — `viewerHasVoted` decides how every control
 * renders — so there is nothing here an ISR window could serve correctly. No
 * revalidation hook attaches to this route, and publishing a course does not
 * revalidate it.
 *
 * Read through `serverApiFetch`, never bare `apiFetch`: a server-side fetch has
 * no ambient cookie jar, and forgetting to forward the session produces a board
 * where nobody has ever voted and every control looks fresh — a bug with no
 * symptom. See the comment in lib/server-api.ts.
 */
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

export default async function RequestsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const page = Number(typeof params['page'] === 'string' ? params['page'] : '1') || 1;
  // The closed section expands on the same route rather than in the client, so
  // it is server-rendered, crawlable, and needs no client state.
  const showClosed = params['closed'] === '1';

  const query = new URLSearchParams({
    page: String(page),
    pageSize: String(PAGE_SIZE),
    includeClosed: showClosed ? 'true' : 'false',
  });
  const board = await serverApiFetch<BoardView>(`/topic-requests?${query.toString()}`, {
    cache: 'no-store',
  });
  const signedIn = await isSignedIn();

  const lastPage = Math.max(1, Math.ceil(board.open.total / board.open.pageSize));

  return (
    <main className="wide-main">
      <h1 className="text-2xl font-semibold">Đề xuất chủ đề</h1>
      <p className="mt-2 text-neutral-700">
        Bạn muốn học chủ đề nào tiếp theo? Gửi đề xuất và bình chọn cho đề xuất của người khác.
      </p>

      {signedIn ? (
        <>
          <p className="mt-4 text-sm">
            <Link href="/me/requests" className="underline">
              Xem đề xuất của tôi
            </Link>
          </p>
          <SubmitForm />
        </>
      ) : (
        <p className="mt-6 rounded border border-neutral-200 p-4 text-neutral-700">
          <Link href="/signin" className="underline">
            Đăng nhập
          </Link>{' '}
          để gửi đề xuất và bình chọn.
        </p>
      )}

      <section className="mt-8">
        <h2 className="text-lg font-semibold" id="open-requests">
          Đang chờ ({board.open.total})
        </h2>

        {board.open.items.length === 0 ? (
          <p className="mt-4 text-neutral-700" data-testid="requests-empty">
            Chưa có đề xuất nào. Hãy là người đầu tiên.
          </p>
        ) : (
          <ul className="mt-4 space-y-3" data-testid="open-requests">
            {board.open.items.map((item) => (
              <li
                key={item.id}
                data-testid="request-row"
                data-request-id={item.id}
                className="flex flex-wrap items-start gap-4 rounded border border-neutral-200 p-4"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-medium" data-testid="request-title-text">
                    {item.requestedTopicTitle}
                  </p>
                  {item.requestDescription ? (
                    <p className="mt-1 text-sm text-neutral-700">{item.requestDescription}</p>
                  ) : null}
                  <p className="mt-1 text-xs text-neutral-500">
                    Gửi ngày {new Date(item.createdAt).toLocaleDateString('vi-VN')}
                  </p>
                </div>
                <VoteButton
                  requestId={item.id}
                  upvoteCount={item.upvoteCount}
                  viewerHasVoted={item.viewerHasVoted}
                  viewerIsRequester={item.viewerIsRequester}
                  signedIn={signedIn}
                />
              </li>
            ))}
          </ul>
        )}

        {lastPage > 1 ? (
          <nav className="mt-6 flex flex-wrap gap-3 text-sm">
            {page > 1 ? (
              <Link href={`/requests?page=${page - 1}`} className="underline">
                Trang trước
              </Link>
            ) : null}
            <span className="text-neutral-600">
              Trang {page} / {lastPage}
            </span>
            {page < lastPage ? (
              <Link href={`/requests?page=${page + 1}`} className="underline">
                Trang sau
              </Link>
            ) : null}
          </nav>
        ) : null}
      </section>

      {board.built.total > 0 ? (
        <section className="mt-10">
          <h2 className="text-lg font-semibold">Đã có khoá học ({board.built.total})</h2>
          <ul className="mt-4 space-y-3" data-testid="built-requests">
            {board.built.items.map((item) => (
              <li
                key={item.id}
                data-testid="built-row"
                data-request-id={item.id}
                className="rounded border border-neutral-200 p-4"
              >
                <p className="font-medium">{item.requestedTopicTitle}</p>
                {item.linkedCourse ? (
                  <p className="mt-1 text-sm">
                    <Link
                      href={`/courses/${item.linkedCourse.slug}`}
                      className="underline"
                      data-testid="built-course-link"
                    >
                      Mở khoá học: {item.linkedCourse.title}
                    </Link>
                  </p>
                ) : (
                  // Accepted, but the course is not published yet — §4.3 keeps a
                  // draft course's slug private, so there is nothing to link to.
                  <p className="mt-1 text-sm text-neutral-600" data-testid="built-no-link">
                    Đang được xây dựng.
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {board.closed.total > 0 ? (
        <section className="mt-10">
          <h2 className="text-lg font-semibold">Đã đóng ({board.closed.total})</h2>
          {showClosed ? (
            <>
              <ul className="mt-4 space-y-3" data-testid="closed-requests">
                {board.closed.items.map((item) => (
                  <li
                    key={item.id}
                    data-testid="closed-row"
                    data-request-id={item.id}
                    data-status={item.requestStatus}
                    className="rounded border border-neutral-200 p-4"
                  >
                    <p className="font-medium text-neutral-700">{item.requestedTopicTitle}</p>
                    <p className="mt-1 text-sm text-neutral-600">
                      {item.requestStatus === 'duplicated'
                        ? 'Trùng với một đề xuất khác'
                        : 'Không được chọn'}
                      {item.reviewerNote ? ` — ${item.reviewerNote}` : ''}
                    </p>
                  </li>
                ))}
              </ul>
              <p className="mt-4 text-sm">
                <Link href="/requests" className="underline" data-testid="closed-collapse">
                  Thu gọn
                </Link>
              </p>
            </>
          ) : (
            <p className="mt-2 text-sm">
              <Link href="/requests?closed=1" className="underline" data-testid="closed-expand">
                Xem các đề xuất đã đóng
              </Link>
            </p>
          )}
        </section>
      ) : null}
    </main>
  );
}
