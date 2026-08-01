# @karowanorg/orc-core

The orc engine: deterministic QuickJS event loop, journaled leaves, replay/resume, supervisor, contracts.

Core owns the declarative `UiPresentation` and named approval-action contracts.
Presentations live only in bounded trace metadata and never affect replay or
extension results. Long-running extensions can replace their live presentation
through `context.present(...)` without creating another leaf.

Part of orc - model-authored promise-native agent programs with deterministic replay, live monitoring, and pluggable harnesses. See the orc repository README for the full picture.
