import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Sparkles } from "lucide-react";
import { useAuth } from "./AuthContext";
import { GlassCard } from "../components/GlassCard";
import { Button } from "../components/Button";
import { Input } from "../components/Input";
import { ApiError } from "../api/client";

export function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Senha deve ter ao menos 8 caracteres");
      return;
    }
    setLoading(true);
    try {
      await register(email, password);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Falha ao criar conta");
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
          <h1 className="text-3xl font-bold">Criar conta</h1>
          <p className="text-sm text-ink-dim">Comece agora — é grátis</p>
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
            autoComplete="new-password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="mínimo 8 caracteres"
          />
          {error ? (
            <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2">
              {error}
            </div>
          ) : null}
          <Button type="submit" disabled={loading} className="w-full">
            {loading ? "Criando…" : "Criar conta"}
          </Button>
        </form>

        <div className="text-center mt-6 text-sm text-ink-dim">
          Já tem conta?{" "}
          <Link to="/login" className="text-accent-purple hover:underline">
            Entrar
          </Link>
        </div>
      </GlassCard>
    </div>
  );
}
