import { CalendarDays, Hammer } from "lucide-react";
import { PageHeader } from "../components/PageHeader";
import { GlassCard } from "../components/GlassCard";
import { EmptyState } from "../components/EmptyState";

export function CalendarPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        icon={CalendarDays}
        title="Calendário"
        subtitle="Sua agenda completa em um só lugar"
        color="purple"
      />
      <GlassCard>
        <EmptyState
          icon={Hammer}
          title="Em construção"
          hint="Visão mensal, semanal e diária chegarão em breve."
        />
      </GlassCard>
    </div>
  );
}
