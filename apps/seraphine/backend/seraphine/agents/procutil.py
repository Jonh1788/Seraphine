"""Subprocess helpers shared by engines and the approved-command runner.

- Windows: ``CREATE_NO_WINDOW`` (same approach as ``llm_adapters.codex``) and
  process-tree kill through ``taskkill /T /F``.
- POSIX: new session + ``killpg``.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import signal
import subprocess
import threading
from typing import Any, Awaitable, Callable

logger = logging.getLogger(__name__)

#: ``on_spawn(pid, creation_time)``: told right after a process starts.
OnSpawn = Callable[[int, "int | None"], Awaitable[None]]

STREAM_LIMIT = 8 * 1024 * 1024

#: Ordinary system variables an approved command may see. Everything else
#: (API keys, tokens, ``SERAPHINE_*``) stays out of the child process.
_ENV_ALLOW_WINDOWS = frozenset(n.upper() for n in (
    "SystemRoot", "windir", "SystemDrive", "PATH", "PATHEXT", "COMSPEC", "TEMP", "TMP",
    "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "ProgramData",
    "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles", "PSModulePath",
    "USERNAME", "USERDOMAIN", "COMPUTERNAME", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS",
))
_ENV_ALLOW_POSIX = frozenset(("PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR", "USER", "SHELL"))
_SECRET_NAME = re.compile(r"KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL", re.IGNORECASE)
REDACTED = "[oculto]"
_MIN_SECRET_LEN = 8


def clean_env() -> dict[str, str]:
    """Minimal environment for an approved command (allow-list, never a deny-list)."""
    allow = _ENV_ALLOW_WINDOWS if os.name == "nt" else _ENV_ALLOW_POSIX
    out: dict[str, str] = {}
    for name, value in os.environ.items():
        key = name.upper() if os.name == "nt" else name
        if key in allow and not _SECRET_NAME.search(name):
            out[name] = value
    return out


def secret_values() -> list[str]:
    """Values of the backend's secret-looking environment variables, longest first."""
    values = {v for k, v in os.environ.items() if _SECRET_NAME.search(k) and len(v) >= _MIN_SECRET_LEN}
    return sorted(values, key=len, reverse=True)


def redact(text: str, secrets: list[str]) -> str:
    for value in secrets:
        text = text.replace(value, REDACTED)
    return text


def spawn_kwargs() -> dict[str, Any]:
    if os.name == "nt":
        return {"creationflags": subprocess.CREATE_NO_WINDOW}
    return {"start_new_session": True}


# -- no engine outlives the backend ------------------------------------------------
#
# Windows: one Job Object with "kill on job close" for the whole backend process.
# Every engine / approved-command process is assigned to it right after it is
# spawned; when the backend dies (even killed) the handle closes and the OS
# terminates them all. Everything here degrades to "no job" with ONE log line;
# the pid + creation time stored on the run (``kill_stale_process``) is the
# second guarantee.

_JOB_KILL_ON_CLOSE = 0x2000
_JOB_EXTENDED_LIMIT_INFO = 9
_PROCESS_TERMINATE = 0x0001
_PROCESS_SET_QUOTA = 0x0100
_PROCESS_QUERY_LIMITED = 0x1000
_STILL_ACTIVE = 259

_job_lock = threading.Lock()
_job: dict[str, Any] = {"handle": None, "failed": False}
_warned = False


def _warn_once(message: str) -> None:
    global _warned
    if not _warned:
        _warned = True
        logger.warning("%s; os motores podem sobreviver a uma queda do backend", message)


def _kernel32() -> Any:
    import ctypes
    from ctypes import wintypes

    k = ctypes.WinDLL("kernel32", use_last_error=True)
    handle = wintypes.HANDLE
    k.CreateJobObjectW.restype = handle
    k.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    k.SetInformationJobObject.restype = wintypes.BOOL
    k.SetInformationJobObject.argtypes = [handle, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    k.AssignProcessToJobObject.restype = wintypes.BOOL
    k.AssignProcessToJobObject.argtypes = [handle, handle]
    k.OpenProcess.restype = handle
    k.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    k.CloseHandle.restype = wintypes.BOOL
    k.CloseHandle.argtypes = [handle]
    k.GetProcessTimes.restype = wintypes.BOOL
    k.GetProcessTimes.argtypes = [handle] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    k.GetExitCodeProcess.restype = wintypes.BOOL
    k.GetExitCodeProcess.argtypes = [handle, ctypes.POINTER(wintypes.DWORD)]
    return k


def _ensure_job() -> Any:
    if os.name != "nt":
        return None
    with _job_lock:
        if _job["handle"] or _job["failed"]:
            return _job["handle"]
        try:
            import ctypes
            from ctypes import wintypes

            class _Basic(ctypes.Structure):
                _fields_ = [
                    ("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                    ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD),
                    ("SchedulingClass", wintypes.DWORD),
                ]

            class _IoCounters(ctypes.Structure):
                _fields_ = [(n, ctypes.c_uint64) for n in (
                    "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                    "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

            class _Extended(ctypes.Structure):
                _fields_ = [
                    ("BasicLimitInformation", _Basic), ("IoInfo", _IoCounters),
                    ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t),
                ]

            k = _kernel32()
            handle = k.CreateJobObjectW(None, None)
            if not handle:
                raise OSError(ctypes.get_last_error(), "CreateJobObjectW")
            info = _Extended()
            info.BasicLimitInformation.LimitFlags = _JOB_KILL_ON_CLOSE
            if not k.SetInformationJobObject(
                    handle, _JOB_EXTENDED_LIMIT_INFO, ctypes.byref(info), ctypes.sizeof(info)):
                err = ctypes.get_last_error()
                k.CloseHandle(handle)
                raise OSError(err, "SetInformationJobObject")
            _job["handle"] = handle
        except Exception as exc:  # noqa: BLE001
            _job["failed"] = True
            _warn_once(f"Job Object indisponível ({exc})")
        return _job["handle"]


def assign_to_job(pid: int) -> bool:
    """Bind process ``pid`` to the backend's kill-on-close job. False (never an
    exception) when there is no job or the assignment fails."""
    if os.name != "nt":
        return False
    job = _ensure_job()
    if not job:
        return False
    try:
        import ctypes

        k = _kernel32()
        proc = k.OpenProcess(_PROCESS_SET_QUOTA | _PROCESS_TERMINATE, False, int(pid))
        if not proc:
            raise OSError(ctypes.get_last_error(), "OpenProcess")
        try:
            if not k.AssignProcessToJobObject(job, proc):
                raise OSError(ctypes.get_last_error(), "AssignProcessToJobObject")
        finally:
            k.CloseHandle(proc)
        return True
    except Exception as exc:  # noqa: BLE001
        _warn_once(f"não foi possível prender o processo ao Job Object ({exc})")
        return False


def process_creation_time(pid: int) -> int | None:
    """Creation instant of a LIVE process as an opaque integer (Windows FILETIME,
    Linux start ticks since boot), or None when it is gone or unreadable. Two
    readings are equal only for the same process (pids get reused)."""
    try:
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes

            k = _kernel32()
            handle = k.OpenProcess(_PROCESS_QUERY_LIMITED, False, int(pid))
            if not handle:
                return None
            try:
                code = wintypes.DWORD()
                if not k.GetExitCodeProcess(handle, ctypes.byref(code)) or code.value != _STILL_ACTIVE:
                    return None
                created, exited, kernel, user = (wintypes.FILETIME() for _ in range(4))
                if not k.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited),
                                         ctypes.byref(kernel), ctypes.byref(user)):
                    return None
                return (created.dwHighDateTime << 32) | created.dwLowDateTime
            finally:
                k.CloseHandle(handle)
        with open(f"/proc/{int(pid)}/stat", "rb") as fh:
            tail = fh.read().decode("utf-8", "replace").rsplit(")", 1)[1].split()
        if tail[0] == "Z":
            return None
        return int(tail[19])  # field 22: starttime
    except Exception:  # noqa: BLE001
        return None


def kill_stale_process(pid: int | None, created: int | None) -> bool:
    """Kill the tree of ``pid`` only if it is alive AND still the same process
    (same creation time). Without a readable creation time nothing is killed."""
    if not pid or created is None:
        return False
    if process_creation_time(pid) != created:
        return False
    try:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW, timeout=15, check=False,
            )
        elif os.getpgid(pid) == pid:  # we spawned it as a session leader
            os.killpg(pid, signal.SIGKILL)
        else:
            os.kill(pid, signal.SIGKILL)
    except Exception:  # noqa: BLE001
        return False
    return True


def track_process(proc: Any) -> None:
    """Called right after every spawn: keeps the process inside the job."""
    assign_to_job(proc.pid)


async def _notify_spawn(proc: Any, on_spawn: OnSpawn | None) -> None:
    if on_spawn is None:
        return
    try:
        await on_spawn(proc.pid, process_creation_time(proc.pid))
    except asyncio.CancelledError:
        raise
    except Exception:  # noqa: BLE001
        logger.exception("on_spawn failed")


def kill_tree(proc: asyncio.subprocess.Process) -> None:
    """Kill ``proc`` and every descendant (best effort, never raises)."""
    if proc.returncode is not None:
        return
    pid = proc.pid
    try:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW, timeout=15, check=False,
            )
        else:
            os.killpg(os.getpgid(pid), signal.SIGKILL)
    except Exception:  # noqa: BLE001
        pass
    try:
        proc.kill()
    except Exception:  # noqa: BLE001
        pass


async def run_lines(
    args: list[str],
    *,
    cwd: str,
    stdin_text: str | None,
    on_line: Callable[[str], Awaitable[None]],
    cancel: asyncio.Event,
    env: dict[str, str] | None = None,
    on_spawn: OnSpawn | None = None,
) -> tuple[int | None, str, bool]:
    """Run a process, feeding stdout lines to ``on_line``.

    Returns ``(returncode, stderr_tail, cancelled)``. ``stdin_text`` is written
    and stdin is closed right away (the prompt never goes into argv). The
    whole process tree is killed on ``cancel`` or when the caller's task is
    cancelled.
    """
    proc = await asyncio.create_subprocess_exec(
        *args,
        cwd=cwd,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        limit=STREAM_LIMIT,
        env=env,
        **spawn_kwargs(),
    )
    track_process(proc)
    stderr_chunks: list[str] = []

    async def _write_stdin() -> None:
        try:
            if stdin_text is not None and proc.stdin is not None:
                proc.stdin.write(stdin_text.encode("utf-8"))
                await proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            try:
                if proc.stdin is not None:
                    proc.stdin.close()
            except Exception:  # noqa: BLE001
                pass

    async def _read_stderr() -> None:
        assert proc.stderr is not None
        while True:
            chunk = await proc.stderr.read(4096)
            if not chunk:
                return
            stderr_chunks.append(chunk.decode("utf-8", "replace"))
            if len(stderr_chunks) > 50:
                del stderr_chunks[:-50]

    async def _read_stdout() -> None:
        assert proc.stdout is not None
        while True:
            line = await proc.stdout.readline()
            if not line:
                return
            text = line.decode("utf-8", "replace").strip()
            if text:
                await on_line(text)

    async def _watch_cancel() -> None:
        await cancel.wait()
        kill_tree(proc)

    tasks = [
        asyncio.create_task(_write_stdin()),
        asyncio.create_task(_read_stderr()),
        asyncio.create_task(_read_stdout()),
    ]
    watcher = asyncio.create_task(_watch_cancel())
    try:
        await _notify_spawn(proc, on_spawn)
        await asyncio.gather(*tasks)
        await proc.wait()
    except asyncio.CancelledError:
        kill_tree(proc)
        raise
    finally:
        watcher.cancel()
        for t in tasks:
            if not t.done():
                t.cancel()
        if proc.returncode is None:
            kill_tree(proc)
            try:
                await asyncio.wait_for(proc.wait(), timeout=10)
            except Exception:  # noqa: BLE001
                pass
    return proc.returncode, "".join(stderr_chunks)[-2000:], cancel.is_set()


async def run_shell_command(
    command: str,
    *,
    cwd: str,
    timeout_s: float,
    cancel: asyncio.Event,
    max_chars: int = 20_000,
    on_spawn: OnSpawn | None = None,
) -> tuple[int | None, str, bool, bool]:
    """Run an owner-approved command string in ``cwd``.

    PowerShell on Windows (``-NoProfile -NonInteractive``), ``sh -c`` elsewhere,
    with a clean environment (``clean_env``). Returns ``(exit_code, output,
    timed_out, cancelled)``; stdout and stderr are merged, secret values of the
    backend's environment are replaced by ``[oculto]`` and ``output`` is
    truncated to ``max_chars``.
    """
    if os.name == "nt":
        argv = ["powershell", "-NoProfile", "-NonInteractive", "-Command", command]
    else:
        argv = ["sh", "-c", command]
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            cwd=cwd,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env=clean_env(),
            **spawn_kwargs(),
        )
    except OSError as exc:
        return None, f"não foi possível iniciar o comando: {exc}", False, False
    track_process(proc)

    secrets = secret_values()
    # Keep a little more than max_chars so a secret cut by the limit is still
    # redacted whole before the output is trimmed.
    keep_limit = max_chars + max((len(v) for v in secrets), default=0)
    kept: list[str] = []
    size = 0
    truncated = False

    async def _drain() -> None:
        nonlocal size, truncated
        assert proc.stdout is not None
        while True:
            chunk = await proc.stdout.read(4096)
            if not chunk:
                return
            text = chunk.decode("utf-8", "replace")
            if size < keep_limit:
                kept.append(text[: keep_limit - size])
                size += len(kept[-1])
            if size >= keep_limit:
                truncated = True

    drain = asyncio.create_task(_drain())
    cancel_waiter = asyncio.create_task(cancel.wait())
    wait_proc = asyncio.create_task(proc.wait())
    timed_out = False
    try:
        await _notify_spawn(proc, on_spawn)
        done, _ = await asyncio.wait(
            {wait_proc, cancel_waiter}, timeout=timeout_s,
            return_when=asyncio.FIRST_COMPLETED,
        )
        if wait_proc not in done:
            timed_out = cancel_waiter not in done
            kill_tree(proc)
            await asyncio.wait_for(proc.wait(), timeout=10)
        await asyncio.wait_for(drain, timeout=10)
    except asyncio.CancelledError:
        kill_tree(proc)
        raise
    except Exception:  # noqa: BLE001
        kill_tree(proc)
    finally:
        cancel_waiter.cancel()
        for t in (drain, wait_proc):
            if not t.done():
                t.cancel()
    output = redact("".join(kept), secrets)
    if len(output) > max_chars:
        output, truncated = output[:max_chars], True
    if truncated:
        output += "\n[... saída truncada ...]"
    return proc.returncode, output, timed_out, cancel.is_set()
