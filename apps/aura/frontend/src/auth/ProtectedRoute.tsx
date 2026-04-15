import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./AuthContext";

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { token, loading } = useAuth();
  const location = useLocation();

  if (!token) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-bg-base text-ink-dim">
        Carregando…
      </div>
    );
  }
  return <>{children}</>;
}
