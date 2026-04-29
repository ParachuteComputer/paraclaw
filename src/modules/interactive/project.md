## Interactive module

Generic ask_user_question flow. Lives in `src/modules/interactive/`.

The container-side MCP tool `ask_user_question` writes a chat-sdk card to outbound.db and polls inbound.db for a `question_response` system message. The host side of this is split:

- **Inline in `src/delivery.ts`:** the `deliverMessage` path intercepts `content.type === 'ask_question'` messages and writes a row to the unified `approvals` table with `kind='question'`. Guarded by `hasTable(db, 'approvals')`.
- **This module:** registers a `ResponseHandler` that runs when a button-click arrives via the channel adapter's `onAction`. It looks up the `approvals` row (filtered to `kind='question'`), writes a `question_response` system message into the session's inbound.db, wakes the container.

The `approvals` table is created by migration 024 (paraclaw#11), which collapsed the previous `pending_questions` and `pending_approvals` tables into one. The module doesn't own the schema, just the behavior. Removing the module disables the button-click response path for questions only; admin approvals (other kinds) still flow through `src/modules/approvals/`, and cards are still delivered.

`getAskQuestionRender` in `src/db/sessions.ts` resolves card render metadata for `chat-sdk-bridge.ts`. It reads from `approvals` and from the permissions module's side tables (`pending_channel_approvals`, `pending_sender_approvals`), degrading via `hasTable`. Stays in core.
