Scraper README
----------------

This directory contains `scrape_live_catalog.py`, a Playwright-based scraper that reads URLs from `links.txt` and extracts course fields.

Quick run (PowerShell, from project root):

```powershell
python -m venv venv
& .\venv\Scripts\Activate.ps1
pip install -r requirements.txt
playwright install
python scripts\scrape_live_catalog.py --links links.txt --output live_courses.jsonl --json live_courses.json --concurrency 2 --delay 0.5
```

Outputs:
- `live_courses.jsonl` — incremental line-delimited JSON, one record per line.
- `live_courses.json` — final combined JSON array (written at the end).

Adjust `--concurrency` and `--delay` to tune speed vs politeness.
