import asyncio
import os
import argparse
from playwright.async_api import async_playwright

SELECTORS_USERNAME = [
    "input[name=username]",
    "input[name=user]",
    "input[name=userid]",
    "input[name=email]",
    "input#username",
    "input#user",
    "input[type=email]",
    "input[type=text]",
]
SELECTORS_PASSWORD = [
    "input[name=password]",
    "input[name=passwd]",
    "input#password",
    "input[type=password]",
]

async def autofill_login(page, username, password):
    # try many selectors for username
    for usel in SELECTORS_USERNAME:
        try:
            el = page.locator(usel)
            if await el.count() > 0:
                await el.first.fill(username)
                break
        except Exception:
            continue
    # try many selectors for password
    for psel in SELECTORS_PASSWORD:
        try:
            el = page.locator(psel)
            if await el.count() > 0:
                await el.first.fill(password)
                break
        except Exception:
            continue
    # try to submit: look for a button
    for btnsel in ["button[type=submit]", "input[type=submit]", "button:has-text('Sign in')", "button:has-text('Sign In')", "button:has-text('Log in')"]:
        try:
            b = page.locator(btnsel)
            if await b.count() > 0:
                await b.first.click()
                return True
        except Exception:
            continue
    # fallback: press Enter in the password field
    try:
        await page.keyboard.press('Enter')
        return True
    except Exception:
        return False

async def main(out_path):
    username = os.environ.get('OHS_USER')
    password = os.environ.get('OHS_PASS')
    if not username or not password:
        print('Environment variables OHS_USER and OHS_PASS must be set for automated login.')
        return

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=False)
        context = await browser.new_context()
        page = await context.new_page()
        await page.goto('https://familygateway.ohs.stanford.edu/', timeout=0)
        # wait a bit for page load
        await page.wait_for_timeout(1500)

        # try to autofill
        ok = await autofill_login(page, username, password)
        if not ok:
            print('Could not find login button to submit; please complete login manually in the opened browser window.')
            input('Press Enter after you have logged in...')
        else:
            # give time for any redirects/MFA
            print('Submitted login form. If MFA or extra steps are required, complete them in the browser. Press Enter here after you finish.')
            input()

        # save storage state
        await context.storage_state(path=out_path)
        await browser.close()
        print('Saved storage state to', out_path)

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', '-o', default='storage_state.json')
    args = parser.parse_args()
    asyncio.run(main(args.out))
