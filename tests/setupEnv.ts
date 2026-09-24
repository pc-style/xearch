// Test-only operator allowlist for convex/access.ts `requireOperator`.
// Individual tests give their "operator" identities (e.g. alice@test.xearch,
// bob@test.xearch) a verified email matching this list; a test asserting the
// authorization boundary itself uses an email deliberately NOT on it (or no
// email at all, for an anonymous identity) instead of relying on this list
// being empty.
process.env.OPERATOR_EMAILS = "alice@test.xearch,bob@test.xearch,operator@test.xearch";
