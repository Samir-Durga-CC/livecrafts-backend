import type { ReactNode } from "react";

interface P { size?: number; className?: string }
const svg = (paths: ReactNode, { size = 18, className }: P) => (
  <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths}</svg>
);

export const Icon = {
  Search: (p: P) => svg(<><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>, p),
  Sidebar: (p: P) => svg(<><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16" /></>, p),
  Plus: (p: P) => svg(<path d="M12 5v14M5 12h14" />, p),
  Chat: (p: P) => svg(<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />, p),
  Globe: (p: P) => svg(<><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>, p),
  Pin: (p: P) => svg(<path d="M12 17v5M9 3h6l-1 6 3 3H7l3-3z" />, p),
  ChevronDown: (p: P) => svg(<path d="m6 9 6 6 6-6" />, p),
  ChevronUp: (p: P) => svg(<path d="m6 15 6-6 6 6" />, p),
  ChevronRight: (p: P) => svg(<path d="m9 6 6 6-6 6" />, p),
  Copy: (p: P) => svg(<><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" /></>, p),
  Edit: (p: P) => svg(<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />, p),
  Retry: (p: P) => svg(<path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5" />, p),
  Share: (p: P) => svg(<path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v14" />, p),
  External: (p: P) => svg(<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />, p),
  More: (p: P) => svg(<><circle cx="12" cy="5" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="12" cy="19" r="1.2" /></>, p),
  Close: (p: P) => svg(<path d="M18 6 6 18M6 6l12 12" />, p),
  Clip: (p: P) => svg(<path d="M21.4 11.6 12.2 20.8a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />, p),
  Image: (p: P) => svg(<><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></>, p),
  Sparkle: (p: P) => svg(<><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /><path d="M19 15l.7 2.1L22 18l-2.3.9L19 21l-.7-2.1L16 18l2.3-.9z" /></>, p),
  Send: (p: P) => svg(<path d="M12 19V5M5 12l7-7 7 7" />, p),
  Check: (p: P) => svg(<path d="M20 6 9 17l-5-5" />, p),
  Shield: (p: P) => svg(<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />, p),
  List: (p: P) => svg(<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />, p),
  Text: (p: P) => svg(<path d="M4 7V4h16v3M9 20h6M12 4v16" />, p),
  Link: (p: P) => svg(<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />, p),
  Key: (p: P) => svg(<><circle cx="8" cy="15" r="4" /><path d="m11 12 9-9M16 7l3 3" /></>, p),
  Plug: (p: P) => svg(<path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0zM12 17v5" />, p),
  Code: (p: P) => svg(<path d="m16 18 6-6-6-6M8 6l-6 6 6 6" />, p),
  Eye: (p: P) => svg(<><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>, p),
  Monitor: (p: P) => svg(<><rect x="2" y="4" width="20" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></>, p),
  Tablet: (p: P) => svg(<><rect x="5" y="2" width="14" height="20" rx="2" /><path d="M11 18h2" /></>, p),
  Phone: (p: P) => svg(<><rect x="7" y="2" width="10" height="20" rx="2" /><path d="M11 18h2" /></>, p),
  Page: (p: P) => svg(<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></>, p),
  Menu: (p: P) => svg(<path d="M4 6h16M4 12h16M4 18h10" />, p),
  Folder: (p: P) => svg(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />, p),
};
