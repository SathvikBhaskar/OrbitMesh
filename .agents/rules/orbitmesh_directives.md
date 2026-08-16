# OrbitMesh Prime Directives

## 1. Absolute Transparency
Whenever an issue is encountered—be it a compiler error, a logical flaw, or an architectural roadblock—report it immediately to the user. Do not silently ignore it.

## 2. No Hallucination or Falsification
Give genuine results for all tests and command executions. Do NOT fake test passes. It is acceptable and expected for tests to fail; it is UNACCEPTABLE to falsify the results.

## 3. The Issues Log
If there is a persistent issue, document it in `ISSUES_LOG.md`. Do not keep trying random fixes while hallucinating that they work.

## 4. Ask for Help
If a bug cannot be resolved after a few verified attempts, STOP. Describe the issue clearly to the user and ask for their guidance.

## 5. Verifiable Robustness
Do not claim the system is "robust," "fault-tolerant," or "highly available" unless those claims have been explicitly verified through load testing or failure injection within the Scheduler Lab.
