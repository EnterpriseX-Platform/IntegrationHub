// Shared render shell for the Project → Tag → Item grouped view.
// Used by Tasks / Schedulers / Baskets. Owns the project headers, the
// per-project "+ Tag" input, the tag sub-headers, empty drop-zones, and the
// drag-over wiring. The page passes `renderItem` to draw each row/card and a
// `colorEdge(color)` helper for the project dot.

import { Plus, Tag as TagIcon, X } from 'lucide-react';
import type { ProjectGroup, TagSubGroup } from './useProjectTagGroups';

interface TagGroupViewProps<T extends { id: string }> {
  grouped: ProjectGroup<T>[];
  // tag-add state from the hook
  addingTagFor: string | null;
  setAddingTagFor: (id: string | null) => void;
  newTagName: string;
  setNewTagName: (v: string) => void;
  handleAddTag: (projectId: string) => void;
  handleRemoveTagGroup: (projectId: string, tagName: string) => void;
  // drag state from the hook
  draggedId: string | null;
  setDraggedId: (id: string | null) => void;
  dropTarget: { groupId: string; beforeId?: string } | null;
  setDropTarget: (t: { groupId: string; beforeId?: string } | null) => void;
  handleDrop: (projectId: string, tg: TagSubGroup<T>, beforeId?: string) => void;
  // page-supplied rendering
  colorEdge: (color?: string) => string;   // returns a tailwind bg-* class for the project dot
  itemNoun?: string;                        // 'flow' | 'scheduler' | 'basket'
  renderItem: (item: T, compositeId: string, dragHandlers: ItemDragHandlers) => React.ReactNode;
}

export interface ItemDragHandlers {
  draggable: true;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  isDragging: boolean;
  showDropIndicatorAbove: boolean;
}

export function TagGroupView<T extends { id: string }>(props: TagGroupViewProps<T>) {
  const {
    grouped, addingTagFor, setAddingTagFor, newTagName, setNewTagName,
    handleAddTag, handleRemoveTagGroup, draggedId, setDraggedId, dropTarget, setDropTarget,
    handleDrop, colorEdge, itemNoun = 'item', renderItem,
  } = props;

  const makeDragHandlers = (item: T, compositeId: string): ItemDragHandlers => ({
    draggable: true,
    onDragStart: (e) => {
      setDraggedId(item.id);
      try { e.dataTransfer.setData('text/plain', item.id); e.dataTransfer.effectAllowed = 'move'; } catch {}
    },
    onDragEnd: () => { setDraggedId(null); setDropTarget(null); },
    onDragOver: (e) => {
      if (!draggedId || draggedId === item.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDropTarget({ groupId: compositeId, beforeId: item.id });
    },
    onDrop: (e) => {
      e.preventDefault();
      const [pid, tagId] = compositeId.split('::');
      const proj = grouped.find(p => p.id === pid);
      const tg = proj?.tagGroups.find(g => g.id === tagId);
      if (proj && tg) handleDrop(proj.id, tg, dropTarget?.beforeId);
    },
    isDragging: draggedId === item.id,
    showDropIndicatorAbove: dropTarget?.groupId === compositeId && dropTarget?.beforeId === item.id,
  });

  return (
    <div className="space-y-7">
      {grouped.map(proj => {
        const isAddingHere = addingTagFor === proj.id;
        return (
          <section key={proj.id}>
            {/* Project header */}
            <header className="flex items-center gap-2 mb-2 px-1">
              <span className={`h-2.5 w-2.5 rounded-full ${colorEdge(proj.color)}`} />
              <h2 className="text-[14px] font-semibold text-slate-900 tracking-tight">{proj.name}</h2>
              <span className="text-[10.5px] tabular-nums text-slate-400">
                {proj.itemCount} {itemNoun}{proj.itemCount === 1 ? '' : 's'}
              </span>
              <span className="flex-1 h-px bg-slate-200" />
              {isAddingHere ? (
                <form
                  onSubmit={(e) => { e.preventDefault(); handleAddTag(proj.id); }}
                  className="inline-flex items-center gap-1 rounded-md ring-1 ring-slate-300 bg-white pl-2 pr-1 py-0.5"
                >
                  <TagIcon className="h-3 w-3 text-slate-400" />
                  <input
                    autoFocus
                    value={newTagName}
                    onChange={(e) => setNewTagName(e.target.value)}
                    onBlur={() => handleAddTag(proj.id)}
                    onKeyDown={(e) => { if (e.key === 'Escape') { setAddingTagFor(null); setNewTagName(''); } }}
                    placeholder="new tag name…"
                    className="w-32 text-[11.5px] py-0.5 focus:outline-none placeholder:text-slate-400"
                  />
                </form>
              ) : (
                <button
                  onClick={() => { setAddingTagFor(proj.id); setNewTagName(''); }}
                  className="inline-flex items-center gap-1 rounded-md ring-1 ring-slate-200 bg-white px-2 py-0.5 text-[12px] font-medium text-slate-600 hover:bg-slate-50 transition-colors"
                  title={`Add a tag group under ${proj.name}`}
                >
                  <Plus className="h-3 w-3" /> Tag
                </button>
              )}
            </header>

            {/* Tag sub-groups */}
            <div className="space-y-3 ml-0 pl-2 sm:ml-2 sm:pl-3 border-l-2 border-slate-100">
              {proj.tagGroups.length === 0 ? (
                <div className="text-[11.5px] text-slate-400 italic px-2 py-1">
                  No {itemNoun}s yet — click <span className="font-semibold">+ Tag</span> to create a tag group.
                </div>
              ) : proj.tagGroups.map(tg => {
                const compositeId = `${proj.id}::${tg.id}`;
                const canRemove = tg.userAdded && tg.items.length === 0;
                const isEmpty = tg.items.length === 0;
                const isDropTargetEmpty = dropTarget?.groupId === compositeId && !dropTarget?.beforeId;
                return (
                  <section
                    key={tg.id}
                    onDragOver={(e) => {
                      if (!draggedId) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                      if (!dropTarget || dropTarget.groupId !== compositeId) {
                        setDropTarget({ groupId: compositeId, beforeId: undefined });
                      }
                    }}
                    onDrop={(e) => { e.preventDefault(); handleDrop(proj.id, tg, dropTarget?.beforeId); }}
                  >
                    <header className="flex items-center gap-2 mb-1.5 group/header">
                      <TagIcon className="h-3 w-3 text-slate-400" />
                      <h3 className="text-[12.5px] font-semibold text-slate-700">{tg.name}</h3>
                      <span className="text-[10.5px] tabular-nums text-slate-400">{tg.items.length}</span>
                      {canRemove && (
                        <button
                          onClick={() => handleRemoveTagGroup(proj.id, tg.id)}
                          className="opacity-0 group-hover/header:opacity-100 inline-flex items-center justify-center h-4 w-4 rounded text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-all"
                          title="Remove this empty tag group"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </header>
                    <ul className={`space-y-1.5 min-h-[8px] ${isEmpty ? `rounded-md border-2 border-dashed ${isDropTargetEmpty ? 'border-blue-400 bg-blue-50/40' : 'border-slate-200 bg-slate-50/40'} px-3 py-3 text-center text-[12px] text-slate-400` : ''}`}>
                      {tg.items.length > 0
                        ? tg.items.map(it => renderItem(it, compositeId, makeDragHandlers(it, compositeId)))
                        : <li className="select-none">Drag a {itemNoun} from this project here to add the "{tg.name}" tag</li>}
                    </ul>
                  </section>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
