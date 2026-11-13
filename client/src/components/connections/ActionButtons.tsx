import { Play, Settings, Loader2, Trash2, FolderOpen } from 'lucide-react';

interface ActionButtonsProps {
  connectionId: string;
  isTesting: boolean;
  onTest: (id: string) => void;
  onEdit: () => void;
  onDelete?: () => void;
  onBrowse?: () => void;
  size?: 'sm' | 'md';
  showLabels?: boolean;
}

export function ActionButtons({
  connectionId,
  isTesting,
  onTest,
  onEdit,
  onDelete,
  onBrowse,
  size = 'md',
  showLabels = false,
}: ActionButtonsProps) {
  const buttonSize = size === 'sm' ? 'p-1.5' : 'p-2';
  const iconSize = size === 'sm' ? 14 : 16;

  return (
    <div className="flex items-center gap-1">
      {/* Browse Button - SFTP only */}
      {onBrowse && (
        <button
          onClick={onBrowse}
          className={`${buttonSize} rounded-md transition-all duration-200 flex items-center justify-center text-gray-600 hover:bg-green-50 hover:text-green-700 border border-gray-200 hover:border-green-200 shadow-sm`}
          title="Browse files"
        >
          <FolderOpen size={iconSize} />
        </button>
      )}

      {/* Test Button - Simple Play Icon */}
      <button
        onClick={() => onTest(connectionId)}
        disabled={isTesting}
        className={`
          ${buttonSize}
          rounded-md
          transition-all
          duration-200
          flex
          items-center
          justify-center
          text-gray-600
          hover:bg-gray-100
          hover:text-gray-800
          border
          border-gray-200
          disabled:opacity-50
          disabled:cursor-not-allowed
          shadow-sm
        `}
        title="Test Connection"
      >
        {isTesting ? (
          <Loader2 size={iconSize} className="animate-spin" />
        ) : (
          <Play size={iconSize} />
        )}
      </button>

      {/* Edit Button */}
      <button
        onClick={onEdit}
        className={`
          ${buttonSize}
          rounded-lg
          transition-all
          duration-200
          flex
          items-center
          gap-1.5
          text-gray-600
          hover:bg-blue-50
          hover:text-blue-600
          border
          border-gray-200
          hover:border-blue-200
        `}
        title="Edit Connection"
      >
        <Settings size={iconSize} />
        {showLabels && (
          <span className="text-sm font-medium">Edit</span>
        )}
      </button>

      {/* Delete Button (optional) */}
      {onDelete && (
        <button
          onClick={onDelete}
          className={`
            ${buttonSize}
            rounded-lg
            transition-all
            duration-200
            flex
            items-center
            gap-1.5
            text-gray-400
            hover:bg-red-50
            hover:text-red-600
            hover:border-red-200
            border
            border-transparent
          `}
          title="Delete Connection"
        >
          <Trash2 size={iconSize} />
          {showLabels && (
            <span className="text-sm font-medium">Delete</span>
          )}
        </button>
      )}
    </div>
  );
}

interface StatusBadgeProps {
  status: string;
  lastTestedAt?: string;
}

export function StatusBadge({ status, lastTestedAt }: StatusBadgeProps) {
  const getStatusConfig = () => {
    switch (status) {
      case 'Connected':
        return {
          bg: 'bg-green-100',
          text: 'text-green-700',
          border: 'border-green-200',
          dot: 'bg-green-500',
          label: 'Connected',
        };
      case 'Error':
        return {
          bg: 'bg-red-100',
          text: 'text-red-700',
          border: 'border-red-200',
          dot: 'bg-red-500',
          label: 'Error',
        };
      default:
        return {
          bg: 'bg-gray-100',
          text: 'text-gray-700',
          border: 'border-gray-200',
          dot: 'bg-gray-400',
          label: 'Disconnected',
        };
    }
  };

  const config = getStatusConfig();

  return (
    <div
      className={`
        inline-flex
        items-center
        gap-1.5
        px-2.5
        py-1
        rounded-full
        border
        ${config.bg}
        ${config.text}
        ${config.border}
        text-xs
        font-medium
      `}
    >
      <div className={`w-2 h-2 rounded-full ${config.dot}`}></div>
      <span>{config.label}</span>
      {lastTestedAt && (
        <span className="text-gray-400 ml-1">
          • {new Date(lastTestedAt).toLocaleString('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}
        </span>
      )}
    </div>
  );
}

export default ActionButtons;
