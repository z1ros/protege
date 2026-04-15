import React from "react";

/**
 * Shared SVG icon set. No emojis anywhere in Protege — all icons are
 * hand-drawn, sized by currentColor, and 1.5px stroke for consistency.
 */

type IconProps = {
  size?: number;
  className?: string;
  strokeWidth?: number;
};

const base = (size: number, strokeWidth: number): React.SVGProps<SVGSVGElement> => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
});

export const IconFlame = ({ size = 14, className, strokeWidth = 2 }: IconProps) => (
  <svg {...base(size, strokeWidth)} className={className}>
    <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
  </svg>
);

export const IconZap = ({ size = 14, className, strokeWidth = 2 }: IconProps) => (
  <svg {...base(size, strokeWidth)} className={className}>
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
  </svg>
);

export const IconBug = ({ size = 14, className, strokeWidth = 2 }: IconProps) => (
  <svg {...base(size, strokeWidth)} className={className}>
    <path d="M12 20v-9" />
    <path d="M8 8V6a4 4 0 0 1 8 0v2" />
    <path d="M5 11h14" />
    <path d="M5 11a7 7 0 0 0 14 0" />
    <path d="M5 19h2" />
    <path d="M17 19h2" />
    <path d="M5 15H3" />
    <path d="M21 15h-2" />
  </svg>
);

export const IconSparkles = ({ size = 14, className, strokeWidth = 2 }: IconProps) => (
  <svg {...base(size, strokeWidth)} className={className}>
    <path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8L12 3z" />
    <path d="M19 14l.8 1.9L22 17l-2.2.8L19 20l-.8-1.9L16 17l2.2-.8L19 14z" />
  </svg>
);

export const IconBook = ({ size = 14, className, strokeWidth = 2 }: IconProps) => (
  <svg {...base(size, strokeWidth)} className={className}>
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
  </svg>
);

export const IconShield = ({ size = 14, className, strokeWidth = 2 }: IconProps) => (
  <svg {...base(size, strokeWidth)} className={className}>
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </svg>
);

export const IconCheck = ({ size = 14, className, strokeWidth = 2 }: IconProps) => (
  <svg {...base(size, strokeWidth)} className={className}>
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

export const IconX = ({ size = 14, className, strokeWidth = 2 }: IconProps) => (
  <svg {...base(size, strokeWidth)} className={className}>
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

export const IconPencil = ({ size = 14, className, strokeWidth = 2 }: IconProps) => (
  <svg {...base(size, strokeWidth)} className={className}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
  </svg>
);

export const IconMic = ({ size = 14, className, strokeWidth = 2 }: IconProps) => (
  <svg {...base(size, strokeWidth)} className={className}>
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <line x1="12" y1="19" x2="12" y2="22" />
    <line x1="8" y1="22" x2="16" y2="22" />
  </svg>
);

export const IconVolume = ({ size = 14, className, strokeWidth = 2 }: IconProps) => (
  <svg {...base(size, strokeWidth)} className={className}>
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
  </svg>
);

export const IconPersonFemale = ({
  size = 14,
  className,
  strokeWidth = 2,
}: IconProps) => (
  <svg {...base(size, strokeWidth)} className={className}>
    <circle cx="12" cy="6" r="4" />
    <line x1="12" y1="10" x2="12" y2="18" />
    <line x1="9" y1="15" x2="15" y2="15" />
  </svg>
);

export const IconPersonMale = ({
  size = 14,
  className,
  strokeWidth = 2,
}: IconProps) => (
  <svg {...base(size, strokeWidth)} className={className}>
    <circle cx="10" cy="14" r="6" />
    <line x1="14" y1="10" x2="20" y2="4" />
    <polyline points="15 4 20 4 20 9" />
  </svg>
);

export const IconStar = ({ size = 14, className, strokeWidth = 2 }: IconProps) => (
  <svg {...base(size, strokeWidth)} className={className}>
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  </svg>
);

export const IconPlus = ({ size = 14, className, strokeWidth = 2 }: IconProps) => (
  <svg {...base(size, strokeWidth)} className={className}>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

export const IconMinus = ({ size = 14, className, strokeWidth = 2 }: IconProps) => (
  <svg {...base(size, strokeWidth)} className={className}>
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);
