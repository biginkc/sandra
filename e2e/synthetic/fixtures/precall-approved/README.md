Independent approval baseline: merged PR #515, commit 8c7053e7024433f46791eac1b186c1b7a7cf10ec.
These frozen source-script and section-reference copies are test-only. Production never imports them. Do not regenerate from the changed implementation to make tests pass. Wording changes require separately approved source evidence.
The oracle reads these frozen records, replaces tokens independently, and compares every rendered line. It does not import the production token resolver or section builder to calculate expected text.
