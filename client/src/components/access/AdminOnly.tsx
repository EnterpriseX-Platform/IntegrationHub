import { Shield } from 'lucide-react';

/** Shown on pages that only admins may use; the server refuses their APIs to other users anyway. */
export function AdminOnlyNotice({ page }: { page: string }) {
  return (
    <div className="p-4 sm:p-6">
      <div className="max-w-md mx-auto mt-16 text-center">
        <Shield className="w-10 h-10 text-gray-300 mx-auto mb-3" />
        <h1 className="text-lg font-semibold text-gray-900">Admins only</h1>
        <p className="mt-1 text-sm text-gray-500">
          {page} is for administrators. Ask an admin if you need access to a project or a table.
        </p>
      </div>
    </div>
  );
}
