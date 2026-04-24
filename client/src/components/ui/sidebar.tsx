import * as React from "react";
import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { 
  BarChart3, 
  Settings, 
  MessageSquare, 
  Users, 
  Home,
  MessageCircle
} from "lucide-react";

const SidebarContext = React.createContext<{
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
}>({
  collapsed: false,
  setCollapsed: () => {},
});

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = React.useState(false);
  
  return (
    <SidebarContext.Provider value={{ collapsed, setCollapsed }}>
      {children}
    </SidebarContext.Provider>
  );
}

export function AppSidebar() {
  const [location] = useLocation();
  
  const navigation = [
    { name: "Dashboard", href: "/", icon: Home },
    { name: "Importar Leads", href: "/leads", icon: Users },
    { name: "Templates", href: "/templates", icon: MessageSquare },
    { name: "Registrar Números", href: "/config", icon: Settings },
    { name: "Relatórios", href: "/reports", icon: BarChart3 },
  ];

  return (
    <div className="w-64 bg-white shadow-lg border-r border-gray-200">
      {/* Logo Section */}
      <div className="px-6 py-4 border-b border-gray-200">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 bg-primary rounded-lg flex items-center justify-center">
            <MessageCircle className="text-white" size={20} />
          </div>
          <div>
            <h1 className="text-lg font-bold text-gray-900">WA Dispatcher</h1>
            <p className="text-sm text-gray-500">Business System</p>
          </div>
        </div>
      </div>

      {/* Navigation Menu */}
      <nav className="px-4 py-6">
        <ul className="space-y-2">
          {navigation.map((item) => {
            const isActive = location === item.href;
            const Icon = item.icon;
            
            return (
              <li key={item.name}>
                <Link
                  href={item.href}
                  className={cn(
                    "flex items-center px-4 py-3 rounded-lg font-medium transition-colors",
                    isActive
                      ? "text-primary bg-blue-50"
                      : "text-gray-700 hover:bg-gray-100"
                  )}
                >
                  <Icon className="mr-3" size={18} />
                  {item.name}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
