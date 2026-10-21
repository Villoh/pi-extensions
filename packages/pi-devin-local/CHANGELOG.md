# @villoh/pi-devin-local

## 0.3.1

### Patch Changes

- 7aba0bc: Cap replayed history images to stay under the Devin server's ~10 MB request limit, fixing `GetChatMessage HTTP 413` after sending several screenshots; older images are replaced by a placeholder.
- d23b36e: Drop aborted/errored turns and answer orphaned tool calls before replaying history, fixing sessions stuck on "There is an issue with this request, please try a different model" after an interrupted tool call.
- 6a22432: Resolve `which` from `PATH` when locating the Devin CLI, so it is found on systems without `/usr/bin/which` (NixOS).
