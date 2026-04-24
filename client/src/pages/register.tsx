import { useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/hooks/useAuth";
import overdriveLogo from "@assets/overdrive-logo-v4.png";

export default function RegisterPage() {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const { register } = useAuth();
  const [, setLocation] = useLocation();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await register.mutateAsync({ username, email, phone, password });
      setSuccess(true);
      setTimeout(() => setLocation("/pending"), 2000);
    } catch (err: any) {
      setError(err.message);
    }
  };

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F5F7FA]">
        <div className="w-full max-w-md p-8 bg-white rounded-2xl shadow-2xl text-center">
          <div className="text-5xl mb-4">✅</div>
          <h2 className="text-2xl font-bold text-[#1A202C] mb-2">Registro realizado!</h2>
          <p className="text-[#718096]">Aguarde aprovação do administrador para acessar o sistema.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F5F7FA]">
      <div className="w-full max-w-md p-8 bg-white rounded-2xl shadow-2xl">
        <div className="text-center mb-8">
          <img src={overdriveLogo} alt="Overdrive" className="h-10 mx-auto mb-3 object-contain" />
          <p className="text-[#718096] mt-2">Crie sua conta</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
              {error}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-[#4A5568] mb-1">Nome de usuario</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full px-4 py-2.5 border border-[#E2E8F0] rounded-lg focus:ring-2 focus:ring-[#0066FF] focus:border-[#0066FF] outline-none transition"
              placeholder="seunome"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-[#4A5568] mb-1">Email Gmail</label>
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
            <label className="block text-sm font-medium text-[#4A5568] mb-1">Telefone</label>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="w-full px-4 py-2.5 border border-[#E2E8F0] rounded-lg focus:ring-2 focus:ring-[#0066FF] focus:border-[#0066FF] outline-none transition"
              placeholder="+5511999999999"
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
              placeholder="Mínimo 6 caracteres"
              required
              minLength={6}
            />
          </div>

          <button
            type="submit"
            disabled={register.isPending}
            className="w-full py-2.5 bg-[#0066FF] text-white font-medium rounded-lg hover:bg-[#0052CC] disabled:opacity-50 transition"
          >
            {register.isPending ? "Registrando..." : "Criar conta"}
          </button>
        </form>

        <p className="text-center text-sm text-[#718096] mt-6">
          Ja tem conta?{" "}
          <a href="/login" className="text-[#0066FF] hover:underline font-medium">
            Fazer login
          </a>
        </p>
      </div>
    </div>
  );
}
