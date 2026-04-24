import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

interface AdminUser {
  id: string;
  username: string;
  email: string;
  phone: string;
  role: string;
  status: string;
  createdAt: string;
}

export default function AdminPage() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<string>("all");

  const { data: users = [], isLoading } = useQuery<AdminUser[]>({
    queryKey: ["/api/admin/users"],
    queryFn: async () => {
      const res = await fetch("/api/admin/users", { credentials: "include" });
      if (!res.ok) throw new Error("Erro ao carregar usuários");
      return res.json();
    },
  });

  const actionMutation = useMutation({
    mutationFn: async ({ id, action }: { id: string; action: string }) => {
      const res = await fetch(`/api/admin/users/${id}/${action}`, {
        method: "PATCH",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Erro na ação");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
    },
  });

  const filtered = filter === "all" ? users : users.filter((u) => u.status === filter);

  const statusColors: Record<string, string> = {
    pending: "bg-yellow-100 text-yellow-800",
    approved: "bg-green-100 text-green-800",
    rejected: "bg-red-100 text-red-800",
    blocked: "bg-gray-100 text-gray-800",
  };

  const statusLabels: Record<string, string> = {
    pending: "Pendente",
    approved: "Aprovado",
    rejected: "Rejeitado",
    blocked: "Bloqueado",
  };

  return (
    <div className="p-3 sm:p-6 max-w-6xl mx-auto">
      <h1 className="text-xl sm:text-2xl font-bold text-slate-800 mb-4 sm:mb-6">Painel de Administração</h1>

      <div className="flex gap-2 mb-4 sm:mb-6 overflow-x-auto scrollbar-hide pb-1">
        {["all", "pending", "approved", "rejected", "blocked"].map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-medium transition whitespace-nowrap flex-shrink-0 min-h-[44px] ${
              filter === f
                ? "bg-blue-600 text-white"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            {f === "all" ? "Todos" : statusLabels[f]} ({f === "all" ? users.length : users.filter((u) => u.status === f).length})
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-slate-500">Carregando...</div>
      ) : (
        <div className="bg-white rounded-xl shadow overflow-hidden overflow-x-auto">
          <table className="w-full min-w-[640px]">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase">Usuário</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase">Email</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase">Telefone</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase">Status</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase">Criado</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((user) => (
                <tr key={user.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-medium text-slate-800">
                    {user.username}
                    {user.role === "admin" && (
                      <span className="ml-2 text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full">Admin</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-600 text-sm">{user.email}</td>
                  <td className="px-4 py-3 text-slate-600 text-sm">{user.phone}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${statusColors[user.status] || ""}`}>
                      {statusLabels[user.status] || user.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-500 text-sm">
                    {user.createdAt ? new Date(user.createdAt).toLocaleDateString("pt-BR") : "-"}
                  </td>
                  <td className="px-4 py-3">
                    {user.role !== "admin" && (
                      <div className="flex gap-1.5">
                        {user.status === "pending" && (
                          <>
                            <button
                              onClick={() => actionMutation.mutate({ id: user.id, action: "approve" })}
                              disabled={actionMutation.isPending}
                              className="px-3 py-1 min-h-[44px] text-xs bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50"
                            >
                              Aprovar
                            </button>
                            <button
                              onClick={() => actionMutation.mutate({ id: user.id, action: "reject" })}
                              disabled={actionMutation.isPending}
                              className="px-3 py-1 min-h-[44px] text-xs bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50"
                            >
                              Rejeitar
                            </button>
                          </>
                        )}
                        {user.status === "approved" && (
                          <button
                            onClick={() => actionMutation.mutate({ id: user.id, action: "block" })}
                            disabled={actionMutation.isPending}
                            className="px-3 py-1 min-h-[44px] text-xs bg-gray-600 text-white rounded-md hover:bg-gray-700 disabled:opacity-50"
                          >
                            Bloquear
                          </button>
                        )}
                        {(user.status === "blocked" || user.status === "rejected") && (
                          <button
                            onClick={() => actionMutation.mutate({ id: user.id, action: "unblock" })}
                            disabled={actionMutation.isPending}
                            className="px-3 py-1 min-h-[44px] text-xs bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
                          >
                            Desbloquear
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <div className="text-center py-8 text-slate-400">Nenhum usuário encontrado</div>
          )}
        </div>
      )}
    </div>
  );
}
