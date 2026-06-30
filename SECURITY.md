# Security Policy

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/andrewLi1994/codex-gemini-web-bridge/security/advisories/new) for security issues. Do not include Google cookies, Chrome profile files, Codex transcripts, or other credentials in a public issue.

Public bug reports are appropriate for non-sensitive failures such as a changed Gemini page layout, unsupported browser detection, or reproducible installation errors.

## Security boundary

Gemini Web Bridge runs locally, uses a dedicated browser profile, and binds Chrome's debugging endpoint to `127.0.0.1` on a randomly selected port. It does not automate Google sign-in, bypass CAPTCHA challenges, or bypass Gemini usage limits.

The dedicated browser profile contains the user's Google session and must be treated as sensitive local data. It is stored outside the repository and must never be committed or shared.

Codex is instructed to send only minimum necessary public URLs and scoped questions. The full Codex conversation, local files, credentials, secrets, and private data must not be sent automatically. Local Bridge state stores conversation metadata but does not copy Gemini prompts or answers.
