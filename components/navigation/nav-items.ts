import {
  BookOpen,
  ChartNoAxesColumn,
  GraduationCap,
  LayoutDashboard,
  Settings,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  title: string;
  href: string;
  icon: LucideIcon;
};

/**
 * Single source of truth for primary navigation — used by both the desktop
 * sidebar and the mobile bottom navigation. Do not duplicate routes/labels.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { title: "Dashboard", href: "/", icon: LayoutDashboard },
  { title: "Study", href: "/study", icon: GraduationCap },
  { title: "Library", href: "/library", icon: BookOpen },
  { title: "Progress", href: "/progress", icon: ChartNoAxesColumn },
  { title: "Settings", href: "/settings", icon: Settings },
];

export function isActiveRoute(pathname: string, href: string): boolean {
  if (href === "/") {
    return pathname === "/";
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}
