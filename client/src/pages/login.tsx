import { useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/hooks/useAuth";
import overdriveLogo from "@assets/overdrive-logo-v4.png";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const { login } = useAuth();
  const [, setLocation] = useLocation();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      const result = await login.mutateAsync({ email, password });
      if (result.status === "pending") {
        setLocation("/pending");
      } else if (result.status === "approved") {
        setLocation("/campaigns");
      }
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F5F7FA]">
      <div className="w-full max-w-md p-8 bg-white rounded-2xl shadow-2xl">
        <div className="text-center mb-8">
          <img src={overdriveLogo} alt="Overdrive" className="h-10 mx-auto mb-3 object-contain" />
          <p className="text-[#718096] mt-2">Faca login para continuar</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
              {error}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-[#4A5568] mb-1">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-4 py-2.5 border border-[#E2E8F0] rounded-lg focus:ring-2 focus:ring-[#0066FF] focus:border-[#0066FF] outline-none transition"
              placeholder="seu@gmail.com"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-[#4A5568] mb-1">Senha</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-4 py-2.5 border border-[#E2E8F0] rounded-lg focus:ring-2 focus:ring-[#0066FF] focus:border-[#0066FF] outline-none transition"
              placeholder="••••••••"
              required
            />
          </div>

          <button
            type="submit"
            disabled={login.isPending}
            className="w-full py-2.5 bg-[#0066FF] text-white font-medium rounded-lg hover:bg-[#0052CC] disabled:opacity-50 transition"
          >
            {login.isPending ? "Entrando..." : "Entrar"}
          </button>
        </form>

        <p className="text-center text-sm text-[#718096] mt-6">
          Nao tem conta?{" "}
          <a href="/register" className="text-[#0066FF] hover:underline font-medium">
            Criar conta
          </a>
        </p>
      </div>
    </div>
  );
}
