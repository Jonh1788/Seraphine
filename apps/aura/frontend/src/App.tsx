import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./auth/AuthContext";
import { ProtectedRoute } from "./auth/ProtectedRoute";
import { LoginPage } from "./auth/LoginPage";
import { RegisterPage } from "./auth/RegisterPage";
import { AppShell } from "./layout/AppShell";
import { ChatPage } from "./pages/ChatPage";
import { DashboardPage } from "./pages/DashboardPage";
import { TasksPage } from "./pages/TasksPage";
import { FinancePage } from "./pages/FinancePage";
import { CalendarPage } from "./pages/CalendarPage";
import { SettingsPage } from "./pages/SettingsPage";

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <AppShell fullBleed>
                <ChatPage />
              </AppShell>
            </ProtectedRoute>
          }
        />
        <Route
          path="/visao-geral"
          element={
            <ProtectedRoute>
              <AppShell>
                <DashboardPage />
              </AppShell>
            </ProtectedRoute>
          }
        />
        <Route
          path="/tarefas"
          element={
            <ProtectedRoute>
              <AppShell>
                <TasksPage />
              </AppShell>
            </ProtectedRoute>
          }
        />
        <Route
          path="/financas"
          element={
            <ProtectedRoute>
              <AppShell>
                <FinancePage />
              </AppShell>
            </ProtectedRoute>
          }
        />
        <Route
          path="/calendario"
          element={
            <ProtectedRoute>
              <AppShell>
                <CalendarPage />
              </AppShell>
            </ProtectedRoute>
          }
        />
        <Route
          path="/configuracoes"
          element={
            <ProtectedRoute>
              <AppShell>
                <SettingsPage />
              </AppShell>
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}
