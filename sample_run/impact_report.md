# Replay impact report

## Result

- Design: intention_to_treat_randomized_holdout
- Treatment: 37/93 judged outcomes succeeded (39.8%); 0 pending, 0 inconclusive
- Randomized holdout: 9/22 judged outcomes succeeded (40.9%); 0 pending, 0 inconclusive
- Absolute difference: -1.1%
- Approximate 95% interval: -24.0% to 21.7%

The primary comparison follows stable randomized assignment, regardless of whether an intervention was served. This avoids the selection bias in comparing served viewers with everyone else. Rates use terminal outcomes for the initially assigned goal; pending and inconclusive viewers are disclosed rather than silently counted as failures.

## Limitations

- Synthetic replay only; this is not a production causal estimate.
- Assignment, not served-versus-unserved status, defines the comparison.
- Small samples and multiple goals limit precision; the interval is an approximate normal interval.
