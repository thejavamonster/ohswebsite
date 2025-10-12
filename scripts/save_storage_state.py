import asyncio
from playwright.async_api import async_playwright
import argparse

async def main(out_path):
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=False)
        context = await browser.new_context()
        page = await context.new_page()
        await page.goto("https://familygateway.ohs.stanford.edu/", timeout=0)
        print("Browser opened. Please log in in the opened browser window. When you're fully logged in, return here and press Enter to save the state.")
        input()
        await context.storage_state(path=out_path)
        await browser.close()
        print("Saved storage state to", out_path)

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", "-o", default="storage_state.json")
    args = parser.parse_args()
    asyncio.run(main(args.out))
