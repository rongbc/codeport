# Changelog

All notable changes to this project will be documented in this file.

## [0.0.2] - 2026-08-29

### Added

- Function-name jump: clangd-powered go-to-definition (F12 / Ctrl+Click) for identifiers inside Markdown code blocks and inline code.
- Background index warm-up: `didOpen` a seed file from `compile_commands.json` to wake clangd's background indexer.
- Settings: `mdCodeLinks.enableFunctionJump`, `mdCodeLinks.prewarmIndex`, `mdCodeLinks.clangdPath`.

### Changed

- Path/line links now resolve only absolute paths and project-root-relative paths.

## [0.0.1] - 2026-08-29

### Added

- Clickable `path/file.c:line` links in Markdown (Ctrl+Click opens file, `#L` fragment reveals line).
