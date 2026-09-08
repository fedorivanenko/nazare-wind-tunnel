# Nazare Wind Tunnel

Independent evaluation infrastructure for Nazare experiments.

This repository owns the experiment control plane, workers, benchmark corpus, verifier configuration, and run artifacts/provenance. The system under test lives in `fedorivanenko/nazare-hydrogen` and is checked out at an immutable `subjectSha` for every run.

Core trust boundary: candidate changes may modify the subject repository, but not the evaluator, benchmark corpus, verifier, scoring policy, or acceptance logic.
