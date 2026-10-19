import type { CSSProperties, MouseEvent } from "react";

export interface AppNavItem {
  id: string;
  label: string;
  href?: string;
  icon?: string;
  color?: string;
  home?: boolean;
  count?: number;
}

export interface AppNavProps {
  title: string;
  icon?: string;
  groups: { label?: string; items: AppNavItem[] }[];
  active?: string;
  onNavigate: (item: AppNavItem) => void;
}

const styles = `
.cn-nav{display:flex;flex-direction:column;align-self:stretch;min-height:0;flex-shrink:0}
.cn-nav-brand,.cn-nav-item{display:flex;align-items:center;text-decoration:none;white-space:nowrap}
.cn-nav-brand{gap:.5rem;flex-shrink:0}
.cn-nav-groups{flex:1;overflow:auto}
.cn-nav-item svg,.cn-nav-brand svg{width:1.125rem;height:1.125rem;flex-shrink:0}
.cn-nav-label{overflow:hidden;text-overflow:ellipsis}
.cn-nav-count{margin-left:auto}
.cn-nav-icon{display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;color:var(--nav-icon-color,currentColor)}
.cn-nav-footer{flex-shrink:0}
@media(min-width:768px){
[data-nav-collapsed] .cn-nav-label,[data-nav-collapsed] .cn-nav-count,[data-nav-collapsed] .cn-nav-eyebrow{display:none}
[data-nav-collapsed] .cn-nav-brand,[data-nav-collapsed] .cn-nav-item{justify-content:center;padding-left:0;padding-right:0}
}
@media(max-width:767px){
.cn-nav{flex-direction:row;max-width:100vw;overflow-x:auto;border-bottom:1px solid var(--sidebar-border)}
.cn-nav-brand{display:none}
.cn-nav-groups,.cn-nav-group{display:flex;align-items:center;gap:.25rem;overflow:visible}
.cn-nav-groups{padding:.5rem}
.cn-nav-eyebrow,.cn-nav-footer{display:none}
.cn-nav-item{flex-shrink:0}
}
`;

const paths: Record<string, string> = {
  contact: "M4 3h16v18H4z M8 16c0-4 8-4 8 0 M12 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6",
  users: "M3 20v-3c0-5 12-5 12 0v3 M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M17 4c4 0 4 6 0 6 M18 13c3 0 4 2 4 5",
  "building-2": "M4 21V3h11v18 M15 9h5v12 M8 7h3 M8 11h3 M8 15h3 M2 21h20",
  "dollar-sign": "M12 2v20 M18 6H9a4 4 0 0 0 0 8h6a4 4 0 0 1 0 8H6",
  activity: "M2 12h5l3-9 4 18 3-9h5",
  layers: "M2 7l10-5 10 5-10 5z M2 12l10 5 10-5 M2 17l10 5 10-5",
  mail: "M3 5h18v14H3z M3 5l9 7 9-7",
  calendar: "M3 5h18v16H3z M3 10h18 M7 2v6 M17 2v6",
};
const colors: Record<string, string> = { blue: "#2563eb", violet: "#7c3aed", green: "#15803d", orange: "#c2410c" };

function Icon({ name }: { name?: string }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name ?? "contact"] ?? paths.contact} /></svg>;
}

export function AppNav({ title, icon, groups, active, onNavigate }: AppNavProps) {
  const home = groups.flatMap((group) => group.items).find((item) => item.home);
  const navigate = (event: MouseEvent<HTMLAnchorElement>, item: AppNavItem) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onNavigate(item);
  };
  return <aside className="cn-nav" aria-label={`${title} navigation`}>
    <style>{styles}</style>
    <a className="cn-nav-brand" href={home?.href ?? "/"} onClick={(event) => navigate(event, home ?? { id: "home", label: title, href: "/" })} title={title}>
      <Icon name={icon} /><span className="cn-nav-label">{title}</span>
    </a>
    <nav className="cn-nav-groups" aria-label="Main">
      {groups.map((group, index) => <div className="cn-nav-group" key={group.label ?? index}>
        {group.label && <div className="cn-nav-eyebrow">{group.label}</div>}
        {group.items.filter((item) => !item.home).map((item) => <a
          key={item.id} className="cn-nav-item" href={item.href ?? "/"}
          data-active={active === item.id ? "" : undefined}
          aria-current={active === item.id ? "page" : undefined}
          title={item.label} onClick={(event) => navigate(event, item)}
        >
          <span className="cn-nav-icon" style={{ "--nav-icon-color": colors[item.color ?? ""] } as CSSProperties}><Icon name={item.icon} /></span>
          <span className="cn-nav-label">{item.label}</span>
          {item.count !== undefined && <span className="cn-nav-count">{item.count}</span>}
        </a>)}
      </div>)}
    </nav>
    <div className="cn-nav-footer" />
  </aside>;
}

export function reportLocation(_path: string): void {}
export function useHostNavigate(_fn: (path: string) => void): void {}
export function useHostChanges(_fn: () => void): void {}
export function openChat(_text: string): void {}
export function useChatContext(_context: { label: string; record: { type: string; id: string; label: string } } | null): void {}
export function useHasChat(): boolean { return false; }
