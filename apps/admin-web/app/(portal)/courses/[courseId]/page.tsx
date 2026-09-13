import { getPrismaClient } from '@knowledge-explorer/database';
import { auth } from '../../../../auth';
import { CurriculumTree } from '../../../../components/curriculum-tree';
import { PublishPanel } from '../../../../components/publish-panel';

/**
 * The curriculum tree for one course.
 *
 * isOwner only decides whether the assignment control is rendered. The API
 * refuses an assignedAdminId from an admin regardless — hiding a control is
 * never the enforcement (R-01).
 */
export default async function CoursePage({ params }: { params: Promise<{ courseId: string }> }) {
  const { courseId } = await params;
  const session = await auth();

  const user = session?.user?.email
    ? await getPrismaClient().user.findUnique({
        where: { email: session.user.email },
        select: { userRole: true },
      })
    : null;

  const isOwner = user?.userRole === 'admin_owner';

  return (
    <>
      <CurriculumTree courseId={courseId} isOwner={isOwner} />
      <PublishPanel courseId={courseId} isOwner={isOwner} />
    </>
  );
}
