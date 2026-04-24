import { useState, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { ChevronDown, Settings, User, LogOut } from "lucide-react";

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((n) => n[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export function UserProfileMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [, navigate] = useLocation();

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  if (!user) return null;

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg hover:bg-[#F7FAFC] transition-colors"
      >
        <div className="w-8 h-8 rounded-full bg-[#0066FF] flex items-center justify-center text-white text-[12px] font-semibold flex-shrink-0">
          {user.avatar ? (
            <img src={user.avatar} alt={user.username} className="w-full h-full rounded-full object-cover" />
          ) : (
            getInitials(user.username)
          )}
        </div>
        <span className="text-[13px] font-medium text-[#1A202C] hidden sm:inline">{user.username}</span>
        <ChevronDown size={14} className={cn("text-[#A0AEC0] transition-transform flex-shrink-0", open && "rotate-180")} />
      </button>

      {open && (
        <div className="absolute top-full right-0 mt-1 w-48 bg-white border border-[#E2E8F0] rounded-lg shadow-lg overflow-hidden z-50">
          <button
            onClick={() => { setOpen(false); navigate("/settings"); window.location.hash = "profile"; }}
            className="w-full flex items-center gap-2.5 px-4 py-2.5 text-[13px] text-[#4A5568] hover:bg-[#F7FAFC] transition-colors text-left"
          >
            <User size={15} className="text-[#94A3B8]" />
            Perfil
          </button>
          <button
            onClick={() => { setOpen(false); navigate("/settings"); window.location.hash = "account"; }}
            className="w-full flex items-center gap-2.5 px-4 py-2.5 text-[13px] text-[#4A5568] hover:bg-[#F7FAFC] transition-colors text-left"
          >
            <Settings size={15} className="text-[#94A3B8]" />
            Configurações
          </button>
          <div className="border-t border-[#E2E8F0]" />
          <button
            onClick={() => { setOpen(false); logout.mutate(); }}
            className="w-full flex items-center gap-2.5 px-4 py-2.5 text-[13px] text-red-500 hover:bg-red-50 transition-colors text-left"
          >
            <LogOut size={15} />
            Sair da conta
          </button>
        </div>
      )}
    </div>
  );
}
