# Proxy maintenance

- Keep completed changes committed in Git. Create a committed rollback checkpoint before deploying.
- Never commit credentials, note databases, personal note content, logs, or runtime state.
- Run the unit tests and the isolated live smoke test before claiming a deployment works.
- Test writes only on temporary notes created by the test; never use existing user notes as fixtures.
- Use SDK writes, preserve both card sides and rich-text structure, and verify results before reporting success.
- Document tool-schema changes and deployment/rollback steps in README.md.
- Keep public deployment files as examples; do not introduce personal paths, account identifiers, domains or server addresses. Use a GitHub no-reply email for commits.
