import React from 'react';

interface DehLogoProps {
  /** Rendered width and height in px. */
  size?: number;
  className?: string;
}

/**
 * DEH (Data Exchange Hub) mark: two brackets (the systems on either side)
 * with arrows running both ways between them.
 */
export const DehLogo: React.FC<DehLogoProps> = ({ size = 32, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 32 32"
    className={className}
    role="img"
    aria-label="logo"
  >
    <g fill="none" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 7H6V25H11" stroke="currentColor" strokeWidth="2.5" />
      <path d="M21 7H26V25H21" stroke="currentColor" strokeWidth="2.5" />
      <g stroke="#4589ff" strokeWidth="2.2">
        <path d="M11 13H20" />
        <path d="M17.5 10.5 20 13 17.5 15.5" />
        <path d="M21 19H12" />
        <path d="M14.5 16.5 12 19 14.5 21.5" />
      </g>
    </g>
  </svg>
);
