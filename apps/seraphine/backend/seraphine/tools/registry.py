from __future__ import annotations

from pathlib import Path
from typing import Any, Iterator



from seraphine.tools.base import Tool
from seraphine.tools.filesystem import ListDirTool, ReadFileTool, WriteFileTool
from seraphine.tools.image_fetch import FetchImageTool
from seraphine.tools.meta import RequestSkillTool
from seraphine.tools.shell import RunShellTool
from seraphine.tools.browser import (
    LearnMusicTasteTool,
    NowPlayingTool,
    OpenUrlTool,
    PauseMusicTool,
    PlayMusicTool,
    ResumeMusicTool,
)
from seraphine.tools.routes import RoutePlannerTool
from seraphine.tools.news import SearchNewsTool
from seraphine.tools.search import WebSearchTool
from seraphine.tools.weather import FormatWeatherCardTool, WeatherForecastTool
from seraphine.tools.dev import (
    EditFileTool,
    GitDiffTool,
    GitStatusTool,
    RunTestsTool,
    SearchCodeTool,
)
from seraphine.tools.document import DocumentReadTool
from seraphine.tools.sticky import StickyNoteTool
from seraphine.tools.flashcards import CreateDeckTool, ListDueTool
from seraphine.tools.image_gen import GenerateImageTool
from seraphine.tools.background import (
    CancelBackgroundTaskTool,
    ListBackgroundTasksTool,
    StartBackgroundTaskTool,
)
from seraphine.tools.native_mac import (
    ActiveAppTool,
    OpenPathTool,
    OsascriptTool,
    ShortcutsRunTool,
)
from seraphine.tools.web import WebFetchTool


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}

    def register(self, tool: Tool) -> None:
        self._tools[tool.name] = tool

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def list(self) -> list[Tool]:
        return list(self._tools.values())

    def as_ollama_tools(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for t in self._tools.values():
            out.append(
                {
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.json_schema,
                    },
                }
            )
        return out

    def __contains__(self, name: object) -> bool:
        return isinstance(name, str) and name in self._tools

    def __iter__(self) -> Iterator[Tool]:
        return iter(self._tools.values())


def build_default_registry(
    allowed_roots: list[Path],
    *,
    skills_dir: Path | None = None,
    store: Any = None,
    google_client: Any = None,
    whatsapp_client: Any = None,
    browser_client: Any = None,
    wise_client: Any = None,
    reminder_scheduler: Any = None,
    finance_service: Any = None,
    task_service: Any = None,
    recurring_service: Any = None,
    habit_service: Any = None,
    water_service: Any = None,
    health_service: Any = None,
    note_service: Any = None,
    work_service: Any = None,
    goal_service: Any = None,
    reading_service: Any = None,
    mood_service: Any = None,
    focus_service: Any = None,
    journal_service: Any = None,
    planning_service: Any = None,
    tts: Any = None,
    llm: Any = None,
    agent_harness: Any = None,
) -> ToolRegistry:
    reg = ToolRegistry()
    reg.register(ReadFileTool(allowed_roots))
    reg.register(ListDirTool(allowed_roots))
    reg.register(WriteFileTool(allowed_roots))
    reg.register(RunShellTool())
    reg.register(WebFetchTool())
    reg.register(WebSearchTool())
    reg.register(DocumentReadTool())
    # 034 Native Mac
    reg.register(OsascriptTool())
    reg.register(ShortcutsRunTool())
    reg.register(OpenPathTool())
    reg.register(ActiveAppTool())
    # 055 Sticky notes
    if store is not None:
        reg.register(StickyNoteTool(store))
    # 067 flashcards
    if store is not None and llm is not None:
        reg.register(CreateDeckTool(store, llm))
        reg.register(ListDueTool(store, llm))
    # 068 image generation
    if store is not None:
        reg.register(GenerateImageTool(store))
        # Visual self-identity (works alongside generate_image as_self=true)
        from seraphine.tools.appearance import (
            ForgetMyAppearanceTool,
            RememberMyAppearanceTool,
        )
        reg.register(RememberMyAppearanceTool(store))
        reg.register(ForgetMyAppearanceTool(store))
    # 073 background tasks
    if store is not None and llm is not None:
        reg.register(StartBackgroundTaskTool(store, llm, tool_registry=reg))
        reg.register(ListBackgroundTasksTool(store))
        reg.register(CancelBackgroundTaskTool(store))
    # 036 Dev sidekick
    reg.register(GitStatusTool())
    reg.register(GitDiffTool())
    reg.register(EditFileTool())
    reg.register(RunTestsTool())
    reg.register(SearchCodeTool())
    reg.register(FetchImageTool())
    reg.register(SearchNewsTool())
    reg.register(RoutePlannerTool())
    reg.register(WeatherForecastTool())
    reg.register(FormatWeatherCardTool())
    reg.register(PlayMusicTool())
    reg.register(NowPlayingTool())
    reg.register(PauseMusicTool())
    reg.register(ResumeMusicTool())
    reg.register(LearnMusicTasteTool(store=store))
    reg.register(OpenUrlTool())
    if skills_dir is not None:
        reg.register(RequestSkillTool(skills_dir))
    if google_client is not None:
        from seraphine.tools.google import (
            CalendarBulkDeleteEventsTool,
            CalendarCreateEventTool,
            CalendarDeleteEventTool,
            CalendarListEventsTool,
            CalendarUpdateEventTool,
            GmailListImportantTool,
            GmailReadMessageTool,
            GmailSendMessageTool,
            GmailDownloadAttachmentTool,
            GoogleAuthStatusTool,
        )

        reg.register(GoogleAuthStatusTool(google_client))
        reg.register(CalendarListEventsTool(google_client))
        reg.register(GmailListImportantTool(google_client))
        reg.register(GmailReadMessageTool(google_client))
        reg.register(GmailDownloadAttachmentTool(google_client))
        # Phase B — write tools (approval-gated)
        reg.register(CalendarCreateEventTool(google_client))
        reg.register(CalendarUpdateEventTool(google_client))
        reg.register(CalendarDeleteEventTool(google_client))
        reg.register(CalendarBulkDeleteEventsTool(google_client))
        reg.register(GmailSendMessageTool(google_client, allowed_roots))
    if whatsapp_client is not None:
        from seraphine.tools.whatsapp import (
            WhatsAppAuthStatusTool,
            WhatsAppListChatsTool,
            WhatsAppReadMessagesTool,
            WhatsAppSearchMessagesTool,
            WhatsAppSendMessageTool,
            WhatsAppSendVoiceTool,
        )

        reg.register(WhatsAppAuthStatusTool(whatsapp_client))
        reg.register(WhatsAppListChatsTool(whatsapp_client))
        reg.register(WhatsAppReadMessagesTool(whatsapp_client))
        reg.register(WhatsAppSendMessageTool(whatsapp_client))
        reg.register(WhatsAppSearchMessagesTool(whatsapp_client))
        if tts is not None:
            reg.register(WhatsAppSendVoiceTool(whatsapp_client, tts))
    if browser_client is not None:
        from seraphine.tools.browser_automation import (
            BrowserClickTool,
            BrowserConfirmPaymentTool,
            BrowserKeyTool,
            BrowserOpenTool,
            BrowserPageInfoTool,
            BrowserScreenshotTool,
            BrowserScrollTool,
            BrowserSubmitTool,
            BrowserTypeTool,
        )

        reg.register(BrowserOpenTool(browser_client))
        reg.register(BrowserScreenshotTool(browser_client))
        reg.register(BrowserClickTool(browser_client))
        reg.register(BrowserTypeTool(browser_client))
        reg.register(BrowserScrollTool(browser_client))
        reg.register(BrowserKeyTool(browser_client))
        reg.register(BrowserPageInfoTool(browser_client))
        reg.register(BrowserSubmitTool(browser_client))
        reg.register(BrowserConfirmPaymentTool(browser_client))
    if wise_client is not None:
        from seraphine.tools.wise import (
            WiseBalanceTool,
            WiseQuoteTool,
            WiseRecipientsTool,
            WiseSendPixTool,
            WiseTransactionsTool,
            WiseTransferStatusTool,
        )

        reg.register(WiseBalanceTool(wise_client))
        reg.register(WiseTransactionsTool(wise_client))
        reg.register(WiseQuoteTool(wise_client))
        reg.register(WiseRecipientsTool(wise_client))
        reg.register(WiseSendPixTool(wise_client))
        reg.register(WiseTransferStatusTool(wise_client))
    if reminder_scheduler is not None:
        from seraphine.tools.reminders import (
            CancelReminderTool,
            CreateReminderTool,
            ListRemindersTool,
        )

        reg.register(CreateReminderTool(reminder_scheduler))
        reg.register(ListRemindersTool(reminder_scheduler))
        reg.register(CancelReminderTool(reminder_scheduler))
    if finance_service is not None:
        from seraphine.tools.financial import (
            AddFinancialEntryTool,
            BulkAddFinancialEntriesTool,
            FinancialDashboardTool,
            ImportFinancialPdfTool,
            ListFinancialEntriesTool,
            MarkInvoicePaidTool,
        )

        reg.register(FinancialDashboardTool(finance_service))
        reg.register(AddFinancialEntryTool(finance_service))
        reg.register(BulkAddFinancialEntriesTool(finance_service))
        reg.register(ListFinancialEntriesTool(finance_service))
        reg.register(ImportFinancialPdfTool(finance_service, llm=llm))
        reg.register(MarkInvoicePaidTool(finance_service))
    if task_service is not None:
        from seraphine.tools.tasks import CreateTaskTool, UpdateTaskTool

        reg.register(CreateTaskTool(task_service, scheduler=reminder_scheduler, work_service=work_service))
        reg.register(UpdateTaskTool(task_service, scheduler=reminder_scheduler))
    if recurring_service is not None:
        from seraphine.tools.recurring import (
            CreateRecurringTaskTool,
            DeleteRecurringTaskTool,
            ListRecurringTasksTool,
            UpdateRecurringTaskTool,
        )

        reg.register(CreateRecurringTaskTool(recurring_service))
        reg.register(ListRecurringTasksTool(recurring_service))
        reg.register(UpdateRecurringTaskTool(recurring_service))
        reg.register(DeleteRecurringTaskTool(recurring_service))
    if habit_service is not None:
        from seraphine.tools.habits import CreateHabitTool, ToggleHabitTool

        reg.register(CreateHabitTool(habit_service))
        reg.register(ToggleHabitTool(habit_service))
    if water_service is not None:
        from seraphine.tools.water import LogWaterTool, SetupWaterTool

        reg.register(LogWaterTool(water_service))
        reg.register(SetupWaterTool(water_service))
    if health_service is not None:
        from seraphine.tools.health import HealthSummaryTool, HealthTrendTool

        reg.register(HealthSummaryTool(health_service))
        reg.register(HealthTrendTool(health_service))
    if note_service is not None:
        from seraphine.tools.notes import (
            CreateNoteTool,
            DeleteNoteTool,
            ListNotesTool,
            SearchNotesTool,
            UpdateNoteTool,
        )

        reg.register(CreateNoteTool(note_service, work_service=work_service))
        reg.register(UpdateNoteTool(note_service))
        reg.register(DeleteNoteTool(note_service))
        reg.register(ListNotesTool(note_service))
        reg.register(SearchNotesTool(note_service))
    if work_service is not None:
        from seraphine.tools.work import (
            CreateWorkProjectTool,
            LinkWorkProjectTool,
            ListWorkProjectsTool,
        )

        reg.register(CreateWorkProjectTool(work_service))
        reg.register(ListWorkProjectsTool(work_service))
        reg.register(LinkWorkProjectTool(work_service))
    if agent_harness is not None:
        from seraphine.tools.agents import (
            AgentsCreateTaskTool,
            AgentsDelegateTool,
            AgentsListTool,
            AgentsRunStatusTool,
        )

        reg.register(AgentsListTool(agent_harness))
        reg.register(AgentsDelegateTool(agent_harness))
        reg.register(AgentsRunStatusTool(agent_harness))
        reg.register(AgentsCreateTaskTool(agent_harness))
    if goal_service is not None:
        from seraphine.tools.goals import (
            CreateGoalTool,
            ListGoalsTool,
            UpdateGoalProgressTool,
        )

        reg.register(CreateGoalTool(goal_service))
        reg.register(ListGoalsTool(goal_service))
        reg.register(UpdateGoalProgressTool(goal_service))
    if reading_service is not None:
        from seraphine.tools.reading import (
            SaveReadingItemTool,
            SearchReadingListTool,
        )

        reg.register(SaveReadingItemTool(reading_service))
        reg.register(SearchReadingListTool(reading_service))
    if mood_service is not None:
        from seraphine.tools.mood import GetMoodTrendTool, LogMoodTool

        reg.register(LogMoodTool(mood_service))
        reg.register(GetMoodTrendTool(mood_service))
    if focus_service is not None:
        from seraphine.tools.focus import GetFocusStatsTool

        reg.register(GetFocusStatsTool(focus_service))
    if journal_service is not None:
        from seraphine.tools.journal import CreateJournalEntryTool, SearchJournalTool

        reg.register(CreateJournalEntryTool(journal_service))
        reg.register(SearchJournalTool(journal_service))
    if planning_service is not None:
        from seraphine.tools.planning import GeneratePlanTool

        reg.register(GeneratePlanTool(planning_service))
    # macOS screen tools — registered unconditionally because they're
    # `proxy_to_client = True`: the backend just ships the call over WS
    # and the Tauri client runs `screencapture` / `cliclick` locally.
    # Previously gated on `sys.platform == 'darwin'`, which hid them
    # whenever the backend ran on Linux (VPS) — i.e., always in prod —
    # so the LLM had no idea these tools existed.
    from seraphine.tools.screen import (
        ScreenCaptureTool,
        ScreenClickTool,
        ScreenCopyToClipboardTool,
        ScreenKeyTool,
        ScreenReadClipboardTool,
        ScreenRunCommandTool,
        ScreenTypeTool,
    )

    reg.register(ScreenCaptureTool())
    reg.register(ScreenClickTool())
    reg.register(ScreenTypeTool())
    reg.register(ScreenRunCommandTool())
    reg.register(ScreenKeyTool())
    reg.register(ScreenCopyToClipboardTool())
    reg.register(ScreenReadClipboardTool())
    return reg
