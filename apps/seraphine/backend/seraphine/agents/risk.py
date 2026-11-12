"""Command risk classifier for approval requests (pure: no I/O).

``assess_command`` reads a shell command string (PowerShell or sh) and answers
how dangerous it looks, so the owner sees a warning before approving and the
harness can refuse some commands outright. It is a readable table of regexes,
not a shell parser: when in doubt a command is ``medium``, never ``low``.

Levels: ``low`` (read-only inspection or test/build runs), ``medium`` (anything
else), ``high`` (destructive, privileged, secret-reading or leaving the project
folder). ``blocked`` commands are never offered to the owner.
"""

from __future__ import annotations

import posixpath
import re
from dataclasses import dataclass, field
from typing import Iterable

LEVELS = ("low", "medium", "high")


@dataclass(frozen=True)
class RiskAssessment:
    level: str
    reasons: list[str] = field(default_factory=list)
    blocked: bool = False
    blocked_reason: str | None = None


# -- normalisation ------------------------------------------------------------


def _norm(text: str) -> str:
    """Lowercase, one slash direction, single spaces."""
    return re.sub(r"\s+", " ", text.lower().replace("\\", "/")).strip()


def _norm_path(path: str) -> str:
    p = posixpath.normpath(_norm(str(path)).rstrip("/") or "/")
    return p.rstrip("/") if len(p) > 1 else p


def _is_inside(path: str, root: str) -> bool:
    return bool(root) and (path == root or path.startswith(root + "/"))


def _split_parts(command: str) -> list[str]:
    """Split on ``; && || | &`` and newlines outside quotes (``>&``/``&>`` stay)."""
    parts: list[str] = []
    cur: list[str] = []
    quote = ""
    i, n = 0, len(command)
    while i < n:
        ch = command[i]
        if quote:
            cur.append(ch)
            if ch == quote:
                quote = ""
        elif ch in "\"'":
            quote = ch
            cur.append(ch)
        elif ch in ";\n\r|":
            parts.append("".join(cur))
            cur = []
        elif ch == "&":
            prev = command[i - 1] if i else ""
            nxt = command[i + 1] if i + 1 < n else ""
            if prev == ">" or nxt == ">":
                cur.append(ch)
            else:
                parts.append("".join(cur))
                cur = []
        else:
            cur.append(ch)
        i += 1
    parts.append("".join(cur))
    return [p.strip() for p in parts if p.strip()]


# -- rule tables (all patterns run on the normalised, lowercase text) ------------

_BLOCKED_RULES: tuple[tuple[str, str], ...] = (
    (r"(^| )-(enc|ec|encodedcommand|encodedarguments)\b",
     "PowerShell codificado ou ofuscado não é permitido."),
    (r"frombase64string.*(iex|invoke-expression|powershell|pwsh|cmd|invoke-command|-command)"
     r"|(iex|invoke-expression|powershell|pwsh|cmd).*frombase64string",
     "Decodificar texto em base64 para executá-lo não é permitido."),
    (r"base64 +(-d|--decode)\b.*\| *(sh|bash|zsh|powershell|pwsh)\b",
     "Decodificar texto em base64 para executá-lo não é permitido."),
    (r"\b(diskpart|bcdedit|format-volume|clear-disk|initialize-disk|remove-partition|"
     r"mkfs(\.\w+)?|fdisk|bootrec|bcdboot)\b",
     "Ferramentas de disco e de inicialização do sistema não são permitidas."),
    (r"\bdd +.*\bof=/dev/", "Ferramentas de disco e de inicialização do sistema não são permitidas."),
)

#: Matched at the start of a single part (``format`` is also a common option name).
_BLOCKED_PART_START = (
    (r"^(format|format\.com)( +[a-z]:| *$)",
     "Ferramentas de disco e de inicialização do sistema não são permitidas."),
)

_FETCH = (r"(iwr|irm|curl|wget|invoke-webrequest|invoke-restmethod|downloadstring|"
          r"downloadfile|net\.webclient|start-bitstransfer)")
_RUNNER = r"(iex|invoke-expression|sh|bash|zsh|powershell|pwsh|python3?|node|cmd)"

_HIGH_RULES: tuple[tuple[str, str], ...] = (
    # destructive deletes and overwrites
    (r"\brm +(-[a-z]*r[a-z]*|--recursive)\b", "Apaga arquivos e pastas de forma recursiva."),
    (r"\b(remove-item|ri|rm|del|erase)\b.*(^| )-recurse\b", "Apaga arquivos e pastas de forma recursiva."),
    (r"\b(del|erase|rd|rmdir)\b.* /s\b", "Apaga arquivos e pastas de forma recursiva."),
    (r"\bdeltree\b", "Apaga arquivos e pastas de forma recursiva."),
    (r"\b(shred|cipher +/w)\b", "Sobrescreve ou apaga dados de forma irreversível."),
    (r"\bgit +clean\b.* -[a-z]*f", "O git clean apaga arquivos que não estão no controle de versão."),
    (r"\bgit +reset\b.* --hard\b", "O git reset --hard descarta alterações não salvas."),
    (r"\bgit +push\b.*( --force\b| --force-with-lease\b| -f\b| \+\S)",
     "Envio forçado ao repositório remoto pode apagar histórico alheio."),
    (r"\bgit +(filter-branch|filter-repo|rebase|reflog +expire|update-ref +-d)\b",
     "Reescreve o histórico do git."),
    # download and execute
    (rf"\b{_FETCH}\b.*\| *{_RUNNER}\b", "Baixa um conteúdo da internet e o executa."),
    (rf"\b(iex|invoke-expression)\b.*\b{_FETCH}\b|\b{_FETCH}\b.*\b(iex|invoke-expression)\b",
     "Baixa um conteúdo da internet e o executa."),
    (r"\b(iex|invoke-expression)\b", "Executa um texto como se fosse um comando."),
    (r"frombase64string|base64 +(-d|--decode)", "Decodifica texto em base64, o que pode esconder o que o comando faz."),
    # privileges and system configuration
    (r"\breg(\.exe)? +(add|delete|import|load|unload|save|restore|copy)\b|\bhk(lm|cu|cr|u|cc)[:/]|\bhkey_",
     "Altera ou lê o registro do Windows."),
    (r"\b(new|set|remove|clear|rename|copy|move)-itemproperty\b.*\bhk", "Altera o registro do Windows."),
    (r"\bset-executionpolicy\b", "Muda a política de execução de scripts do PowerShell."),
    (r"\bsc(\.exe)? +(\\\\\S+ +)?(create|config|delete|stop|start|failure|sdset)\b"
     r"|\b(new|set|stop|start|restart|remove|suspend)-service\b|\bnet +(start|stop|user|localgroup|share)\b",
     "Cria, altera ou para serviços e contas do Windows."),
    (r"\b(schtasks|(register|unregister|set|new|enable|disable)-scheduledtask(job)?)\b",
     "Cria ou altera tarefas agendadas."),
    (r"\b(netsh|(new|set|remove|enable|disable)-netfirewall\w*|ufw|iptables)\b",
     "Altera a rede ou o firewall do computador."),
    (r"\brunas\b|-verb +runas\b|\bsudo\b|\bdoas\b",
     "Pede privilégios de administrador."),
    (r"\b(takeown|icacls|cacls|chown|chmod +-r|setfacl)\b", "Muda donos ou permissões de arquivos."),
    (r"\b(setx|dism|wmic|bcdedit|gpupdate|secedit)\b|setenvironmentvariable.*machine",
     "Altera configurações do sistema."),
    # secrets
    (r"(^|[ /\"'=:(])\.env(\.[a-z0-9_-]+)?($|[ /\"';|&)])", "Lê um arquivo .env, que costuma guardar senhas e chaves."),
    (r"\bid_(rsa|dsa|ecdsa|ed25519)\b|(^|/)\.ssh(/|$| )|\.(pem|pfx|p12|ppk)\b",
     "Mexe em chaves ou certificados."),
    (r"(^|/)\.(aws|azure|kube|gnupg|docker|config/gcloud)(/|$| )|\.(npmrc|netrc|pypirc|git-credentials)\b"
     r"|\bcredentials?(\.json|\.xml)?\b",
     "Lê arquivos de credenciais."),
    (r"\b(cmdkey|vaultcmd|get-storedcredential|secret-tool|security +find-generic-password)\b|credential manager",
     "Acessa o cofre de credenciais."),
    (r"\bprintenv\b|(^| )(get-childitem|gci|ls|dir|get-item|gi|get-content) +(-\w+ +)*env:"
     r"|\[(system\.)?environment\]::getenvironmentvariables|\bos\.environ\b|\bprocess\.env\b"
     r"|(^|[;&|] *)(env|export -p|set) *($|[|;&])",
     "Despeja as variáveis de ambiente."),
    (r"\$env:\w*(key|token|secret|passw|credential)", "Lê uma variável de ambiente que parece guardar um segredo."),
    # turning off protection
    (r"\b(set|add)-mppreference\b|\bmpcmdrun\b|\bwindefend\b|\bmsmpeng\b|\bsetenforce\b|\bufw +disable\b"
     r"|\b(disable|stop)\b.*\b(defender|antivirus|firewall|realtime)\b",
     "Desliga ou enfraquece uma proteção de segurança."),
)

#: Paths that leave the project folder without being a plain absolute path.
_HOME_REFS = re.compile(
    r"(^|[ \"'=(,])~(/|$|[ \"')])"
    r"|\$\{?home\}?\b|\$env:(userprofile|homepath|homedrive|home|appdata|localappdata|programdata|"
    r"systemroot|windir|temp|tmp|public|programfiles\S*|allusersprofile)\b"
    r"|%(userprofile|homepath|homedrive|appdata|localappdata|programdata|systemroot|windir|temp|tmp)%"
)
_ABS_PATH = re.compile(
    r"(?<![\w.])[a-z]:/[^ \"'`;|&<>)]*"  # c:/x
    r"|(?<![\w.:/])//[^ \"'`;|&<>)/]+/[^ \"'`;|&<>)]*"  # //host/share
    r"|(?<![\w.:/-])/(?:etc|usr|var|bin|sbin|home|root|tmp|opt|mnt|dev|proc|sys|lib|lib64|srv|boot|"
    r"users|volumes|private|library|system|applications|windows|programdata)\b[^ \"'`;|&<>)]*"
)
_REL_TOKEN = re.compile(r"[^ \"'`;|&<>=()]*\.\.[^ \"'`;|&<>()]*")

# -- low (read-only / test / build) and medium reason tables ---------------------

_LOW_PART = re.compile(
    r"^(?:&\s*)?(?:"
    r"git +(status|diff|log|show|rev-parse|ls-files|blame|describe|shortlog|--version)\b"
    r"|git +branch( +(-a|-r|-v|-vv|--all|--list|--show-current))* *$"
    r"|git +remote( +-v)? *$|git +stash +list\b|git +config +--get\b"
    r"|(ls|dir|get-childitem|gci|tree|pwd|get-location|gl|cd|chdir|set-location|sl|where|where\.exe|which|"
    r"whoami|hostname|get-date|date|echo|write-output|write-host|type|cat|get-content|gc|head|tail|more|"
    r"wc|measure-object|select-object|select|select-string|sls|grep|rg|findstr|format-table|ft|format-list|"
    r"fl|get-item|gi|test-path|resolve-path|get-filehash|get-command|get-help|sort-object|"
    r"where-object|foreach-object)(?: |$)"
    r"|(python3?|py|node|npm|pnpm|yarn|pip|dotnet|cargo|go|java|uv|ruby|php) +(--version|-v|-version|version) *$"
    r"|(?:\S*/)?(python3?|py)(\.exe)? +-m +(pytest|unittest|mypy|ruff +check)\b"
    r"|pytest\b|(npm|pnpm|yarn) +(test|t)\b|(npm|pnpm|yarn) +(run +)?(test|build|lint|typecheck|check)\b"
    r"|(vitest|jest|tsc|eslint|mypy)\b|ruff +check\b"
    r"|cargo +(test|build|check|clippy)\b|go +(test|build|vet)\b|dotnet +(test|build)\b"
    r")"
)
#: A part is never low when it can run or write something hidden in it.
_LOW_VETO = re.compile(r">|`|\$\(|\| *\w| -(exec|execdir|delete|fix|write|out|outfile)|--(fix|write|output|out)\b")

_MEDIUM_REASONS: tuple[tuple[str, str], ...] = (
    (r"\b(npm|pnpm|yarn|pip3?|uv|cargo|go|dotnet|gem|composer|winget|choco|scoop|apt|apt-get|brew) +"
     r"(install|i|add|update|upgrade|remove|uninstall|get|restore)\b|\bnpx\b|\binstall-module\b",
     "Instala ou altera pacotes."),
    (r"\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|ssh|scp|sftp|ftp|nc|ncat|telnet|ping|"
     r"nslookup|test-netconnection)\b|\bgit +(clone|fetch|pull|push|remote +add)\b",
     "Acessa a rede."),
    (r"\bgit +(commit|merge|tag|add|checkout|switch|restore|stash|cherry-pick|am|apply|mv|rm|branch|init)\b",
     "Altera o repositório git."),
    (r"\b(set-content|add-content|out-file|new-item|copy-item|move-item|rename-item|remove-item|clear-content|"
     r"mkdir|md|touch|cp|mv|copy|move|ren|rename|del|erase|rm|rmdir|rd|tee|sed -i|ni|cpi|mi|ri|sc|ac)\b",
     "Cria, altera ou apaga arquivos."),
    (r"\b(start-process|start|invoke-command|\./\S+|\.\\\S+|python3?|py|node|bash|sh|powershell|pwsh|cmd|"
     r"ruby|php|java|deno|bun)\b|\.(ps1|bat|cmd|sh|py|js)\b",
     "Executa um programa ou script."),
)


def _protected_roots(project_path: str, protected: Iterable[str]) -> tuple[str, list[str]]:
    return _norm_path(project_path) if project_path else "", [
        _norm_path(p) for p in protected if str(p).strip()]


def _resolve(token: str, project: str) -> str:
    t = _norm(token).strip("\"'")
    if re.match(r"^[a-z]:/|^/", t):
        return posixpath.normpath(t)
    return posixpath.normpath(posixpath.join(project or "/", t))


def _path_findings(norm: str, project: str, protected: list[str]) -> tuple[list[str], list[str]]:
    """Return ``(outside_project_reasons, blocked_reasons)`` for the paths in ``norm``."""
    outside: list[str] = []
    blocked: list[str] = []
    candidates: list[str] = [m.group(0).rstrip(",.") for m in _ABS_PATH.finditer(norm)]
    for tok in _REL_TOKEN.findall(norm):
        if ".." in tok.split("/"):
            candidates.append(tok)
    for tok in candidates:
        resolved = _resolve(tok, project)
        if any(_is_inside(resolved, root) for root in protected):
            blocked.append("Mexe na pasta de dados ou no banco de dados do Seraphine.")
        elif not (project and _is_inside(resolved, project)):
            outside.append("Mexe em arquivos fora da pasta do projeto.")
    if _HOME_REFS.search(norm):
        outside.append("Mexe na pasta pessoal ou do sistema do usuário.")
    return outside, blocked


def _medium_reason(part: str) -> str:
    for pattern, reason in _MEDIUM_REASONS:
        if re.search(pattern, part):
            return reason
    return "Comando que não é reconhecido como somente leitura."


def _add(target: list[str], reason: str) -> None:
    if reason not in target:
        target.append(reason)


def assess_command(command: str, *, project_path: str = "",
                   protected_paths: Iterable[str] = ()) -> RiskAssessment:
    """Classify ``command``. ``protected_paths`` are Seraphine's own data folder
    and database: any reference to them is ``blocked``."""
    text = str(command or "")
    norm = _norm(text)
    project, protected = _protected_roots(project_path, protected_paths)
    high: list[str] = []
    medium: list[str] = []
    blocked: list[str] = []

    for pattern, reason in _BLOCKED_RULES:
        if re.search(pattern, norm):
            _add(blocked, reason)
    for protected_root in protected:
        if protected_root not in ("", "/") and protected_root in norm:
            _add(blocked, "Mexe na pasta de dados ou no banco de dados do Seraphine.")
    for pattern, reason in _HIGH_RULES:
        if re.search(pattern, norm):
            _add(high, reason)
    outside, path_blocked = _path_findings(norm, project, protected)
    for reason in outside:
        _add(high, reason)
    for reason in path_blocked:
        _add(blocked, reason)

    all_low = True
    parts = _split_parts(text) or [text]
    for part in parts:
        pn = _norm(part)
        for pattern, reason in _BLOCKED_PART_START:
            if re.search(pattern, pn):
                _add(blocked, reason)
        if _LOW_PART.search(pn) and not _LOW_VETO.search(pn):
            continue
        all_low = False
        _add(medium, _medium_reason(pn))

    if blocked:
        level = "high"
        reasons = blocked + [r for r in high if r not in blocked]
        return RiskAssessment(level, reasons, True, " ".join(blocked))
    if high:
        return RiskAssessment("high", high, False, None)
    if all_low:
        return RiskAssessment("low", [], False, None)
    return RiskAssessment("medium", medium, False, None)
