# afm-cli — Apple Foundation Models helper (OpenJarvis #4)

`afm-cli` is a tiny Swift command-line wrapper around Apple's on-device
[`FoundationModels`](https://developer.apple.com/documentation/foundationmodels)
framework. It lets the Seraphine Python backend run inference on Apple's local
Foundation Model (the same model that powers Apple Intelligence) without any cloud
round-trip or API key.

## Requirements

- **macOS 26+** with **Apple Intelligence** enabled (the `FoundationModels`
  framework ships only on macOS 26 and later).
- Xcode / Swift toolchain (`swiftc`) to build the helper.

On macOS < 26 the framework is absent, the helper compiles to a stub that exits
with code `2`, and the Python adapter
(`llm_adapters.apple_fm.AppleFoundationModelsClient`) is **inert by design**:
`is_available()` returns `False` and `chat()` raises `LLMUnavailableError`.

## Build

```sh
mkdir -p ~/.seraphine/bin
swiftc afm-cli.swift -o ~/.seraphine/bin/afm-cli
```

The Python adapter looks for the helper at `~/.seraphine/bin/afm-cli` by default
(override with the `SERAPHINE_AFM_HELPER` env var), falling back to whatever
`afm-cli` resolves to on `PATH`.

## Protocol

The helper speaks a minimal line-oriented JSON protocol:

- **stdin** — one JSON object on a single line:

  ```json
  {"messages": [{"role": "user", "content": "olá"}], "temperature": 0.7}
  ```

- **stdout** — streamed response, one token/text chunk per line. The Python
  adapter reads lines until EOF, emits each non-empty chunk as a `Token`, then a
  final `Token(text="", done=True)`.

- **stderr** — diagnostics (e.g. the "FoundationModels unavailable" message on
  older macOS).

## NOTE — API must be re-verified before building

`afm-cli.swift` targets the `LanguageModelSession.streamResponse(to:)` API as
documented during development. The shipping **macOS 26 SDK** may rename or reshape
this surface (session construction, streaming type, partial-result shape). **Re-verify
the `FoundationModels` API against the installed SDK before compiling**, and adjust
the streaming loop accordingly. CI does **not** compile this file; it is a
forward-looking artifact.
