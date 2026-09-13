# Workspace interface

This is an operating surface for parallel Codex work. The familiar desktop workbench follows the user's completed interview: a permanent session rail, independently saved work tabs, actual terminals, and an optional account drawer. No fabricated sessions or quota values appear at first launch.

The palette uses slate surfaces (`#14191f`, `#1d242d`, `#263240`), light body text, blue selection, green activity, amber attention, and red errors. Status always includes an icon and Korean text; color is supplementary. Segoe UI and Malgun Gothic serve controls; Cascadia Mono and Consolas serve terminal content. Chrome stays compact so the terminals own the viewport.

Project folders group the stable session rail. The attention filter includes approval, input, errors, quota waits, unread results, and unreviewed work. Opening a terminal clears unread results only; the explicit 검수 완료 control handles review separately. Hidden work tabs retain attention counts.

Each work tab stores its panel membership, order, column count, and adjustable column proportions. Column separators support pointer dragging and arrow keys; panel move controls support keyboard users. Panels allow vertical resizing. A panel or tab close removes a view, while session termination requires confirmation. The same live session can appear in multiple tabs. Xterm instances survive state snapshots; focus gives one view input and resize ownership.

The account drawer shows status-query quota windows and reset times, plus forecasts when available. Import and refresh are explicit actions. Session headers distinguish automatic selection, fixed accounts, and switching; switching a pinned account explicitly clears its pin. New-session and destructive-action dialogs provide bounded focus. Errors appear in a dismissible banner without moving terminal focus.

The application is intended for desktop window widths. Narrow windows preserve usable terminal width with horizontal scrolling; the account drawer overlays rather than crushing terminals. Reduced decorative motion and local system fonts avoid distractions and network dependencies.
