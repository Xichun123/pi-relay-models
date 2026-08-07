# Changelog

All notable changes to this project are documented here.

## Unreleased

## 0.4.0 - 2026-08-07

- Add `relay_models action=unmap` for removing selected metadata mappings and `action=clear` for removing selected protocol overrides, with single-model and batch support.
- Collapse `relay_models` terminal results to an eight-line preview with a `Ctrl+O` expansion hint; the full structured result remains available when expanded.

## 0.3.0 - 2026-08-02

- Add `relay_models action=remove` and `/relay-remove` to unregister a managed relay and clean up its persisted credential and model cache.
- Support atomic batch `map` operations through the `mappings` tool parameter, with one validation, configuration save, and model refresh per batch.
- Allow a top-level mapping protocol default with optional per-entry overrides while preserving the existing single-model API.

## 0.2.0 - 2026-07-28

- Support batch `exclude` and `include` operations through the `remoteModelIds` tool parameter.
- Use a root package extension entry so Pi displays the clean `pi-relay-models` label.

## 0.1.1 - 2026-07-26

- Recommend npm as the installation source in the user documentation.
- Publish npm releases automatically from matching Git version tags through GitHub Actions and trusted publishing.

## 0.1.0 - 2026-07-26

- Discover model IDs from OpenAI- and Anthropic-compatible relay endpoints.
- Reuse model metadata from pi's official catalog.
- Route models through Chat Completions, Responses, or Messages within one provider.
- Store API keys exclusively through pi's `/login` credential flow.
- Persist user-approved metadata mappings, protocol overrides, and exclusions.
- Apply configurable Claude and Codex request-header profiles.
