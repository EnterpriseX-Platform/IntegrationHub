import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Theme, Loading, InlineLoading, InlineNotification, IconButton, Search } from '@carbon/react';
import { ArrowUp, ArrowDown, Close, Search as SearchIcon, Download } from '@carbon/icons-react';
import { Button } from '../components/ui/Button';
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
          <Loading withOverlay={false} small description="Loading file" />
          <span className="text-sm text-gray-400">Loading file...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-screen flex items-center justify-center bg-[#1e1e1e]">
        <Theme theme="g100" className="max-w-md w-full">
          <InlineNotification kind="error" lowContrast hideCloseButton title="Error" subtitle={error} />
        </Theme>
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
            <span className="text-[12px] px-1.5 py-0.5 bg-yellow-600/30 text-yellow-300 rounded">
              {encoding.toUpperCase()}
            </span>
          )}
        </div>
        <Theme theme="g100" className="flex items-center gap-2 bg-transparent">
          <IconButton
            kind="ghost"
            size="sm"
            label="Search (Ctrl+F)"
            onClick={() => { setShowSearch(!showSearch); if (!showSearch) setTimeout(() => searchInputRef.current?.focus(), 50); }}
          >
            <SearchIcon />
          </IconButton>
          <Button variant="ghost" size="sm" onClick={handleDownload} title="Download" leftIcon={<Download />}>
            Download
          </Button>
        </Theme>
      </div>

      {/* Search Bar */}
      {showSearch && (
        <Theme theme="g100" className="bg-[#3c3c3c] border-b border-[#404040] px-4 py-1.5 flex items-center gap-2 flex-shrink-0">
          <div className="flex-1">
            <Search
              ref={searchInputRef}
              id="txt-viewer-search"
              size="sm"
              labelText="Search in loaded lines"
              placeholder="Search in loaded lines..."
              value={searchText}
              onChange={(e: any) => setSearchText(e.target.value)}
              onClear={() => setSearchText('')}
              onKeyDown={(e: any) => { if (e.key === 'Enter') goToMatch(currentMatch + (e.shiftKey ? -1 : 1)); }}
            />
          </div>
          {searchResults.length > 0 && (
            <span className="text-[12px] text-gray-400">
              {currentMatch + 1} / {searchResults.length}
            </span>
          )}
          <IconButton kind="ghost" size="sm" label="Previous match" onClick={() => goToMatch(currentMatch - 1)} disabled={searchResults.length === 0}>
            <ArrowUp />
          </IconButton>
          <IconButton kind="ghost" size="sm" label="Next match" onClick={() => goToMatch(currentMatch + 1)} disabled={searchResults.length === 0}>
            <ArrowDown />
          </IconButton>
          <IconButton kind="ghost" size="sm" label="Close search" onClick={() => { setShowSearch(false); setSearchText(''); setSearchResults([]); setCurrentMatch(-1); }}>
            <Close />
          </IconButton>
        </Theme>
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
                  <td className="sticky left-0 px-3 py-0 text-right text-[12px] text-[#858585] select-none bg-inherit border-r border-[#333333] w-[60px] min-w-[60px]">
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
          <Theme theme="g100" className="flex items-center justify-center py-4 bg-transparent">
            <InlineLoading description="Loading more lines..." />
          </Theme>
        )}
      </div>

      {/* Status Bar */}
      <div className="flex items-center justify-between px-4 py-1 bg-[#007acc] text-white text-[12px] flex-shrink-0 select-none">
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
