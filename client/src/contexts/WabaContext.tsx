import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

interface WabaContextType {
  wabasList: any[];
  activeWabaId: string | null;
  setActiveWabaId: (id: string | null) => void;
  isLoading: boolean;
}

const WabaContext = createContext<WabaContextType>({
  wabasList: [],
  activeWabaId: null,
  setActiveWabaId: () => {},
  isLoading: false,
});

export function WabaProvider({ children }: { children: ReactNode }) {
  const [activeWabaId, setActiveWabaId] = useState<string | null>(null);

  const { data: wabasList = [], isLoading } = useQuery<any[]>({
    queryKey: ["/api/wabas"],
  });

  useEffect(() => {
    if (wabasList.length > 0 && !activeWabaId) {
      const active = wabasList.find((w: any) => w.isActive) || wabasList[0];
      setActiveWabaId(active.id);
    }
  }, [wabasList, activeWabaId]);

  return (
    <WabaContext.Provider value={{ wabasList, activeWabaId, setActiveWabaId, isLoading }}>
      {children}
    </WabaContext.Provider>
  );
}

export function useWaba() {
  return useContext(WabaContext);
}
