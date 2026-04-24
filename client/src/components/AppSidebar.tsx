import { useState, useEffect, useRef } from "react";
import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { useWaba } from "@/contexts/WabaContext";
import { useAuth } from "@/hooks/useAuth";
import { 
  Menu, X, ChevronDown, Bot, Megaphone, Gauge, MessageCircle, Globe, ScrollText, Phone, Shield, Thermometer, Mic
} from "lucide-react";
import overdriveLogo from "@assets/overdrive-logo-v4.png";

interface SidebarSection {
  label: string;
  items: SidebarItem[];
}

interface SidebarItem {
  href: string;
  icon: React.ComponentType<{ className?: string; size?: string | number }>;
  label: string;
}

const sidebarSections: SidebarSection[] = [
  {
    label: "CAMPANHAS",
    items: [
      { href: "/campaigns", icon: Megaphone, label: "Campanhas" },
    ],
  },
  {
    label: "COMUNICAÇÃO",
    items: [
      { href: "/chat", icon: MessageCircle, label: "Conversas" },
      { href: "/bot", icon: Bot, label: "Bot Automático" },
      { href: "/voices", icon: Mic, label: "Perfis de Voz TTS" },
    ],
  },
  {
    label: "MONITORAMENTO",
    items: [
      { href: "/dashboard", icon: Gauge, label: "Dashboard" },
      { href: "/number-health", icon: Thermometer, label: "Saúde dos Números" },
    ],
  },
  {
    label: "CONFIGURAÇÕES",
    items: [
      { href: "/config", icon: Phone, label: "Números / WABAs" },
      { href: "/webhook", icon: Globe, label: "Webhook & Deploy" },
      { href: "/lead-cleaner", icon: ScrollText, label: "Preparar Lista" },
    ],
  },
];

export function AppSidebar() {
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const [wabaDropdownOpen, setWabaDropdownOpen] = useState(false);
  const { wabasList, activeWabaId, setActiveWabaId } = useWaba();
  const { isAdmin } = useAuth();

  useEffect(() => {
    setMobileOpen(false);
  }, [location]);

  useEffect(() => {
    if (!mobileOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (sidebarRef.current && !sidebarRef.current.contains(e.target as Node)) {
        setMobileOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [mobileOpen]);

  useEffect(() => {
    if (mobileOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [mobileOpen]);

  const activeWaba = wabasList.find((w: any) => w.id === activeWabaId) || wabasList[0];

  const isItemActive = (href: string) => {
    if (href === "/campaigns") return location === "/campaigns" || location.startsWith("/campaigns/");
    return location === href || location.startsWith(href + "/");
  };

  const sidebarContent = (
    <>
      <div className="px-5 py-6 flex items-center justify-between">
        <img src={overdriveLogo} alt="Overdrive" className="w-full h-auto object-contain max-w-[180px]" />
        <button 
          onClick={() => setMobileOpen(false)} 
          className="lg:hidden p-2 text-[#718096] hover:text-[#1A202C] min-w-[44px] min-h-[44px] flex items-center justify-center"
        >
          <X size={20} />
        </button>
      </div>

      {wabasList.length > 0 && (
        <div className="px-3 mb-2">
          <div
            className="flex items-center justify-between px-3 py-2 bg-[#F7FAFC] rounded-lg cursor-pointer hover:bg-[#EDF2F7] transition-colors"
            onClick={() => setWabaDropdownOpen(!wabaDropdownOpen)}
          >
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-2 h-2 rounded-full bg-[#38A169] flex-shrink-0" />
              <span className="text-xs font-medium text-[#4A5568] truncate">
                {activeWaba?.name?.trim() || activeWaba?.wabaId || "Selecionar WABA"}
              </span>
            </div>
            <ChevronDown size={14} className={cn("text-[#A0AEC0] transition-transform", wabaDropdownOpen && "rotate-180")} />
          </div>
          {wabaDropdownOpen && wabasList.length > 1 && (
            <div className="mt-1 bg-white border border-[#E2E8F0] rounded-lg shadow-lg overflow-hidden">
              {wabasList.map((w: any) => (
                <div
                  key={w.id}
                  className={cn(
                    "px-3 py-2 text-xs cursor-pointer hover:bg-[#F7FAFC] transition-colors",
                    w.id === activeWabaId ? "bg-[#EBF8FF] text-[#0066FF]" : "text-[#4A5568]"
                  )}
                  onClick={() => {
                    setActiveWabaId(w.id);
                    setWabaDropdownOpen(false);
                  }}
                >
                  {w.name?.trim() || w.wabaId}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <nav className="flex-1 px-3 mt-1 overflow-y-auto">
        {sidebarSections.map((section) => (
          <div key={section.label} className="mb-3">
            <div className="px-4 py-1.5">
              <span className="text-[10px] font-semibold text-[#A0AEC0] uppercase tracking-widest">
                {section.label}
              </span>
            </div>
            <div className="space-y-0.5">
              {section.items.map((item) => {
                const Icon = item.icon;
                const isActive = isItemActive(item.href);
                return (
                  <Link key={item.href} href={item.href}>
                    <div
                      className={cn(
                        "flex items-center gap-3 px-4 py-2.5 rounded-lg text-[14px] font-medium cursor-pointer transition-all duration-200",
                        isActive 
                          ? "bg-[#0066FF]/[0.08] text-[#0066FF]" 
                          : "text-[#64748B] hover:text-[#1A202C] hover:bg-[#F7FAFC]"
                      )}
                    >
                      <Icon size={18} className={isActive ? "text-[#0066FF]" : "text-[#94A3B8]"} />
                      <span>{item.label}</span>
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {isAdmin && (
        <nav className="px-3 mb-3">
          <div className="mb-1">
            <div className="px-4 py-1.5">
              <span className="text-[10px] font-semibold text-[#A0AEC0] uppercase tracking-widest">
                ADMINISTRAÇÃO
              </span>
            </div>
            <Link href="/admin">
              <div
                className={cn(
                  "flex items-center gap-3 px-4 py-2.5 rounded-lg text-[14px] font-medium cursor-pointer transition-all duration-200",
                  isItemActive("/admin")
                    ? "bg-[#0066FF]/[0.08] text-[#0066FF]"
                    : "text-[#64748B] hover:text-[#1A202C] hover:bg-[#F7FAFC]"
                )}
              >
                <Shield size={18} className={isItemActive("/admin") ? "text-[#0066FF]" : "text-[#94A3B8]"} />
                <span>Usuários</span>
              </div>
            </Link>
          </div>
        </nav>
      )}

    </>
  );

  return (
    <>
      <button
        onClick={() => setMobileOpen(true)}
        className="lg:hidden fixed top-3 left-3 z-50 p-2.5 rounded-lg bg-white border border-[#E2E8F0] shadow-sm text-[#718096] hover:text-[#1A202C] min-w-[44px] min-h-[44px] flex items-center justify-center"
        aria-label="Abrir menu"
      >
        <Menu size={20} />
      </button>

      <div className="hidden lg:flex saas-sidebar flex-col h-screen w-[240px] fixed left-0 top-0 z-30">
        {sidebarContent}
      </div>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/30" />
          <div 
            ref={sidebarRef}
            className="absolute left-0 top-0 h-full w-[260px] bg-white border-r border-[#E2E8F0] shadow-xl flex flex-col animate-slide-in"
          >
            {sidebarContent}
          </div>
        </div>
      )}
    </>
  );
}
