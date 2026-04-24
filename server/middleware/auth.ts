import type { Request, Response, NextFunction } from "express";

declare module "express-session" {
  interface SessionData {
    userId: string;
    userRole: string;
    userStatus: string;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session?.userId) {
    return res.status(401).json({ message: "Não autenticado" });
  }
  if (req.session.userStatus !== "approved") {
    return res.status(403).json({ message: "Conta não aprovada" });
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.session?.userId) {
    return res.status(401).json({ message: "Não autenticado" });
  }
  if (req.session.userRole !== "admin") {
    return res.status(403).json({ message: "Acesso restrito a administradores" });
  }
  next();
}
