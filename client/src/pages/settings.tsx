import { useState, useEffect, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { User, Lock, Eye, EyeOff, Check, AlertCircle, Sliders, Camera } from "lucide-react";

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((n) => n[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function ProfileSection() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [username, setUsername] = useState(user?.username || "");
  const [email, setEmail] = useState(user?.email || "");
  const [phone, setPhone] = useState(user?.phone || "");
  const [avatar, setAvatar] = useState(user?.avatar || "");
  const [successMsg, setSuccessMsg] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const updateProfile = useMutation({
    mutationFn: async (data: { username: string; email: string; phone: string; avatar: string }) => {
      const res = await fetch("/api/auth/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.message);
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      setSuccessMsg("Perfil atualizado com sucesso");
      setErrorMsg("");
      setTimeout(() => setSuccessMsg(""), 3000);
    },
    onError: (error: Error) => {
      setErrorMsg(error.message);
      setSuccessMsg("");
    },
  });

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadingAvatar(true);
    setErrorMsg("");
    try {
      const formData = new FormData();
      formData.append('avatar', file);
      const res = await fetch("/api/auth/avatar", {
        method: "POST",
        credentials: "include",
        body: formData,
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.message);
      setAvatar(result.avatarUrl);
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      setSuccessMsg("Foto atualizada com sucesso");
      setTimeout(() => setSuccessMsg(""), 3000);
    } catch (err: any) {
      setErrorMsg(err.message || "Erro ao fazer upload da foto");
    } finally {
      setUploadingAvatar(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg("");
    setSuccessMsg("");
    updateProfile.mutate({ username, email, phone, avatar });
  };

  return (
    <div className="bg-white rounded-xl border border-[#E2E8F0] p-6">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-lg bg-[#EBF8FF] flex items-center justify-center">
          <User size={18} className="text-[#0066FF]" />
        </div>
        <div>
          <h2 className="text-[16px] font-semibold text-[#1A202C]">Dados Pessoais</h2>
          <p className="text-[13px] text-[#A0AEC0]">Atualize suas informações de perfil</p>
        </div>
      </div>

      <div className="flex items-center gap-4 mb-6 p-4 bg-[#F7FAFC] rounded-lg">
        <div className="relative group cursor-pointer" onClick={() => fileInputRef.current?.click()}>
          <div className="w-16 h-16 rounded-full bg-[#0066FF] flex items-center justify-center text-white text-xl font-semibold flex-shrink-0 overflow-hidden">
            {(avatar || user?.avatar) ? (
              <img src={avatar || user?.avatar || undefined} alt={user?.username} className="w-full h-full rounded-full object-cover" />
            ) : (
              getInitials(user?.username || "U")
            )}
          </div>
          <div className="absolute inset-0 rounded-full bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
            {uploadingAvatar ? (
              <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : (
              <Camera size={18} className="text-white" />
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            onChange={handleAvatarUpload}
            className="hidden"
          />
        </div>
        <div>
          <p className="text-[14px] font-medium text-[#1A202C]">{user?.username}</p>
          <p className="text-[13px] text-[#A0AEC0]">{user?.email}</p>
          <p className="text-[11px] text-[#0066FF] mt-0.5 cursor-pointer hover:underline" onClick={() => fileInputRef.current?.click()}>
            Alterar foto
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-[13px] font-medium text-[#4A5568] mb-1.5">Nome de usuário</label>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full px-3 py-2.5 border border-[#E2E8F0] rounded-lg text-[14px] text-[#1A202C] focus:outline-none focus:ring-2 focus:ring-[#0066FF]/20 focus:border-[#0066FF] transition-colors"
            required
          />
        </div>
        <div>
          <label className="block text-[13px] font-medium text-[#4A5568] mb-1.5">Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full px-3 py-2.5 border border-[#E2E8F0] rounded-lg text-[14px] text-[#1A202C] focus:outline-none focus:ring-2 focus:ring-[#0066FF]/20 focus:border-[#0066FF] transition-colors"
            required
          />
        </div>
        <div>
          <label className="block text-[13px] font-medium text-[#4A5568] mb-1.5">Telefone</label>
          <input
            type="text"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="w-full px-3 py-2.5 border border-[#E2E8F0] rounded-lg text-[14px] text-[#1A202C] focus:outline-none focus:ring-2 focus:ring-[#0066FF]/20 focus:border-[#0066FF] transition-colors"
            required
          />
        </div>

        {successMsg && (
          <div className="flex items-center gap-2 p-3 bg-slate-50 border border-slate-200 rounded-lg">
            <Check size={16} className="text-slate-500" />
            <span className="text-[13px] text-slate-600">{successMsg}</span>
          </div>
        )}
        {errorMsg && (
          <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg">
            <AlertCircle size={16} className="text-red-600" />
            <span className="text-[13px] text-red-700">{errorMsg}</span>
          </div>
        )}

        <button
          type="submit"
          disabled={updateProfile.isPending}
          className="px-5 py-2.5 bg-[#0066FF] text-white text-[14px] font-medium rounded-lg hover:bg-[#0052CC] transition-colors disabled:opacity-50"
        >
          {updateProfile.isPending ? "Salvando..." : "Salvar Alterações"}
        </button>
      </form>
    </div>
  );
}

function SecuritySection() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [successMsg, setSuccessMsg] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  const changePassword = useMutation({
    mutationFn: async (data: { currentPassword: string; newPassword: string; confirmPassword: string }) => {
      const res = await fetch("/api/auth/password", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.message);
      return result;
    },
    onSuccess: () => {
      setSuccessMsg("Senha alterada com sucesso");
      setErrorMsg("");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setTimeout(() => setSuccessMsg(""), 3000);
    },
    onError: (error: Error) => {
      setErrorMsg(error.message);
      setSuccessMsg("");
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg("");
    setSuccessMsg("");
    if (newPassword !== confirmPassword) {
      setErrorMsg("Nova senha e confirmação não conferem");
      return;
    }
    changePassword.mutate({ currentPassword, newPassword, confirmPassword });
  };

  return (
    <div className="bg-white rounded-xl border border-[#E2E8F0] p-6">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-lg bg-[#FFF5F5] flex items-center justify-center">
          <Lock size={18} className="text-red-500" />
        </div>
        <div>
          <h2 className="text-[16px] font-semibold text-[#1A202C]">Segurança</h2>
          <p className="text-[13px] text-[#A0AEC0]">Altere sua senha de acesso</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-[13px] font-medium text-[#4A5568] mb-1.5">Senha atual</label>
          <div className="relative">
            <input
              type={showCurrent ? "text" : "password"}
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="w-full px-3 py-2.5 pr-10 border border-[#E2E8F0] rounded-lg text-[14px] text-[#1A202C] focus:outline-none focus:ring-2 focus:ring-[#0066FF]/20 focus:border-[#0066FF] transition-colors"
              required
            />
            <button
              type="button"
              onClick={() => setShowCurrent(!showCurrent)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[#A0AEC0] hover:text-[#4A5568]"
            >
              {showCurrent ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>
        <div>
          <label className="block text-[13px] font-medium text-[#4A5568] mb-1.5">Nova senha</label>
          <div className="relative">
            <input
              type={showNew ? "text" : "password"}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full px-3 py-2.5 pr-10 border border-[#E2E8F0] rounded-lg text-[14px] text-[#1A202C] focus:outline-none focus:ring-2 focus:ring-[#0066FF]/20 focus:border-[#0066FF] transition-colors"
              required
              minLength={6}
            />
            <button
              type="button"
              onClick={() => setShowNew(!showNew)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[#A0AEC0] hover:text-[#4A5568]"
            >
              {showNew ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          <p className="text-[12px] text-[#A0AEC0] mt-1">Mínimo 6 caracteres</p>
        </div>
        <div>
          <label className="block text-[13px] font-medium text-[#4A5568] mb-1.5">Confirmar nova senha</label>
          <div className="relative">
            <input
              type={showConfirm ? "text" : "password"}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full px-3 py-2.5 pr-10 border border-[#E2E8F0] rounded-lg text-[14px] text-[#1A202C] focus:outline-none focus:ring-2 focus:ring-[#0066FF]/20 focus:border-[#0066FF] transition-colors"
              required
              minLength={6}
            />
            <button
              type="button"
              onClick={() => setShowConfirm(!showConfirm)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[#A0AEC0] hover:text-[#4A5568]"
            >
              {showConfirm ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>

        {successMsg && (
          <div className="flex items-center gap-2 p-3 bg-slate-50 border border-slate-200 rounded-lg">
            <Check size={16} className="text-slate-500" />
            <span className="text-[13px] text-slate-600">{successMsg}</span>
          </div>
        )}
        {errorMsg && (
          <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg">
            <AlertCircle size={16} className="text-red-600" />
            <span className="text-[13px] text-red-700">{errorMsg}</span>
          </div>
        )}

        <button
          type="submit"
          disabled={changePassword.isPending}
          className="px-5 py-2.5 bg-[#0066FF] text-white text-[14px] font-medium rounded-lg hover:bg-[#0052CC] transition-colors disabled:opacity-50"
        >
          {changePassword.isPending ? "Alterando..." : "Alterar Senha"}
        </button>
      </form>
    </div>
  );
}

function AccountSection() {
  const { user } = useAuth();

  return (
    <div className="bg-white rounded-xl border border-[#E2E8F0] p-6">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-lg bg-[#F0FFF4] flex items-center justify-center">
          <Sliders size={18} className="text-[#38A169]" />
        </div>
        <div>
          <h2 className="text-[16px] font-semibold text-[#1A202C]">Configurações da Conta</h2>
          <p className="text-[13px] text-[#A0AEC0]">Informações e preferências da sua conta</p>
        </div>
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between p-4 bg-[#F7FAFC] rounded-lg">
          <div>
            <p className="text-[13px] font-medium text-[#4A5568]">Idioma do sistema</p>
            <p className="text-[12px] text-[#A0AEC0]">Idioma utilizado na interface</p>
          </div>
          <span className="text-[13px] text-[#1A202C] font-medium bg-white px-3 py-1.5 rounded-lg border border-[#E2E8F0]">Português (BR)</span>
        </div>

        <div className="flex items-center justify-between p-4 bg-[#F7FAFC] rounded-lg">
          <div>
            <p className="text-[13px] font-medium text-[#4A5568]">Fuso horário</p>
            <p className="text-[12px] text-[#A0AEC0]">Fuso utilizado para datas e horários</p>
          </div>
          <span className="text-[13px] text-[#1A202C] font-medium bg-white px-3 py-1.5 rounded-lg border border-[#E2E8F0]">América/São Paulo (UTC-3)</span>
        </div>

        <div className="flex items-center justify-between p-4 bg-[#F7FAFC] rounded-lg">
          <div>
            <p className="text-[13px] font-medium text-[#4A5568]">Tipo de conta</p>
            <p className="text-[12px] text-[#A0AEC0]">Nível de acesso da sua conta</p>
          </div>
          <span className={`text-[13px] font-medium px-3 py-1.5 rounded-lg border ${
            user?.role === "admin"
              ? "bg-purple-50 text-purple-700 border-purple-200"
              : "bg-blue-50 text-blue-700 border-blue-200"
          }`}>
            {user?.role === "admin" ? "Administrador" : "Usuário"}
          </span>
        </div>

        <div className="flex items-center justify-between p-4 bg-[#F7FAFC] rounded-lg">
          <div>
            <p className="text-[13px] font-medium text-[#4A5568]">Status da conta</p>
            <p className="text-[12px] text-[#A0AEC0]">Situação atual da sua conta no sistema</p>
          </div>
          <span className={`text-[13px] font-medium px-3 py-1.5 rounded-lg border ${
            user?.status === "approved"
              ? "bg-slate-50 text-slate-600 border-slate-200"
              : user?.status === "pending"
                ? "bg-slate-50 text-slate-500 border-slate-200"
                : "bg-red-50 text-red-700 border-red-200"
          }`}>
            {user?.status === "approved" ? "Ativa" : user?.status === "pending" ? "Pendente" : user?.status === "blocked" ? "Bloqueada" : "Rejeitada"}
          </span>
        </div>
      </div>
    </div>
  );
}

type SettingsTab = "profile" | "security" | "account";

function getTabFromHash(): SettingsTab {
  const hash = window.location.hash.replace("#", "");
  if (hash === "security" || hash === "account") return hash;
  return "profile";
}

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<SettingsTab>(getTabFromHash);

  useEffect(() => {
    const onHashChange = () => setActiveTab(getTabFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const handleTabChange = (tab: SettingsTab) => {
    setActiveTab(tab);
    window.location.hash = tab;
  };

  const tabs = [
    { id: "profile" as const, label: "Perfil", icon: User },
    { id: "security" as const, label: "Segurança", icon: Lock },
    { id: "account" as const, label: "Conta", icon: Sliders },
  ];

  return (
    <div className="p-3 sm:p-6 max-w-3xl mx-auto">
      <div className="flex gap-2 mb-4 sm:mb-6 overflow-x-auto scrollbar-hide">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => handleTabChange(tab.id)}
              className={`flex items-center gap-2 px-3 sm:px-4 py-2.5 rounded-lg text-xs sm:text-[14px] font-medium transition-colors whitespace-nowrap flex-shrink-0 min-h-[44px] ${
                activeTab === tab.id
                  ? "bg-[#0066FF]/[0.08] text-[#0066FF]"
                  : "text-[#64748B] hover:text-[#1A202C] hover:bg-[#F7FAFC]"
              }`}
            >
              <Icon size={16} />
              {tab.label}
            </button>
          );
        })}
      </div>

      {activeTab === "profile" && <ProfileSection />}
      {activeTab === "security" && <SecuritySection />}
      {activeTab === "account" && <AccountSection />}
    </div>
  );
}
