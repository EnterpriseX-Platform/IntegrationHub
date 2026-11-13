import React, { useState, useEffect, useRef } from 'react';

interface LogEntry {
  id: string;
  timestamp: string;
  message: string;
  type: 'info' | 'success' | 'error' | 'warning';
}

interface LogsPanelProps {
  isOpen?: boolean;
  onToggle?: () => void;
  newLog?: LogEntry;
}

const initialLogs: LogEntry[] = [
  {
    id: '1',
    timestamp: '14:32:15',
    message: 'Starting flow execution...',
    type: 'info',
  },
  {
    id: '2',
    timestamp: '14:32:16',
    message: 'Executing: Schedule Trigger...',
    type: 'info',
  },
  {
    id: '3',
    timestamp: '14:32:16',
    message: 'Schedule Trigger: Success',
    type: 'success',
  },
];

export const LogsPanel: React.FC<LogsPanelProps> = ({
  isOpen: controlledIsOpen,
  onToggle,
  newLog,
}) => {
  const [isOpen, setIsOpen] = useState(controlledIsOpen ?? false);
  const [logs, setLogs] = useState<LogEntry[]>(initialLogs);
  const logsEndRef = useRef<HTMLDivElement>(null);

  // Sync with controlled state if provided
  useEffect(() => {
    if (controlledIsOpen !== undefined) {
      setIsOpen(controlledIsOpen);
    }
  }, [controlledIsOpen]);

  // Add new log when provided
  useEffect(() => {
    if (newLog) {
      setLogs((prev) => [...prev, newLog]);
    }
  }, [newLog]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  const handleToggle = () => {
    const newState = !isOpen;
    setIsOpen(newState);
    onToggle?.();
  };

  const getLogColor = (type: LogEntry['type']) => {
    switch (type) {
      case 'success':
        return 'text-green-500';
      case 'error':
        return 'text-red-500';
      case 'warning':
        return 'text-yellow-500';
      case 'info':
      default:
        return 'text-blue-500';
    }
  };

  const addLog = (message: string, type: LogEntry['type'] = 'info') => {
    const now = new Date();
    const timestamp = now.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const newLogEntry: LogEntry = {
      id: Date.now().toString(),
      timestamp,
      message,
      type,
    };
    setLogs((prev) => [...prev, newLogEntry]);
  };

  const clearLogs = () => {
    setLogs([]);
  };

  // Expose addLog method through ref
  React.useImperativeHandle(
    (React as any).createRef(),
    () => ({
      addLog,
      clearLogs,
    })
  );

  return (
    <>
      {/* Logs Panel */}
      <div
        className={`fixed bottom-4 right-4 w-96 bg-white rounded-xl border border-gray-200 shadow-2xl transition-all duration-300 z-50 ${
          isOpen ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4 pointer-events-none'
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <i className="fas fa-terminal text-gray-500"></i>
            <span className="font-medium text-sm">Execution Logs</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={clearLogs}
              className="p-1.5 hover:bg-gray-100 rounded text-gray-400 hover:text-gray-600 transition-colors"
              title="Clear logs"
            >
              <i className="fas fa-trash-alt text-xs"></i>
            </button>
            <button
              onClick={handleToggle}
              className="p-1.5 hover:bg-gray-100 rounded transition-colors"
            >
              <i className="fas fa-times text-xs text-gray-500"></i>
            </button>
          </div>
        </div>

        {/* Logs Content */}
        <div className="p-3 h-48 overflow-auto font-mono text-xs space-y-1">
          {logs.length === 0 ? (
            <div className="text-gray-400 text-center py-8">No logs yet</div>
          ) : (
            logs.map((log) => (
              <div key={log.id} className="flex gap-2">
                <span className="text-gray-400">{log.timestamp}</span>
                <span className={getLogColor(log.type)}>{log.message}</span>
              </div>
            ))
          )}
          <div ref={logsEndRef} />
        </div>
      </div>

      {/* Toggle Button */}
      <button
        onClick={handleToggle}
        className={`fixed bottom-4 right-4 bg-blue-500 hover:bg-blue-600 text-white px-3 h-9 rounded-lg shadow-lg flex items-center gap-2 transition-all duration-300 z-40 ${
          isOpen ? 'opacity-0 pointer-events-none' : 'opacity-100'
        } whitespace-nowrap`}
      >
        <i className="fas fa-terminal"></i>
        <span>Logs</span>
      </button>
    </>
  );
};

export default LogsPanel;
