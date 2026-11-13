import { 
  Database, 
  Server,
  Globe, 
  Cloud,
  FileJson,
  Mail,
  Wifi,
  Webhook,
  Settings,
  type LucideIcon
} from 'lucide-react';

interface ConnectionIconProps {
  type: string;
  subtype?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}

// Map connection types to Lucide icons
const iconMap: Record<string, LucideIcon> = {
  // Database types
  'postgresql': Database,
  'mysql': Database,
  'sqlite': Database,
  'oracle': Database,
  'mssql': Database,
  'mongodb': Database,
  'redis': Database,
  'database': Database,
  
  // Storage types
  'sftp': Server,
  'smtp': Mail,
  'ftp': Server,
  's3': Cloud,
  'google-drive': Cloud,
  'dropbox': Cloud,
  
  // API types
  'rest-api': Globe,
  'graphql': FileJson,
  'soap': Mail,
  'webhook': Webhook,
  
  // Messaging types
  'kafka': Wifi,
  'rabbitmq': Mail,
  'mqtt': Wifi,
  
  // Default
  'default': Settings,
};

// Color mappings for each type
const colorMap: Record<string, { bg: string; icon: string; border: string }> = {
  'postgresql': { bg: 'bg-blue-100', icon: 'text-blue-600', border: 'border-blue-200' },
  'mysql': { bg: 'bg-orange-100', icon: 'text-orange-600', border: 'border-orange-200' },
  'sqlite': { bg: 'bg-sky-100', icon: 'text-sky-600', border: 'border-sky-200' },
  'oracle': { bg: 'bg-red-100', icon: 'text-red-600', border: 'border-red-200' },
  'mssql': { bg: 'bg-yellow-100', icon: 'text-yellow-600', border: 'border-yellow-200' },
  'mongodb': { bg: 'bg-green-100', icon: 'text-green-600', border: 'border-green-200' },
  'redis': { bg: 'bg-red-100', icon: 'text-red-600', border: 'border-red-200' },
  'database': { bg: 'bg-blue-100', icon: 'text-blue-600', border: 'border-blue-200' },
  
  'sftp': { bg: 'bg-green-100', icon: 'text-green-600', border: 'border-green-200' },
  'smtp': { bg: 'bg-rose-100', icon: 'text-rose-600', border: 'border-rose-200' },
  'ftp': { bg: 'bg-yellow-100', icon: 'text-yellow-600', border: 'border-yellow-200' },
  's3': { bg: 'bg-orange-100', icon: 'text-orange-600', border: 'border-orange-200' },
  'google-drive': { bg: 'bg-red-100', icon: 'text-red-600', border: 'border-red-200' },
  'dropbox': { bg: 'bg-blue-100', icon: 'text-blue-600', border: 'border-blue-200' },
  
  'rest-api': { bg: 'bg-purple-100', icon: 'text-purple-600', border: 'border-purple-200' },
  'graphql': { bg: 'bg-pink-100', icon: 'text-pink-600', border: 'border-pink-200' },
  'soap': { bg: 'bg-indigo-100', icon: 'text-indigo-600', border: 'border-indigo-200' },
  'webhook': { bg: 'bg-teal-100', icon: 'text-teal-600', border: 'border-teal-200' },
  
  'kafka': { bg: 'bg-gray-100', icon: 'text-gray-600', border: 'border-gray-300' },
  'rabbitmq': { bg: 'bg-orange-100', icon: 'text-orange-600', border: 'border-orange-200' },
  'mqtt': { bg: 'bg-cyan-100', icon: 'text-cyan-600', border: 'border-cyan-200' },
  
  'default': { bg: 'bg-gray-100', icon: 'text-gray-600', border: 'border-gray-200' },
};

const sizeMap = {
  sm: { container: 'w-8 h-8', icon: 16 },
  md: { container: 'w-10 h-10', icon: 20 },
  lg: { container: 'w-12 h-12', icon: 24 },
  xl: { container: 'w-16 h-16', icon: 32 },
};

export function ConnectionIcon({ type, subtype, size = 'md', className = '' }: ConnectionIconProps) {
  // Use subtype if available (for database types), otherwise use type
  const effectiveType = subtype || type;
  
  const IconComponent = iconMap[effectiveType] || iconMap[type] || iconMap['default'];
  const colors = colorMap[effectiveType] || colorMap[type] || colorMap['default'];
  const dimensions = sizeMap[size];
  
  return (
    <div 
      className={`
        ${dimensions.container} 
        ${colors.bg} 
        ${colors.border}
        rounded-lg 
        flex 
        items-center 
        justify-center 
        border
        shadow-sm
        ${className}
      `}
    >
      <IconComponent 
        size={dimensions.icon} 
        className={colors.icon}
      />
    </div>
  );
}

export function getConnectionIconColor(type: string, subtype?: string) {
  const effectiveType = subtype || type;
  return colorMap[effectiveType] || colorMap[type] || colorMap['default'];
}

export default ConnectionIcon;
