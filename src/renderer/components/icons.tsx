/**
 * Inline SVG icons (no icon library is installed). 24×24 stroke icons drawn with currentColor,
 * decorative by default: pair them with visible text or an aria-label on the control.
 */
import type { ReactNode, SVGProps } from 'react';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  size?: number;
}

function makeIcon(name: string, children: ReactNode, opts: { fill?: boolean } = {}) {
  function Icon({ size = 16, strokeWidth = 1.75, ...rest }: IconProps) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill={opts.fill ? 'currentColor' : 'none'}
        stroke={opts.fill ? 'none' : 'currentColor'}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        {...rest}
      >
        {children}
      </svg>
    );
  }
  Icon.displayName = `${name}Icon`;
  return Icon;
}

export const HashIcon = makeIcon('Hash', <path d="M5 9h14M5 15h14M10 4 8 20M16 4l-2 16" />);
export const LockIcon = makeIcon(
  'Lock',
  <>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </>,
);
export const ArchiveIcon = makeIcon(
  'Archive',
  <>
    <rect x="3" y="4" width="18" height="5" rx="1" />
    <path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4" />
  </>,
);
export const SearchIcon = makeIcon(
  'Search',
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </>,
);
/** A dashboard: the Overview page. */
export const OverviewIcon = makeIcon(
  'Overview',
  <>
    <rect x="3.5" y="3.5" width="7" height="9" rx="1.5" />
    <rect x="13.5" y="3.5" width="7" height="5" rx="1.5" />
    <rect x="13.5" y="11.5" width="7" height="9" rx="1.5" />
    <rect x="3.5" y="15.5" width="7" height="5" rx="1.5" />
  </>,
);
export const FilterIcon = makeIcon('Filter', <path d="M4 6.5h16M7 12h10M10 17.5h4" />);
export const HomeIcon = makeIcon(
  'Home',
  <>
    <path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1z" />
  </>,
);
export const ChevronDownIcon = makeIcon('ChevronDown', <path d="m6 9 6 6 6-6" />);
export const ChevronRightIcon = makeIcon('ChevronRight', <path d="m9 6 6 6-6 6" />);
export const ChevronLeftIcon = makeIcon('ChevronLeft', <path d="m15 6-6 6 6 6" />);
export const CloseIcon = makeIcon('Close', <path d="M6 6l12 12M18 6 6 18" />);
export const LinkIcon = makeIcon(
  'Link',
  <>
    <path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1" />
    <path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1" />
  </>,
);
export const CheckIcon = makeIcon('Check', <path d="m5 12.5 4.5 4.5L19 7.5" />);
export const DownloadIcon = makeIcon('Download', <path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 20h14" />);
export const ExternalLinkIcon = makeIcon(
  'ExternalLink',
  <path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />,
);
export const FileIcon = makeIcon(
  'File',
  <>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </>,
);
export const FileTextIcon = makeIcon(
  'FileText',
  <>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5M9 13h6M9 17h6" />
  </>,
);
export const FileCodeIcon = makeIcon(
  'FileCode',
  <>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5M10 12.5 8 15l2 2.5M14 12.5l2 2.5-2 2.5" />
  </>,
);
export const FileArchiveIcon = makeIcon(
  'FileArchive',
  <>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5M11 5h1M11 8h1M11 11h1M10.5 14h2v3h-2z" />
  </>,
);
export const ImageIcon = makeIcon(
  'Image',
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="9" cy="10" r="1.75" />
    <path d="m21 16-5-5-9 9" />
  </>,
);
export const FilmIcon = makeIcon(
  'Film',
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4" />
  </>,
);
export const MusicIcon = makeIcon(
  'Music',
  <>
    <path d="M9 18V6l11-2v12" />
    <circle cx="6.5" cy="18" r="2.5" />
    <circle cx="17.5" cy="16" r="2.5" />
  </>,
);
export const SunIcon = makeIcon(
  'Sun',
  <>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </>,
);
export const MoonIcon = makeIcon('Moon', <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />);
export const MonitorIcon = makeIcon(
  'Monitor',
  <>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8M12 16v4" />
  </>,
);
export const MenuIcon = makeIcon('Menu', <path d="M4 7h16M4 12h16M4 17h16" />);
export const CalendarIcon = makeIcon(
  'Calendar',
  <>
    <rect x="3.5" y="5" width="17" height="15" rx="2" />
    <path d="M3.5 10h17M8 3v4M16 3v4" />
  </>,
);
export const ThreadIcon = makeIcon(
  'Thread',
  <path d="M20 12a8 8 0 0 1-11.7 7.1L4 20l1-4.1A8 8 0 1 1 20 12zM8.5 10.5h7M8.5 13.5h4.5" />,
);
export const UsersIcon = makeIcon(
  'Users',
  <>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
    <path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14a6.5 6.5 0 0 1 3.5 6" />
  </>,
);
export const UserIcon = makeIcon(
  'User',
  <>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21a8 8 0 0 1 16 0" />
  </>,
);
export const HistoryIcon = makeIcon(
  'History',
  <>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5M12 7v5l3 2" />
  </>,
);
export const TrashIcon = makeIcon('Trash', <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" />);
export const AlertIcon = makeIcon(
  'Alert',
  <>
    <path d="M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    <path d="M12 9v4.5M12 17h.01" />
  </>,
);
export const SyncIcon = makeIcon(
  'Sync',
  <>
    <path d="M20 11a8 8 0 0 0-14.3-4.9L4 8" />
    <path d="M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16" />
    <path d="M20 20v-4h-4" />
  </>,
);
export const ArrowDownIcon = makeIcon('ArrowDown', <path d="M12 5v14m0 0-6-6m6 6 6-6" />);
export const ArrowUpIcon = makeIcon('ArrowUp', <path d="M12 19V5m0 0-6 6m6-6 6 6" />);
export const PencilIcon = makeIcon('Pencil', <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16zM13.5 6.5l4 4" />);
export const EyeOffIcon = makeIcon(
  'EyeOff',
  <>
    <path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c5 0 8.5 4 9.5 7a13 13 0 0 1-2.7 4M6.6 6.6A13 13 0 0 0 2.5 12c1 3 4.5 7 9.5 7a9.9 9.9 0 0 0 5.4-1.6" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
  </>,
);
export const CornerDownRightIcon = makeIcon('CornerDownRight', <path d="M5 4v7a4 4 0 0 0 4 4h10m0 0-4-4m4 4-4 4" />);
export const DotIcon = makeIcon('Dot', <circle cx="12" cy="12" r="4" />, { fill: true });

// Added for the search and archive-home pages.
export const SmileIcon = makeIcon(
  'Smile',
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01" />
  </>,
);
export const ListIcon = makeIcon('List', <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />);
export const LayersIcon = makeIcon(
  'Layers',
  <>
    <path d="m12 3 9 5-9 5-9-5z" />
    <path d="m3 13 9 5 9-5" />
  </>,
);
export const FolderIcon = makeIcon(
  'Folder',
  <path d="M3.5 7a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />,
);
export const CopyIcon = makeIcon(
  'Copy',
  <>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" />
  </>,
);
export const DatabaseIcon = makeIcon(
  'Database',
  <>
    <ellipse cx="12" cy="6" rx="7.5" ry="3" />
    <path d="M4.5 6v12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3" />
  </>,
);
export const ClockIcon = makeIcon(
  'Clock',
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </>,
);
export const MessageIcon = makeIcon(
  'Message',
  <path d="M5 5h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-8l-5 4v-4H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" />,
);
export const KeyIcon = makeIcon(
  'Key',
  <>
    <circle cx="8" cy="15" r="4" />
    <path d="m11 12 8.5-8.5M16 7l2.5 2.5M14 9l2 2" />
  </>,
);
export const TerminalIcon = makeIcon(
  'Terminal',
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="m7 9 3 3-3 3M13 15h4" />
  </>,
);

// Added for Settings and the Slack connection.
export const SettingsIcon = makeIcon(
  'Settings',
  <>
    <path d="M10.3 3.4a1.8 1.8 0 0 1 3.4 0l.3.9a1.8 1.8 0 0 0 2.5 1l.8-.4a1.8 1.8 0 0 1 2.4 2.4l-.4.8a1.8 1.8 0 0 0 1 2.5l.9.3a1.8 1.8 0 0 1 0 3.4l-.9.3a1.8 1.8 0 0 0-1 2.5l.4.8a1.8 1.8 0 0 1-2.4 2.4l-.8-.4a1.8 1.8 0 0 0-2.5 1l-.3.9a1.8 1.8 0 0 1-3.4 0l-.3-.9a1.8 1.8 0 0 0-2.5-1l-.8.4a1.8 1.8 0 0 1-2.4-2.4l.4-.8a1.8 1.8 0 0 0-1-2.5l-.9-.3a1.8 1.8 0 0 1 0-3.4l.9-.3a1.8 1.8 0 0 0 1-2.5l-.4-.8a1.8 1.8 0 0 1 2.4-2.4l.8.4a1.8 1.8 0 0 0 2.5-1z" />
    <circle cx="12" cy="12" r="3" />
  </>,
);
export const GlobeIcon = makeIcon(
  'Globe',
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
  </>,
);
export const PlugIcon = makeIcon('Plug', <path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4" />);
export const LogOutIcon = makeIcon(
  'LogOut',
  <path d="M9 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h3M16 16l4-4-4-4M20 12H9" />,
);
export const InfoIcon = makeIcon(
  'Info',
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </>,
);
export const ArrowRightIcon = makeIcon('ArrowRight', <path d="M5 12h14m0 0-6-6m6 6-6 6" />);
