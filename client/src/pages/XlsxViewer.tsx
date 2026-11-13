import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { API_URL, withAuthToken } from '../config/api';

interface SheetMeta {
  name: string;
  rowCount: number;
  colCount: number;
}

type SortDir = 'asc' | 'desc' | null;

const PAGE_SIZE = 1000;
const ROW_HEIGHT = 24; // px per row
const BUFFER_ROWS = 30; // rows to render above/below viewport

export default function XlsxViewer() {
  const [searchParams] = useSearchParams();
  const basketId = searchParams.get('basketId');
  const fileId = searchParams.get('fileId');

  const [fileName, setFileName] = useState('');
  const [sheetNames, setSheetNames] = useState<SheetMeta[]>([]);
  const [activeSheet, setActiveSheet] = useState(0);
  const [headers, setHeaders] = useState<string[]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [filteredCount, setFilteredCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [tooLarge, setTooLarge] = useState<{ fileName: string; fileSize: number } | null>(null);

  // All loaded rows (accumulated pages)
  const [allRows, setAllRows] = useState<string[][]>([]);
  const [hasMore, setHasMore] = useState(false);
  const loadedOffset = useRef(0);

  // Virtual scroll state
  const [scrollTop, setScrollTop] = useState(0);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Cell selection
  const [selectedCell, setSelectedCell] = useState<{ row: number; col: number } | null>(null);
  const [cellAddress, setCellAddress] = useState('');
  const [cellValue, setCellValue] = useState('');
  const [colWidths, setColWidths] = useState<Record<number, number>>({});

  // Sort & Filter state
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>(null);
  const [filters, setFilters] = useState<Record<number, Set<string>>>({});
  const [filterDropdown, setFilterDropdown] = useState<number | null>(null);
  const [filterSearch, setFilterSearch] = useState('');
  const filterRef = useRef<HTMLDivElement>(null);
  const [filterUniqueValues, setFilterUniqueValues] = useState<string[]>([]);

  // Column resize
  const resizingCol = useRef<number | null>(null);
  const resizeStartX = useRef(0);
  const resizeStartW = useRef(0);

  // Track if server-side sort/filter is active
  const isServerMode = useRef(false);

  useEffect(() => {
    if (!basketId || !fileId) {
      setError('Missing basketId or fileId');
      setLoading(false);
      return;
    }
    fetchInitialData(0);
  }, [basketId, fileId]);

  // Reset on sheet switch
  useEffect(() => {
    if (!loading && sheetNames.length > 0) {
      resetAndFetch();
    }
  }, [activeSheet]);

  // Close filter dropdown on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setFilterDropdown(null);
        setFilterSearch('');
      }
    };
    if (filterDropdown !== null) {
      document.addEventListener('mousedown', handleClick);
      return () => document.removeEventListener('mousedown', handleClick);
    }
  }, [filterDropdown]);

  const buildQueryParams = (offset: number, extraSortCol?: number | null, extraSortDir?: SortDir) => {
    const params = new URLSearchParams();
    params.set('sheet', String(activeSheet));
    params.set('offset', String(offset));
    params.set('limit', String(PAGE_SIZE));

    const sc = extraSortCol !== undefined ? extraSortCol : sortCol;
    const sd = extraSortDir !== undefined ? extraSortDir : sortDir;
    if (sc !== null && sd) {
      params.set('sortCol', String(sc));
      params.set('sortDir', sd);
      isServerMode.current = true;
    }

    const filterEntries = Object.entries(filters);
    if (filterEntries.length > 0) {
      // Send first filter only (server supports one at a time, client handles rest)
      const [col, vals] = filterEntries[0];
      params.set('filterCol', col);
      params.set('filterValues', Array.from(vals).join('\x1f'));
      isServerMode.current = true;
    }

    return params.toString();
  };

  const fetchInitialData = async (sheet: number) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('sheet', String(sheet));
      params.set('offset', '0');
      params.set('limit', String(PAGE_SIZE));

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120000); // 2 min timeout for large files
      const res = await fetch(`${API_URL}/baskets/${basketId}/files/${fileId}/xlsx-data?${params}`, { signal: controller.signal });
      clearTimeout(timeout);
      const json = await res.json();
      if (json.success && json.data.tooLarge) {
        setTooLarge({ fileName: json.data.fileName, fileSize: json.data.fileSize });
        setLoading(false);
        document.title = json.data.fileName;
        return;
      }
      if (json.success && json.data.sheet) {
        const d = json.data;
        setFileName(d.fileName);
        setSheetNames(d.sheetNames);
        setHeaders(d.sheet.headers);
        setAllRows(d.sheet.rows);
        setTotalRows(d.sheet.rowCount);
        setFilteredCount(d.sheet.filteredCount ?? d.sheet.rowCount);
        setHasMore(d.sheet.hasMore);
        loadedOffset.current = d.sheet.rows.length;
        document.title = d.fileName;
      } else if (json.success && json.data.sheets) {
        // Backward compat: old endpoint returned all sheets
        const d = json.data;
        setFileName(d.fileName);
        const metas = d.sheets.map((s: any) => ({ name: s.name, rowCount: s.rowCount, colCount: s.colCount }));
        setSheetNames(metas);
        const s = d.sheets[sheet] || d.sheets[0];
        setHeaders(s.headers);
        setAllRows(s.rows);
        setTotalRows(s.rowCount);
        setFilteredCount(s.rowCount);
        setHasMore(false);
        loadedOffset.current = s.rows.length;
        document.title = d.fileName;
      } else {
        setError(json.error || 'Failed to load file');
      }
    } catch (e) {
      setError('Failed to fetch file data');
    } finally {
      setLoading(false);
    }
  };

  const fetchMoreRows = async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const qs = buildQueryParams(loadedOffset.current);
      const res = await fetch(`${API_URL}/baskets/${basketId}/files/${fileId}/xlsx-data?${qs}`);
      const json = await res.json();
      if (json.success && json.data.sheet) {
        const d = json.data.sheet;
        setAllRows(prev => [...prev, ...d.rows]);
        setHasMore(d.hasMore);
        setFilteredCount(d.filteredCount ?? d.rowCount);
        loadedOffset.current += d.rows.length;
      }
    } catch (e) {
      console.error('Error fetching more rows:', e);
    } finally {
      setLoadingMore(false);
    }
  };

  const resetAndFetch = () => {
    setAllRows([]);
    setHeaders([]);
    setHasMore(false);
    loadedOffset.current = 0;
    setSortCol(null);
    setSortDir(null);
    setFilters({});
    setFilterDropdown(null);
    setColWidths({});
    setSelectedCell(null);
    setCellAddress('');
    setCellValue('');
    setScrollTop(0);
    isServerMode.current = false;
    fetchInitialData(activeSheet);
  };

  const refetchWithSortFilter = async (newSortCol: number | null, newSortDir: SortDir, newFilters?: Record<number, Set<string>>) => {
    setLoading(true);
    setAllRows([]);
    loadedOffset.current = 0;
    isServerMode.current = true;

    const params = new URLSearchParams();
    params.set('sheet', String(activeSheet));
    params.set('offset', '0');
    params.set('limit', String(PAGE_SIZE));

    if (newSortCol !== null && newSortDir) {
      params.set('sortCol', String(newSortCol));
      params.set('sortDir', newSortDir);
    }

    const activeFilters = newFilters ?? filters;
    const filterEntries = Object.entries(activeFilters);
    if (filterEntries.length > 0) {
      const [col, vals] = filterEntries[0];
      params.set('filterCol', col);
      params.set('filterValues', Array.from(vals).join('\x1f'));
    }

    try {
      const res = await fetch(`${API_URL}/baskets/${basketId}/files/${fileId}/xlsx-data?${params}`);
      const json = await res.json();
      if (json.success && json.data.sheet) {
        const d = json.data.sheet;
        setHeaders(d.headers);
        setAllRows(d.rows);
        setTotalRows(d.rowCount);
        setFilteredCount(d.filteredCount ?? d.rowCount);
        setHasMore(d.hasMore);
        loadedOffset.current = d.rows.length;
      }
    } catch (e) {
      console.error('Error refetching:', e);
    } finally {
      setLoading(false);
      if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
    }
  };

  // Scroll handler — load more + update virtual scroll position
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);

    // Load more when near bottom
    if (hasMore && !loadingMore) {
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (distFromBottom < 500) {
        fetchMoreRows();
      }
    }
  }, [hasMore, loadingMore]);

  // Virtual scroll computation
  const virtualData = useMemo(() => {
    const containerHeight = scrollContainerRef.current?.clientHeight || 600;
    const headerHeight = 56; // 2 header rows ~28px each
    const visibleRows = Math.ceil((containerHeight - headerHeight) / ROW_HEIGHT);
    const startRow = Math.max(0, Math.floor((scrollTop - headerHeight) / ROW_HEIGHT) - BUFFER_ROWS);
    const endRow = Math.min(allRows.length, startRow + visibleRows + BUFFER_ROWS * 2);
    const totalHeight = allRows.length * ROW_HEIGHT + headerHeight;

    return { startRow, endRow, totalHeight, visibleRows };
  }, [scrollTop, allRows.length]);

  const getColLetter = (index: number): string => {
    let result = '';
    let n = index;
    while (n >= 0) {
      result = String.fromCharCode(65 + (n % 26)) + result;
      n = Math.floor(n / 26) - 1;
    }
    return result;
  };

  const handleCellClick = (ri: number, ci: number) => {
    setSelectedCell({ row: ri, col: ci });
    setCellAddress(`${getColLetter(ci)}${ri + 1}`);
    setCellValue(ri === -1 ? (headers[ci] || '') : (allRows[ri]?.[ci] || ''));
  };

  const handleDownload = () => {
    const link = document.createElement('a');
    link.href = withAuthToken(`${API_URL}/baskets/${basketId}/files/${fileId}/download`);
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const getColWidth = (ci: number) => colWidths[ci] ?? 100;

  const handleResizeStart = useCallback((ci: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizingCol.current = ci;
    resizeStartX.current = e.clientX;
    resizeStartW.current = colWidths[ci] ?? 100;

    const handleMouseMove = (ev: MouseEvent) => {
      if (resizingCol.current === null) return;
      const diff = ev.clientX - resizeStartX.current;
      const newWidth = Math.max(40, resizeStartW.current + diff);
      setColWidths(prev => ({ ...prev, [resizingCol.current!]: newWidth }));
    };

    const handleMouseUp = () => {
      resizingCol.current = null;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [colWidths]);

  const handleResizeDoubleClick = useCallback((ci: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!headers.length) return;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.font = '11px "Segoe UI", Tahoma, Geneva, Verdana, sans-serif';

    let maxWidth = ctx.measureText(headers[ci] || '').width;
    const sampleRows = allRows.slice(0, 200);
    for (const row of sampleRows) {
      const w = ctx.measureText(row[ci] || '').width;
      if (w > maxWidth) maxWidth = w;
    }
    setColWidths(prev => ({ ...prev, [ci]: Math.max(40, Math.min(500, Math.ceil(maxWidth + 24))) }));
  }, [headers, allRows]);

  // Sort handler — server-side for large data
  const handleSort = (ci: number) => {
    let newCol: number | null;
    let newDir: SortDir;
    if (sortCol === ci) {
      if (sortDir === 'asc') { newCol = ci; newDir = 'desc'; }
      else { newCol = null; newDir = null; }
    } else {
      newCol = ci;
      newDir = 'asc';
    }
    setSortCol(newCol);
    setSortDir(newDir);
    refetchWithSortFilter(newCol, newDir);
  };

  // Filter handlers
  const toggleFilterDropdown = async (ci: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (filterDropdown === ci) {
      setFilterDropdown(null);
      setFilterSearch('');
      return;
    }
    // Fetch unique values for this column from server (first 5000 rows)
    setFilterDropdown(ci);
    setFilterSearch('');
    try {
      const params = new URLSearchParams();
      params.set('sheet', String(activeSheet));
      params.set('offset', '0');
      params.set('limit', '5000');
      const res = await fetch(`${API_URL}/baskets/${basketId}/files/${fileId}/xlsx-data?${params}`);
      const json = await res.json();
      if (json.success && json.data.sheet) {
        const vals = new Set<string>();
        for (const row of json.data.sheet.rows) {
          vals.add(row[ci] || '');
        }
        setFilterUniqueValues(Array.from(vals).sort((a, b) => a.localeCompare(b, 'th')));
      }
    } catch {
      setFilterUniqueValues([]);
    }
  };

  const isColumnFiltered = (ci: number) => filters[ci] !== undefined;

  const handleFilterSelectAll = (ci: number) => {
    const newFilters = { ...filters };
    delete newFilters[ci];
    setFilters(newFilters);
    refetchWithSortFilter(sortCol, sortDir, newFilters);
  };

  const handleFilterToggleValue = (ci: number, value: string) => {
    setFilters(prev => {
      const allValues = filterUniqueValues;
      const current = prev[ci] ?? new Set(allValues);
      const next = new Set(current);
      if (next.has(value)) next.delete(value); else next.add(value);
      if (next.size === allValues.length) {
        const result = { ...prev };
        delete result[ci];
        return result;
      }
      return { ...prev, [ci]: next };
    });
  };

  const handleFilterApply = () => {
    setFilterDropdown(null);
    setFilterSearch('');
    refetchWithSortFilter(sortCol, sortDir);
  };

  const handleFilterSelectOnly = (ci: number, value: string) => {
    const newFilters = { ...filters, [ci]: new Set([value]) };
    setFilters(newFilters);
    setFilterDropdown(null);
    refetchWithSortFilter(sortCol, sortDir, newFilters);
  };

  const activeFilterCount = Object.keys(filters).length;

  if (tooLarge) {
    const sizeMB = (tooLarge.fileSize / 1024 / 1024).toFixed(1);
    return (
      <div className="h-screen flex items-center justify-center bg-[#f0f0f0]">
        <div className="bg-white rounded-xl shadow-lg p-10 max-w-md text-center">
          <div className="w-20 h-20 mx-auto mb-5 bg-[#e2efda] rounded-full flex items-center justify-center">
            <svg className="w-10 h-10 text-[#217346]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 10v6m0 0l-3-3m3 3l3-3M3 17V7a2 2 0 012-2h6l2 2h4a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-gray-900 mb-2">{tooLarge.fileName}</h2>
          <p className="text-sm text-gray-500 mb-6">{sizeMB} MB</p>
          <a
            href={withAuthToken(`${API_URL}/baskets/${basketId}/files/${fileId}/download`)}
            className="inline-flex items-center gap-2 px-6 py-3 bg-[#217346] text-white rounded-lg hover:bg-[#1a5c38] transition-colors font-medium"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            Download
          </a>
        </div>
      </div>
    );
  }

  if (loading && allRows.length === 0) {
    return (
      <div className="h-screen flex items-center justify-center bg-[#f0f0f0]">
        <div className="flex flex-col items-center gap-4">
          <div className="animate-spin h-10 w-10 border-4 border-[#217346] border-t-transparent rounded-full" />
          <span className="text-sm text-gray-700 font-medium">Opening spreadsheet...</span>
          <span className="text-xs text-gray-500">Large files may take a moment to load</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-screen flex items-center justify-center bg-[#f0f0f0]">
        <div className="bg-white rounded-lg shadow-lg p-8 max-w-md text-center">
          <div className="w-16 h-16 mx-auto mb-4 bg-red-100 rounded-full flex items-center justify-center">
            <svg className="w-8 h-8 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-gray-900 mb-2">Error</h2>
          <p className="text-gray-600">{error}</p>
        </div>
      </div>
    );
  }

  const renderFilterDropdown = (ci: number) => {
    if (filterDropdown !== ci) return null;
    const currentFilter = filters[ci];
    const isAllSelected = !currentFilter;
    const searchLower = filterSearch.toLowerCase();
    const filteredValues = filterSearch
      ? filterUniqueValues.filter(v => v.toLowerCase().includes(searchLower))
      : filterUniqueValues;

    return (
      <div
        ref={filterRef}
        className="absolute top-full left-0 mt-1 bg-white border border-[#c0c0c0] shadow-lg rounded z-50 min-w-[220px] max-w-[320px]"
        style={{ maxHeight: 350 }}
        onClick={e => e.stopPropagation()}
      >
        <div className="border-b border-[#e0e0e0] p-1.5 flex gap-1">
          <button
            onClick={() => { setSortCol(ci); setSortDir('asc'); setFilterDropdown(null); refetchWithSortFilter(ci, 'asc'); }}
            className={`flex-1 px-2 py-1 text-[11px] rounded flex items-center gap-1.5 ${
              sortCol === ci && sortDir === 'asc' ? 'bg-[#d6e4f0] text-[#217346] font-medium' : 'hover:bg-gray-100 text-gray-700'
            }`}
          >
            <svg className="w-3 h-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M6 2v8M3 5l3-3 3 3" /></svg>
            A to Z
          </button>
          <button
            onClick={() => { setSortCol(ci); setSortDir('desc'); setFilterDropdown(null); refetchWithSortFilter(ci, 'desc'); }}
            className={`flex-1 px-2 py-1 text-[11px] rounded flex items-center gap-1.5 ${
              sortCol === ci && sortDir === 'desc' ? 'bg-[#d6e4f0] text-[#217346] font-medium' : 'hover:bg-gray-100 text-gray-700'
            }`}
          >
            <svg className="w-3 h-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M6 10V2M3 7l3 3 3-3" /></svg>
            Z to A
          </button>
        </div>

        <div className="p-1.5 border-b border-[#e0e0e0]">
          <input
            type="text"
            placeholder="Search..."
            value={filterSearch}
            onChange={e => setFilterSearch(e.target.value)}
            className="w-full px-2 py-1 text-[11px] border border-[#c0c0c0] rounded outline-none focus:border-[#217346]"
            autoFocus
          />
        </div>

        <div className="border-b border-[#e0e0e0]">
          <label className="flex items-center gap-2 px-2 h-7 hover:bg-gray-50 cursor-pointer whitespace-nowrap">
            <input type="checkbox" checked={isAllSelected} onChange={() => handleFilterSelectAll(ci)} className="w-3 h-3 accent-[#217346]" />
            <span className="text-[11px] font-medium text-gray-700">(Select All)</span>
          </label>
        </div>

        <div className="overflow-y-auto" style={{ maxHeight: 200 }}>
          {filteredValues.map((val, idx) => {
            const checked = isAllSelected || (currentFilter?.has(val) ?? false);
            return (
              <label key={idx} className="flex items-center gap-2 px-2 h-7 hover:bg-gray-50 cursor-pointer group whitespace-nowrap">
                <input type="checkbox" checked={checked} onChange={() => handleFilterToggleValue(ci, val)} className="w-3 h-3 accent-[#217346]" />
                <span className="text-[11px] text-gray-700 truncate flex-1">{val || '(Blank)'}</span>
                <button
                  onClick={(e) => { e.preventDefault(); handleFilterSelectOnly(ci, val); }}
                  className="hidden group-hover:block text-[9px] text-[#217346] hover:underline flex-shrink-0"
                >
                  Only
                </button>
              </label>
            );
          })}
          {filteredValues.length === 0 && (
            <div className="px-2 py-2 text-[11px] text-gray-400 text-center">No matches</div>
          )}
        </div>

        <div className="border-t border-[#e0e0e0] p-1.5 flex justify-between">
          <button onClick={() => handleFilterSelectAll(ci)} className="px-2 py-0.5 text-[11px] text-gray-600 hover:text-gray-900">Clear Filter</button>
          <button onClick={handleFilterApply} className="inline-flex items-center justify-center px-3 h-8 text-[13px] bg-[#217346] text-white rounded hover:bg-[#1a5c38] whitespace-nowrap">OK</button>
        </div>
      </div>
    );
  };

  const totalTableWidth = headers.reduce((sum, _, ci) => sum + getColWidth(ci), 0) + 50;

  return (
    <div className="h-screen flex flex-col bg-white" style={{ fontFamily: "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif" }}>
      {/* Title Bar */}
      <div className="bg-[#217346] text-white px-4 py-1.5 flex items-center justify-between select-none flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 bg-white/20 rounded flex items-center justify-center">
            <span className="text-xs font-bold">X</span>
          </div>
          <span className="text-sm font-medium">{fileName}</span>
        </div>
        <button onClick={handleDownload} className="inline-flex items-center justify-center px-3 h-8 text-[13px] bg-white/15 hover:bg-white/25 rounded transition-colors whitespace-nowrap">
          <svg className="w-4 h-4 inline mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          Download
        </button>
      </div>

      {/* Ribbon */}
      <div className="bg-[#f3f3f3] border-b border-[#d4d4d4] px-3 py-1 flex items-center gap-4 flex-shrink-0">
        <div className="flex items-center gap-1 text-xs text-gray-600">
          <span className="text-gray-400">Sheet:</span>
          <span className="font-medium text-gray-800">{sheetNames[activeSheet]?.name}</span>
          <span className="mx-2 text-gray-300">|</span>
          <span className="text-gray-400">Total Rows:</span>
          <span className="font-medium text-gray-800">{totalRows.toLocaleString()}</span>
          {filteredCount !== totalRows && (
            <>
              <span className="mx-2 text-gray-300">|</span>
              <span className="text-gray-400">Filtered:</span>
              <span className="font-medium text-[#217346]">{filteredCount.toLocaleString()}</span>
            </>
          )}
          <span className="mx-2 text-gray-300">|</span>
          <span className="text-gray-400">Loaded:</span>
          <span className="font-medium text-gray-800">{allRows.length.toLocaleString()}</span>
          {hasMore && <span className="text-gray-400 ml-1">(scroll for more)</span>}
          <span className="mx-2 text-gray-300">|</span>
          <span className="text-gray-400">Columns:</span>
          <span className="font-medium text-gray-800">{headers.length}</span>
          {activeFilterCount > 0 && (
            <>
              <span className="mx-2 text-gray-300">|</span>
              <button
                onClick={() => { setFilters({}); setSortCol(null); setSortDir(null); refetchWithSortFilter(null, null, {}); }}
                className="text-[#c24629] hover:text-red-700 font-medium"
              >
                Clear All Filters
              </button>
            </>
          )}
        </div>
      </div>

      {/* Formula Bar */}
      <div className="flex items-center border-b border-[#d4d4d4] flex-shrink-0">
        <div className="w-[80px] border-r border-[#d4d4d4] px-2 py-1 bg-white">
          <input type="text" value={cellAddress} readOnly className="w-full text-xs text-center font-medium text-gray-700 bg-transparent outline-none" placeholder="A1" />
        </div>
        <div className="flex items-center px-1 border-r border-[#d4d4d4] text-gray-400">
          <span className="text-xs italic px-1">fx</span>
        </div>
        <div className="flex-1 px-2 py-1 bg-white">
          <input type="text" value={cellValue} readOnly className="w-full text-xs text-gray-700 bg-transparent outline-none" />
        </div>
      </div>

      {/* Spreadsheet Grid with Virtual Scroll */}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-auto bg-white"
        style={{ scrollbarWidth: 'thin' }}
        onScroll={handleScroll}
      >
        <div style={{ height: virtualData.totalHeight, width: totalTableWidth, position: 'relative' }}>
          {/* Sticky header */}
          <table className="border-collapse" style={{ width: totalTableWidth, tableLayout: 'fixed', position: 'sticky', top: 0, zIndex: 20 }}>
            <colgroup>
              <col style={{ width: 50 }} />
              {headers.map((_, ci) => (
                <col key={ci} style={{ width: getColWidth(ci) }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th className="bg-[#e6e6e6] border-r border-b border-[#c0c0c0] text-[10px] text-gray-500" style={{ height: 24 }} />
                {headers.map((_, ci) => (
                  <th
                    key={ci}
                    className={`px-1 py-0.5 text-[10px] font-normal text-center border-r border-b select-none cursor-pointer relative ${
                      selectedCell?.col === ci ? 'bg-[#d6e4f0] border-[#5b9bd5] text-[#217346] font-semibold' : 'bg-[#e6e6e6] border-[#c0c0c0] text-gray-600'
                    }`}
                    onClick={() => handleCellClick(-1, ci)}
                    style={{ height: 24 }}
                  >
                    {getColLetter(ci)}
                    <div className="absolute top-0 right-0 w-[5px] h-full cursor-col-resize hover:bg-[#5b9bd5] z-40"
                      onMouseDown={(e) => handleResizeStart(ci, e)}
                      onDoubleClick={(e) => handleResizeDoubleClick(ci, e)}
                    />
                  </th>
                ))}
              </tr>
              <tr>
                <th className="bg-[#e6e6e6] border-r border-b border-[#c0c0c0] text-[10px] text-gray-500 font-normal" style={{ height: 28 }}>1</th>
                {headers.map((h, ci) => (
                  <th
                    key={ci}
                    className={`px-2 py-1 text-left text-[11px] font-bold border-r border-b cursor-pointer relative overflow-visible ${
                      selectedCell?.row === -1 && selectedCell?.col === ci ? 'bg-[#d6e4f0] border-[#5b9bd5]' : 'bg-[#e2efda] border-[#a9d08e]'
                    } text-[#375623]`}
                    onClick={() => handleSort(ci)}
                    style={{ height: 28 }}
                  >
                    <span className="block truncate pr-5">{h}</span>
                    {sortCol === ci && sortDir && (
                      <span className="absolute right-5 top-1/2 -translate-y-1/2 text-[9px] text-[#217346]">
                        {sortDir === 'asc' ? '\u25B2' : '\u25BC'}
                      </span>
                    )}
                    <button
                      onClick={(e) => toggleFilterDropdown(ci, e)}
                      className={`absolute right-0.5 top-1/2 -translate-y-1/2 w-4 h-4 flex items-center justify-center rounded ${
                        isColumnFiltered(ci) ? 'text-[#217346]' : 'text-gray-400 hover:text-gray-600'
                      }`}
                    >
                      <svg className="w-3 h-3" viewBox="0 0 12 12" fill="currentColor"><path d="M1 1h10L7.5 5.5V10L4.5 11V5.5L1 1z" /></svg>
                    </button>
                    {renderFilterDropdown(ci)}
                    <div className="absolute top-0 right-0 w-[5px] h-full cursor-col-resize hover:bg-[#5b9bd5] z-40"
                      onMouseDown={(e) => handleResizeStart(ci, e)}
                      onDoubleClick={(e) => handleResizeDoubleClick(ci, e)}
                    />
                  </th>
                ))}
              </tr>
            </thead>
          </table>

          {/* Virtual rows */}
          {allRows.slice(virtualData.startRow, virtualData.endRow).map((row, i) => {
            const rowIndex = virtualData.startRow + i;
            const top = 52 + rowIndex * ROW_HEIGHT; // 52 = header height
            return (
              <div
                key={rowIndex}
                className="flex group"
                style={{ position: 'absolute', top, left: 0, height: ROW_HEIGHT, width: totalTableWidth }}
              >
                {/* Row number */}
                <div
                  className={`flex-shrink-0 text-center text-[10px] border-r border-b leading-[${ROW_HEIGHT}px] ${
                    selectedCell?.row === rowIndex ? 'bg-[#d6e4f0] border-[#5b9bd5] text-[#217346] font-semibold' : 'bg-[#e6e6e6] border-[#c0c0c0] text-gray-500'
                  }`}
                  style={{ width: 50, height: ROW_HEIGHT, lineHeight: `${ROW_HEIGHT}px` }}
                >
                  {rowIndex + 2}
                </div>
                {/* Cells */}
                {row.map((cell, ci) => (
                  <div
                    key={ci}
                    className={`flex-shrink-0 px-2 text-[11px] border-r border-b overflow-hidden cursor-cell truncate ${
                      selectedCell?.row === rowIndex && selectedCell?.col === ci
                        ? 'outline outline-2 outline-[#217346] outline-offset-[-1px] bg-[#e2efda]/30'
                        : 'border-[#e0e0e0]'
                    } ${rowIndex % 2 === 0 ? 'bg-white' : 'bg-[#f9f9f9]'} text-gray-800`}
                    style={{ width: getColWidth(ci), height: ROW_HEIGHT, lineHeight: `${ROW_HEIGHT}px` }}
                    onClick={() => handleCellClick(rowIndex, ci)}
                    title={cell}
                  >
                    {cell}
                  </div>
                ))}
              </div>
            );
          })}

          {/* Loading more indicator */}
          {loadingMore && (
            <div style={{ position: 'absolute', top: 52 + allRows.length * ROW_HEIGHT, left: 0, width: '100%', textAlign: 'center', padding: 12 }}>
              <span className="text-xs text-gray-500">Loading more rows...</span>
            </div>
          )}
        </div>
      </div>

      {/* Sheet Tabs */}
      <div className="flex items-center border-t border-[#c0c0c0] bg-[#e6e6e6] flex-shrink-0">
        <div className="flex items-center gap-0.5 px-1 py-0.5 flex-1 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
          {sheetNames.map((s, idx) => (
            <button
              key={idx}
              onClick={() => { setActiveSheet(idx); setSelectedCell(null); setCellAddress(''); setCellValue(''); }}
              className={`px-4 py-1 text-[11px] border transition-colors whitespace-nowrap ${
                idx === activeSheet
                  ? 'bg-white border-[#c0c0c0] border-b-white text-[#217346] font-medium -mb-px z-10'
                  : 'bg-[#e6e6e6] border-transparent text-gray-600 hover:bg-[#d9d9d9]'
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-4 px-3 py-1 text-[10px] text-gray-500 border-l border-[#c0c0c0]">
          {selectedCell && selectedCell.row >= 0 && <span>Cell: {cellAddress}</span>}
          <span>Rows: {totalRows.toLocaleString()}</span>
          {filteredCount !== totalRows && (
            <span className="text-[#217346]">Filtered: {filteredCount.toLocaleString()}</span>
          )}
        </div>
      </div>
    </div>
  );
}
