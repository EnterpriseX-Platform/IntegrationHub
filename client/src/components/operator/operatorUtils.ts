// Shared utilities for operator dashboard pages

import type { SidebarFilter, SidebarProject } from './ProjectTreeSidebar';

/**
 * Filter items by sidebar scope.
 * @param items - any items with `projectId` field
 * @param scope - sidebar selected scope id
 * @param projectsById - map of projectId → project (for group/agency lookups)
 * @param activePredicate - optional predicate to identify "active" items (for scope='active')
 */
export function filterByScope<T extends { projectId?: string }>(
  items: T[],
  scope: string,
  projectsById: Map<string, SidebarProject>,
  activePredicate?: (item: T) => boolean,
): T[] {
  if (!scope || scope === 'all') return items;

  if (scope === 'active' && activePredicate) {
    return items.filter(activePredicate);
  }

  if (scope.startsWith('project:')) {
    const id = scope.slice('project:'.length);
    return items.filter(i => i.projectId === id);
  }

  if (scope.startsWith('group:')) {
    const groupName = scope.slice('group:'.length);
    return items.filter(i => {
      const p = projectsById.get(i.projectId || '');
      return p?.projectGroup === groupName;
    });
  }

  if (scope.startsWith('agency:')) {
    // format: agency:<groupName>:<agencyName>
    const rest = scope.slice('agency:'.length);
    const colon = rest.indexOf(':');
    if (colon === -1) return items;
    const groupName = rest.slice(0, colon);
    const agencyName = rest.slice(colon + 1);
    return items.filter(i => {
      const p = projectsById.get(i.projectId || '');
      return p?.projectGroup === groupName && p?.agency === agencyName;
    });
  }

  return items;
}

export function buildProjectsById(projects: SidebarProject[]): Map<string, SidebarProject> {
  return new Map(projects.map(p => [p.id, p]));
}

export interface DefaultFilter {
  filter: SidebarFilter;
}

export const DEFAULT_FILTER: DefaultFilter = {
  filter: { scope: 'all', label: 'All Projects' },
};
