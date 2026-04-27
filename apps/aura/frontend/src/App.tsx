import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./auth/AuthContext";
import { ProtectedRoute } from "./auth/ProtectedRoute";
import { LoginPage } from "./auth/LoginPage";
import { RegisterPage } from "./auth/RegisterPage";
import { AppShell } from "./layout/AppShell";
import { ChatPage } from "./pages/ChatPage";
import { HojePage } from "./pages/HojePage";
import { TasksPage } from "./pages/TasksPage";
import { FinancePage } from "./pages/FinancePage";
import { CalendarPage } from "./pages/CalendarPage";
import { SettingsPage } from "./pages/SettingsPage";
import { MaisPage } from "./pages/MaisPage";
import { HabitsPage } from "./pages/HabitsPage";
import { KnowledgePage } from "./pages/KnowledgePage";
import { VisaoPage } from "./pages/VisaoPage";
import { LembretesPage } from "./pages/LembretesPage";

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
          path="/hoje"
          element={
            <ProtectedRoute>
              <AppShell title="Hoje">
                <HojePage />
              </AppShell>
            </ProtectedRoute>
          }
        />
        <Route path="/visao-geral" element={<Navigate to="/hoje" replace />} />
        <Route
          path="/tarefas"
          element={
            <ProtectedRoute>
              <AppShell title="Tarefas">
                <TasksPage />
              </AppShell>
            </ProtectedRoute>
          }
        />
        <Route
          path="/financas"
          element={
            <ProtectedRoute>
              <AppShell title="Finanças">
                <FinancePage />
              </AppShell>
            </ProtectedRoute>
          }
        />
        <Route
          path="/calendario"
          element={
            <ProtectedRoute>
              <AppShell title="Calendário">
                <CalendarPage />
              </AppShell>
            </ProtectedRoute>
          }
        />
        <Route
          path="/configuracoes"
          element={
            <ProtectedRoute>
              <AppShell title="Configurações">
                <SettingsPage />
              </AppShell>
            </ProtectedRoute>
          }
        />
        <Route
          path="/mais"
          element={
            <ProtectedRoute>
              <AppShell title="Mais">
                <MaisPage />
              </AppShell>
            </ProtectedRoute>
          }
        />
        <Route
          path="/mais/habitos"
          element={
            <ProtectedRoute>
              <AppShell title="Hábitos">
                <HabitsPage />
              </AppShell>
            </ProtectedRoute>
          }
        />
        <Route
          path="/mais/conhecimento"
          element={
            <ProtectedRoute>
              <AppShell title="Conhecimento">
                <KnowledgePage />
              </AppShell>
            </ProtectedRoute>
          }
        />
        <Route
          path="/visao"
          element={
            <ProtectedRoute>
              <AppShell title="Visão">
                <VisaoPage />
              </AppShell>
            </ProtectedRoute>
          }
        />
        <Route
          path="/mais/lembretes"
          element={
            <ProtectedRoute>
              <AppShell title="Lembretes">
                <LembretesPage />
              </AppShell>
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}
