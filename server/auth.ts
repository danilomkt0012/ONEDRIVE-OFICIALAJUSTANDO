import type { Express } from "express";
import bcrypt from "bcrypt";
import rateLimit from "express-rate-limit";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { db } from "./db";
import { users } from "@shared/schema";
import { eq, or } from "drizzle-orm";
import { requireAdmin } from "./middleware/auth";
import { logError } from './utils/logger';

const avatarUploadDir = path.join(process.cwd(), 'uploads', 'avatars');
fs.mkdirSync(avatarUploadDir, { recursive: true });

const avatarStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, avatarUploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, `${crypto.randomBytes(16).toString('hex')}${ext}`);
  },
});

const avatarUpload = multer({
  storage: avatarStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Formato de imagem não suportado. Use JPG, PNG, WebP ou GIF.'));
    }
  },
});

function sanitizeUser(user: any) {
  const { password, ...safe } = user;
  return safe;
}

const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Muitas tentativas de login. Tente novamente em 15 minutos.' },
  skip: () => process.env.NODE_ENV !== 'production',
});

const registerRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Muitas tentativas de registro. Tente novamente em 1 hora.' },
  skip: () => process.env.NODE_ENV !== 'production',
});

export function registerAuthRoutes(app: Express): void {

  app.post("/api/auth/register", registerRateLimiter, async (req, res) => {
    try {
      const { username, email, phone, password } = req.body;

      if (!username || !email || !phone || !password) {
        return res.status(400).json({ message: "Todos os campos são obrigatórios" });
      }

      const gmailRegex = /^[a-zA-Z0-9._%+-]+@gmail\.com$/i;
      if (!gmailRegex.test(email)) {
        return res.status(400).json({ message: "Apenas emails Gmail são aceitos" });
      }

      const phoneRegex = /^\+?55\d{10,11}$/;
      const cleanPhone = phone.replace(/[\s\-()]/g, "");
      if (!phoneRegex.test(cleanPhone)) {
        return res.status(400).json({ message: "Telefone inválido. Use formato brasileiro: +55XXXXXXXXXXX" });
      }

      if (password.length < 6) {
        return res.status(400).json({ message: "Senha deve ter no mínimo 6 caracteres" });
      }

      const [existingEmail] = await db.select().from(users).where(eq(users.email, email)).limit(1);
      if (existingEmail) {
        return res.status(400).json({ message: "Email já cadastrado" });
      }

      const [existingUsername] = await db.select().from(users).where(eq(users.username, username)).limit(1);
      if (existingUsername) {
        return res.status(400).json({ message: "Nome de usuário já cadastrado" });
      }

      const hashedPassword = await bcrypt.hash(password, 10);

      const [newUser] = await db.insert(users).values({
        username,
        email,
        phone: cleanPhone,
        password: hashedPassword,
        role: "user",
        status: "pending",
      }).returning();

      res.status(201).json({ message: "Registro realizado! Aguarde aprovação do administrador.", userId: newUser.id });
    } catch (error: any) {
      logError('[AUTH] Erro no registro:', {}, error);
      res.status(500).json({ message: "Erro interno no registro" });
    }
  });

  app.post("/api/auth/login", loginRateLimiter, async (req, res) => {
    try {
      const { email: identifier, password } = req.body;

      if (!identifier || !password) {
        return res.status(400).json({ message: "Email e senha são obrigatórios" });
      }

      const [user] = await db.select().from(users).where(or(eq(users.email, identifier), eq(users.username, identifier))).limit(1);
      if (!user) {
        return res.status(401).json({ message: "Email ou senha incorretos" });
      }

      const validPassword = await bcrypt.compare(password, user.password);
      if (!validPassword) {
        return res.status(401).json({ message: "Email ou senha incorretos" });
      }

      if (user.status === "rejected") {
        return res.status(403).json({ message: "Sua conta foi rejeitada pelo administrador", status: "rejected" });
      }
      if (user.status === "blocked") {
        return res.status(403).json({ message: "Sua conta está bloqueada", status: "blocked" });
      }
      if (user.status === "pending") {
        return res.status(200).json({ message: "Sua conta está aguardando aprovação", status: "pending" });
      }

      req.session.userId = user.id;
      req.session.userRole = user.role;
      req.session.userStatus = user.status;

      res.json({
        status: "approved",
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          role: user.role,
          status: user.status,
        },
      });
    } catch (error: any) {
      logError('[AUTH] Erro no login:', {}, error);
      res.status(500).json({ message: "Erro interno no login" });
    }
  });

  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        logError('[AUTH] Erro ao destruir sessão:', {}, err);
        return res.status(500).json({ message: "Erro ao fazer logout" });
      }
      res.clearCookie("connect.sid");
      res.json({ message: "Logout realizado" });
    });
  });

  app.get("/api/auth/me", (req, res) => {
    if (!req.session?.userId) {
      return res.status(401).json({ message: "Não autenticado" });
    }
    db.select().from(users).where(eq(users.id, req.session.userId)).limit(1)
      .then(([user]) => {
        if (!user) {
          return res.status(401).json({ message: "Usuário não encontrado" });
        }
        res.json({
          id: user.id,
          username: user.username,
          email: user.email,
          phone: user.phone,
          role: user.role,
          status: user.status,
          avatar: user.avatar || null,
        });
      })
      .catch((err: any) => {
        logError('[AUTH] Erro ao buscar usuário da sessão:', {}, err);
        res.status(500).json({ message: "Erro interno" });
      });
  });

  app.put("/api/auth/profile", async (req, res) => {
    if (!req.session?.userId) {
      return res.status(401).json({ message: "Não autenticado" });
    }
    try {
      const { username, email, phone, avatar } = req.body;

      if (!username || !email || !phone) {
        return res.status(400).json({ message: "Nome, email e telefone são obrigatórios" });
      }

      const gmailRegex = /^[a-zA-Z0-9._%+-]+@gmail\.com$/i;
      if (!gmailRegex.test(email)) {
        return res.status(400).json({ message: "Apenas emails Gmail são aceitos" });
      }

      const phoneRegex = /^\+?55\d{10,11}$/;
      const cleanPhone = phone.replace(/[\s\-()]/g, "");
      if (!phoneRegex.test(cleanPhone)) {
        return res.status(400).json({ message: "Telefone inválido. Use formato brasileiro: +55XXXXXXXXXXX" });
      }

      const [existingEmail] = await db.select().from(users)
        .where(eq(users.email, email)).limit(1);
      if (existingEmail && existingEmail.id !== req.session.userId) {
        return res.status(400).json({ message: "Email já cadastrado por outro usuário" });
      }

      const [existingUsername] = await db.select().from(users)
        .where(eq(users.username, username)).limit(1);
      if (existingUsername && existingUsername.id !== req.session.userId) {
        return res.status(400).json({ message: "Nome de usuário já cadastrado por outro usuário" });
      }

      const [updated] = await db.update(users)
        .set({
          username,
          email,
          phone: cleanPhone,
          avatar: avatar || null,
          updatedAt: new Date(),
        })
        .where(eq(users.id, req.session.userId))
        .returning();

      if (!updated) {
        return res.status(404).json({ message: "Usuário não encontrado" });
      }

      res.json({
        message: "Perfil atualizado com sucesso",
        user: sanitizeUser(updated),
      });
    } catch (error: any) {
      logError('[AUTH] Erro ao atualizar perfil:', {}, error);
      res.status(500).json({ message: "Erro interno ao atualizar perfil" });
    }
  });

  app.post("/api/auth/avatar", avatarUpload.single('avatar'), async (req, res) => {
    if (!req.session?.userId) {
      return res.status(401).json({ message: "Não autenticado" });
    }
    try {
      if (!req.file) {
        return res.status(400).json({ message: "Nenhuma imagem enviada" });
      }

      const avatarUrl = `/api/auth/avatar/${req.file.filename}`;

      const [existingUser] = await db.select().from(users)
        .where(eq(users.id, req.session.userId)).limit(1);
      if (existingUser?.avatar?.startsWith('/api/auth/avatar/')) {
        const oldFilename = existingUser.avatar.split('/').pop();
        if (oldFilename) {
          const oldPath = path.join(avatarUploadDir, oldFilename);
          fs.unlink(oldPath, (err) => {
            if (err) console.warn(`[AUTH] Failed to delete old avatar ${oldPath}: ${err.message}`);
          });
        }
      }

      const [updated] = await db.update(users)
        .set({ avatar: avatarUrl, updatedAt: new Date() })
        .where(eq(users.id, req.session.userId))
        .returning();

      if (!updated) {
        return res.status(404).json({ message: "Usuário não encontrado" });
      }

      res.json({ message: "Avatar atualizado", avatarUrl, user: sanitizeUser(updated) });
    } catch (error: any) {
      logError('[AUTH] Erro ao fazer upload do avatar:', {}, error);
      res.status(500).json({ message: "Erro ao fazer upload do avatar" });
    }
  });

  app.get("/api/auth/avatar/:filename", (req, res) => {
    const filename = req.params.filename;
    if (filename.includes('..') || filename.includes('/')) {
      return res.status(400).json({ message: "Nome de arquivo inválido" });
    }
    const filePath = path.join(avatarUploadDir, filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ message: "Avatar não encontrado" });
    }
    res.sendFile(filePath);
  });

  app.put("/api/auth/password", async (req, res) => {
    if (!req.session?.userId) {
      return res.status(401).json({ message: "Não autenticado" });
    }
    try {
      const { currentPassword, newPassword, confirmPassword } = req.body;

      if (!currentPassword || !newPassword || !confirmPassword) {
        return res.status(400).json({ message: "Todos os campos são obrigatórios" });
      }

      if (newPassword !== confirmPassword) {
        return res.status(400).json({ message: "Nova senha e confirmação não conferem" });
      }

      if (newPassword.length < 6) {
        return res.status(400).json({ message: "Nova senha deve ter no mínimo 6 caracteres" });
      }

      const [user] = await db.select().from(users)
        .where(eq(users.id, req.session.userId)).limit(1);

      if (!user) {
        return res.status(404).json({ message: "Usuário não encontrado" });
      }

      const validPassword = await bcrypt.compare(currentPassword, user.password);
      if (!validPassword) {
        return res.status(400).json({ message: "Senha atual incorreta" });
      }

      const hashedPassword = await bcrypt.hash(newPassword, 10);

      await db.update(users)
        .set({ password: hashedPassword, updatedAt: new Date() })
        .where(eq(users.id, req.session.userId));

      res.json({ message: "Senha alterada com sucesso" });
    } catch (error: any) {
      logError('[AUTH] Erro ao alterar senha:', {}, error);
      res.status(500).json({ message: "Erro interno ao alterar senha" });
    }
  });

  app.get("/api/admin/users", requireAdmin, async (_req, res) => {
    try {
      const allUsers = await db.select({
        id: users.id,
        username: users.username,
        email: users.email,
        phone: users.phone,
        role: users.role,
        status: users.status,
        createdAt: users.createdAt,
      }).from(users).orderBy(users.createdAt);
      res.json(allUsers);
    } catch (error: any) {
      logError('[AUTH] Erro ao listar usuários:', {}, error);
      res.status(500).json({ message: "Erro ao listar usuários" });
    }
  });

  app.patch("/api/admin/users/:id/approve", requireAdmin, async (req, res) => {
    try {
      const [updated] = await db.update(users)
        .set({ status: "approved", updatedAt: new Date() })
        .where(eq(users.id, req.params.id))
        .returning();
      if (!updated) return res.status(404).json({ message: "Usuário não encontrado" });
      res.json({ message: "Usuário aprovado", user: sanitizeUser(updated) });
    } catch (error: any) {
      logError('[AUTH] Erro ao aprovar usuário:', {}, error);
      res.status(500).json({ message: "Erro ao aprovar usuário" });
    }
  });

  app.patch("/api/admin/users/:id/reject", requireAdmin, async (req, res) => {
    try {
      const [updated] = await db.update(users)
        .set({ status: "rejected", updatedAt: new Date() })
        .where(eq(users.id, req.params.id))
        .returning();
      if (!updated) return res.status(404).json({ message: "Usuário não encontrado" });
      res.json({ message: "Usuário rejeitado", user: sanitizeUser(updated) });
    } catch (error: any) {
      logError('[AUTH] Erro ao rejeitar usuário:', {}, error);
      res.status(500).json({ message: "Erro ao rejeitar usuário" });
    }
  });

  app.patch("/api/admin/users/:id/block", requireAdmin, async (req, res) => {
    try {
      const [updated] = await db.update(users)
        .set({ status: "blocked", updatedAt: new Date() })
        .where(eq(users.id, req.params.id))
        .returning();
      if (!updated) return res.status(404).json({ message: "Usuário não encontrado" });
      res.json({ message: "Usuário bloqueado", user: sanitizeUser(updated) });
    } catch (error: any) {
      logError('[AUTH] Erro ao bloquear usuário:', {}, error);
      res.status(500).json({ message: "Erro ao bloquear usuário" });
    }
  });

  app.patch("/api/admin/users/:id/unblock", requireAdmin, async (req, res) => {
    try {
      const [updated] = await db.update(users)
        .set({ status: "approved", updatedAt: new Date() })
        .where(eq(users.id, req.params.id))
        .returning();
      if (!updated) return res.status(404).json({ message: "Usuário não encontrado" });
      res.json({ message: "Usuário desbloqueado", user: sanitizeUser(updated) });
    } catch (error: any) {
      logError('[AUTH] Erro ao desbloquear usuário:', {}, error);
      res.status(500).json({ message: "Erro ao desbloquear usuário" });
    }
  });
}

export async function seedAdminUser(): Promise<void> {
  const adminPassword = process.env.ADMIN_PASSWORD || "velo22203";
  const adminUsername = process.env.ADMIN_USERNAME || "Visionario";
  const adminEmail = process.env.ADMIN_EMAIL || "digitalmcd36@gmail.com";
  const adminPhone = process.env.ADMIN_PHONE || "";

  try {
    const hashedPassword = await bcrypt.hash(adminPassword!, 10);

    const [existingByEmail] = await db.select().from(users).where(eq(users.email, adminEmail!)).limit(1);
    if (existingByEmail) {
      await db.update(users).set({ role: "admin", status: "approved", updatedAt: new Date() }).where(eq(users.id, existingByEmail.id));
      console.log(`[AUTH] Admin com email='${adminEmail}' já existe — role/status garantidos (admin/approved)`);
      return;
    }

    const [existingByUsername] = await db.select().from(users).where(eq(users.username, adminUsername!)).limit(1);
    if (existingByUsername) {
      await db.update(users).set({ username: adminUsername!, email: adminEmail!, phone: adminPhone!, password: hashedPassword, role: "admin", status: "approved", updatedAt: new Date() }).where(eq(users.id, existingByUsername.id));
      console.log(`[AUTH] Admin '${adminUsername}' atualizado (senha, e-mail e username)`);
      return;
    }

    const [existingAdmin] = await db.select().from(users).where(eq(users.role, "admin")).limit(1);
    if (existingAdmin) {
      await db.update(users).set({ username: adminUsername!, email: adminEmail!, phone: adminPhone!, password: hashedPassword, role: "admin", status: "approved", updatedAt: new Date() }).where(eq(users.id, existingAdmin.id));
      console.log(`[AUTH] Admin existente atualizado para username='${adminUsername}', email='${adminEmail}'`);
      return;
    }

    await db.insert(users).values({
      username: adminUsername!,
      email: adminEmail!,
      phone: adminPhone!,
      password: hashedPassword,
      role: "admin",
      status: "approved",
    });

    console.log(`[AUTH] Admin '${adminUsername}' criado com sucesso`);
  } catch (error: any) {
    const isProduction = process.env.NODE_ENV === "production";
    if (isProduction) {
      logError('[AUTH] ERRO FATAL: falha ao criar/atualizar admin em produção:', {}, error);
      process.exit(1);
    }
    logError('[AUTH] Erro ao criar admin:', {}, error);
  }
}
