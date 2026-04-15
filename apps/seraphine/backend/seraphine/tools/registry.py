from __future__ import annotations

from pathlib import Path
from typing import Any, Iterator



from seraphine.tools.base import Tool
from seraphine.tools.filesystem import ListDirTool, ReadFileTool, WriteFileTool
from seraphine.tools.image_fetch import FetchImageTool
from seraphine.tools.meta import RequestSkillTool
from seraphine.tools.shell import RunShellTool
from seraphine.tools.browser import LearnMusicTasteTool, OpenUrlTool, PlayMusicTool
from seraphine.tools.routes import RoutePlannerTool
from seraphine.tools.news import SearchNewsTool
from seraphine.tools.search import WebSearchTool
from seraphine.tools.weather import FormatWeatherCardTool, WeatherForecastTool
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
    tts: Any = None,
    llm: Any = None,
) -> ToolRegistry:
    reg = ToolRegistry()
    reg.register(ReadFileTool(allowed_roots))
    reg.register(ListDirTool(allowed_roots))
    reg.register(WriteFileTool(allowed_roots))
    reg.register(RunShellTool())
    reg.register(WebFetchTool())
    reg.register(WebSearchTool())
    reg.register(FetchImageTool())
    reg.register(SearchNewsTool())
    reg.register(RoutePlannerTool())
    reg.register(WeatherForecastTool())
    reg.register(FormatWeatherCardTool())
    reg.register(PlayMusicTool())
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
        )

        reg.register(FinancialDashboardTool(finance_service))
        reg.register(AddFinancialEntryTool(finance_service))
        reg.register(BulkAddFinancialEntriesTool(finance_service))
        reg.register(ListFinancialEntriesTool(finance_service))
        reg.register(ImportFinancialPdfTool(finance_service, llm=llm))
    if task_service is not None:
        from seraphine.tools.tasks import CreateTaskTool, UpdateTaskTool

        reg.register(CreateTaskTool(task_service))
        reg.register(UpdateTaskTool(task_service))
    if recurring_service is not None:
        from seraphine.tools.recurring import CreateRecurringTaskTool

        reg.register(CreateRecurringTaskTool(recurring_service))
    # macOS screen tools — always registered (no client needed, uses subprocess)
    import sys
    if sys.platform == "darwin":
        from seraphine.tools.screen import (
            ScreenCaptureTool,
            ScreenClickTool,
            ScreenCopyToClipboardTool,
            ScreenKeyTool,
            ScreenReadClipboardTool,
            ScreenTypeTool,
        )

        reg.register(ScreenCaptureTool())
        reg.register(ScreenClickTool())
        reg.register(ScreenTypeTool())
        reg.register(ScreenKeyTool())
        reg.register(ScreenCopyToClipboardTool())
        reg.register(ScreenReadClipboardTool())
    return reg
