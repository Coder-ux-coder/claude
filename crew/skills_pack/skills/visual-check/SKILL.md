---
name: visual-check
description: Screenshot a web page or local app (desktop and phone sizes) and check it for visual defects and console errors. Use before submitting any task that changes something a person sees.
---

# Visual check

Anything a person sees must be looked at, not just tested.

1. Start the app (or open the HTML file) and note its URL.
2. Take screenshots at desktop and phone width:

   ```bash
   python3 "${CLAUDE_PLUGIN_ROOT}/skills/visual-check/screenshot.py" http://localhost:3000 --out /tmp/shot-desktop.png
   python3 "${CLAUDE_PLUGIN_ROOT}/skills/visual-check/screenshot.py" http://localhost:3000 --out /tmp/shot-phone.png --width 390 --height 844
   ```

   The script prints any browser console errors it saw. Add `--click "text=Sign in"` to click something first.
3. Open the PNG files with your Read tool and look at them: layout, overflow, contrast, empty or broken
   states, text cut off, dark mode if the app has one.
4. Fix what you find, re-shoot, and put the screenshot paths in your submission evidence.

If neither Playwright nor Chrome is installed, say so in your evidence and describe what you verified instead.
