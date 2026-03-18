import { Blocks, Brain, ChartColumnBig, LayoutDashboard, MessagesSquare } from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";
import { prefetchRoute } from "../route-prefetch";

const navItems = [
  { to: "/", label: "Dashboard", end: true, icon: LayoutDashboard },
  { to: "/sessions", label: "Sessions", icon: MessagesSquare },
  { to: "/memory", label: "Memory", icon: Brain },
  { to: "/integrations", label: "Integrations", icon: Blocks },
  { to: "/tokens", label: "Tokens", icon: ChartColumnBig }
];

export function AppShell() {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <h1>Harness-Monitor</h1>
        </div>

        <nav className="sidebar-nav">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              title={item.label}
              aria-label={item.label}
              onMouseEnter={() => {
                void prefetchRoute(item.to);
              }}
              onFocus={() => {
                void prefetchRoute(item.to);
              }}
              className={({ isActive }) => isActive ? "nav-link active" : "nav-link"}
            >
              <item.icon size={16} strokeWidth={2.2} aria-hidden="true" />
              <span className="nav-label">{item.label}</span>
            </NavLink>
          ))}
        </nav>
      </aside>

      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
