#!/usr/bin/env python3
"""
scrape_live_catalog.py

Scrape the live OHS course catalog (public) using Playwright to render pages.
Extract fields: code, name, description, subject, level, semester, slug, source_url.

Usage (PowerShell):
  python scripts/scrape_live_catalog.py --output live_courses.json

Requirements:
  pip install playwright
  playwright install

Be polite: the script waits between requests.
"""
import asyncio, json, re, argparse, time, random
from playwright.async_api import async_playwright
from urllib.parse import urljoin


async def extract_course_from_page(page, url):
    """Extract fields from a rendered course page.
    Returns a dict with the requested fields.
    """
    # title
    name = ''
    try:
        name = (await page.locator('h1.article__title, h1').first.inner_text()).strip()
    except Exception:
        name = ''

    # code
    code = ''
    try:
        code = (await page.locator('.field--name-field-course-number .field__item, .field--name-field-course-number').first.inner_text()).strip()
    except Exception:
        # fallback: look for 2-6 char code in page text
        try:
            txt = await page.text_content()
            m = re.search(r"\b([A-Z]{1,4}\d{1,4}[A-Za-z]?)\b", txt or '')
            if m:
                code = m.group(1)
        except Exception:
            code = ''

    # description
    desc = ''
    for sel in ['.article__body .field__item', '.field--name-body .field__item', 'meta[name=description]']:
        try:
            if sel.startswith('meta'):
                el = await page.locator(sel).first.get_attribute('content')
                if el and len(el.strip())>10:
                    desc = el.strip(); break
            else:
                el = await page.locator(sel).first.inner_text()
                if el and len(el.strip())>10:
                    desc = el.strip(); break
        except Exception:
            continue

    # subject, level, semester
    subject = ''
    level = ''
    semester = ''
    try:
        subject = (await page.locator('.field--name-field-subject-ref .field__item, .field--name-field-subject-ref').first.inner_text()).strip()
    except Exception:
        subject = ''
    try:
        level = (await page.locator('.field--name-field-level-ref .field__item, .field--name-field-level-ref').first.inner_text()).strip()
    except Exception:
        level = ''
    try:
        semester = (await page.locator('.field--name-field-semester-ref .field__item, .field--name-field-semester-ref').first.inner_text()).strip()
    except Exception:
        semester = ''

    # prerequisites: look for headings containing prerequisite and then capture next paragraph or list
    prerequisites = []
    try:
        # search for elements that contain the word "Prereq" or "Prerequisite"
        possible = await page.locator("xpath=//*[self::h1 or self::h2 or self::h3 or self::h4 or self::strong or self::b][contains(translate(normalize-space(.),'PREREQUISITES','prerequisites'),'prerequisites')]").all()
        if not possible:
            possible = await page.locator("xpath=//*[contains(translate(normalize-space(.),'PREREQUISITE','prerequisite'), 'prerequisite')]").all()
        if possible:
            # for the first match, try to get the following sibling paragraph or list
            el = possible[0]
            # try next sibling paragraph
            try:
                sib = await el.evaluate_handle('e => {let n=e.nextElementSibling; return n ? n.outerHTML : null}')
                if sib:
                    txt = await (await sib.get_property('textContent')).json_value()
                    if txt and txt.strip():
                        prerequisites = [s.strip() for s in re.split(r'[;,]\s*|\n', txt.strip()) if s.strip()]
            except Exception:
                pass
    except Exception:
        prerequisites = []

    slug = (code or name).lower()
    slug = re.sub(r'[^a-z0-9]+', '-', slug).strip('-')

    return {
        'source_url': url,
        'code': code,
        'name': name,
        'description': desc,
        'subject': subject,
        'level': level,
        'semester': semester,
        'prerequisites': prerequisites,
        'slug': slug,
    }


async def load_links(path):
    with open(path, 'r', encoding='utf8') as f:
        lines = [l.strip() for l in f if l.strip()]
    # dedupe and return
    seen = []
    for l in lines:
        if l not in seen:
            seen.append(l)
    return seen


async def fetch_worker(context, url, out_path, timeout, semaphore, combined_json_path=None, lock=None, flush_every=1, counter=None):
    async with semaphore:
        page = await context.new_page()
        # speedup: block images/fonts/styles/media to reduce page load time
        async def _route_handler(route, request):
            try:
                if request.resource_type in ("image", "media", "font", "stylesheet"):
                    await route.abort()
                else:
                    await route.continue_()
            except Exception:
                try:
                    await route.continue_()
                except Exception:
                    pass

        try:
            await page.route("**/*", _route_handler)
        except Exception:
            # routing may fail in some environments; ignore
            pass
        # set navigation and default timeouts
        try:
            page.set_default_navigation_timeout(timeout)
            page.set_default_timeout(10000)
        except Exception:
            pass
        rec = None
        try:
            print('Visiting', url)
            await page.goto(url, timeout=timeout)
            # wait for a key element, but not too long
            try:
                # wait just for DOM content to be available (faster than networkidle/full load)
                await page.wait_for_selector('h1, article, .article__title', timeout=3000)
            except Exception:
                pass
            rec = await extract_course_from_page(page, url)
        except Exception as e:
            print('Error fetching', url, e)
        finally:
            try:
                await page.close()
            except Exception:
                pass

        # write incrementally to jsonl
        if rec is None:
            rec = {'source_url': url, 'error': True}
        try:
            with open(out_path, 'a', encoding='utf8') as fo:
                fo.write(json.dumps(rec, ensure_ascii=False) + '\n')
        except Exception as e:
            print('Failed to write result for', url, e)

        # update combined JSON atomically if requested. Optionally flush only every N records.
        if combined_json_path and lock:
            try:
                want_flush = True
                if flush_every and flush_every > 1 and counter is not None:
                    # flush only every `flush_every` records
                    want_flush = (counter['value'] % flush_every) == 0
                if want_flush:
                    async with lock:
                        items = []
                        try:
                            with open(out_path, 'r', encoding='utf8') as fi:
                                for line in fi:
                                    line = line.strip()
                                    if not line:
                                        continue
                                    try:
                                        items.append(json.loads(line))
                                    except Exception:
                                        continue
                        except FileNotFoundError:
                            items = [rec]
                        with open(combined_json_path, 'w', encoding='utf8') as fo2:
                            json.dump(items, fo2, indent=2, ensure_ascii=False)
            except Exception as e:
                print('Failed to update combined JSON:', e)

        return rec


async def main(output, json_output, concurrency, delay, links_path, timeout, storage_state=None, flush_every=1):
    links = await load_links(links_path)
    print('Will scrape', len(links), 'URLs from', links_path)
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        # create a single context; if storage_state provided, use it so requests are authenticated
        if storage_state:
            try:
                context = await browser.new_context(storage_state=storage_state)
            except Exception:
                # fallback to creating a fresh context
                context = await browser.new_context()
        else:
            context = await browser.new_context()
        sem = asyncio.Semaphore(concurrency)
        tasks = []
        # lock to protect combined JSON writes
        json_lock = asyncio.Lock() if json_output else None
        # optional counter used to decide when to flush combined JSON
        flush_counter = {'value': 0}
        for url in links:
            flush_counter['value'] += 1
            tasks.append(fetch_worker(context, url, output, timeout, sem, json_output, json_lock, flush_every=flush_every, counter=flush_counter))
            # small stagger to avoid bursts
            await asyncio.sleep(delay)

        # run tasks with concurrency limited by semaphore inside fetch_worker
        results = await asyncio.gather(*tasks)
        try:
            await context.close()
        except Exception:
            pass
        await browser.close()

    # write combined JSON
    final = [r for r in results if r]
    if json_output:
        with open(json_output, 'w', encoding='utf8') as f:
            json.dump(final, f, indent=2, ensure_ascii=False)
        print('Wrote', json_output)
    else:
        print('Completed', len(final), 'records')

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--links', '-l', default='links.txt', help='Path to file with URLs (one per line)')
    parser.add_argument('--output', '-o', default='live_courses.jsonl', help='Line-delimited JSON output path')
    parser.add_argument('--json', default='live_courses.json', help='Final combined JSON output path')
    parser.add_argument('--concurrency', type=int, default=2, help='Number of concurrent browser pages')
    parser.add_argument('--delay', type=float, default=0.5, help='Stagger delay between starting tasks (seconds)')
    parser.add_argument('--timeout', type=int, default=30000, help='Navigation timeout in ms')
    parser.add_argument('--storage-state', default=None, help='Path to Playwright storage_state.json (for authenticated sessions)')
    parser.add_argument('--flush-every', type=int, default=1, help='Write combined JSON every N records (1 = every record)')
    args = parser.parse_args()
    asyncio.run(main(args.output, args.json, args.concurrency, args.delay, args.links, args.timeout, storage_state=args.storage_state, flush_every=args.flush_every))
