# Critical review addendum

After each module, data-preparation step, and larger UI/backend section, run the smallest relevant automated checks and perform a deliberate critical review before building on it. Review the error paths as carefully as the happy path: missing or stale inputs, coordinate mismatches, empty versus failed feature results, ambiguous identifiers, oversized requests, browser focus/scroll behavior, and accidental network or path leakage.

At each milestone, record what was checked, what remains uncertain, and whether the result is suitable for scientific interpretation or only engineering testing. Repeat the review periodically after dependency, annotation-release, schema, or rendering changes; a passing old test suite is not evidence that a new data source or interface behavior is correct. Keep manual domain-scientist, cross-browser, and clean-environment checks explicitly separate from automated evidence.
