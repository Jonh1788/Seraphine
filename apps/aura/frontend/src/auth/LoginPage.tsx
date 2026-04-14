import { useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Sparkles } from "lucide-react";
import { useAuth } from "./AuthContext";
import { GlassCard } from "../components/GlassCard";
import { Button } from "../components/Button";
import { Input } from "../components/Input";
import { ApiError } from "../api/client";

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { from?: string } };
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(email, password);
      const dest = location.state?.from ?? "/";
      navigate(dest, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Falha ao entrar");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-bg-base text-ink-primary grid place-items-center p-4">
      <GlassCard className="w-full max-w-md">
        <div className="flex flex-col items-center gap-3 mb-6">
          <div className="h-12 w-12 rounded-full bg-gradient-to-br from-accent-purple-strong to-accent-purple grid place-items-center">
            <Sparkles className="h-6 w-6 text-white" />
          </div>
          <h1 className="text-3xl font-bold">Entrar na Aura</h1>
          <p className="text-sm text-ink-dim">Seu assistente pessoal multi-tenant</p>
        </div>

        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <Input
            label="E-mail"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="voce@exemplo.com"
          />
          <Input
            label="Senha"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
          {error ? (
            <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2">
              {error}
            </div>
          ) : null}
          <Button type="submit" disabled={loading} className="w-full">
            {loading ? "Entrando…" : "Entrar"}
          </Button>
        </form>

        <div className="text-center mt-6 text-sm text-ink-dim">
          Não tem conta?{" "}
          <Link to="/register" className="text-accent-purple hover:underline">
            Criar uma agora
          </Link>
        </div>
      </GlassCard>
    </div>
  );
}
