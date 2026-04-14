import { Settings, Hammer } from "lucide-react";
import { PageHeader } from "../components/PageHeader";
import { GlassCard } from "../components/GlassCard";
import { EmptyState } from "../components/EmptyState";

export function SettingsPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        icon={Settings}
        title="Configurações"
        subtitle="Ajuste sua conta e preferências"
        color="purple"
      />
      <GlassCard>
        <EmptyState
          icon={Hammer}
          title="Em construção"
          hint="Perfil, integrações e notificações chegarão em breve."
        />
      </GlassCard>
    </div>
  );
}
