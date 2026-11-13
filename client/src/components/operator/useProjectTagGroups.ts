// Shared hook: group a flat list of items (flows / schedulers / baskets) by
// Project (outer) → Tag (inner), with per-project DB-backed tag catalog,
// inline "+ Tag", and HTML5 drag-drop reorder + retag.
//
// Used by Tasks, Schedulers and Baskets pages so the tag UX is identical.
//
// The caller supplies how to read each item's id / projectId / tags / order,
// and how to PERSIST a change (PUT). The hook owns all grouping + drag state.

import { useState, useEffect, useMemo, useCallback } from 'react';
import { API_URL, apiFetch } from '../../config/api';

export interface TaggableItem {
  id: string;
  projectId?: string;
}

export interface TagSubGroup<T> {
  id: string;            // tag name, or '__untagged__'
  name: string;          // display label
  items: T[];
  userAdded?: boolean;   // declared in ProjectTag catalog (shows delete-X when empty)
}
export interface ProjectGroup<T> {
  id: string;            // projectId or 'unassigned'
  name: string;
  color?: string;
  tagGroups: TagSubGroup<T>[];
  itemCount: number;
}

export interface UseProjectTagGroupsArgs<T extends TaggableItem> {
  items: T[];
  projects: Array<{ id: string; name: string; color?: string }>;
  projectsById: Map<string, { groupPosition?: number; agencyPosition?: number; position?: number }>;
  // accessors
  getProjectId: (item: T) => string | undefined;
  getProjectName: (item: T) => string | undefined;
  getProjectColor: (item: T) => string | undefined;
  getTags: (item: T) => string[];        // parsed tag-name array for the item
  getDisplayOrder: (item: T) => number;  // for stable sort within a tag group
  getName: (item: T) => string;          // for tiebreak sort
  // persistence — called when an item is dropped (retag + reorder). Should PUT.
  // `patch` includes `displayOrder` and optionally `tags` (JSON string).
  persistItem: (itemId: string, patch: { displayOrder: number; tags?: string }) => Promise<Response>;
  // optimistic local mutation: the page applies the computed displayOrder/tags
  // to its own item shape (it knows its own field names).
  applyLocalPatch: (patches: Array<{ id: string; displayOrder: number; tags?: string }>) => void;
  // re-sync from server on failure
  reload: () => void;
  onError?: (msg: string) => void;
}

export function useProjectTagGroups<T extends TaggableItem>(args: UseProjectTagGroupsArgs<T>) {
  const {
    items, projects, projectsById,
    getProjectId, getProjectName, getProjectColor, getTags, getDisplayOrder, getName,
    persistItem, applyLocalPatch, reload, onError,
  } = args;

  // Per-project declared tag catalog (from ProjectTag table)
  const [projectTagsById, setProjectTagsById] = useState<Record<string, Array<{ id: string; name: string }>>>({});
  const [addingTagFor, setAddingTagFor] = useState<string | null>(null);
  const [newTagName, setNewTagName] = useState('');
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ groupId: string; beforeId?: string } | null>(null);

  // Fetch tag catalog whenever project list changes
  useEffect(() => {
    if (projects.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const results = await Promise.all(
          projects.map(p =>
            fetch(`${API_URL}/projects/${p.id}/tags`)
              .then(r => r.json())
              .then(d => ({ projectId: p.id, tags: (d.success && Array.isArray(d.data)) ? d.data : [] }))
              .catch(() => ({ projectId: p.id, tags: [] }))
          )
        );
        if (cancelled) return;
        const map: Record<string, Array<{ id: string; name: string }>> = {};
        for (const { projectId, tags } of results) {
          map[projectId] = (tags as any[]).map(t => ({ id: t.id, name: t.name }));
        }
        setProjectTagsById(map);
      } catch {/* silent */}
    })();
    return () => { cancelled = true; };
  }, [projects]);

  const grouped = useMemo<ProjectGroup<T>[]>(() => {
    const projectMap = new Map<string, ProjectGroup<T>>();

    for (const it of items) {
      const pid = getProjectId(it) || 'unassigned';
      if (!projectMap.has(pid)) {
        projectMap.set(pid, {
          id: pid,
          name: getProjectName(it) || 'Unassigned',
          color: getProjectColor(it),
          tagGroups: [],
          itemCount: 0,
        });
      }
      const proj = projectMap.get(pid)!;
      proj.itemCount += 1;
      const tags = getTags(it);
      const keys = tags.length > 0 ? tags : ['__untagged__'];
      for (const tag of keys) {
        let tg = proj.tagGroups.find(g => g.id === tag);
        if (!tg) {
          tg = { id: tag, name: tag === '__untagged__' ? 'Untagged' : tag, items: [] };
          proj.tagGroups.push(tg);
        }
        tg.items.push(it);
      }
    }

    // Seed declared tags (even when empty)
    for (const pid of Object.keys(projectTagsById)) {
      const declared = projectTagsById[pid] || [];
      if (declared.length === 0) continue;
      let proj = projectMap.get(pid);
      if (!proj) {
        const pObj = projects.find(p => p.id === pid);
        if (!pObj) continue;
        proj = { id: pid, name: pObj.name, color: pObj.color, tagGroups: [], itemCount: 0 };
        projectMap.set(pid, proj);
      }
      for (const tag of declared) {
        const existing = proj.tagGroups.find(g => g.id === tag.name);
        if (existing) existing.userAdded = true;
        else proj.tagGroups.push({ id: tag.name, name: tag.name, items: [], userAdded: true });
      }
    }

    for (const proj of projectMap.values()) {
      proj.tagGroups.sort((a, b) => {
        if (a.id === '__untagged__') return 1;
        if (b.id === '__untagged__') return -1;
        return a.name.localeCompare(b.name, 'th');
      });
      for (const tg of proj.tagGroups) {
        tg.items.sort((a, b) => (getDisplayOrder(a) - getDisplayOrder(b)) || getName(a).localeCompare(getName(b)));
      }
    }

    return Array.from(projectMap.values()).sort((a, b) => {
      const pa: any = projectsById.get(a.id), pb: any = projectsById.get(b.id);
      const ga = pa?.groupPosition ?? 999, gb = pb?.groupPosition ?? 999;
      if (ga !== gb) return ga - gb;
      const aa = pa?.agencyPosition ?? 999, ab = pb?.agencyPosition ?? 999;
      if (aa !== ab) return aa - ab;
      const xa = pa?.position ?? 999, xb = pb?.position ?? 999;
      if (xa !== xb) return xa - xb;
      return a.name.localeCompare(b.name);
    });
  }, [items, projectTagsById, projects, projectsById, getProjectId, getProjectName, getProjectColor, getTags, getDisplayOrder, getName]);

  // Persist tag catalog mutations
  const handleAddTag = useCallback(async (projectId: string) => {
    const trimmed = newTagName.trim();
    setAddingTagFor(null);
    setNewTagName('');
    if (!projectId || !trimmed || trimmed === '__untagged__') return;
    const tempId = `tmp-${projectId}-${trimmed}`;
    setProjectTagsById(prev => {
      const list = prev[projectId] || [];
      if (list.some(t => t.name === trimmed)) return prev;
      return { ...prev, [projectId]: [...list, { id: tempId, name: trimmed }] };
    });
    try {
      const r = await fetch(`${API_URL}/projects/${projectId}/tags`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      const d = await r.json();
      if (!d.success) throw new Error(d.error || 'Failed to add tag');
      setProjectTagsById(prev => ({
        ...prev,
        [projectId]: (prev[projectId] || []).map(t => t.id === tempId ? { id: d.data.id, name: d.data.name } : t),
      }));
    } catch (e: any) {
      setProjectTagsById(prev => ({ ...prev, [projectId]: (prev[projectId] || []).filter(t => t.id !== tempId) }));
      onError?.(`เพิ่ม tag ไม่สำเร็จ: ${e.message}`);
    }
  }, [newTagName, onError]);

  const handleRemoveTagGroup = useCallback(async (projectId: string, tagName: string) => {
    const tag = (projectTagsById[projectId] || []).find(t => t.name === tagName);
    if (!tag || tag.id.startsWith('tmp-')) return;
    const before = projectTagsById[projectId] || [];
    setProjectTagsById(prev => ({ ...prev, [projectId]: (prev[projectId] || []).filter(t => t.id !== tag.id) }));
    try {
      const r = await apiFetch(`${API_URL}/project-tags/${tag.id}`, { method: 'DELETE' });
      const d = await r.json();
      if (!d.success) throw new Error(d.error || 'Failed to delete tag');
    } catch (e: any) {
      setProjectTagsById(prev => ({ ...prev, [projectId]: before }));
      onError?.(`ลบ tag ไม่สำเร็จ: ${e.message}`);
    }
  }, [projectTagsById, onError]);

  // Drag-drop within same project → reorder + retag
  const handleDrop = useCallback(async (
    targetProjectId: string,
    targetTagGroup: TagSubGroup<T>,
    insertBeforeId?: string,
  ) => {
    const draggedItem = items.find(i => i.id === draggedId);
    setDraggedId(null); setDropTarget(null);
    if (!draggedItem) return;

    const sourceProjectId = getProjectId(draggedItem) || 'unassigned';
    if (sourceProjectId !== targetProjectId) {
      onError?.('ลากย้ายข้าม project ไม่ได้ — ย้ายภายใน project เดียวกันเท่านั้น');
      return;
    }
    const proj = grouped.find(p => p.id === targetProjectId);
    if (!proj) return;
    const sourceTagGroup = proj.tagGroups.find(g => g.items.some(it => it.id === draggedItem.id));
    const isCrossTag = sourceTagGroup?.id !== targetTagGroup.id;

    const remaining = targetTagGroup.items.filter(it => it.id !== draggedItem.id);
    const insertAt = insertBeforeId ? remaining.findIndex(it => it.id === insertBeforeId) : remaining.length;
    const idx = insertAt < 0 ? remaining.length : insertAt;
    const reordered = [...remaining.slice(0, idx), draggedItem, ...remaining.slice(idx)];

    const updates: Promise<Response>[] = [];
    const localPatches: Array<{ id: string; displayOrder: number; tags?: string }> = [];
    reordered.forEach((it, i) => {
      const newOrder = (i + 1) * 10;
      let tags: string | undefined;
      if (isCrossTag && it.id === draggedItem.id) {
        const oldTags = getTags(draggedItem);
        const sourceTag = sourceTagGroup?.id;
        const targetTag = targetTagGroup.id;
        const newTags = oldTags.filter(t => !sourceTag || sourceTag === '__untagged__' || t !== sourceTag);
        if (targetTag && targetTag !== '__untagged__' && !newTags.includes(targetTag)) newTags.push(targetTag);
        tags = JSON.stringify(newTags);
      }
      localPatches.push({ id: it.id, displayOrder: newOrder, ...(tags ? { tags } : {}) });
      if (getDisplayOrder(it) !== newOrder || tags !== undefined) {
        updates.push(persistItem(it.id, { displayOrder: newOrder, ...(tags ? { tags } : {}) }));
      }
    });

    // Optimistic local update — the page applies patches to its own item shape
    applyLocalPatch(localPatches);

    try {
      const responses = await Promise.all(updates);
      const failed = responses.filter(r => !r.ok);
      if (failed.length > 0) {
        onError?.(`บันทึก tag ไม่สำเร็จ (HTTP ${failed[0].status})`);
        reload();
      }
    } catch (e: any) {
      onError?.(`network error: ${e?.message || e}`);
      reload();
    }
  }, [items, draggedId, grouped, getProjectId, getTags, getDisplayOrder, persistItem, applyLocalPatch, reload, onError]);

  return {
    grouped,
    // tag CRUD state
    addingTagFor, setAddingTagFor, newTagName, setNewTagName, handleAddTag, handleRemoveTagGroup,
    // drag state
    draggedId, setDraggedId, dropTarget, setDropTarget, handleDrop,
  };
}

// Parse a tags field that may be a JSON string or array.
export function parseTagsField(tags: unknown): string[] {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags.filter(t => typeof t === 'string' && t.trim());
  try {
    const arr = JSON.parse(tags as string);
    return Array.isArray(arr) ? arr.filter((t: any) => typeof t === 'string' && t.trim()) : [];
  } catch { return []; }
}
