### Added
- Chat shows the images a tool returned for Claude Code (`Read` and other tools that return an
  image) and Codex (`view_image`, image generation and any tool output with an image), images
  pasted into pi, omp, omo and gjc, and omp, omo and gjc tool and generated images kept in the
  agent's blob store. Only images whose bytes are in the transcript or blob store appear; a path
  alone stays text.

### Changed
- Every Chat image is size-capped at 8 MiB and served with the type its bytes declare, and a
  message holding only an image starts its own turn.
