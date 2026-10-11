# Changelog review UI smoke test

From the repository root, using Node 24 or a compatible Node version declared by the locked `isomorphic-dompurify`/`jsdom` dependencies:

```sh
npm ci --prefix frontend
npm run test:changelog-ui --prefix frontend
```

No environment variables, credentials, running backend or database are required. The script loads the actual changelog page, compiles its TSX with the installed TypeScript compiler and renders it with React in jsdom. It resolves jsdom through the existing `isomorphic-dompurify` dependency, so no additional dependency is required and nested npm layouts work.

The API, authentication session, Next.js Link, toast notifications and confirmation-dialog wrapper are test doubles. The public page uses the real DOMPurify sanitizer and its rendered Tailwind whitespace utilities are compiled to check computed paragraph display. Home and search excerpts use the actual components with unrelated child components replaced by test doubles. This verifies the review workflow and rendered text, rather than deployment connectivity, backend authorization or Headless UI's browser focus behavior.

The checks cover:

- Reading or generating drafts never publishes them.
- Draft markup is escaped and evidence links use exact approved HTTPS hosts.
- Unsaved edits block review; editing must create a saved revision first.
- Publication requires a review note, approval checkbox and a second confirmation.
- A failed write refreshes the current revision and clears approval without retrying publication.
- The next decision uses the refreshed revision; published entries become read-only.
- Public assisted updates retain approved paragraphs and literal markup as text; legacy HTML updates retain sanitized formatting.
- Home and search excerpts preserve literal assisted wording; homepage defaults omit unsupported uptime, monitoring and operational claims.

The script exits nonzero on a failed assertion and makes no network requests.
