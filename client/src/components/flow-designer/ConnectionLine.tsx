import { useMemo } from 'react';

interface Point {
  x: number;
  y: number;
}

interface ConnectionLineProps {
  from: Point;
  to: Point;
  animated?: boolean;
  selected?: boolean;
  onClick?: () => void;
}

export const ConnectionLine = ({ from, to, animated = true, selected = false, onClick }: ConnectionLineProps) => {
  // Calculate control points for bezier curve
  const path = useMemo(() => {
    const dx = Math.abs(to.x - from.x);
    const dy = Math.abs(to.y - from.y);
    
    // Dynamic control point distance based on distance between nodes
    const distance = Math.sqrt(dx * dx + dy * dy);
    const controlOffset = Math.min(distance * 0.5, 150);
    
    // Control points create smooth curve from any direction
    const cp1 = {
      x: from.x + (to.x > from.x ? controlOffset : -controlOffset),
      y: from.y + (to.y > from.y ? controlOffset * 0.3 : -controlOffset * 0.3)
    };
    const cp2 = {
      x: to.x - (to.x > from.x ? controlOffset : -controlOffset),
      y: to.y - (to.y > from.y ? controlOffset * 0.3 : -controlOffset * 0.3)
    };
    
    return `M ${from.x} ${from.y} C ${cp1.x} ${cp1.y}, ${cp2.x} ${cp2.y}, ${to.x} ${to.y}`;
  }, [from, to]);

  return (
    <g className="connection-line-group cursor-pointer" onClick={onClick}>
      {/* Invisible wider path for easier clicking */}
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={15}
        className="connection-line-hit-area"
      />
      {/* Visible line */}
      <path
        d={path}
        fill="none"
        stroke={selected ? "#2563eb" : "#3b82f6"}
        strokeWidth={selected ? 3 : 2}
        className={animated ? "connection-line-animated" : ""}
        strokeDasharray={animated ? "8,4" : "none"}
      />
      {/* Arrow head */}
      <circle cx={to.x} cy={to.y} r={4} fill={selected ? "#2563eb" : "#3b82f6"} />
    </g>
  );
};

export default ConnectionLine;
