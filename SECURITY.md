# Security Notes

This project is meant for a user-owned local Mac and a user-owned BlueBubbles server.

Do not publish:

- `.env`
- BlueBubbles passwords or API tokens
- OpenAI API keys
- real chat GUIDs, message GUIDs, handles, phone numbers, or email addresses
- logs, attachment downloads, audio transcripts, screenshots, or screen recordings with real content
- Apple ID details, Find My locations, Calendar databases, or other local private data

Recommended defaults:

- Keep `BRIDGE_HOST=127.0.0.1`.
- Keep `BRIDGE_AUTO_SEND=false` while testing.
- Use `ALLOWED_CHAT_GUIDS` or `ALLOWED_HANDLES`.
- Test with your own account or a dedicated test chat first.

Codex Desktop CDP support uses a local debug surface and should be treated as experimental. Do not expose the debug port to an untrusted network.
