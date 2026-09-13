# Product

<!-- impeccable:product-schema 1 -->

## Platform

web UI in a Windows Electron desktop app; macOS is future work.

## Users and task

An individual runs tens of Codex CLI sessions across projects and accounts. The primary task is seeing which sessions need attention and arranging relevant terminals together. Work tabs retain independent layouts, and a session can appear in multiple tabs without duplicating its process. Closing a pane closes the view only.

## Confirmed constraints

Retain existing Codex CLI. Separate account authentication from project configuration. Default automatic account selection, healthy session stability, explicit pinning, status-query usage, and reset-based pacing forecasts. Credentials import independently from Orca/OpenCodex. Background session persistence. See the dated requirements and architecture for reasoning.

## Implementation assumptions

Provisional name Codex Workspace. Compact Korean operating interface. Session status remains visible outside the selected tab. No automatic updates until runtime survival verification. These choices implement the user's instruction to proceed after the completed interview.
