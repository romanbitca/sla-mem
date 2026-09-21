import { Link } from 'react-router';
import { AlertIcon } from '../components/icons';
import { SidebarToggle } from '../components/layout/shell';
import { EmptyState } from '../components/ui/EmptyState';

export default function NotFoundPage() {
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4 lg:hidden">
        <SidebarToggle />
      </header>
      <EmptyState
        icon={<AlertIcon size={20} />}
        title="Page not found"
        description="There’s nothing at this address."
        action={
          <Link
            to="/"
            className="focus-ring inline-flex h-8.5 items-center rounded-lg border border-line bg-raised px-3.5 text-sm font-medium text-ink hover:bg-hover"
          >
            Back to the archive
          </Link>
        }
      />
    </section>
  );
}
