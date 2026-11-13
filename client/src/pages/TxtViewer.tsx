import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { API_URL, withAuthToken } from '../config/api';

const PAGE_SIZE = 1000;

export default function TxtViewer() {
  const [searchParams] = useSearchParams();
  const basketId = searchParams.get('basketId');
  const fileId = searchParams.get('fileId');

  const [fileName, setFileName] = useState('');
  const [lines, setLines] = useState<string[]>([]);
  const [totalLines, setTotalLines] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [encoding, setEncoding] = useState('');
  const [searchText, setSearchText] = useState('');
  const [searchResults, setSearchResults] = useState<number[]>([]);
  const [currentMatch, setCurrentMatch] = useState(-1);
  const [showSearch, setShowSearch] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const loadedOffset = useRef(0);
  const isLoadingRef = useRef(false);

  useEffect(() => {
    if (!basketId || !fileId) {
      setError('Missing basketId or fileId');
      setLoading(false);
      return;
    }
    fetchData(0);
  }, [basketId, fileId]);

  // Keyboard shortcut for search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        setShowSearch(true);
        setTimeout(() => searchInputRef.current?.focus(), 50);
      }
      if (e.key === 'Escape') {
        setShowSearch(false);
        setSearchText('');
        setSearchResults([]);
        setCurrentMatch(-1);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Search within loaded lines
  useEffect(() => {
    if (!searchText) {
      setSearchResults([]);
      setCurrentMatch(-1);
      return;
    }
    const lower = searchText.toLowerCase();
    const matches: number[] = [];
    lines.forEach((line, idx) => {
      if (line.toLowerCase().includes(lower)) matches.push(idx);
    });
    setSearchResults(matches);
    setCurrentMatch(matches.length > 0 ? 0 : -1);
  }, [searchText, lines]);

  const fetchData = async (offset: number) => {
    if (isLoadingRef.current) return;
    isLoadingRef.current = true;

    try {
      const tl = totalLines > 0 ? `&totalLines=${totalLines}` : '';
      const res = await fetch(`${API_URL}/baskets/${basketId}/files/${fileId}/txt-data?offset=${offset}&limit=${PAGE_SIZE}${tl}`);
      const json = await res.json();
      if (json.success) {
        if (offset === 0) {
          setFileName(json.data.fileName);
          setEncoding(json.data.encoding);
          setLines(json.data.lines);
          document.title = json.data.fileName;
        } else {
          setLines(prev => [...prev, ...json.data.lines]);
        }
        setTotalLines(json.data.totalLines);
        loadedOffset.current = offset + json.data.lines.length;
        // If no new lines returned, mark as fully loaded to prevent infinite loop
        if (json.data.lines.length === 0) {
          loadedOffset.current = json.data.totalLines;
        }
      } else {
        setError(json.error || 'Failed to load file');
      }
    } catch (e) {
      setError('Failed to fetch file data');
    } finally {
      setLoading(false);
      setLoadingMore(false);
      isLoadingRef.current = false;
    }
  };

  // Lazy load on scroll
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el || isLoadingRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    if (scrollHeight - scrollTop - clientHeight < 500 && loadedOffset.current < totalLines) {
      setLoadingMore(true);
      fetchData(loadedOffset.current);
    }
  }, [totalLines, basketId, fileId]);

  const handleDownload = () => {
    const link = document.createElement('a');
    link.href = withAuthToken(`${API_URL}/baskets/${basketId}/files/${fileId}/download`);
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const goToMatch = (idx: number) => {
    if (idx < 0 || idx >= searchResults.length) return;
    setCurrentMatch(idx);
    const lineIdx = searchResults[idx];
    const lineEl = document.getElementById(`line-${lineIdx}`);
    lineEl?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const highlightLine = (line: string, search: string) => {
    if (!search) return line || ' ';
    const lower = line.toLowerCase();
    const sLower = search.toLowerCase();
    const parts: JSX.Element[] = [];
    let lastIdx = 0;
    let idx = lower.indexOf(sLower);
    let key = 0;
    while (idx !== -1) {
      if (idx > lastIdx) parts.push(<span key={key++}>{line.slice(lastIdx, idx)}</span>);
      parts.push(<mark key={key++} className="bg-yellow-300 text-black px-0">{line.slice(idx, idx + search.length)}</mark>);
      lastIdx = idx + search.length;
      idx = lower.indexOf(sLower, lastIdx);
    }
    if (lastIdx < line.length) parts.push(<span key={key++}>{line.slice(lastIdx)}</span>);
    return parts.length > 0 ? <>{parts}</> : (line || ' ');
  };

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-[#1e1e1e]">
        <div className="flex flex-col items-center gap-3">
          <div className="animate-spin h-8 w-8 border-3 border-blue-400 border-t-transparent rounded-full" />
          <span className="text-sm text-gray-400">Loading file...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-screen flex items-center justify-center bg-[#1e1e1e]">
        <div className="bg-[#2d2d2d] rounded-lg shadow-lg p-8 max-w-md text-center">
          <div className="w-16 h-16 mx-auto mb-4 bg-red-900/30 rounded-full flex items-center justify-center">
            <svg className="w-8 h-8 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-gray-200 mb-2">Error</h2>
          <p className="text-gray-400">{error}</p>
        </div>
      </div>
    );
  }

  const loadedPercent = totalLines > 0 ? Math.round((lines.length / totalLines) * 100) : 100;

  return (
    <div className="h-screen flex flex-col bg-[#1e1e1e] text-gray-300" style={{ fontFamily: "'Consolas', 'Courier New', 'Monaco', monospace" }}>
      {/* Title Bar */}
      <div className="bg-[#323233] text-gray-300 px-4 py-1.5 flex items-center justify-between select-none flex-shrink-0 border-b border-[#404040]">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 bg-blue-500/20 rounded flex items-center justify-center">
            <svg className="w-4 h-4 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
          <span className="text-sm font-medium text-gray-200">{fileName}</span>
          {encoding !== 'utf-8' && (
            <span className="text-[10px] px-1.5 py-0.5 bg-yellow-600/30 text-yellow-300 rounded">
              {encoding.toUpperCase()}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setShowSearch(!showSearch); if (!showSearch) setTimeout(() => searchInputRef.current?.focus(), 50); }}
            className="inline-flex items-center justify-center px-2 h-8 text-[13px] bg-white/10 hover:bg-white/20 rounded transition-colors whitespace-nowrap"
            title="Search (Ctrl+F)"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </button>
          <button
            onClick={handleDownload}
            className="inline-flex items-center justify-center px-3 h-8 text-[13px] bg-white/10 hover:bg-white/20 rounded transition-colors whitespace-nowrap"
            title="Download"
          >
            <svg className="w-4 h-4 inline mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            Download
          </button>
        </div>
      </div>

      {/* Search Bar */}
      {showSearch && (
        <div className="bg-[#3c3c3c] border-b border-[#404040] px-4 py-1.5 flex items-center gap-2 flex-shrink-0">
          <svg className="w-4 h-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            ref={searchInputRef}
            type="text"
            placeholder="Search in loaded lines..."
            value={searchText}
            onChange={e => setSearchText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') goToMatch(currentMatch + (e.shiftKey ? -1 : 1)); }}
            className="flex-1 px-2 py-0.5 text-xs bg-[#2d2d2d] border border-[#505050] rounded text-gray-200 outline-none focus:border-blue-500"
          />
          {searchResults.length > 0 && (
            <span className="text-[11px] text-gray-400">
              {currentMatch + 1} / {searchResults.length}
            </span>
          )}
          <button onClick={() => goToMatch(currentMatch - 1)} className="px-1 text-gray-400 hover:text-gray-200" disabled={searchResults.length === 0}>
            <svg className="w-4 h-4" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M6 2v8M3 5l3-3 3 3" /></svg>
          </button>
          <button onClick={() => goToMatch(currentMatch + 1)} className="px-1 text-gray-400 hover:text-gray-200" disabled={searchResults.length === 0}>
            <svg className="w-4 h-4" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M6 10V2M3 7l3 3 3-3" /></svg>
          </button>
          <button onClick={() => { setShowSearch(false); setSearchText(''); setSearchResults([]); setCurrentMatch(-1); }} className="px-1 text-gray-400 hover:text-gray-200">
            <svg className="w-4 h-4" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 3l6 6M9 3l-6 6" /></svg>
          </button>
        </div>
      )}

      {/* Content Area */}
      <div
        ref={containerRef}
        className="flex-1 overflow-auto"
        onScroll={handleScroll}
        style={{ scrollbarWidth: 'thin' }}
      >
        <table className="w-full border-collapse">
          <tbody>
            {lines.map((line, idx) => {
              const isMatch = searchResults.includes(idx);
              const isCurrentMatch = searchResults[currentMatch] === idx;
              return (
                <tr
                  key={idx}
                  id={`line-${idx}`}
                  className={`${isCurrentMatch ? 'bg-yellow-800/30' : isMatch ? 'bg-yellow-900/20' : idx % 2 === 0 ? 'bg-[#1e1e1e]' : 'bg-[#222222]'} hover:bg-[#2a2d2e]`}
                >
                  <td className="sticky left-0 px-3 py-0 text-right text-[11px] text-[#858585] select-none bg-inherit border-r border-[#333333] w-[60px] min-w-[60px]">
                    {idx + 1}
                  </td>
                  <td className="px-4 py-0 text-[12px] whitespace-pre" style={{ tabSize: 4 }}>
                    {highlightLine(line, searchText)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {loadingMore && (
          <div className="flex items-center justify-center py-4 gap-2">
            <div className="animate-spin h-4 w-4 border-2 border-blue-400 border-t-transparent rounded-full" />
            <span className="text-xs text-gray-500">Loading more lines...</span>
          </div>
        )}
      </div>

      {/* Status Bar */}
      <div className="flex items-center justify-between px-4 py-1 bg-[#007acc] text-white text-[11px] flex-shrink-0 select-none">
        <div className="flex items-center gap-4">
          <span>Lines: {totalLines.toLocaleString()}</span>
          <span>Loaded: {lines.length.toLocaleString()} ({loadedPercent}%)</span>
          {encoding !== 'utf-8' && <span>Encoding: {encoding.toUpperCase()}</span>}
        </div>
        <div className="flex items-center gap-4">
          {lines.length < totalLines && (
            <button
              onClick={() => { setLoadingMore(true); fetchData(loadedOffset.current); }}
              className="hover:underline"
            >
              Load More
            </button>
          )}
          <span>{fileName}</span>
        </div>
      </div>
    </div>
  );
}
