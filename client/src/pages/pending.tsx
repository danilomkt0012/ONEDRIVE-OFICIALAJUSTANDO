import overdriveLogo from "@assets/overdrive-logo-v4.png";

export default function PendingPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F5F7FA]">
      <div className="w-full max-w-md p-8 bg-white rounded-2xl shadow-2xl text-center">
        <img src={overdriveLogo} alt="Overdrive" className="h-10 mx-auto mb-6 object-contain" />
        <div className="text-5xl mb-4">⏳</div>
        <h2 className="text-2xl font-bold text-[#1A202C] mb-2">Aguardando aprovação</h2>
        <p className="text-[#718096] mb-6">
          Sua conta foi criada com sucesso. Um administrador precisa aprovar seu acesso antes que você possa usar o sistema.
        </p>
        <a
          href="/login"
          className="inline-block px-6 py-2.5 bg-[#F7FAFC] text-[#4A5568] font-medium rounded-lg hover:bg-[#EDF2F7] border border-[#E2E8F0] transition"
        >
          Voltar ao login
        </a>
      </div>
    </div>
  );
}
