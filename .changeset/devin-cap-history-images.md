---
"@villoh/pi-devin-local": patch
---

Cap replayed history images to stay under the Devin server's ~10 MB request limit, fixing `GetChatMessage HTTP 413` after sending several screenshots; older images are replaced by a placeholder.
