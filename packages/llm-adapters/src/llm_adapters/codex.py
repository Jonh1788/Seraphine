"""Use the official Codex CLI and its existing login as a Seraphine engine.

Seraphine owns history and tool execution. Each ephemeral Codex call returns a
structured reply or tool requests; it cannot run shell commands or change files.
"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from typing import Any, AsyncIterator

from llm_adapters.types import ChatMessage, LLMUnavailableError, Token


def _hidden() -> dict[str, Any]:
    return {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}


class CodexClient:
    def __init__(self, model: str = "", *, executable: str = "codex", timeout: float = 180):
        self.model = model
        self.executable = executable
        self.timeout = timeout
        self._processes: set[asyncio.subprocess.Process] = set()

    async def check_available(self) -> None:
        executable = shutil.which(self.executable)
        if not executable:
            raise LLMUnavailableError("Instale o Codex neste computador e conecte sua conta.")
        process = await asyncio.create_subprocess_exec(
            executable, "login", "status", stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE, **_hidden(),
        )
        try:
            await asyncio.wait_for(process.communicate(), timeout=10)
        except (TimeoutError, asyncio.CancelledError):
            if process.returncode is None:
                process.kill()
            await process.wait()
            raise
        if process.returncode:
            raise LLMUnavailableError("Abra o Codex neste computador e entre na sua conta.")

    async def warmup(self, **_: Any) -> None:
        await self.check_available()

    async def aclose(self) -> None:
        for process in tuple(self._processes):
            if process.returncode is None:
                process.kill()
            await process.wait()

    @staticmethod
    def _schema() -> dict[str, Any]:
        return {
            "type": "object", "additionalProperties": False,
            "required": ["text", "tool_calls"],
            "properties": {
                "text": {"type": "string"},
                "tool_calls": {"type": "array", "items": {
                    "type": "object", "additionalProperties": False,
                    "required": ["name", "arguments"],
                    "properties": {"name": {"type": "string"}, "arguments": {"type": "string"}},
                }},
            },
        }

    @staticmethod
    def _parse_reply(reply: str, tools: list[dict[str, Any]]) -> Token:
        try:
            data = json.loads(reply)
            allowed = {t["function"]["name"] for t in tools}
            calls = []
            for item in data["tool_calls"]:
                if item["name"] not in allowed:
                    raise ValueError("unknown tool")
                arguments = json.loads(item["arguments"])
                if not isinstance(arguments, dict):
                    raise ValueError("tool arguments must be an object")
                calls.append({"function": {"name": item["name"], "arguments": arguments}})
            if not isinstance(data["text"], str):
                raise ValueError("text must be a string")
            return Token(text=data["text"], done=True, tool_calls=calls or None)
        except (ValueError, TypeError, KeyError) as exc:
            raise LLMUnavailableError("O Codex retornou uma resposta inválida. Tente novamente.") from exc

    async def chat(
        self, messages: list[ChatMessage], *, model: str | None = None,
        temperature: float = 0.7, audio: bytes | None = None,
        tools: list[dict[str, Any]] | None = None, think: bool = False,
    ) -> AsyncIterator[Token]:
        if audio:
            raise LLMUnavailableError("Transcreva o áudio antes de enviá-lo ao Codex.")
        executable = shutil.which(self.executable)
        if not executable:
            raise LLMUnavailableError("Codex não encontrado neste computador.")
        available_tools = tools or []
        system = "\n\n".join(str(m.content) for m in messages if m.role == "system")
        instructions = (
            system + "\n\nYou are the inference engine for Seraphine. Follow the system context above. "
            "The input contains conversation history and available Seraphine tools as JSON. "
            "Respond to the last user message, considering tool results already present. "
            "Return the required JSON object. Put the natural-language reply in text. "
            "To request a Seraphine action, return tool_calls with a listed name and a JSON-encoded "
            "arguments object; leave text empty when requesting tools. Seraphine executes these "
            "tools and supplies their results on the next call. Never invent a tool result or "
            "claim an action completed before receiving its result. Do not use Codex's built-in "
            "tools, access files, or run commands. No coding task is being requested."
        )
        payload = json.dumps({
            "messages": [m.model_dump() for m in messages if m.role != "system"],
            "available_tools": available_tools,
        }, ensure_ascii=False).encode("utf-8")
        with tempfile.TemporaryDirectory(prefix="seraphine-codex-") as directory:
            root = Path(directory)
            (root / "instructions.md").write_text(instructions, encoding="utf-8")
            (root / "response.json").write_text(json.dumps(self._schema()), encoding="utf-8")
            args = [
                executable, "exec", "--ignore-user-config", "--ephemeral", "--json",
                "--skip-git-repo-check", "--sandbox", "read-only", "--color", "never",
                "--disable", "shell_tool", "--disable", "multi_agent", "--disable", "plugins",
                "-c", "project_doc_max_bytes=0", "-c", 'web_search="disabled"',
                "-c", 'model_reasoning_effort="' + ("medium" if think else "low") + '"',
                "-c", "model_instructions_file=" + json.dumps(str(root / "instructions.md")),
                "--output-schema", str(root / "response.json"), "--cd", directory,
            ]
            if model or self.model:
                args.extend(["--model", model or self.model])
            args.append("-")
            try:
                process = await asyncio.create_subprocess_exec(
                    *args, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE, limit=8 * 1024 * 1024, **_hidden(),
                )
            except OSError as exc:
                raise LLMUnavailableError("Não foi possível iniciar o Codex.") from exc
            self._processes.add(process)
            try:
                # communicate drains both streams and avoids a full stderr pipe
                # deadlocking the Windows child. Prompts never enter argv/logs.
                output, _stderr = await asyncio.wait_for(
                    process.communicate(payload), timeout=self.timeout,
                )
                if process.returncode:
                    raise LLMUnavailableError(
                        "O Codex não concluiu a resposta. Confira a conexão, o login e o limite da conta."
                    )
                reply = None
                for line in output.decode("utf-8").splitlines():
                    event = json.loads(line)
                    if event.get("type") == "item.completed":
                        item = event.get("item", {})
                        if item.get("type") == "agent_message":
                            reply = item.get("text")
                    if event.get("type") in ("turn.failed", "error"):
                        raise LLMUnavailableError("O Codex não concluiu a resposta. Tente novamente.")
                if not reply:
                    raise LLMUnavailableError("O Codex terminou sem enviar uma resposta.")
                yield self._parse_reply(reply, available_tools)
            except TimeoutError as exc:
                raise LLMUnavailableError("O Codex demorou para responder. Tente novamente.") from exc
            finally:
                if process.returncode is None:
                    process.kill()
                await process.wait()
                self._processes.discard(process)
