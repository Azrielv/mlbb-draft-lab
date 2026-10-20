@echo off
REM Re-scrape Liquipedia (heroes, icons, all configured MPL / MSC / M-series games)
cd /d "%~dp0scraper"
python build_heroes.py
python build_matches.py %*
pause
