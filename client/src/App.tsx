import { Switch, Route, Redirect, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Config from "@/pages/config";
import LeadCleaner from "@/pages/lead-cleaner";
import Dashboard from "@/pages/dashboard";
import WebhookSettings from "@/pages/webhook-settings";
import ChatPage from "@/pages/chat";
import BotPage from "@/pages/bot";
import CampaignsPage from "@/pages/campaigns";
import CampaignWizardPage from "@/pages/campaign-wizard";
import CampaignDetailPage from "@/pages/campaign-detail";
import LoginPage from "@/pages/login";
import RegisterPage from "@/pages/register";
import PendingPage from "@/pages/pending";
import AdminPage from "@/pages/admin";
import SettingsPage from "@/pages/settings";
import PrivacyPolicyPage from "@/pages/privacy-policy";
import NumberHealthPage from "@/pages/number-health";
import VoiceProfilesPage from "@/pages/voice-profiles";
import { TopNav } from "@/components/TopNav";
import { AppSidebar } from "@/components/AppSidebar";
import { WabaProvider } from "@/contexts/WabaContext";
import { useAuth } from "@/hooks/useAuth";

function AuthRouter() {
  return (
    <Switch>
      <Route path="/login" component={LoginPage} />
      <Route path="/register" component={RegisterPage} />
      <Route path="/pending" component={PendingPage} />
      <Route>
        <Redirect to="/login" />
      </Route>
    </Switch>
  );
}

function ProtectedAdminRoute() {
  const { isAdmin } = useAuth();
  if (!isAdmin) {
    return <Redirect to="/campaigns" />;
  }
  return <AdminPage />;
}

function AppRouter() {
  return (
    <Switch>
      <Route path="/">
        <Redirect to="/campaigns" />
      </Route>
      <Route path="/dashboard" component={Dashboard} />
      <Route path="/campaigns" component={CampaignsPage} />
      <Route path="/campaigns/:id/wizard" component={CampaignWizardPage} />
      <Route path="/campaigns/:id" component={CampaignDetailPage} />
      <Route path="/config" component={Config} />
      <Route path="/lead-cleaner" component={LeadCleaner} />
      <Route path="/webhook" component={WebhookSettings} />
      <Route path="/chat" component={ChatPage} />
      <Route path="/bot" component={BotPage} />
      <Route path="/admin" component={ProtectedAdminRoute} />
      <Route path="/settings" component={SettingsPage} />
      <Route path="/number-health" component={NumberHealthPage} />
      <Route path="/voices" component={VoiceProfilesPage} />
      <Route path="/login">
        <Redirect to="/campaigns" />
      </Route>
      <Route path="/register">
        <Redirect to="/campaigns" />
      </Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function AppContent() {
  const { user, isLoading, isAuthenticated } = useAuth();
  const [location] = useLocation();

  if (location === "/privacy-policy") {
    return <PrivacyPolicyPage />;
  }

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F5F7FA]">
        <div className="text-[#718096] text-lg">Carregando...</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <AuthRouter />;
  }

  if (user?.status === "pending") {
    if (location !== "/pending") {
      return <Redirect to="/pending" />;
    }
    return <PendingPage />;
  }

  return (
    <WabaProvider>
      <div className="min-h-screen bg-[#F5F7FA]">
        <AppSidebar />
        <TopNav />
        <main className="lg:ml-[240px] pt-16 min-h-screen">
          <Toaster />
          <AppRouter />
        </main>
      </div>
    </WabaProvider>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <AppContent />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
