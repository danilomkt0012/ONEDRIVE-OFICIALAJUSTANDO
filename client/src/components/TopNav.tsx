import { useLocation } from "wouter";
import { Phone, ScrollText, Globe, MessageCircle, Megaphone, Gauge, Bot, Shield, Settings, type LucideIcon } from "lucide-react";
import { UserProfileMenu } from "./UserProfileMenu";

interface PageInfo {
  title: string;
  subtitle: string;
  icon: LucideIcon;
}

const pages: Record<string, PageInfo> = {
  "/campaigns": { title: "Campanhas", subtitle: "Gerencie todas as suas campanhas de disparo", icon: Megaphone },
  "/config": { title: "Números / WABAs", subtitle: "Registre e gerencie seus números e contas WhatsApp", icon: Phone },
  "/lead-cleaner": { title: "Preparar Lista", subtitle: "Importe, organize e formate sua lista de contatos", icon: ScrollText },
  "/webhook": { title: "Webhook & Deploy", subtitle: "Status do servidor e configuração do webhook Meta", icon: Globe },
  "/chat": { title: "Conversas", subtitle: "Chat em tempo real com seus contatos WhatsApp", icon: MessageCircle },
  "/bot": { title: "Bot Automático", subtitle: "Configure respostas automáticas por palavras-chave", icon: Bot },
  "/dashboard": { title: "Dashboard", subtitle: "Monitoramento global de campanhas e qualidade de envio", icon: Gauge },
  "/admin": { title: "Administração", subtitle: "Gerenciar usuários e permissões", icon: Shield },
  "/settings": { title: "Configurações", subtitle: "Gerencie seu perfil e preferências da conta", icon: Settings },
};

const defaultPage: PageInfo = { title: "Campanhas", subtitle: "Gerencie todas as suas campanhas de disparo", icon: Megaphone };

function resolvePageInfo(location: string): PageInfo {
  if (pages[location]) return pages[location];
  if (location.startsWith("/campaigns/") && location.endsWith("/wizard")) {
    return { title: "Configurar Campanha", subtitle: "", icon: Megaphone };
  }
  if (location.startsWith("/campaigns/")) {
    return { title: "Painel da Campanha", subtitle: "Métricas, chat, contatos e logs", icon: Megaphone };
  }
  return defaultPage;
}

export function TopNav() {
  const [location] = useLocation();
  const page = resolvePageInfo(location);
  const Icon = page.icon;

  return (
    <header className="saas-topbar h-16 flex items-center justify-between px-4 sm:px-8 fixed top-0 right-0 left-0 lg:left-[240px] z-20">
      <div className="flex items-center gap-3 ml-10 lg:ml-0">
        <div className="w-8 h-8 rounded-lg bg-[#F7FAFC] border border-[#E2E8F0] flex items-center justify-center flex-shrink-0">
          <Icon size={15} className="text-[#64748B]" />
        </div>
        <div className="flex flex-col sm:flex-row sm:items-baseline sm:gap-3 min-w-0">
          <h1 className="text-[15px] font-semibold text-[#1A202C] tracking-tight whitespace-nowrap">{page.title}</h1>
          <span className="text-[12px] sm:text-[13px] text-[#A0AEC0] font-normal hidden md:inline truncate">{page.subtitle}</span>
        </div>
      </div>
      <UserProfileMenu />
    </header>
  );
}
