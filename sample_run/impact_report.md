# Replay impact report

## Result

- Design: intention_to_treat_randomized_holdout
- Treatment: 37/93 assigned viewers with observed success (39.8%); 93 judged, 0 pending, 0 inconclusive
- Treatment judged-only rate (secondary): 39.8%
- Randomized holdout: 9/22 assigned viewers with observed success (40.9%); 22 judged, 0 pending, 0 inconclusive
- Holdout judged-only rate (secondary): 40.9%
- Absolute difference: -1.1%
- Approximate 95% interval: -24.0% to 21.7%

The primary comparison follows stable randomized assignment, regardless of whether an intervention was served. Rates use all assigned viewers as the denominator; pending and inconclusive outcomes remain visible and are not silently removed. When follow-up is incomplete, this is interim observed-success yield, not a finalized treatment-effect estimate.

## Limitations

- Synthetic replay only; this is not a production causal estimate.
- Assignment, not served-versus-unserved status, defines the comparison.
- Pending and inconclusive assignments remain in the assigned denominator and are not counted as observed successes; interpret the result as interim observed-success yield until follow-up is complete.
- Small samples and multiple goals limit precision; the interval is an approximate normal interval.
