#!/usr/bin/env python3
"""
scrape_local_html.py

Parse saved course-catalog and course HTML files (local) and extract
code, name, description, subject, level, semester into JSON.

Usage:
  python scripts/scrape_local_html.py --input "C:/Users/jenni/Downloads/*.html" --output courses.extracted.json

This script is intentionally heuristic-based so you can tune selectors
if needed for your saved files.
"""
import argparse
from bs4 import BeautifulSoup
import glob, json, re, os


def text_or_none(el):
    return el.get_text(' ', strip=True) if el else None


def find_label_value(soup, label_regex):
    # find an element whose text matches label_regex and return nearby value
    label = soup.find(string=re.compile(label_regex, re.I))
    if not label:
        return None
    el = label if isinstance(label, str) else label
    # label might be text node; get parent
    parent = label.parent if hasattr(label, 'parent') else None
    # check siblings
    if parent:
        # common patterns: <dt>Label</dt><dd>Value</dd>
        dd = parent.find_next('dd')
        if dd and text_or_none(dd):
            return text_or_none(dd)
        # label within <th>/<td> pairs
        td = parent.find_next('td')
        if td and text_or_none(td):
            return text_or_none(td)
        # perhaps strong/b nodes
        next_text = parent.find_next(string=True)
        if next_text and next_text.strip() and next_text.strip() != label.strip():
            return next_text.strip()
    return None


def heuristics_parse(html, url=None):
    soup = BeautifulSoup(html, 'html.parser')

    # name: prefer h1
    name = None
    h1 = soup.find('h1')
    if h1 and text_or_none(h1):
        name = text_or_none(h1)
    else:
        # try title tag
        if soup.title and soup.title.string:
            name = soup.title.string.strip()

    # code: look for patterns like (JLCD1) near title or 'Course Number' labels
    code = None
    if name:
        m = re.search(r"\(([A-Za-z0-9\-_/]+)\)", name)
        if m:
            code = m.group(1)
            # strip code from name
            name = re.sub(r"\s*\([A-Za-z0-9\-_/]+\)\s*$", '', name).strip()

    if not code:
        # look for 'Course Number' or 'Course Code'
        code = find_label_value(soup, r"Course\s*(Number|Code)")
        if code:
            code = code.strip()

    # description: common classes or first main paragraph
    description = None
    for sel in ['.course-description', '.description', '.lead', '.summary', '.field--name-body', 'main p', 'article p']:
        el = soup.select_one(sel)
        if el and text_or_none(el):
            description = text_or_none(el)
            break
    # fallback: first meaningful <p>
    if not description:
        for p in soup.find_all('p'):
            t = text_or_none(p)
            if t and len(t) > 40:
                description = t
                break

    # subject / level / semester via label lookup
    subject = find_label_value(soup, r"\bSubject\b|Department|Discipline")
    level = find_label_value(soup, r"\bLevel\b|Grade Level|Audience")
    semester = find_label_value(soup, r"\bSemester\b|Term\b|Year-?long|Year long|Year-long")

    # fallback: look for badges/metadata blocks containing known values
    if not subject:
        # scan for text containing known subject words
        txt = text_or_none(soup)
        for cand in ['Humanities','Core','English','Science','Mathematics','Computer Science','Languages','History','Wellness','Homeroom']:
            if cand.lower() in (txt or '').lower():
                subject = cand
                break

    # normalize some values
    if level:
        level = level.strip()
    if semester:
        semester = semester.strip()
    if subject:
        subject = subject.strip()

    # slug: from code if available else name
    slug_src = code or name or url or 'course'
    slug = re.sub(r'[^a-z0-9]+','-', slug_src.lower()).strip('-')

    return {
        'source_url': url or '',
        'code': code or '',
        'name': name or '',
        'description': description or '',
        'subject': subject or '',
        'level': level or '',
        'semester': semester or '',
        'slug': slug,
    }


def scrape_files(patterns):
    files = []
    for pat in patterns:
        files.extend(glob.glob(pat))
    results = []
    for fp in sorted(set(files)):
        try:
            with open(fp, 'r', encoding='utf8', errors='ignore') as f:
                html = f.read()
            rec = heuristics_parse(html, url='file://' + os.path.abspath(fp))
            rec['_source_file'] = fp
            results.append(rec)
            print('Parsed', fp, '->', rec['slug'])
        except Exception as e:
            print('Failed', fp, e)
    return results


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--input', '-i', nargs='+', required=True, help='Glob(s) or file paths to HTML files')
    p.add_argument('--output', '-o', default='courses.extracted.json', help='Output JSON file')
    args = p.parse_args()

    results = scrape_files(args.input)
    with open(args.output, 'w', encoding='utf8') as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    print('Wrote', args.output)


if __name__ == '__main__':
    main()
